import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { type HTTPMethods } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { createPosApp } from '../../app.ts';
import { preparePosRoute, type PosOwnerRouteWithPreflight } from '../../preflight.ts';
import { createReversalTokens } from '../../reversals.ts';
import { withStoreTransaction } from '../../transaction.ts';
import { PosError } from '../../wire.ts';
import { registerPosRealityRoutes } from '../02/routes.ts';
import { registerFinanceRoutes } from '../09/routes.ts';
import type { TaxEvidenceFile } from './evidence-client.ts';
import { registerTaxRoutes } from './routes.ts';

const runtime = dbPool('pos', 'runtime', 'test');
const migrator = dbPool('pos', 'migrate', 'test');
const app = Fastify();
const day = '2026-11-17';
const initial = '2026-11-17T06:45:00Z';
let at = new Date(initial);
const storeId = randomUUID(), otherStore = randomUUID();
const actorId = randomUUID(), otherActor = randomUUID();
const menuId = randomUUID();
const evidence = new Map<string, TaxEvidenceFile>();
const verifyCalls: unknown[] = [];
let verifierDown = false;

const ownerFor = (target: typeof app): PosOwnerRouteWithPreflight => (method, path, mode, handler) => {
  target.route<{ Params: { storeId: string; id?: string } }>({ method, url: '/pos/:storeId' + path,
    async handler(req, reply) {
      try {
        const { storeId } = req.params;
        const prepared = await preparePosRoute(runtime, { storeId, actorId: req.headers['x-test-actor'] === 'other' ? otherActor : actorId },
          () => at, handler, req.params, req.body, String(req.headers['idempotency-key']), req.query);
        return await withStoreTransaction(runtime, storeId, db => prepared.apply(db, at),
          { write: mode === 'command', readOnly: mode === 'read' });
      } catch (error) {
        if (error instanceof PosError) return reply.code(error.statusCode).send(error.result);
        throw error;
      }
    } });
};
const owner = ownerFor(app);

