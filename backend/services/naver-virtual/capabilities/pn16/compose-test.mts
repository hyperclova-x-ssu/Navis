import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import type { PersonaGrant } from '../../../../packages/naver/config/index.ts'
import { commercePaths, pn16Operations as op } from '../../../../packages/naver/contracts/pn16/index.ts'
import { createPersonaApp } from '../../app.ts'
import { createPersonaSeedContext, seedPersona } from '../../seed.ts'
import { migratePersona } from '../../migrate.ts'
import { personaCapability } from './index.ts'

const seed = createPersonaSeedContext()
let now = seed.now
// Local runs outside the Compose network may point at a disposable database (FIX-GAP-B evidence).
const proofDb = { host: process.env.PN16_PROOF_DB_HOST ?? 'db', port: Number(process.env.PN16_PROOF_DB_PORT ?? 5432) }
const admin = new Pool({ ...proofDb, user: 'postgres', database: 'naver_virtual' })
const migrations = new Pool({ ...proofDb, user: 'nvirtual_mig', database: 'naver_virtual' })
const runtime = new Pool({ ...proofDb, user: 'nvirtual_run', database: 'naver_virtual' })
const syntheticSeller = 'ansungjalbu-smartstore'
const bucket = 'cafe-private'
const accountId = seed.accountId
const secondaryAccount = 'cafe-isolation-control'

function newGrant(workload: string, operations: PersonaGrant['providerCredentials'], grantAccount = accountId): PersonaGrant {
  return { workload, accountId: grantAccount, operations: Object.keys(operations ?? {}),
    providerCredentials: operations, token: randomBytes(24).toString('hex') }
}

const photoGrant = { accessKeyId: 'photo-access', secretAccessKey: randomBytes(32).toString('hex'), bucket, keyPrefix: 'photos/' }
const artifactGrant = { accessKeyId: 'artifact-access', secretAccessKey: randomBytes(32).toString('hex'), bucket, keyPrefix: 'videos/' }
const inventory = { clientId: 'pn16-inventory', sellerId: syntheticSeller }
const pos = { clientId: 'pn16-pos', sellerId: syntheticSeller }
const operator = newGrant('account', { [op.objectPut]: photoGrant, [op.objectGet]: photoGrant, [op.objectDelete]: photoGrant })
const marketing = newGrant('marketing-worker', {
  [op.objectPut]: artifactGrant, [op.objectGet]: artifactGrant, [op.objectDelete]: artifactGrant,
})
const foreign = newGrant('account', { [op.objectGet]: photoGrant, [op.objectPut]: photoGrant }, secondaryAccount)
const capabilities = [personaCapability]
let app: ReturnType<typeof createPersonaApp> | undefined
let base = 'http://127.0.0.1:0'

function request(grant: PersonaGrant, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('x-navis-naver-virtual-token', grant.token)
  headers.set('x-navis-naver-virtual-account', grant.accountId)
  return fetch(base + path, { ...init, headers })
}

function s3(method: string, path: string, grant: PersonaGrant,
  credential: typeof photoGrant, buffer?: Buffer<ArrayBuffer>, extra: Record<string, string> = {}) {
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const bodyHash = createHash('sha256').update(buffer ?? '').digest('hex')
  const headers: Record<string, string> = {
    host: new URL(base).host, 'x-amz-date': date, 'x-amz-content-sha256': bodyHash, ...extra,
  }
  const names = Object.keys(headers).sort()
  const canonical = [method, path, '', names.map((name) => `${name}:${headers[name]}\n`).join(''), names.join(';'), bodyHash].join('\n')
  const pieces = [date.slice(0, 8), 'kr-standard', 's3', 'aws4_request']
  const key = pieces.reduce<string | Buffer>((value, piece) =>
    createHmac('sha256', value).update(piece).digest(), `AWS4${credential.secretAccessKey}`)
  const signature = createHmac('sha256', key).update([
    'AWS4-HMAC-SHA256', date, pieces.join('/'), createHash('sha256').update(canonical).digest('hex'),
  ].join('\n')).digest('hex')
  delete headers.host // fetch sets the Host on the actual HTTP request
  return request(grant, path, { method, body: buffer, headers: {
    ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${pieces.join('/')}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  } })
}

