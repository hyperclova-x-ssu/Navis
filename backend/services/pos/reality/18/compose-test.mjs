// B18 compose proof: owner HTTP through api-gateway → POS/Account/Customer → their own PostgreSQL, re-read in a new session.
// Run inside the Compose network with access to `api-gateway` and `db` (see README "Local proof").
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { dbPool } from '../../../../packages/db/index.ts';
import { provisionOwner } from '../../../account/reality/00/provision.ts';
import { withStoreTransaction } from '../../transaction.ts';

const origin = process.env.NAVIS_B18_ORIGIN ?? 'http://127.0.0.1:18180';
const gateway = process.env.NAVIS_B18_GATEWAY ?? 'http://api-gateway:3000';
const password = randomBytes(24).toString('base64url');
const owner = { loginId: `${randomUUID()}@example.invalid`, storeId: randomUUID() };
const outsider = { loginId: `${randomUUID()}@example.invalid`, storeId: randomUUID() };
const accountDb = dbPool('account', 'migrate');
const posDb = dbPool('pos', 'migrate');
const customerDb = dbPool('customer', 'migrate');
const evidence = { requests: [], ids: {} };
let session = {};

function send(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
    const outgoing = httpRequest(url, { method, headers, signal: AbortSignal.timeout(10_000) }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function call(method, path, status, { body, bytes, type, key, record } = {}) {
  const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin' };
  if (path.startsWith('/api/v1/auth/') && session.cookie) headers.cookie = session.cookie;
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (bytes) headers['content-type'] = type;
  const response = await send(gateway + path, method, headers, bytes ?? (body === undefined ? undefined : JSON.stringify(body)));
  const text = response.body.toString('utf8');
  assert.equal(response.status, status, `${method} ${path} expected ${status}: ${text.slice(0, 300)}`);
  const setCookie = response.headers['set-cookie']?.find(value => value.startsWith('navis_refresh='));
  if (setCookie) session.cookie = setCookie.split(';')[0];
  if (record) evidence.requests.push({ step: record, method, path: path.replace(/\/api\/v1\/stores\/[0-9a-f-]+/, '/api/v1/stores/{storeId}'),
    status, requestId: response.headers['x-request-id'] ?? null, cacheControl: response.headers['cache-control'] ?? null });
  if (status === 204 || !response.body.length) return undefined;
  return response.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : response.body;
}

async function login(account) {
  session = {};
  session.token = (await call('POST', '/api/v1/auth/login', 200, { body: { loginId: account.loginId, password } })).accessToken;
}

const base = id => `/api/v1/stores/${id}`;
const pos = `${base(owner.storeId)}/pos`;

async function upload(storeId, purpose, bytes, type) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { fileId } = await call('POST', `${base(storeId)}/files`, 200,
    { key: `file:${purpose}:${sha256}`, body: { purpose, contentType: type, size: bytes.length, sha256 }, record: `upload ${purpose}` });
  await call('PUT', `${base(storeId)}/files/${fileId}/content`, 204, { bytes, type });
  await call('POST', `${base(storeId)}/files/${fileId}/complete`, 200, { body: {} });
  return { fileId, sha256 };
}

async function projection(taxPaymentId) {
  const { items } = await call('GET', `${base(owner.storeId)}/calendar/projections?limit=200`, 200);
  return items.find(item => item.source === 'tax-due' && item.sourceId === taxPaymentId) ?? null;
}

async function waitFor(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
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

try {
  for (const [account, name] of [[owner, 'B18 tax store'], [outsider, 'Other store']]) {
    await provisionOwner(accountDb, { loginId: account.loginId, password, ownerName: 'Synthetic owner', storeId: account.storeId,
      storeName: name, businessDayStart: '04:30' });
  }
  await login(owner);
  // The POS operating day (store clock, 04:30 business-day start) is the date a paid record defaults to.
  const today = (await call('GET', `${pos}/ledger`, 200)).from;
  const dueOn = new Date(Date.parse(today) + 12 * 86_400_000).toISOString().slice(0, 10);
  evidence.ids.storeId = owner.storeId;

  // 1. A due item from the owner's notice: create → upload the notice as evidence → attach.
  assert.deepEqual((await call('GET', `${pos}/tax-payments`, 200, { record: 'empty list' })).items, []);
  await call('POST', `${pos}/tax-payments`, 400, { body: { taxType: '부가가치세', amount: 1, dueOn } });
  const created = await call('POST', `${pos}/tax-payments`, 200,
    { key: 'b18-create', body: { taxType: '부가가치세 2기 예정', amount: 412000, dueOn }, record: 'create tax payment' });
  const taxPaymentId = created.taxPaymentId;
  evidence.ids.taxPaymentId = taxPaymentId;
  evidence.ids.createReceiptId = created.receiptId;
  assert.deepEqual(await call('POST', `${pos}/tax-payments`, 200,
    { key: 'b18-create', body: { taxType: '부가가치세 2기 예정', amount: 412000, dueOn } }), created);
  assert.equal((await call('POST', `${pos}/tax-payments`, 409, { key: 'b18-dup',
    body: { taxType: '부가가치세 2기예정', amount: 412000, dueOn } })).reason, 'TAX_PAYMENT_EXISTS');
  await waitFor(async () => (await projection(taxPaymentId))?.date === dueOn, 'calendar tax-due projection');
  evidence.calendarBefore = await projection(taxPaymentId);

  const pdf = Buffer.from(`%PDF-1.4\n% B18 notice ${randomUUID()}\n%%EOF\n`);
  const notice = await upload(owner.storeId, 'tax-evidence', pdf, 'application/pdf');
  evidence.ids.fileId = notice.fileId;
  const receiptPhoto = await upload(owner.storeId, 'receipt-evidence', pdf.subarray(0, pdf.length - 1), 'application/pdf');
  await login(outsider);
  const foreign = await upload(outsider.storeId, 'tax-evidence', Buffer.from(`%PDF-1.4\n% other ${randomUUID()}\n`), 'application/pdf');
  assert.equal((await call('GET', `${pos}/tax-payments`, 403)).code, 'STORE_FORBIDDEN');
  await login(owner);
  for (const fileId of [foreign.fileId, receiptPhoto.fileId]) {
    assert.equal((await call('POST', `${pos}/tax-payments/${taxPaymentId}/evidence`, 404,
      { key: `b18-bad-${fileId}`, body: { fileId, expectedRevision: 1 } })).reason, 'EVIDENCE_FILE_NOT_FOUND');
  }
  const attached = await call('POST', `${pos}/tax-payments/${taxPaymentId}/evidence`, 200,
    { key: 'b18-attach', body: { fileId: notice.fileId, expectedRevision: 1 }, record: 'attach evidence' });
  assert.equal(attached.payment.evidence, 'attached');
  assert.equal(attached.payment.evidenceFiles[0].sha256, notice.sha256);
  assert.equal((await call('POST', `${pos}/tax-payments/${taxPaymentId}/paid`, 409,
    { key: 'b18-stale', body: { expectedRevision: 1 } })).reason, 'STALE_REVISION');
  assert.equal((await call('POST', `${pos}/tax-payments/${taxPaymentId}/paid`, 400, { body: { expectedRevision: 2 } })).reason,
    'IDEMPOTENCY_KEY_REQUIRED');

  // 2. Record the payment the owner made at Hometax. The calendar entry is withdrawn.
  const paid = await call('POST', `${pos}/tax-payments/${taxPaymentId}/paid`, 200,
    { key: 'b18-paid', body: { expectedRevision: 2 }, record: 'mark paid' });
  evidence.ids.paidReceiptId = paid.receiptId;
  assert.equal(paid.payment.status, 'paid');
  assert.equal(paid.payment.paidOn, today);
  await waitFor(async () => (await projection(taxPaymentId)) === null, 'calendar projection withdrawal');

  // 3. New session: the same payment, date and file are re-read from the services.
  await call('POST', '/api/v1/auth/logout', 204);
  await login(owner);
  const reread = await call('GET', `${pos}/tax-payments/${taxPaymentId}`, 200, { record: 're-read after new session' });
  assert.equal(reread.status, 'paid');
  assert.equal(reread.paidOn, today);
  assert.equal(reread.dueOn, dueOn);
  assert.equal(reread.revision, 3);
  assert.deepEqual(reread.evidenceFiles.map(file => file.fileId), [notice.fileId]);
  const listed = await call('GET', `${pos}/tax-payments`, 200);
  assert.equal(listed.summary.unpaidCount, 0);
  assert.equal(listed.next, null);
  assert.deepEqual(await call('GET', `${base(owner.storeId)}/files/${notice.fileId}/content`, 200), pdf);
  evidence.reread = { status: reread.status, paidOn: reread.paidOn, dueOn: reread.dueOn, revision: reread.revision,
    evidenceFileIds: reread.evidenceFiles.map(file => file.fileId) };

  // 4. Review check with receipt undo, then a verified export that matches its preview.
  const menu = await call('POST', `${base(owner.storeId)}/inventory/menu`, 201,
    { key: 'b18-menu', body: { name: '아메리카노', category: 'drink', price: 4500 } });
  const bill = await call('POST', `${pos}/bills`, 200, { key: 'b18-bill', body: { type: 'takeout', lines: [{ menuId: menu.resourceId, qty: 2 }] } });
  await call('POST', `${pos}/bills/${bill.resourceId}/payments`, 200,
    { key: 'b18-cash', body: { method: 'cash', amount: bill.quote.payable, quoteRevision: bill.quote.quoteRevision }, record: 'cash sale' });
  const expense = await call('POST', `${pos}/expenses`, 200,
    { key: 'b18-expense', body: { date: today, category: 'supplies', amount: 12000, evidence: 'none', memo: '컵 홀더' } });
  const period = `from=${today}&to=${today}`;
  const reviews = await call('GET', `${pos}/tax-reviews?${period}`, 200, { record: 'review list' });
  assert.equal(reviews.reviewCount, 1);
  const check = await call('POST', `${pos}/tax-reviews/${expense.expenseId}/check`, 200,
    { key: 'b18-check', body: { expenseRevision: 1 }, record: 'mark checked' });
  assert.equal((await call('GET', `${pos}/tax-reviews?${period}`, 200)).reviewCount, 0);
  await call('POST', `${pos}/tax/receipts/${check.receiptId}/undo`, 200, { key: 'b18-undo', body: {}, record: 'undo check' });
  assert.equal((await call('GET', `${pos}/tax-reviews?${period}`, 200)).reviewCount, 1);

  const preview = await call('GET', `${pos}/tax-exports/preview?${period}`, 200, { record: 'export preview' });
  const ledger = await call('GET', `${pos}/ledger?businessDate=${today}`, 200);
  assert.equal(preview.verification.status, 'verified');
  assert.equal(preview.preview.sales.total, ledger.totals.sales.total);
  assert.equal(preview.preview.deposits.total, ledger.totals.deposits.total);
  assert.equal(preview.preview.expenses.total, ledger.totals.expenses);
  assert.equal(preview.officialLinks.hometax, 'https://www.hometax.go.kr/');
  const exported = await call('POST', `${pos}/tax-exports`, 200,
    { key: 'b18-export', body: { from: today, to: today, expectedSourceRevision: preview.sourceRevision }, record: 'create export' });
  evidence.ids.exportId = exported.exportId;
  await call('POST', '/api/v1/auth/logout', 204);
  await login(owner);
  const download = await call('GET', `${pos}/tax-exports/${exported.exportId}/file?format=csv`, 200, { record: 'download csv' });
  const csv = Buffer.from(download.contentBase64, 'base64');
  assert.equal(createHash('sha256').update(csv).digest('hex'), exported.files.csv.sha256);
  const [, ...lines] = parseCsv(csv.subarray(3).toString('utf8'));
  const sum = kind => lines.filter(line => line[0] === kind).reduce((total, line) => total + Number(line[4]), 0);
  assert.equal(sum('매출'), preview.preview.sales.total);
  assert.equal(sum('입금'), preview.preview.deposits.total);
  assert.equal(sum('지출'), preview.preview.expenses.total);
  const xlsx = await call('GET', `${pos}/tax-exports/${exported.exportId}/file?format=xlsx`, 200, { record: 'download xlsx' });
  assert.equal(createHash('sha256').update(Buffer.from(xlsx.contentBase64, 'base64')).digest('hex'), exported.files.xlsx.sha256);
  evidence.export = { preview: preview.preview, verification: preview.verification, rowCount: exported.rowCount,
    csvSha256: exported.files.csv.sha256, csvSums: { sales: sum('매출'), deposits: sum('입금'), expenses: sum('지출') } };

  // 5. Database correlation: the rows, events and projection the HTTP flow produced.
  evidence.db = await withStoreTransaction(posDb, owner.storeId, async db => ({
    taxPayment: (await db.query(`SELECT tax_payment_id, status, paid_on::text, due_on::text, revision, paid_recorded_at IS NOT NULL AS recorded
      FROM pos.tax_payment WHERE store_id = $1`, [owner.storeId])).rows,
    evidence: (await db.query(`SELECT file_id, content_type, size, sha256, detached_at FROM pos.tax_evidence WHERE store_id = $1`,
      [owner.storeId])).rows,
    events: (await db.query(`SELECT store_seq::text, event_id, payload->'calendarProjection' AS projection FROM pos.outbox
      WHERE store_id = $1 AND event_type = 'pos.tax_due_changed.v1' ORDER BY store_seq`, [owner.storeId])).rows,
    exports: (await db.query('SELECT export_id, row_count, csv_sha256 FROM pos.tax_export WHERE store_id = $1', [owner.storeId])).rows,
    review: (await db.query('SELECT expense_id, status, revision FROM pos.tax_review WHERE store_id = $1', [owner.storeId])).rows,
  }));
  assert.equal(evidence.db.taxPayment[0].revision, 3);
  assert.equal(evidence.db.events.length, 3);
  evidence.db.calendarProjection = (await withStoreTransaction(customerDb, owner.storeId, db => db.query(`
    SELECT source, source_id, source_revision, starts_on::text FROM customer.calendar_projection
    WHERE store_id = $1 AND source = 'tax-due'`, [owner.storeId]))).rows;
  assert.deepEqual(evidence.db.calendarProjection.map(row => [row.source_revision, row.starts_on]), [[3, null]]);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await Promise.all([accountDb.end(), posDb.end(), customerDb.end()]);
}
