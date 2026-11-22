import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { pn16Operations } from '../../../../packages/naver/contracts/pn16/index.ts'
import type { PersonaCapability } from '../../app.ts'
import { header, safeEqual, validateS3Signature } from './sigv4.ts'

type Context = Parameters<PersonaCapability['register']>[1]
type ObjectLocation = { bucket: string; key: string }
type StoredObject = { bytes: Buffer; etag: string; metadata: Record<string, string>; modified_at: Date }
const empty = Buffer.alloc(0)
const maxBytes = 16 * 1024 * 1024
const metadataFields = ['content-type', 'content-encoding', 'cache-control', 'content-disposition', 'content-language']

const storageErrors = {
  AccessDenied: [403, 'Access Denied'],
  BadDigest: [400, 'The Content-MD5 you specified did not match what we received.'],
  EntityTooLarge: [400, 'Your proposed upload exceeds the maximum allowed object size.'],
  InternalError: [500, 'We encountered an internal error. Please try again.'],
  InvalidAccessKeyId: [403, 'The AWS Access Key Id you provided does not exist in our records.'],
  InvalidDigest: [400, 'The Content-MD5 you specified is not valid.'],
  InvalidRange: [416, 'The requested range is not satisfiable.'],
  InvalidRequest: [400, 'Invalid Request'],
  InvalidURI: [400, 'Could not parse the specified URI.'],
  KeyTooLong: [400, 'Your key is too long.'],
  MissingContentLength: [411, 'You must provide the Content-Length HTTP header.'],
  NoSuchKey: [404, 'The specified key does not exist.'],
  PreconditionFailed: [412, 'At least one of the pre-conditions you specified did not hold.'],
  RequestTimeTooSkewed: [403, 'The difference between the request time and the server time is too large.'],
  SignatureDoesNotMatch: [403, 'The request signature we calculated does not match the signature you provided.'],
} as const
type StorageError = keyof typeof storageErrors

function responseHeaders(reply: FastifyReply, now: Date) {
  return reply.headers({ 'x-amz-request-id': randomUUID(), date: now.toUTCString(), 'accept-ranges': 'bytes' })
}

