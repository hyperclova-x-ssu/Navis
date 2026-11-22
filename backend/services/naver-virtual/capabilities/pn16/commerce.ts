import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import { commercePaths, pn16Operations } from '../../../../packages/naver/contracts/pn16/index.ts'
import type {
  CommerceOrderDetail, CommerceOriginProduct, CommerceProductPage, CommerceSellerOrder, CommerceStockReceipt, CommerceToken,
} from '../../../../packages/naver/contracts/pn16/index.ts'
import type { PersonaContext } from '../../app.ts'
import { PersonaEffectError } from '../../db.ts'
import { orderQuery, productSearch, stockUpdate, tokenRequest } from './commerce-input.ts'
import { sellerId } from './data.ts'
import { safeEqual } from './sigv4.ts'

type Scope = { accountId: string; workload: string; clientId: string; sellerId: string }
type Product = {
  origin_no: string
  channel_no: string
  seller_code: string
  origin: CommerceStockReceipt['originProduct']
}
type Token = { token: string; expires_at: Date }

const tokenSeconds = 10800
const formMediaType = 'application/x-www-form-urlencoded'
const errors = {
  BAD_REQUEST: [400, 'Bad Request'],
  UNAUTHORIZED: [401, 'Unauthorized'],
  FORBIDDEN: [403, 'Forbidden'],
  NOT_FOUND: [404, 'Not Found'],
  CONFLICT: [409, 'Conflict'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Unsupported Media Type'],
  INTERNAL_SERVER_ERROR: [500, 'Internal Server Error'],
} as const

type CommerceCode = keyof typeof errors
class CommerceEffectError extends Error {
  readonly code: CommerceCode;

  constructor(code: CommerceCode) {
    super(code);
    this.code = code;
  }
}

function failure(reply: FastifyReply, now: Date, code: CommerceCode, withTrace = false) {
  const [status, message] = errors[code]
  const traceId = reply.getHeader('gncp-gw-trace-id')
  return reply.code(status).send({
    code, message, timestamp: now.toISOString(),
    ...(withTrace ? { traceId } : {}), ...(!withTrace || status === 415 ? { invalidInputs: [] } : {}),
  })
}

function scopeFor(request: FastifyRequest, context: PersonaContext): Scope | undefined {
  const clientId = context.providerCredential(request, 'clientId')
  const configuredSeller = context.providerCredential(request, 'sellerId')
  if (!clientId || configuredSeller !== sellerId) return
  return { accountId: context.accountId(request), workload: context.workload(request), clientId, sellerId: configuredSeller }
}

async function signedIn(client: PoolClient, request: FastifyRequest, scope: Scope, now: Date) {
  const authorization = request.headers.authorization ?? ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)
  if (!match) return false
  const { accountId, workload, clientId, sellerId } = scope
  const result = await client.query(
    `SELECT 1 FROM naver_virtual.pn16_commerce_token
     WHERE account_id = $1 AND workload = $2 AND client_id = $3 AND seller_id = $4
       AND token = $5 AND expires_at > $6`,
    [accountId, workload, clientId, sellerId, match[1], now],
  )
  return result.rowCount === 1
}