async function storageError(response: Response, status: number, code: string) {
  assert.equal(response.status, status)
  assert.match(response.headers.get('content-type') ?? '', /^application\/xml/)
  const id = response.headers.get('x-amz-request-id')
  assert.ok(id)
  const fields = [...(await response.text()).matchAll(/<(Code|Message|RequestId)>([^<]+)<\/\1>/g)]
  assert.deepEqual(fields.map((field) => field[1]), ['Code', 'Message', 'RequestId'])
  assert.equal(fields[0][2], code)
  assert.equal(fields[2][2], id)
}

async function tokenForm(clientId: string, salt: string, seller: string, timestamp = now.valueOf()) {
  const { rows: [row] } = await admin.query<{ signature: string }>(
    'SELECT naver_virtual.crypt($1, $2) AS signature', [`${clientId}_${timestamp}`, salt],
  )
  return new URLSearchParams({
    client_id: clientId, timestamp: String(timestamp), grant_type: 'client_credentials', type: 'SELLER',
    account_id: seller, client_secret_sign: Buffer.from(row.signature).toString('base64'),
  })
}

function commerce(grant: PersonaGrant, path: string, token: string, body: unknown, method = 'POST') {
  return request(grant, path, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  })
}

function exactKeys(value: object, expected: string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort())
}

async function accessToken(response: Response, seconds: number): Promise<string> {
  assert.equal(response.status, 200)
  const body = await response.json()
  exactKeys(body, ['access_token', 'expires_in', 'token_type'])
  assert.ok(typeof body.access_token === 'string' && body.access_token.length > 0)
  assert.equal(body.expires_in, seconds)
  assert.equal(body.token_type, 'Bearer')
  return body.access_token
}

