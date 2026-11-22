import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

const algorithm = 'AWS4-HMAC-SHA256'
const authPattern = /^AWS4-HMAC-SHA256 Credential=([^/\s,]+)\/(\d{8})\/kr-standard\/s3\/aws4_request,\s*SignedHeaders=([a-z0-9;-]+),\s*Signature=([a-f0-9]{64})$/
const amzDatePattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
const hashPattern = /^[a-f0-9]{64}$/

export function safeEqual(left: string, right: string): boolean {
  const first = Buffer.from(left)
  const second = Buffer.from(right)
  return first.length === second.length && timingSafeEqual(first, second)
}

export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value.join(',') : value
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function encodePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(decodeURIComponent(segment))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
}

export type SignatureError = 'InvalidRequest' | 'InvalidURI' | 'InvalidAccessKeyId'
  | 'AccessDenied' | 'SignatureDoesNotMatch' | 'RequestTimeTooSkewed'

// https://api.ncloud-docs.com/docs/common-objectstorageapi-objectstorageapi
export function validateS3Signature(input: {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: Buffer
  now: Date
  accessKeyId: string
  secretAccessKey: string
}): SignatureError | undefined {
  const { method, path, headers, body, now, accessKeyId, secretAccessKey } = input
  const authorization = header(headers, 'authorization')
  if (!authorization) return 'AccessDenied'
  const match = authPattern.exec(authorization)
  if (!match) return 'InvalidRequest'
  const [, keyId, date, signedHeaders, providedSignature] = match
  if (!safeEqual(keyId, accessKeyId)) return 'InvalidAccessKeyId'

  const amzDate = header(headers, 'x-amz-date')
  const dateHeader = header(headers, 'date')
  const timestamp = amzDate
    ? new Date(amzDate.replace(amzDatePattern, '$1-$2-$3T$4:$5:$6Z'))
    : new Date(dateHeader ?? '')
  if (!Number.isFinite(timestamp.valueOf())) return 'InvalidRequest'
  const requestTime = timestamp.toISOString().replace(/[-:]|\.\d{3}/g, '')
  if ((amzDate && amzDate !== requestTime) || !requestTime.startsWith(date)) return 'InvalidRequest'
  if (Math.abs(now.valueOf() - timestamp.valueOf()) > 15 * 60_000) return 'RequestTimeTooSkewed'

  const names = signedHeaders.split(';')
  if (
    [...new Set(names)].sort().join(';') !== signedHeaders || !names.includes('host')
    || !names.includes(amzDate ? 'x-amz-date' : 'date')
    || Object.keys(headers).some((name) => name.startsWith('x-amz-')
      && name !== 'x-amz-content-sha256' && !names.includes(name))
    || names.some((name) => header(headers, name) === undefined)
  ) return 'InvalidRequest'

  const providedHash = header(headers, 'x-amz-content-sha256')
  if (method === 'PUT' && !providedHash) return 'InvalidRequest'
  const contentHash = providedHash ?? sha256(body)
  if (contentHash !== 'UNSIGNED-PAYLOAD'
    && (!hashPattern.test(contentHash) || !safeEqual(contentHash, sha256(body)))) return 'InvalidRequest'

  let uri: string
  try {
    uri = encodePath(path)
  } catch {
    return 'InvalidURI'
  }
  const canonicalHeaders = names.map((name) =>
    `${name}:${header(headers, name)?.trim().replace(/[ \t]+/g, ' ')}\n`).join('')
  const canonicalRequest = [method, uri, '', canonicalHeaders, signedHeaders, contentHash].join('\n')
  const scope = [date, 'kr-standard', 's3', 'aws4_request']
  const signingKey = scope.reduce<string | Buffer>((key, part) =>
    createHmac('sha256', key).update(part).digest(), `AWS4${secretAccessKey}`)
  const stringToSign = [algorithm, requestTime, scope.join('/'), sha256(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  if (!safeEqual(signature, providedSignature)) return 'SignatureDoesNotMatch'
}
