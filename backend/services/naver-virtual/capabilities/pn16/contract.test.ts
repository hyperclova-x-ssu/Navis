import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validateS3Signature } from './sigv4.ts'
import { stockUpdate, orderQuery, productSearch, tokenRequest } from './commerce-input.ts'

const now = new Date('2026-11-17T06:45:00Z')
const credentials = { accessKeyId: 'test-key', secretAccessKey: 'synthetic-fixture' }
const body = Buffer.from([0, 255, 13, 10, 200])
const path = '/owned-photos/menu/%EB%9D%BC%EB%96%BC%20%25.png'

function signedFixture() {
  const headers = {
    host: 'naver-virtual:3000',
    'x-amz-date': '20261117T064500Z',
    'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
  }
  const scope = '20261117/kr-standard/s3/aws4_request'
  const names = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = `PUT\n${path}\n\nhost:${headers.host}\nx-amz-content-sha256:${headers['x-amz-content-sha256']}\nx-amz-date:${headers['x-amz-date']}\n\n${names}\n${headers['x-amz-content-sha256']}`
  const key = scope.split('/').reduce<string | Buffer>((previous, part) =>
    createHmac('sha256', previous).update(part).digest(), `AWS4${credentials.secretAccessKey}`)
  const signature = createHmac('sha256', key).update([
    'AWS4-HMAC-SHA256', headers['x-amz-date'], scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n')).digest('hex')
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`,
  }
}

describe('PN16 published wire', () => {
  it('validates Ncloud SigV4 over the exact Korean key and body', () => {
    const request = { method: 'PUT', path, headers: signedFixture(), body, now, ...credentials }
    expect(validateS3Signature(request)).toBeUndefined()
    expect(validateS3Signature({ ...request, path: path + 'x' })).toBe('SignatureDoesNotMatch')
    expect(validateS3Signature({ ...request, body: Buffer.from([0, 255]) })).toBe('InvalidRequest')
    expect(validateS3Signature({ ...request, accessKeyId: 'other-key' })).toBe('InvalidAccessKeyId')
    expect(validateS3Signature({ ...request, now: new Date('2026-11-17T07:15:00Z') }))
      .toBe('RequestTimeTooSkewed')
  })

  it('reads the official Commerce form without accepting app authorization from extra fields', () => {
    const form = new URLSearchParams({
      client_id: 'cafe-commerce', timestamp: String(now.valueOf()),
      grant_type: 'client_credentials', type: 'SELLER', account_id: 'cafe-seller',
      client_secret_sign: 'fixture',
    })
    expect(tokenRequest(form)).toEqual({
      clientId: 'cafe-commerce', timestamp: now.valueOf(), type: 'SELLER',
      sellerId: 'cafe-seller', signedSecret: 'fixture',
    })
    form.append('account_id', 'different')
    expect(tokenRequest(form)).toBeUndefined()
  })

  it('bounds seller order IDs and accepts documented stock and search field names', () => {
    expect(orderQuery({ productOrderIds: ['202611170010001'] })).toEqual(['202611170010001'])
    expect(orderQuery({ productOrderIds: Array.from({ length: 301 }, (_, i) => String(i)) }))
      .toBeUndefined()
    expect(orderQuery({ productOrderIds: [4700] })).toBeUndefined()
    expect(stockUpdate({ optionInfo: { optionCombinations: [
      { id: 100001, stockQuantity: 0, price: 0 },
    ] } })).toEqual([{ id: 100001, stockQuantity: 0, price: 0, usable: true }])
    expect(stockUpdate({ optionInfo: { optionCombinations: [
      { id: 1, stockQuantity: -1 },
    ] } })).toBeUndefined()
    expect(stockUpdate({ optionInfo: { optionCombinations: [
      { id: 1, stockQuantity: 2, sellerId: 'foreign' },
    ] } })).toBeUndefined()
    expect(productSearch({ searchKeywordType: 'PRODUCT_NO', originProductNos: [10001] }))
      .toMatchObject({ page: 1, size: 50, originProductNos: [10001] })
    expect(productSearch({ size: 501 })).toBeUndefined()
  })
})