try {
  await admin.query(`
    CREATE ROLE nvirtual_mig LOGIN;
    CREATE ROLE nvirtual_run LOGIN;
    REVOKE CONNECT ON DATABASE naver_virtual FROM PUBLIC;
    GRANT CONNECT ON DATABASE naver_virtual TO nvirtual_mig, nvirtual_run;
    CREATE SCHEMA naver_virtual AUTHORIZATION nvirtual_mig;
    GRANT USAGE ON SCHEMA naver_virtual TO nvirtual_run;
    CREATE EXTENSION pgcrypto WITH SCHEMA naver_virtual;
  `)
  const { rows: [salts] } = await admin.query<{ inventory: string; pos: string }>(
    "SELECT naver_virtual.gen_salt('bf', 4) AS inventory, naver_virtual.gen_salt('bf', 4) AS pos",
  )
  const sellerGrant = newGrant('inventory', {
    [op.commerceToken]: { ...inventory, clientSecret: salts.inventory },
    [op.productSearch]: inventory, [op.optionStock]: inventory,
  })
  const ordersGrant = newGrant('pos', {
    [op.commerceToken]: { ...pos, clientSecret: salts.pos }, [op.orderDetail]: pos,
  })
  const grants = [operator, marketing, foreign, sellerGrant, ordersGrant]
  const restart = async () => {
    await app?.close()
    app = createPersonaApp({ pool: runtime, grants, capabilities, logging: false, now: () => now })
    base = await app.listen({ host: '127.0.0.1', port: 0 })
  }

  await migratePersona(migrations, capabilities)
  await seedPersona(migrations, capabilities, seed)
  await restart()
  assert.equal((await fetch(base + '/readyz')).status, 200)

  const path = `/${bucket}/photos/%EB%9D%BC%EB%96%BC%20%25.bin`
  const data = Buffer.alloc(2200001).fill(Buffer.from([0, 255, 10, 13, 96, 200, 4]))
  const mime = 'application/octet-stream'
  const metadata = { 'content-type': mime, 'x-amz-meta-purpose': 'menu-photo' }
  const etag = '"' + createHash('md5').update(data).digest('hex') + '"'
  const put = await s3('PUT', path, operator, photoGrant, data, metadata)
  assert.equal(put.status, 200)
  assert.equal(put.headers.get('etag'), etag)
  assert.equal(await put.text(), '')
  const get = await s3('GET', path, operator, photoGrant)
  assert.equal(get.status, 200)
  const exact = Buffer.from(await get.arrayBuffer())
  assert.ok(exact.equals(data))
  assert.equal(get.headers.get('last-modified'), now.toUTCString())
  assert.equal(get.headers.get('content-type'), mime)
  assert.equal(Number(get.headers.get('content-length')), data.length)
  assert.equal(get.headers.get('etag'), etag)
  assert.equal(get.headers.get('x-amz-meta-purpose'), 'menu-photo')
  assert.ok(get.headers.get('x-amz-request-id'))
  const partial = await s3('GET', path, operator, photoGrant, undefined, { range: 'bytes=1-5' })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), `bytes 1-5/${data.length}`)
  assert.ok(Buffer.from(await partial.arrayBuffer()).equals(data.subarray(1, 6)))
  assert.equal((await s3('GET', path, operator, photoGrant, undefined, { 'if-none-match': etag })).status, 304)
  await storageError(await s3('GET', path, operator, photoGrant, undefined, { range: 'bytes=99999999-' }), 416, 'InvalidRange')
  await storageError(await s3('PUT', path, operator, photoGrant, data, { 'x-amz-acl': 'public-read' }), 403, 'AccessDenied')
  await storageError(await s3('PUT', path, operator, photoGrant, data, { 'content-md5': Buffer.alloc(16).toString('base64') }), 400, 'BadDigest')
  for (const method of ['PUT', 'GET', 'DELETE']) {
    await storageError(await s3(method, path, marketing, artifactGrant, method === 'PUT' ? data : undefined), 403, 'AccessDenied')
  }
  await storageError(await s3('GET', path, operator, artifactGrant), 403, 'InvalidAccessKeyId')
  await storageError(await s3('GET', path.replace(bucket, 'foreign-bucket'), operator, photoGrant), 403, 'AccessDenied')
  assert.equal((await fetch(base + path)).status, 401)
  assert.equal((await fetch(base + path, { headers: {
    'x-navis-naver-virtual-token': operator.token, 'x-navis-naver-virtual-account': secondaryAccount,
  } })).status, 403)
  await storageError(await s3('GET', path, foreign, photoGrant), 404, 'NoSuchKey')
  const otherBytes = Buffer.from('other scoped copy')
  assert.equal((await s3('PUT', path, foreign, photoGrant, otherBytes)).status, 200)
  const samePath = await s3('GET', path, operator, photoGrant)
  assert.ok(Buffer.from(await samePath.arrayBuffer()).equals(data))
  const unscoped = await runtime.query('SELECT 1 FROM naver_virtual.pn16_object')
  assert.equal(unscoped.rowCount, 0)
  console.info('PASS Object Storage exact 2200001 bytes, metadata, range, denial, and runtime RLS')

  const issue = (grant: PersonaGrant, form: URLSearchParams) => request(grant, commercePaths.token, { method: 'POST', body: form })
  const form = await tokenForm(inventory.clientId, salts.inventory, syntheticSeller)
  const inventoryToken = await accessToken(await issue(sellerGrant, form), 10800)
  const reused = await accessToken(await issue(sellerGrant, form), 10800)
  assert.ok(reused === inventoryToken)
  const wrongSeller = await tokenForm(inventory.clientId, salts.inventory, 'foreign-seller')
  assert.equal((await issue(sellerGrant, wrongSeller)).status, 403)
  const wrongSignature = new URLSearchParams(form)
  wrongSignature.set('client_secret_sign', 'invalid')
  assert.equal((await issue(sellerGrant, wrongSignature)).status, 400)
  const outdated = await tokenForm(inventory.clientId, salts.inventory, syntheticSeller, now.valueOf() - 300001)
  assert.equal((await issue(sellerGrant, outdated)).status, 400)
  const posForm = await tokenForm(pos.clientId, salts.pos, syntheticSeller)
  const posToken = await accessToken(await issue(ordersGrant, posForm), 10800)
  const deniedReplay = await commerce(ordersGrant, commercePaths.orders, inventoryToken, { productOrderIds: ['1'] })
  assert.equal(deniedReplay.status, 401)
  const gatewayError = await deniedReplay.json()
  exactKeys(gatewayError, ['code', 'message', 'timestamp', 'traceId'])
  assert.equal(gatewayError.code, 'UNAUTHORIZED')
  assert.equal(gatewayError.traceId, deniedReplay.headers.get('gncp-gw-trace-id'))
  assert.equal((await commerce(ordersGrant, commercePaths.products, posToken, {})).status, 403)
  const unauthorizedProduct = await commerce(sellerGrant, commercePaths.products, 'invalid', {})
  assert.equal(unauthorizedProduct.status, 401)
  const productError = await unauthorizedProduct.json()
  exactKeys(productError, ['code', 'message', 'timestamp', 'invalidInputs'])
  assert.equal(productError.code, 'UNAUTHORIZED')
  assert.deepEqual(productError.invalidInputs, [])

  const search = () => commerce(sellerGrant, commercePaths.products, inventoryToken, {
    searchKeywordType: 'PRODUCT_NO', originProductNos: [10001], page: 1, size: 1,
  })
  const page = await search()
  assert.equal(page.status, 200)
  const result = await page.json()
  assert.deepEqual(result, {
    contents: [{ originProductNo: 10001, channelProducts: [{
      originProductNo: 10001, channelProductNo: 20001, channelServiceType: 'STOREFARM',
      name: '하우스 블렌드 원두', sellerManagementCode: 'HOUSE-BLEND', statusType: 'SALE', stockQuantity: 23, salePrice: 12000,
    }] }], page: 1, size: 1, totalElements: 1, totalPages: 1, first: true, last: true,
  })
  const lookup = async (filters: object) => {
    const response = await commerce(sellerGrant, commercePaths.products, inventoryToken, filters)
    assert.equal(response.status, 200)
    return response.json()
  }
  const byCode = await lookup({ searchKeywordType: 'SELLER_CODE', sellerManagementCode: 'HOUSE-BLEND', size: 1 })
  assert.deepEqual(byCode, result)
  const byChannel = await lookup({ searchKeywordType: 'CHANNEL_PRODUCT_NO', channelProductNos: [20001], size: 1 })
  assert.deepEqual(byChannel, result)
  assert.deepEqual((await lookup({ productStatusTypes: ['WAIT'] })).contents, [])
  const nextPage = await lookup({ page: 2, size: 1 })
  assert.deepEqual(nextPage, { ...result, contents: [], page: 2, first: false })
  const stock = (id: number, token = inventoryToken, target = '10001') => commerce(sellerGrant,
    commercePaths.optionStock.replace(':originProductNo', target), token,
    { optionInfo: { optionCombinations: [{ id, stockQuantity: 12, price: 0, usable: true }] } }, 'PUT')
  assert.equal((await stock(100001, posToken)).status, 401)
  assert.equal((await stock(100009)).status, 400)
  assert.equal((await stock(100001, inventoryToken, '10002')).status, 404)
  assert.equal((await (await search()).json()).contents[0].channelProducts[0].stockQuantity, 23)
  const update = await stock(100001)
  assert.equal(update.status, 200)
  const receipt = await update.json()
  exactKeys(receipt, ['originProductNo', 'smartstoreChannelProductNo', 'originProduct'])
  exactKeys(receipt.originProduct, ['statusType', 'name', 'detailContent', 'images', 'salePrice', 'stockQuantity', 'detailAttribute'])
  exactKeys(receipt.originProduct.images, ['representativeImage'])
  exactKeys(receipt.originProduct.images.representativeImage, ['url'])
  exactKeys(receipt.originProduct.detailAttribute, ['optionInfo'])
  exactKeys(receipt.originProduct.detailAttribute.optionInfo, ['optionCombinations'])
  assert.deepEqual(receipt.originProduct.detailAttribute.optionInfo.optionCombinations, [
    { id: 100001, optionName1: '200g', stockQuantity: 12, price: 0, usable: true },
    { id: 100002, optionName1: '500g', stockQuantity: 5, price: 13000, usable: true },
  ])
  assert.deepEqual(await (await stock(100001)).json(), receipt)
  assert.equal((await (await search()).json()).contents[0].channelProducts[0].stockQuantity, 17)
  // RV-GAP-B-4: a public request also changes option price and usability as documented; no 409.
  const repriced = await commerce(sellerGrant, commercePaths.optionStock.replace(':originProductNo', '10001'), inventoryToken,
    { optionInfo: { optionCombinations: [{ id: 100002, stockQuantity: 5, price: 14000, usable: true }] } }, 'PUT')
  assert.equal(repriced.status, 200)
  assert.deepEqual((await repriced.json()).originProduct.detailAttribute.optionInfo.optionCombinations[1],
    { id: 100002, optionName1: '500g', stockQuantity: 5, price: 14000, usable: true })
  assert.equal((await (await search()).json()).contents[0].channelProducts[0].stockQuantity, 17)

  const orderId = seed.cafe.businessDate.replaceAll('-', '') + '0001001'
  const deliveredId = '202611160001101'
  const orders = await commerce(ordersGrant, commercePaths.orders, posToken, {
    productOrderIds: [orderId, '42', deliveredId],
  })
  assert.equal(orders.status, 200)
  const detail = await orders.json()
  exactKeys(detail, ['timestamp', 'traceId', 'data'])
  assert.equal(detail.timestamp, now.toISOString())
  assert.equal(detail.traceId, orders.headers.get('gncp-gw-trace-id'))
  assert.equal(detail.data.length, 2)
  exactKeys(detail.data[0], ['order', 'productOrder'])
  exactKeys(detail.data[0].order, ['orderId', 'orderDate', 'paymentDate'])
  assert.deepEqual(detail.data[0].productOrder, {
    productOrderId: orderId, productOrderStatus: 'PAYED', productId: '20001', originalProductId: '10001',
    productName: '하우스 블렌드 원두', itemNo: '100001', quantity: 1, totalPaymentAmount: 12000,
  })
  assert.equal(detail.data[1].productOrder.productOrderId, deliveredId)
  assert.equal(detail.data[1].productOrder.productOrderStatus, 'DELIVERED')
  assert.equal((await commerce(ordersGrant, commercePaths.orders, posToken, {
    productOrderIds: Array.from({ length: 301 }, (_, i) => String(i)),
  })).status, 400)
  console.info('PASS Commerce OAuth, workload and seller scope, exact product stock acknowledgement and order schema')

  await seedPersona(migrations, capabilities, seed)
  await restart()
  assert.equal((await (await search()).json()).contents[0].channelProducts[0].stockQuantity, 17)
  const retained = await s3('GET', path, operator, photoGrant)
  assert.ok(Buffer.from(await retained.arrayBuffer()).equals(data))
  const remove = await s3('DELETE', path, operator, photoGrant)
  assert.equal(remove.status, 204)
  assert.equal(await remove.text(), '')
  assert.equal((await s3('DELETE', path, operator, photoGrant)).status, 204)
  await storageError(await s3('GET', path, operator, photoGrant), 404, 'NoSuchKey')
  const other = await s3('GET', path, foreign, photoGrant)
  assert.ok(Buffer.from(await other.arrayBuffer()).equals(otherBytes))

  now = new Date(+seed.now + 151 * 60_000)
  const refreshForm = await tokenForm(inventory.clientId, salts.inventory, syntheticSeller)
  const refreshed = await accessToken(await issue(sellerGrant, refreshForm), 10800)
  assert.ok(refreshed !== inventoryToken)
  assert.equal((await search()).status, 200)
  now = new Date(+seed.now + 180 * 60_000)
  assert.equal((await search()).status, 401)
  assert.equal((await commerce(sellerGrant, commercePaths.products, refreshed, {})).status, 200)
  const next = createPersonaSeedContext(new Date(+seed.now + 24 * 60 * 60_000))
  await seedPersona(migrations, capabilities, next)
  now = next.now
  const newToken = await accessToken(await issue(sellerGrant, await tokenForm(inventory.clientId, salts.inventory, syntheticSeller)), 10800)
  const newSearch = await commerce(sellerGrant, commercePaths.products, newToken, {})
  assert.equal((await newSearch.json()).contents[0].channelProducts[0].stockQuantity, 23)
  const newPosToken = await accessToken(await issue(ordersGrant, await tokenForm(pos.clientId, salts.pos, syntheticSeller)), 10800)
  const newOrderId = next.cafe.businessDate.replaceAll('-', '') + '0001001'
  const newOrders = await commerce(ordersGrant, commercePaths.orders, newPosToken, { productOrderIds: [orderId, newOrderId] })
  assert.deepEqual((await newOrders.json()).data.map((item: typeof detail.data[number]) => item.productOrder.productOrderId), [newOrderId])
  console.info('PASS service restart, same-generation seed retry, token refresh and expiry, and next-generation date shift')
} finally {
  await app?.close()
  await Promise.all([admin.end(), migrations.end(), runtime.end()])
}