async function issueToken(client: PoolClient, scope: Scope, input: NonNullable<ReturnType<typeof tokenRequest>>,
  secret: string, now: Date): Promise<CommerceToken | undefined> {
  const signature = await client.query<{ signed: string }>(
    'SELECT naver_virtual.pn16_bcrypt($1, $2) AS signed', [`${input.clientId}_${input.timestamp}`, secret],
  )
  const expected = signature.rows[0]?.signed
  if (!expected || !safeEqual(Buffer.from(expected, 'utf8').toString('base64'), input.signedSecret)) return
  const resource = [scope.accountId, scope.workload, scope.clientId, scope.sellerId, input.type]
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 16))', [JSON.stringify(resource)])
  await client.query(
    `DELETE FROM naver_virtual.pn16_commerce_token
     WHERE account_id = $1 AND workload = $2 AND client_id = $3 AND seller_id = $4
       AND grant_type = $5 AND expires_at <= $6`,
    [...resource, now],
  )
  const reusable = await client.query<Token>(
    `SELECT token, expires_at FROM naver_virtual.pn16_commerce_token
     WHERE account_id = $1 AND workload = $2 AND client_id = $3 AND seller_id = $4
       AND grant_type = $5 AND expires_at >= $6
     ORDER BY expires_at DESC LIMIT 1`,
    [...resource, new Date(now.valueOf() + 30 * 60_000)],
  )
  const prior = reusable.rows[0]
  if (prior) return {
    access_token: prior.token, expires_in: Math.floor((prior.expires_at.valueOf() - now.valueOf()) / 1000),
    token_type: 'Bearer',
  }
  const token = randomBytes(32).toString('base64url')
  await client.query(
    `INSERT INTO naver_virtual.pn16_commerce_token
     (account_id, workload, client_id, seller_id, grant_type, token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [...resource, token, new Date(now.valueOf() + tokenSeconds * 1000)],
  )
  return { access_token: token, expires_in: tokenSeconds, token_type: 'Bearer' }
}

function bindCommerce(app: FastifyInstance, context: PersonaContext) {
  app.addContentTypeParser(formMediaType, { parseAs: 'string' },
    (_request, body, done) => done(null, new URLSearchParams(String(body))))
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('gncp-gw-trace-id', randomUUID())
  })
  app.setErrorHandler((error, request, reply) => {
    const withTrace = request.routeOptions.config.personaOperation === pn16Operations.orderDetail
    if (error instanceof CommerceEffectError) return failure(reply, context.now(), error.code, withTrace)
    if (error instanceof PersonaEffectError) return failure(reply, context.now(), error.statusCode === 409 ? 'CONFLICT' : 'BAD_REQUEST', withTrace)
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined
    if (status === 415) return failure(reply, context.now(), 'UNSUPPORTED_MEDIA_TYPE', withTrace)
    if (status === 400 || status === 413) return failure(reply, context.now(), 'BAD_REQUEST', withTrace)
    return failure(reply, context.now(), 'INTERNAL_SERVER_ERROR', withTrace)
  })

  // https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth
  app.post(commercePaths.token, { config: { personaOperation: pn16Operations.commerceToken }, bodyLimit: 2048 },
    async (request, reply) => {
      const now = context.now()
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== formMediaType) {
        return failure(reply, now, 'UNSUPPORTED_MEDIA_TYPE')
      }
      const input = tokenRequest(request.body)
      if (!input || Math.abs(now.valueOf() - input.timestamp) > 5 * 60_000) return failure(reply, now, 'BAD_REQUEST')
      const scope = scopeFor(request, context)
      if (!scope || input.clientId !== scope.clientId || (input.type === 'SELLER' && input.sellerId !== scope.sellerId)) {
        return failure(reply, now, 'FORBIDDEN')
      }
      const secret = context.providerCredential(request, 'clientSecret')
      if (!secret || !/^\$2a\$(?:0[4-9]|1[0-2])\$[./A-Za-z0-9]{22}$/.test(secret)) {
        return failure(reply, now, 'FORBIDDEN')
      }
      const result = await context.transaction(request, (client) => issueToken(client, scope, input, secret, now))
      if (!result) return failure(reply, now, 'BAD_REQUEST')
      return result
    })

  // https://apicenter.commerce.naver.com/docs/commerce-api/current/search-product
  app.post(commercePaths.products, { config: { personaOperation: pn16Operations.productSearch }, bodyLimit: 16384 },
    async (request, reply) => {
      const now = context.now()
      const scope = scopeFor(request, context)
      if (!scope) return failure(reply, now, 'FORBIDDEN')
      const result = await context.transaction(request, async (client) => {
        if (!await signedIn(client, request, scope, now)) return 'UNAUTHORIZED'
        const input = productSearch(request.body)
        if (!input) return 'BAD_REQUEST'
        const { rows } = await client.query<Product>(
          `SELECT origin_no, channel_no, seller_code, origin FROM naver_virtual.pn16_product
           WHERE account_id = $1 AND seller_id = $2
             AND ($3::bigint[] IS NULL OR origin_no = ANY($3))
             AND ($4::bigint[] IS NULL OR channel_no = ANY($4))
             AND ($5::text IS NULL OR seller_code = $5)
             AND ($6::text[] IS NULL OR origin->>'statusType' = ANY($6))
           ORDER BY origin_no DESC`,
          [scope.accountId, scope.sellerId, input.originProductNos, input.channelProductNos,
            input.sellerManagementCode, input.productStatusTypes],
        )
        const offset = (input.page - 1) * input.size
        const totalPages = Math.ceil(rows.length / input.size)
        return {
          contents: rows.slice(offset, offset + input.size).map(({ origin_no, channel_no, seller_code, origin }) => ({
            originProductNo: Number(origin_no),
            channelProducts: [{
              originProductNo: Number(origin_no), channelProductNo: Number(channel_no), channelServiceType: 'STOREFARM',
              name: origin.name, sellerManagementCode: seller_code, statusType: origin.statusType,
              salePrice: origin.salePrice, stockQuantity: origin.stockQuantity,
            }],
          })),
          page: input.page, size: input.size, totalElements: rows.length, totalPages,
          first: input.page === 1, last: input.page >= totalPages,
        } satisfies CommerceProductPage
      })
      if (typeof result === 'string') return failure(reply, now, result)
      return result
    })

  // https://apicenter.commerce.naver.com/docs/commerce-api/current/read-origin-product-product
  app.get<{ Params: { originProductNo: string } }>(commercePaths.originProduct, {
    config: { personaOperation: pn16Operations.productRead },
  }, async (request, reply) => {
    const now = context.now()
    const scope = scopeFor(request, context)
    if (!scope) return failure(reply, now, 'FORBIDDEN')
    const originNo = request.params.originProductNo
    if (!/^[0-9]{1,16}$/.test(originNo) || !Number.isSafeInteger(Number(originNo)) || Number(originNo) < 1) {
      return failure(reply, now, 'BAD_REQUEST')
    }
    const result = await context.transaction(request, async client => {
      if (!await signedIn(client, request, scope, now)) return 'UNAUTHORIZED'
      const { rows: [product] } = await client.query<Pick<Product, 'origin'>>(
        'SELECT origin FROM naver_virtual.pn16_product WHERE account_id=$1 AND seller_id=$2 AND origin_no=$3',
        [scope.accountId, scope.sellerId, originNo],
      )
      return product ? { originProduct: product.origin } satisfies CommerceOriginProduct : 'NOT_FOUND'
    })
    if (typeof result === 'string') return failure(reply, now, result)
    return result
  })

  // https://apicenter.commerce.naver.com/docs/commerce-api/current/update-options-product
  app.put<{ Params: { originProductNo: string } }>(commercePaths.optionStock, {
    config: { personaOperation: pn16Operations.optionStock }, bodyLimit: 32768,
  }, async (request, reply) => {
    const now = context.now()
    const scope = scopeFor(request, context)
    if (!scope) return failure(reply, now, 'FORBIDDEN')
    const originNo = request.params.originProductNo
    const updates = stockUpdate(request.body)
    if (!updates || !/^[0-9]{1,16}$/.test(originNo) || !Number.isSafeInteger(Number(originNo)) || Number(originNo) < 1) {
      return failure(reply, now, 'BAD_REQUEST')
    }
    const approved = updates
    const values = [scope.accountId, scope.sellerId, originNo]
    const select = 'SELECT origin_no, channel_no, seller_code, origin FROM naver_virtual.pn16_product WHERE account_id=$1 AND seller_id=$2 AND origin_no=$3'
    const apply = async (client: PoolClient) => {
      if (!await signedIn(client, request, scope, now)) return 'UNAUTHORIZED'
      const { rows: [product] } = await client.query<Product>(select + ' FOR UPDATE', values)
      if (!product) return 'NOT_FOUND'
      const options = product.origin.detailAttribute.optionInfo.optionCombinations
      const byId = new Map(approved.map((option) => [option.id, option]))
      if (approved.some((update) => !options.some((option) => update.id === option.id)
        || product.origin.salePrice + update.price < 0)) return 'BAD_REQUEST'
      if (request.headers['idempotency-key'] !== undefined && options.some(option => {
        const update = byId.get(option.id)
        return update && (update.price !== option.price || update.usable !== option.usable)
      })) return 'CONFLICT'
      const changed = options.map((option) => ({ ...option, ...byId.get(option.id) }))
      const stockQuantity = changed.reduce((sum, option) => sum + (option.usable ? option.stockQuantity : 0), 0)
      if (stockQuantity > 99999999) return 'BAD_REQUEST'
      const { statusType } = product.origin
      const origin = {
        ...product.origin, stockQuantity,
        statusType: statusType === 'SALE' || statusType === 'OUTOFSTOCK'
          ? stockQuantity > 0 ? 'SALE' : 'OUTOFSTOCK'
          : statusType,
        detailAttribute: { optionInfo: { optionCombinations: changed } },
      } satisfies CommerceStockReceipt['originProduct']
      await client.query(
        `UPDATE naver_virtual.pn16_product SET origin = $4
         WHERE account_id = $1 AND seller_id = $2 AND origin_no = $3 AND origin IS DISTINCT FROM $4::jsonb`,
        [scope.accountId, scope.sellerId, originNo, origin],
      )
      return {
        originProductNo: Number(product.origin_no), smartstoreChannelProductNo: Number(product.channel_no), originProduct: origin,
      } satisfies CommerceStockReceipt
    }
    if (request.headers['idempotency-key'] !== undefined) {
      if (!await context.transaction(request, client => signedIn(client, request, scope, now))) {
        return failure(reply, now, 'UNAUTHORIZED')
      }
      const fingerprint = createHash('sha256').update(JSON.stringify([scope.workload, scope.sellerId, originNo,
        [...approved].sort((a, b) => a.id - b.id)])).digest('hex')
      await context.effect(request, fingerprint, async client => {
        const result = await apply(client)
        if (typeof result === 'string') throw new CommerceEffectError(result)
        return originNo
      })
      const { rows: [latest] } = await context.transaction(request, client => client.query<Product>(select, values))
      if (!latest) return failure(reply, now, 'NOT_FOUND')
      return { originProductNo: Number(latest.origin_no), smartstoreChannelProductNo: Number(latest.channel_no),
        originProduct: latest.origin } satisfies CommerceStockReceipt
    }
    const result = await context.transaction(request, apply)
    if (typeof result === 'string') return failure(reply, now, result)
    return result
  })

  // https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-pay-order-seller
  app.post(commercePaths.orders, { config: { personaOperation: pn16Operations.orderDetail }, bodyLimit: 16384 },
    async (request, reply) => {
      const now = context.now()
      const scope = scopeFor(request, context)
      if (!scope) return failure(reply, now, 'FORBIDDEN', true)
      const result = await context.transaction(request, async (client) => {
        if (!await signedIn(client, request, scope, now)) return 'UNAUTHORIZED'
        const ids = orderQuery(request.body)
        if (!ids) return 'BAD_REQUEST'
        const { rows } = await client.query<{ detail: CommerceSellerOrder }>(
          `SELECT detail FROM naver_virtual.pn16_product_order
           WHERE account_id = $1 AND seller_id = $2 AND order_no = ANY($3::text[])
           ORDER BY array_position($3::text[], order_no)`,
          [scope.accountId, scope.sellerId, ids],
        )
        return rows.map(({ detail }) => detail)
      })
      if (typeof result === 'string') return failure(reply, now, result, true)
      return {
        timestamp: now.toISOString(), traceId: String(reply.getHeader('gncp-gw-trace-id')), data: result,
      } satisfies CommerceOrderDetail
    })
}

export function registerCommerce(app: FastifyInstance, context: PersonaContext) {
  app.register(async (router) => bindCommerce(router, context))
}
