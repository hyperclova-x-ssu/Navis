import { crc32 as nodeCrc32 } from 'node:zlib';
import Fastify from 'fastify';
import { afterAll, expect, it } from 'vitest';
import { createTaxEvidenceVerifier } from './evidence-client.ts';
import { crc32, encodeCsv, encodeXlsx, exportHeader, type ExportRow } from './files.ts';

const rows: ExportRow[] = [
  { kind: 'sales', date: '2026-11-17', item: '순매출', detail: '총매출 9000 · 할인 0 · 환불 0', amount: 9000,
    evidence: '', evidenceFiles: null, paidOn: null, memo: '', sourceId: '' },
  { kind: 'expense', date: '2026-11-17', item: '운영비', detail: '', amount: 2000, evidence: '증빙 없음',
    evidenceFiles: null, paidOn: null, memo: '=HYPERLINK("x"), "따옴표"\n줄', sourceId: 'e1' },
  { kind: 'deposit', date: '2026-11-17', item: '실제 입금', detail: '현금', amount: -500,
    evidence: '', evidenceFiles: null, paidOn: null, memo: '-1+2', sourceId: '' },
  { kind: 'tax-payment', date: '2026-12-10', item: '원천세 <11월>&', detail: '납부 전', amount: 183000,
    evidence: '증빙 파일 있음', evidenceFiles: 1, paidOn: null, memo: '\u0001', sourceId: 't1' },
];

/** Minimal reader for the stored ZIP written by `zip()`; verifies each entry CRC with Node's own implementation. */
function unzip(data: Buffer) {
  const entries = new Map<string, string>();
  let offset = 0;
  while (data.readUInt32LE(offset) === 0x04034b50) {
    expect(data.readUInt16LE(offset + 8)).toBe(0);
    const crc = data.readUInt32LE(offset + 14), size = data.readUInt32LE(offset + 18), nameLength = data.readUInt16LE(offset + 26);
    const name = data.toString('utf8', offset + 30, offset + 30 + nameLength);
    const body = data.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    expect(nodeCrc32(body)).toBe(crc);
    entries.set(name, body.toString('utf8'));
    offset += 30 + nameLength + size;
  }
  expect(data.readUInt32LE(offset)).toBe(0x02014b50);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(data.readUInt16LE(end + 10)).toBe(entries.size);
  expect(data.readUInt32LE(end + 16)).toBe(offset);
  return entries;
}

it('writes a BOM CRLF CSV that quotes text and neutralizes formulas but keeps signed numbers', () => {
  const csv = encodeCsv(rows);
  expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = csv.subarray(3).toString('utf8');
  const lines = text.split('\r\n');
  expect(lines[0]).toBe(exportHeader.join(','));
  expect(lines[1]).toBe('매출,2026-11-17,순매출,총매출 9000 · 할인 0 · 환불 0,9000,,,,,');
  expect(text).toContain(`"'=HYPERLINK(""x""), ""따옴표""\n줄"`);
  expect(text).toContain(`입금,2026-11-17,실제 입금,현금,-500,,,,'-1+2,`);
  expect(text.endsWith('\r\n')).toBe(true);
});

it('writes a deterministic XLSX whose ledger sheet holds the same values as the CSV', () => {
  const at = new Date('2026-11-17T06:45:31Z');
  const first = encodeXlsx(rows, [['순매출', 9000], ['검증', '장부 합계와 일치']], at);
  expect(encodeXlsx(rows, [['순매출', 9000], ['검증', '장부 합계와 일치']], at).equals(first)).toBe(true);
  const files = unzip(first);
  expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
  const ledger = files.get('xl/worksheets/sheet1.xml')!;
  expect(ledger).toContain('<c r="E2" s="1"><v>9000</v></c>');
  expect(ledger).toContain('<c r="E4" s="1"><v>-500</v></c>');
  expect(ledger).toContain('<t xml:space="preserve">원천세 &lt;11월&gt;&amp;</t>');
  expect(ledger).not.toContain('\u0001');
  expect(files.get('xl/workbook.xml')).toContain('<sheet name="장부" sheetId="1" r:id="rId1"/>');
  expect(files.get('xl/worksheets/sheet2.xml')).toContain('<c r="B2" s="1"><v>9000</v></c>');
});

it('matches the standard CRC-32', () => {
  for (const sample of ['', 'a', '세무사 자료', 'x'.repeat(5000)]) {
    expect(crc32(Buffer.from(sample))).toBe(nodeCrc32(Buffer.from(sample)));
  }
});

const account = Fastify();
afterAll(() => account.close());

it('verifies tax evidence through the Account workload API and maps missing files to null', async () => {
  const file = { fileId: '4f1c2b7a-1a0e-4c6b-9d2a-0f9b6c1e2d3a', purpose: 'tax-evidence', contentType: 'application/pdf', size: 12,
    sha256: 'a'.repeat(64) };
  const seen: unknown[] = [];
  account.post<{ Params: { storeId: string; fileId: string } }>('/internal/v1/account/stores/:storeId/files/:fileId/evidence-verify',
    async (req, reply) => {
      seen.push({ auth: req.headers.authorization, params: req.params, body: req.body });
      if (req.params.fileId === file.fileId) return file;
      if (req.params.fileId.startsWith('0')) return reply.code(500).send({});
      return reply.code(404).send({ code: 'NOT_FOUND' });
    });
  const origin = await account.listen({ host: '127.0.0.1', port: 0 });
  const verify = createTaxEvidenceVerifier(origin, 'pos-account-token');
  const storeId = '11111111-1111-4111-8111-111111111111', actorId = '22222222-2222-4222-8222-222222222222';
  expect(await verify({ storeId, actorId, fileId: file.fileId })).toEqual({ fileId: file.fileId, contentType: 'application/pdf',
    size: 12, sha256: 'a'.repeat(64) });
  expect(seen[0]).toEqual({ auth: 'Bearer pos-account-token', params: { storeId, fileId: file.fileId },
    body: { actorId, purpose: 'tax-evidence' } });
  expect(await verify({ storeId, actorId, fileId: '9f1c2b7a-1a0e-4c6b-9d2a-0f9b6c1e2d3a' })).toBeNull();
  await expect(verify({ storeId, actorId, fileId: '0f1c2b7a-1a0e-4c6b-9d2a-0f9b6c1e2d3a' })).rejects.toThrow('unavailable');
});

it.each(['https://user@example.test', 'https://example.test/file', 'https://example.test/?q=1',
  'https://example.test/#file', 'ftp://example.test'])('rejects the invalid Account origin %s', base => {
  expect(() => createTaxEvidenceVerifier(base, 'test-token')).toThrow(/origin/i);
});