beforeAll(async () => {
  await runMigrations('pos', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test');
  for (const store of [storeId, otherStore]) {
    await withStoreTransaction(migrator, store, async (db) => {
      await db.query('INSERT INTO pos.store (store_id) VALUES ($1)', [store]);
      await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
        VALUES ($1, $2, '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [store, day]);
      await db.query('INSERT INTO pos.catalog_menu (store_id, menu_id, snapshot) VALUES ($1, $2, $3)', [
        store, menuId, { name: '아메리카노', basePrice: 4500, baseCost: 1000, recipeVersion: 'recipe-1', saleStatus: 'selling', groups: [] },
      ]);
    });
  }
  registerTaxRoutes(owner, { verifyEvidence: async (scope) => {
    verifyCalls.push(scope);
    if (verifierDown) throw new Error('down');
    return evidence.get(scope.fileId) ?? null;
  } });
  registerFinanceRoutes(owner, { readReceiptStatus: async () => ({ status: 'active' }) });
  registerPosRealityRoutes(owner, createReversalTokens(randomUUID()));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await Promise.all([runtime.end(), migrator.end()]);
});

function call(method: HTTPMethods, path: string, payload?: object, key: string = randomUUID(), store = storeId, actor?: string) {
  return app.inject({ method, url: '/pos/' + store + path, payload,
    headers: { 'idempotency-key': key, ...(actor && { 'x-test-actor': actor }) } });
}

async function ok(method: HTTPMethods, path: string, body?: object, key?: string, store = storeId) {
  const response = await call(method, path, body, key, store);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function reason(method: HTTPMethods, path: string, body?: object) {
  return (await call(method, path, body)).json().reason;
}

async function taxEvents(id: string) {
  const { rows } = await withStoreTransaction(runtime, storeId, (db) => db.query<{ payload: Record<string, unknown> }>(`
    SELECT payload FROM pos.outbox WHERE store_id = $1 AND event_type = 'pos.tax_due_changed.v1' AND aggregate_id = $2 ORDER BY store_seq
  `, [storeId, id]), { readOnly: true });
  return rows.map(row => row.payload);
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += char;
  }
  return rows;
}

it('records owner tax payments with a duplicate guard, revisions, a paid record, calendar events and undo', async () => {
  expect(await reason('POST', '/tax-payments', { taxType: ' ', amount: 1, dueOn: '2026-12-10' })).toBe('TAX_TYPE_REQUIRED');
  expect(await reason('POST', '/tax-payments', { taxType: '원천세', amount: 0, dueOn: '2026-12-10' })).toBe('AMOUNT_INVALID');
  expect(await reason('POST', '/tax-payments', { taxType: '원천세', amount: 1, dueOn: '2026-13-01' })).toBe('DATE_INVALID');
  expect(await reason('POST', '/tax-payments', { taxType: '원천세', amount: 1, dueOn: '2026-12-10', evidence: 'example' }))
    .toBe('INVALID_REQUEST');

  const key = randomUUID();
  const body = { taxType: '원천세(11월분)', amount: 183000, dueOn: '2026-12-10' };
  const created = await ok('POST', '/tax-payments', body, key);
  const id: string = created.taxPaymentId;
  expect(created).toMatchObject({ resourceId: id, revision: 1, affectedSources: ['pos.tax-payments', 'pos.tax'],
    undoUntil: '2026-11-17T06:45:06.000Z',
    payment: { type: '원천세(11월분)', amount: 183000, dueOn: '2026-12-10', paidOn: null, status: 'unpaid', overdue: false,
      evidence: 'none', evidenceFiles: [], paidRecordedAt: null } });
  expect(await ok('POST', '/tax-payments', body, key)).toEqual(created);
  expect((await call('POST', '/tax-payments', { ...body, amount: 1 }, key)).json().reason).toBe('IDEMPOTENCY_MISMATCH');
  const duplicate = await call('POST', '/tax-payments', { ...body, taxType: ' 원천세 (11월분) ' });
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json()).toMatchObject({ reason: 'TAX_PAYMENT_EXISTS',
    details: { taxPaymentId: id, type: '원천세(11월분)', amount: 183000, dueOn: '2026-12-10', status: 'unpaid' } });
  const overdue = await ok('POST', '/tax-payments', { taxType: '부가세', amount: 50000, dueOn: '2026-10-25' });
  const forced = await ok('POST', '/tax-payments', { ...body, confirmDuplicate: true });
  expect(forced.taxPaymentId).not.toBe(id);

  const list = await ok('GET', '/tax-payments');
  expect(list.items.map((row: { taxPaymentId: string }) => row.taxPaymentId))
    .toEqual([id, forced.taxPaymentId].sort().reverse().concat(overdue.taxPaymentId));
  expect(list.next).toMatchObject({ taxPaymentId: overdue.taxPaymentId, overdue: true });
  expect(list.summary).toEqual({ unpaidCount: 3, unpaidTotal: 416000, overdueCount: 1, dueSoonCount: 3, paidCount: 0, withEvidenceCount: 0 });
  expect(list).toMatchObject({ today: day, asOf: initial.replace('Z', '.000Z'), nextCursor: null });
  const firstPage = await ok('GET', '/tax-payments?limit=1&status=unpaid');
  expect(firstPage.items).toHaveLength(1);
  expect((await ok('GET', `/tax-payments?limit=5&cursor=${firstPage.nextCursor}`)).items).toHaveLength(2);
  expect((await ok('GET', '/tax-payments?dueFrom=2026-11-01&dueTo=2026-12-31')).items).toHaveLength(2);
  expect(await reason('GET', '/tax-payments?dueFrom=2026-12-31&dueTo=2026-11-01')).toBe('INVALID_PERIOD');
  expect(await reason('GET', '/tax-payments?status=done')).toBe('INVALID_STATUS');
  expect((await call('GET', `/tax-payments/${id}`, undefined, undefined, otherStore)).statusCode).toBe(404);
  expect((await ok('GET', '/tax-payments', undefined, undefined, otherStore)).items).toEqual([]);
  expect((await runtime.query('SELECT count(*)::integer AS n FROM pos.tax_payment')).rows[0].n).toBe(0);
  await ok('DELETE', `/tax-payments/${forced.taxPaymentId}`, { expectedRevision: 1, confirmed: true });

  expect(await reason('POST', `/tax-payments/${id}/paid`, { expectedRevision: 2 })).toBe('STALE_REVISION');
  expect(await reason('POST', `/tax-payments/${id}/paid`, { expectedRevision: 1, paidOn: '2026-11-18' })).toBe('PAID_ON_FUTURE');
  const paid = await ok('POST', `/tax-payments/${id}/paid`, { expectedRevision: 1 });
  expect(paid.payment).toMatchObject({ status: 'paid', paidOn: day, revision: 2, paidRecordedAt: '2026-11-17T06:45:00.000Z' });
  expect(await ok('POST', `/tax-payments/${id}/paid`, { expectedRevision: 2 })).toMatchObject({ changed: false, revision: 2 });
  const undoPath = `/tax/receipts/${paid.receiptId}/undo`;
  expect((await call('POST', undoPath, {}, undefined, storeId, 'other')).statusCode).toBe(404);
  const undoKey = randomUUID();
  const undone = await ok('POST', undoPath, {}, undoKey);
  expect(undone).toMatchObject({ resourceId: id, revision: 3, resourceKind: 'tax-payment', undoneReceiptId: paid.receiptId });
  expect(await ok('POST', undoPath, {}, undoKey)).toEqual(undone);
  expect(await reason('POST', undoPath, {})).toBe('UNDO_UNAVAILABLE');
  expect(await ok('GET', `/tax-payments/${id}`)).toMatchObject({ status: 'unpaid', paidOn: null, paidRecordedAt: null, revision: 3,
    sourceRevision: 3 });

  expect(await reason('PATCH', `/tax-payments/${id}`, { status: 'unpaid', paidOn: day, expectedRevision: 3 })).toBe('DATE_INVALID');
  expect(await reason('PATCH', `/tax-payments/${id}`, { paidOn: day, expectedRevision: 3 })).toBe('DATE_INVALID');
  expect(await reason('PATCH', `/tax-payments/${id}`, { status: 'paid', expectedRevision: 3 })).toBe('DATE_INVALID');
  expect(await reason('PATCH', `/tax-payments/${id}`, { expectedRevision: 3 })).toBe('INVALID_REQUEST');
  expect(await reason('PATCH', `/tax-payments/${id}`, { amount: 184000, expectedRevision: 2 })).toBe('STALE_REVISION');
  expect((await ok('PATCH', `/tax-payments/${id}`, { amount: 184000, type: '원천세 11월분', expectedRevision: 3 })).payment)
    .toMatchObject({ amount: 184000, type: '원천세 11월분', revision: 4 });
  expect((await ok('PATCH', `/tax-payments/${id}`, { status: 'paid', paidOn: '2026-11-16', expectedRevision: 4 })).payment)
    .toMatchObject({ status: 'paid', paidOn: '2026-11-16', revision: 5 });
  expect((await ok('PATCH', `/tax-payments/${id}`, { status: 'unpaid', expectedRevision: 5 })).payment)
    .toMatchObject({ status: 'unpaid', paidOn: null, revision: 6 });
  expect(await ok('PATCH', `/tax-payments/${id}`, { amount: 184000, expectedRevision: 6 })).toMatchObject({ changed: false, revision: 6 });

  expect(await reason('DELETE', `/tax-payments/${id}`, { expectedRevision: 6 })).toBe('CONFIRMATION_REQUIRED');
  const removed = await ok('DELETE', `/tax-payments/${id}`, { expectedRevision: 6, confirmed: true });
  expect((await call('GET', `/tax-payments/${id}`)).statusCode).toBe(404);
  await ok('POST', `/tax/receipts/${removed.receiptId}/undo`, {});
  expect(await ok('GET', `/tax-payments/${id}`)).toMatchObject({ revision: 8, status: 'unpaid' });
  const again = await ok('DELETE', `/tax-payments/${id}`, { expectedRevision: 8, confirmed: true });
  at = new Date('2026-11-17T06:45:07Z');
  expect(await reason('POST', `/tax/receipts/${again.receiptId}/undo`, {})).toBe('UNDO_EXPIRED');
  at = new Date(initial);

  const events = await taxEvents(id);
  expect(events.map(event => event.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(events.map(event => (event.calendarProjection as { entry: unknown }).entry)).toEqual([
    { date: '2026-12-10' }, null, { date: '2026-12-10' }, { date: '2026-12-10' }, null, { date: '2026-12-10' }, null,
    { date: '2026-12-10' }, null,
  ]);
  expect(events[0]).toEqual({ taxPaymentId: id, revision: 1, status: 'unpaid', dueOn: '2026-12-10', paidOn: null, amount: 183000,
    deleted: false, evidenceCount: 0,
    calendarProjection: { source: 'tax-due', sourceId: id, revision: 1, entry: { date: '2026-12-10' } } });
  expect(events.every(event => !JSON.stringify(event).includes('원천세'))).toBe(true);
});

it('counts as evidence only verified Account tax-evidence files', async () => {
  const created = await ok('POST', '/tax-payments', { taxType: '종합소득세', amount: 320000, dueOn: '2026-11-30' });
  const id: string = created.taxPaymentId;
  const fileId = randomUUID(), missing = randomUUID();
  evidence.set(fileId, { fileId, contentType: 'application/pdf', size: 2048, sha256: 'b'.repeat(64) });
  expect(await reason('POST', `/tax-payments/${id}/evidence`, { fileId: missing, expectedRevision: 1 })).toBe('EVIDENCE_FILE_NOT_FOUND');
  verifierDown = true;
  expect(await reason('POST', `/tax-payments/${id}/evidence`, { fileId, expectedRevision: 1 })).toBe('EVIDENCE_VERIFIER_UNAVAILABLE');
  verifierDown = false;
  expect(await reason('POST', `/tax-payments/${id}/evidence`, { fileId: 'not-a-file', expectedRevision: 1 })).toBe('INVALID_REQUEST');
  const attached = await ok('POST', `/tax-payments/${id}/evidence`, { fileId, expectedRevision: 1 });
  expect(verifyCalls.at(-1)).toEqual({ storeId, actorId, fileId });
  expect(attached.payment).toMatchObject({ revision: 2, evidence: 'attached',
    evidenceFiles: [{ fileId, contentType: 'application/pdf', size: 2048, sha256: 'b'.repeat(64), attachedAt: '2026-11-17T06:45:00.000Z' }] });
  expect(await ok('POST', `/tax-payments/${id}/evidence`, { fileId, expectedRevision: 2 })).toMatchObject({ changed: false });
  expect((await ok('GET', '/tax-payments')).summary.withEvidenceCount).toBe(1);
  expect(await reason('DELETE', `/tax-payments/${id}/evidence/${fileId}`, { expectedRevision: 2 })).toBe('CONFIRMATION_REQUIRED');
  expect(await reason('DELETE', `/tax-payments/${id}/evidence/${missing}`, { expectedRevision: 2, confirmed: true }))
    .toBe('EVIDENCE_NOT_ATTACHED');
  const detached = await ok('DELETE', `/tax-payments/${id}/evidence/${fileId}`, { expectedRevision: 2, confirmed: true });
  expect(detached.payment).toMatchObject({ revision: 3, evidence: 'none', evidenceFiles: [] });
  await ok('POST', `/tax/receipts/${detached.receiptId}/undo`, {});
  expect(await ok('GET', `/tax-payments/${id}`)).toMatchObject({ revision: 4, evidence: 'attached', evidenceFiles: [{ fileId }] });
  const paid = await ok('POST', `/tax-payments/${id}/paid`, { expectedRevision: 4 });
  expect(paid.payment).toMatchObject({ status: 'paid', evidence: 'attached' });
  expect((await taxEvents(id)).at(-1)).toMatchObject({ revision: 5, status: 'paid', evidenceCount: 1,
    calendarProjection: { entry: null } });
});

it('reviews expenses without evidence against the reviewed expense revision', async () => {
  const missing = await ok('POST', '/expenses', { date: day, category: 'operations', amount: 2000, evidence: 'none', memo: '영수증 분실' });
  const carded = await ok('POST', '/expenses', { date: day, category: 'supplies', amount: 3000, evidence: 'card' });
  const list = await ok('GET', `/tax-reviews?from=${day}&to=${day}`);
  expect(list).toMatchObject({ from: day, to: day, reviewCount: 1, checkedCount: 0, totalCount: 1,
    items: [{ refType: 'expense', refId: missing.expenseId, date: day, category: 'operations', amount: 2000, memo: '영수증 분실',
      reason: 'missing-evidence', status: 'needs-check', expenseRevision: 1, checkedAt: null }] });
  expect((await ok('GET', '/tax-reviews')).from).toBe('2026-11-01');
  expect(await reason('GET', '/tax-reviews?from=2025-11-01&to=2026-11-17')).toBe('INVALID_PERIOD');
  expect(await reason('POST', `/tax-reviews/${missing.expenseId}/check`, { expenseRevision: 2 })).toBe('STALE_REVISION');
  expect(await reason('POST', `/tax-reviews/${carded.expenseId}/check`, { expenseRevision: 1 })).toBe('TAX_ITEM_NOT_FOUND');
  const checked = await ok('POST', `/tax-reviews/${missing.expenseId}/check`, { expenseRevision: 1 });
  expect(checked.item).toMatchObject({ status: 'checked', checkedAt: '2026-11-17T06:45:00.000Z' });
  expect(await ok('POST', `/tax-reviews/${missing.expenseId}/check`, { expenseRevision: 1 })).toMatchObject({ changed: false });
  expect(await ok('GET', `/tax-reviews?from=${day}&to=${day}`)).toMatchObject({ reviewCount: 0, checkedCount: 1 });
  expect((await ok('GET', `/tax-reviews?from=${day}&to=${day}&status=needs-check`)).items).toEqual([]);
  await ok('PATCH', `/expenses/${missing.expenseId}`, { amount: 2500, expectedRevision: 1 });
  expect((await ok('GET', `/tax-reviews?from=${day}&to=${day}`)).items[0]).toMatchObject({ status: 'needs-check', expenseRevision: 2,
    amount: 2500 });
  const recheck = await ok('POST', `/tax-reviews/${missing.expenseId}/check`, { expenseRevision: 2 });
  await ok('POST', `/tax/receipts/${recheck.receiptId}/undo`, {});
  expect(await ok('GET', `/tax-reviews?from=${day}&to=${day}`)).toMatchObject({ reviewCount: 1, checkedCount: 0 });
});

it('exports a verified ledger whose CSV and XLSX match the preview the owner saw', async () => {
  const draft = await ok('POST', '/bills', { type: 'takeout', lines: [{ menuId, qty: 2 }] });
  await ok('POST', `/bills/${draft.resourceId}/payments`, { method: 'cash', quoteRevision: draft.quote.quoteRevision, amount: 9000 });
  const due = await ok('POST', '/tax-payments', { taxType: '지방소득세', amount: 18300, dueOn: day });
  const period = `from=${day}&to=${day}`;
  const preview = await ok('GET', `/tax-exports/preview?${period}`);
  const ledger = await ok('GET', `/ledger?businessDate=${day}`);
  expect(preview).toMatchObject({ from: day, to: day, officialLinks: { hometax: 'https://www.hometax.go.kr/' },
    verification: { status: 'verified' }, estimate: null,
    connections: [{ source: 'sales', status: 'connected' }, { source: 'expenses', status: 'connected' },
      { source: 'evidence', status: 'partial' }],
    preview: { sales: { total: ledger.totals.sales.total, gross: 9000 }, deposits: { total: ledger.totals.deposits.total },
      expenses: { total: ledger.totals.expenses, count: 2, evidenceRecorded: 1, missingEvidence: 1 },
      reviews: { needsCheck: 1, checked: 0 }, taxPayments: { count: 2, paidTotal: 320000, unpaidTotal: 18300, withEvidenceFile: 1 },
      cashReceipts: null } });
  expect(preview.preview.sales.total).toBe(9000);
  expect(preview.preview.expenses.total).toBe(5500);

  const created = await ok('POST', '/tax-exports', { from: day, to: day, expectedSourceRevision: preview.sourceRevision });
  expect(created).toMatchObject({ from: day, to: day, preview: preview.preview, sourceRevision: preview.sourceRevision,
    verification: { status: 'verified' }, affectedSources: ['pos.tax-exports'] });
  const csvFile = await ok('GET', `/tax-exports/${created.exportId}/file?format=csv`);
  const csv = Buffer.from(csvFile.contentBase64, 'base64');
  expect(csvFile).toMatchObject({ format: 'csv', filename: `navis-tax-${day}_${day}.csv`, contentType: 'text/csv; charset=utf-8',
    size: csv.length, sha256: created.files.csv.sha256 });
  expect(createHash('sha256').update(csv).digest('hex')).toBe(created.files.csv.sha256);
  const [header, ...lines] = parseCsv(csv.subarray(3).toString('utf8'));
  expect(header[0]).toBe('구분');
  const sum = (kind: string) => lines.filter(line => line[0] === kind).reduce((total, line) => total + Number(line[4]), 0);
  expect(sum('매출')).toBe(preview.preview.sales.total);
  expect(sum('입금')).toBe(preview.preview.deposits.total);
  expect(sum('지출')).toBe(preview.preview.expenses.total);
  expect(lines.filter(line => line[0] === '지출').map(line => [line[2], line[4], line[5], line[8]])).toEqual(expect.arrayContaining([
    ['운영비', '2500', '증빙 없음', '영수증 분실'], ['소모품', '3000', '카드 내역', ''],
  ]));
  expect(lines.find(line => line[0] === '세금 납부')).toEqual(['세금 납부', day, '지방소득세', '납부 전', '18300', '증빙 파일 없음', '0', '', '',
    due.taxPaymentId]);
  const xlsxFile = await ok('GET', `/tax-exports/${created.exportId}/file?format=xlsx`);
  const xlsx = Buffer.from(xlsxFile.contentBase64, 'base64');
  expect(xlsx.subarray(0, 2).toString()).toBe('PK');
  expect(createHash('sha256').update(xlsx).digest('hex')).toBe(created.files.xlsx.sha256);
  expect(await reason('GET', `/tax-exports/${created.exportId}/file?format=pdf`)).toBe('INVALID_FORMAT');

  expect((await ok('GET', '/tax-exports')).items).toMatchObject([{ exportId: created.exportId, rowCount: lines.length,
    preview: preview.preview }]);
  expect(await ok('GET', `/tax-exports/${created.exportId}`)).toMatchObject({ exportId: created.exportId, from: day,
    files: { csv: { sha256: created.files.csv.sha256 } } });
  expect((await call('GET', `/tax-exports/${created.exportId}`, undefined, undefined, otherStore)).statusCode).toBe(404);

  await ok('POST', '/expenses', { date: day, category: 'rent', amount: 100000, evidence: 'tax-invoice' });
  const changed = await call('POST', '/tax-exports', { from: day, to: day, expectedSourceRevision: preview.sourceRevision });
  expect(changed.statusCode).toBe(409);
  expect(changed.json()).toMatchObject({ reason: 'TAX_EXPORT_PREVIEW_CHANGED', details: { preview: { expenses: { total: 105500 } } } });
  expect(await reason('POST', '/tax-exports', { from: day, to: '2026-11-16' })).toBe('INVALID_PERIOD');
  expect(await reason('POST', '/tax-exports', { from: '2025-11-16', to: day })).toBe('INVALID_PERIOD');
  expect((await ok('GET', '/tax-exports/preview?from=2025-11-17&to=2026-11-17')).verification.status).toBe('verified');
  expect(await reason('GET', `/tax-exports/preview?${period}&format=csv`)).toBe('INVALID_REQUEST');
});

it('archives both tax files on owner creation and downloads verified bytes within the same store', async () => {
  const archived = Fastify();
  const objects = new Map<string, Buffer>();
  const writes: string[] = [];
  const reads: string[] = [];
  let failWorkbook = true;
  registerTaxRoutes(ownerFor(archived), { objectStorage: {
    async put(key: string, bytes: Buffer) {
      writes.push(key);
      if (failWorkbook && key.endsWith('.xlsx')) throw new Error('storage unavailable');
      objects.set(key, bytes);
    },
    async get(key: string) {
      reads.push(key);
      const bytes = objects.get(key);
      return bytes && { body: Readable.from([bytes]), contentLength: bytes.length, contentType: null };
    },
  } });
  const send = (method: 'GET' | 'POST', path: string, payload?: object, key = randomUUID(), store = otherStore) =>
    archived.inject({ method, url: `/pos/${store}${path}`, payload, headers: { 'idempotency-key': key } });
  const period = { from: day, to: day };
  const commandKey = randomUUID();
  try {
    const legacy = await ok('POST', '/tax-exports', period, undefined, otherStore);
    const legacyPath = `/tax-exports/${legacy.exportId}/file`;
    const oldFile = await send('GET', legacyPath);
    expect(oldFile.statusCode).toBe(200);
    expect(oldFile.json().sha256).toBe(legacy.files.csv.sha256);
    expect(reads).toEqual([]);

    const failed = await send('POST', '/tax-exports', period, commandKey);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().reason).toBe('TAX_EXPORT_STORAGE_UNAVAILABLE');
    expect((await send('GET', '/tax-exports')).json().items.map((row: { exportId: string }) => row.exportId)).toEqual([legacy.exportId]);

    failWorkbook = false;
    const created = await send('POST', '/tax-exports', period, commandKey);
    expect(created.statusCode).toBe(200);
    const receipt = created.json();
    const csvPath = `/tax-exports/${receipt.exportId}/file?format=csv`;
    const workbookPath = `/tax-exports/${receipt.exportId}/file?format=xlsx`;
    const keys = writes.slice(-2);
    expect(keys).toEqual([
      expect.stringMatching(new RegExp(`^stores/${otherStore}/documents/tax/.+\\.csv$`)),
      expect.stringMatching(new RegExp(`^stores/${otherStore}/documents/tax/.+\\.xlsx$`)),
    ]);
    const writeCount = writes.length;
    expect((await send('POST', '/tax-exports', period, commandKey)).json()).toEqual(receipt);
    expect(writes).toHaveLength(writeCount);

    expect((await send('GET', csvPath, undefined, undefined, storeId)).statusCode).toBe(404);
    expect(reads).toEqual([]);
    for (const [index, path] of [csvPath, workbookPath].entries()) {
      const file = await send('GET', path);
      expect(file.statusCode).toBe(200);
      expect(Buffer.from(file.json().contentBase64, 'base64')).toEqual(objects.get(keys[index]));
    }
    expect(reads).toEqual(keys);
    expect((await ok('GET', csvPath, undefined, undefined, otherStore)).sha256).toBe(receipt.files.csv.sha256);

    objects.set(keys[0], Buffer.alloc(objects.get(keys[0])!.length));
    expect((await send('GET', csvPath)).json().reason).toBe('TAX_EXPORT_INTEGRITY');
    objects.delete(keys[1]);
    expect((await send('GET', workbookPath)).json().reason).toBe('TAX_EXPORT_STORAGE_UNAVAILABLE');
  } finally {
    await archived.close();
  }
});

it('verifies tax evidence outside the store lock and rejects an intervening tax revision', async () => {
  const payment = await ok('POST', '/tax-payments', { taxType: '사전 확인', amount: 16100, dueOn: '2026-12-20' });
  const fileId = randomUUID();
  let lockAvailable: boolean | undefined;
  let verificationCalls = 0;
  const owner = createPosApp(runtime, { gatewayToken: 'test-owner', operating: true, logging: false, now: () => at,
    async verifyTaxEvidence() {
      verificationCalls++;
      lockAvailable = await withStoreTransaction(runtime, storeId, async db => {
        const { rows: [row] } = await db.query<{ available: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtextextended('pos:' || $1, 0)) AS available", [storeId]);
        return row.available;
      });
      if (lockAvailable) await ok('PATCH', `/tax-payments/${payment.resourceId}`, { amount: 16200, expectedRevision: payment.revision });
      return { fileId, contentType: 'application/pdf', size: 2048, sha256: 'e'.repeat(64) };
    },
  });
  const headers = { authorization: 'Bearer test-owner', 'x-navis-store-id': storeId, 'x-navis-user-id': actorId,
    'x-navis-store-role': 'owner', 'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00', 'idempotency-key': randomUUID() };
  try {
    const result = await owner.inject({ method: 'POST', url: `/internal/v1/pos/stores/${storeId}/tax-payments/${payment.resourceId}/evidence`,
      headers, payload: { fileId, expectedRevision: payment.revision } });
    expect(lockAvailable).toBe(true);
    expect(verificationCalls).toBe(1);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().reason).toBe('STALE_REVISION');
    expect((await ok('GET', `/tax-payments/${payment.resourceId}`)).evidenceFiles).toEqual([]);
  } finally {
    await owner.close();
  }
});