// https://api.ncloud-docs.com/docs/storage-objectstorage#응답-상태-코드
function storageError(reply: FastifyReply, code: StorageError) {
  const [status, message] = storageErrors[code]
  return reply.code(status).type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>${reply.getHeader('x-amz-request-id')}</RequestId></Error>`)
}

function location(request: FastifyRequest): ObjectLocation | StorageError {
  const parts = /^\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/([^?]+)$/.exec(request.raw.url ?? '')
  if (!parts) return 'InvalidURI'
  try {
    const key = decodeURIComponent(parts[2])
    if (Buffer.byteLength(key) > 1024) return 'KeyTooLong'
    if (/[\p{Cc}\\]/u.test(key) || key.split('/').some((part) => part === '.' || part === '..')) {
      return 'InvalidURI'
    }
    return { bucket: parts[1], key }
  } catch {
    return 'InvalidURI'
  }
}

function authorize(request: FastifyRequest, body: Buffer, now: Date, context: Context): ObjectLocation | StorageError {
  const target = location(request)
  if (typeof target === 'string') return target
  const accessKeyId = context.providerCredential(request, 'accessKeyId')
  const secretAccessKey = context.providerCredential(request, 'secretAccessKey')
  const bucket = context.providerCredential(request, 'bucket')
  const prefix = context.providerCredential(request, 'keyPrefix')
  if (!accessKeyId || !secretAccessKey || !bucket || !prefix?.endsWith('/')) return 'AccessDenied'
  const problem = validateS3Signature({
    method: request.method, path: request.raw.url ?? '', headers: request.headers, body, now, accessKeyId, secretAccessKey,
  })
  if (problem) return problem
  if (target.bucket !== bucket || !target.key.startsWith(prefix) || target.key === prefix) return 'AccessDenied'
  return target
}

function objectMetadata(request: FastifyRequest): Record<string, string> {
  const allowed = Object.keys(request.headers).filter((name) =>
    metadataFields.includes(name) || name.startsWith('x-amz-meta-'))
  return Object.fromEntries(allowed.map((name) => [name, header(request.headers, name) ?? '']))
}

function parseRange(value: string, length: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2]) || !length) return
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), length - 1) : length - 1
  if (start <= end) return { start, end }
}

function conditionResult(request: FastifyRequest, object: StoredObject): 304 | 412 | undefined {
  const matches = (value: string) => value.split(',').some((tag) => ['*', object.etag].includes(tag.trim()))
  const ifMatch = header(request.headers, 'if-match')
  const ifNoneMatch = header(request.headers, 'if-none-match')
  const unmodifiedSince = Date.parse(header(request.headers, 'if-unmodified-since') ?? '')
  const modifiedSince = Date.parse(header(request.headers, 'if-modified-since') ?? '')
  const modifiedAt = Math.floor(object.modified_at.valueOf() / 1000) * 1000
  if (ifMatch ? !matches(ifMatch) : modifiedAt > unmodifiedSince) return 412
  if (ifNoneMatch ? matches(ifNoneMatch) : modifiedAt <= modifiedSince) return 304
}

export function registerStorage(app: FastifyInstance, context: Context) {
  app.register(async (storage) => {
    storage.removeAllContentTypeParsers()
    storage.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: maxBytes }, (_request, body, done) => done(null, body))
    storage.setErrorHandler((error, _request, reply) => {
      responseHeaders(reply, context.now())
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return storageError(reply, 'EntityTooLarge')
      if (code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH') return storageError(reply, 'InvalidRequest')
      return storageError(reply, 'InternalError')
    })
    const path = '/:bucket/*'

    // https://api.ncloud-docs.com/docs/storage-objectstorage-putobject
    storage.put(path, { config: { personaOperation: pn16Operations.objectPut }, bodyLimit: maxBytes }, async (request, reply) => {
      const now = context.now()
      responseHeaders(reply, now)
      const body = Buffer.isBuffer(request.body) ? request.body : empty
      const target = authorize(request, body, now, context)
      if (typeof target === 'string') return storageError(reply, target)
      if (!request.headers['content-length'] && request.headers['transfer-encoding'] !== 'chunked') {
        return storageError(reply, 'MissingContentLength')
      }
      const acl = header(request.headers, 'x-amz-acl')
      if (acl && acl !== 'private') return storageError(reply, 'AccessDenied')
      if (Object.keys(request.headers).some((name) => name.startsWith('x-amz-grant-'))) {
        return storageError(reply, 'AccessDenied')
      }
      const digest = createHash('md5').update(body).digest()
      const md5 = header(request.headers, 'content-md5')
      if (md5 && !/^[A-Za-z0-9+/]{22}==$/.test(md5)) return storageError(reply, 'InvalidDigest')
      if (md5 && !safeEqual(md5, digest.toString('base64'))) return storageError(reply, 'BadDigest')
      const etag = `"${digest.toString('hex')}"`
      await context.transaction(request, (client) => client.query(
        `INSERT INTO naver_virtual.pn16_object AS object (account_id, bucket, key, bytes, etag, metadata, modified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id, bucket, key) DO UPDATE
         SET bytes = EXCLUDED.bytes, etag = EXCLUDED.etag, metadata = EXCLUDED.metadata, modified_at = EXCLUDED.modified_at
         WHERE (object.bytes, object.metadata) IS DISTINCT FROM (EXCLUDED.bytes, EXCLUDED.metadata)`,
        [context.accountId(request), target.bucket, target.key, body, etag, objectMetadata(request), now],
      ))
      return reply.header('etag', etag).code(200).send()
    })

    // https://api.ncloud-docs.com/docs/storage-objectstorage-getobject
    storage.get(path, { config: { personaOperation: pn16Operations.objectGet }, exposeHeadRoute: false }, async (request, reply) => {
      const now = context.now()
      responseHeaders(reply, now)
      const target = authorize(request, empty, now, context)
      if (typeof target === 'string') return storageError(reply, target)
      const result = await context.transaction(request, (client) => client.query<StoredObject>(
        `SELECT bytes, etag, metadata, modified_at FROM naver_virtual.pn16_object
         WHERE account_id = $1 AND bucket = $2 AND key = $3`,
        [context.accountId(request), target.bucket, target.key],
      ))
      const object = result.rows[0]
      if (!object) return storageError(reply, 'NoSuchKey')
      reply.headers({ etag: object.etag, 'last-modified': object.modified_at.toUTCString() })
      const condition = conditionResult(request, object)
      if (condition === 304) return reply.code(304).send()
      if (condition === 412) return storageError(reply, 'PreconditionFailed')
      const requestedRange = header(request.headers, 'range')
      const range = requestedRange ? parseRange(requestedRange, object.bytes.length) : undefined
      if (requestedRange && !range) {
        reply.header('content-range', `bytes */${object.bytes.length}`)
        return storageError(reply, 'InvalidRange')
      }
      reply.headers(object.metadata)
      if (!range) return reply.code(200).send(object.bytes)
      return reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${object.bytes.length}`)
        .send(object.bytes.subarray(range.start, range.end + 1))
    })

    // https://api.ncloud-docs.com/docs/storage-objectstorage-deleteobject
    storage.delete(path, { config: { personaOperation: pn16Operations.objectDelete } }, async (request, reply) => {
      const now = context.now()
      responseHeaders(reply, now)
      const target = authorize(request, empty, now, context)
      if (typeof target === 'string') return storageError(reply, target)
      if (Buffer.isBuffer(request.body) && request.body.length) return storageError(reply, 'InvalidRequest')
      await context.transaction(request, (client) => client.query(
        `DELETE FROM naver_virtual.pn16_object WHERE account_id = $1 AND bucket = $2 AND key = $3`,
        [context.accountId(request), target.bucket, target.key],
      ))
      return reply.code(204).send()
    })
  })
}
