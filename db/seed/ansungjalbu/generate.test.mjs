import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, createDecipheriv } from 'node:crypto';
import { generate, verifyConsistency, businessDateAt } from './generate.mjs';

const content = JSON.parse(await readFile(new URL('./fixtures/content.sample.json', import.meta.url), 'utf8'));
const options = { end: '2026-11-17', days: 7, seed: 42 };
const sum = (rows, field) => rows.reduce((n, row) => n + row[field], 0);

// Catches clock/random/path dependent artifacts and ignored seed arguments.
test('same content/options/seed produce byte-identical artifacts', () => {
  const first = generate(content, options);
  const second = generate(structuredClone(content), options);
  for (const key of ['sql', 'summaryJson', 'summaryMd']) assert.equal(first[key], second[key]);
  assert.notEqual(first.sql, generate(content, { ...options, seed: 43 }).sql);
  assert.ok(first.sql.includes('O\\\'Brien'));
  assert.ok(first.sql.startsWith('-- Fictional'));
  assert.ok(first.sql.endsWith('COMMIT;\n'));
});

// Catches imbalance, missing sales lines, double-counted corrections/receipts,
// absent closings, invalid FKs and unconverted fractional money.
test('sample has balanced ledgers, receipts before consumption, and all checks pass', () => {
  const result = generate(content, options);
  const r = result.rows;
  assert.doesNotThrow(() => verifyConsistency(r, content));
  assert.equal(r.business_day.length, 7);
  assert.equal(r.day_closing.length, 7);
  assert.ok(r.goods_receipt.length > 0);
  assert.ok(r.payment_correction.some(x => x.kind === 'cancel'));
  assert.ok(r.payment_correction.some(x => x.kind === 'refund'));
  assert.ok(r.membership_use.length > 0);
  for (const bill of r.bill) {
    const lines = r.settlement_line.filter(x => x.bill_id === bill.bill_id);
    const gross = lines.reduce((n, x) => n + (x.base_price_at_sale + x.option_price_at_sale) * x.qty, 0);
    assert.equal(sum(r.payment.filter(x => x.bill_id === bill.bill_id), 'amount'),
      gross - sum(r.bill_discount.filter(x => x.origin_bill_id === bill.bill_id), 'amount'));
  }
  const approved = sum(r.payment, 'amount');
  const returned = sum(r.payment_correction, 'amount');
  assert.equal(sum(result.summary.daily, 'netSales'), approved - returned);
  assert.equal(result.summary.daily.length, 7);
  for (const stock of result.summary.stock) assert.ok(stock.closingQtyBase >= 0);
  assert.ok(result.summary.skipped.some(x => x.includes('demand')));
});

// Catches lost v1 stock channels, revision provenance and order/payment ordering.
test('v1 preserves channel stock, closing revision and source-backed business fields', () => {
  const input = structuredClone(content);
  Object.assign(input.store, { area_key: 'fixture-area', lat: 37.4963, lng: 126.9574 });
  input.ingredients[1].track = false;
  input.menu[0].memo = 'Fictional menu memo';
  input.expenses[0].memo = 'Fictional expense memo';
  const { rows: r, sql, summary } = generate(input, options);
  assert.equal(summary.erdVersion, 'v1.1');
  assert.equal(r.store[0].area_key, 'fixture-area');
  assert.equal(r.store[0].lat, 37.4963);
  assert.equal(r.store[0].lng, 126.9574);
  assert.equal(r.menu_item[0].memo, input.menu[0].memo);
  assert.ok(r.expense.some(e => e.memo === input.expenses[0].memo));
  assert.equal(r.inventory_item[1].track_restock, false);
  assert.equal(r.inventory_item[1].low_stock_per_channel, null);
  assert.ok(r.stock_daily_opening.every(s => s.channel === 'store'));
  assert.ok(!Object.hasOwn(r, 'channel_stock'));
  for (const day of r.business_day) {
    assert.equal(day.drawer_memo, null);
    const orders = r.pos_order.filter(o => o.business_day_id === day.business_day_id);
    assert.deepEqual(orders.map(o => o.seq), orders.map(o => o.order_no));
    assert.equal(r.day_closing.find(c => c.business_day_id === day.business_day_id).based_on_revision, day.revision);
  }
  for (const bill of r.bill) {
    const order = r.pos_order.find(o => o.origin_bill_id === bill.bill_id);
    assert.equal(bill.requested_at, order.ordered_at);
    assert.equal(bill.member_link_chosen, bill.member_id !== null);
    assert.equal(order.prepared_at, null); // No preparation-start event in the input model.
    assert.equal(order.memo, null);
    if (bill.reservation_id) {
      assert.equal(bill.reservation_decision, 'accepted');
      assert.equal(bill.reservation_first_order_id, order.order_id);
    }
  }
  for (const payment of r.payment) {
    const order = r.pos_order.find(o => o.origin_bill_id === payment.bill_id);
    assert.equal(payment.seq, order.seq);
    assert.equal(payment.created_by, r.app_user[0].user_id);
  }
  assert.match(sql, /"based_on_revision"/);
  assert.match(sql, /UPDATE "bill" SET "reservation_first_order_id"/);
});

// Catches base quantities being mistaken for order units or rounded unit prices.
test('v1 purchases preserve exact package cost and receipt-to-base conversions', () => {
  const { rows: r } = generate(content, options);
  assert.deepEqual(r.purchase_item.map(p => [p.purchase_unit, p.minimum_qty, p.order_step, p.unit_price]),
    [['kg', 1, 1, 25700], ['pcs', 10, 10, 2100]]);
  for (const receipt of r.goods_receipt) {
    const line = r.purchase_order_line.find(p => p.pol_id === receipt.pol_id);
    const move = r.stock_movement.find(m => m.receipt_id === receipt.receipt_id);
    const expense = r.expense.find(e => e.receipt_id === receipt.receipt_id);
    assert.equal(move.delta_base, receipt.qty * line.base_per_unit);
    assert.equal(expense.amount, receipt.qty * line.unit_price);
    assert.equal(r.purchase_order.find(p => p.po_id === line.po_id).expected_time,
      new Intl.DateTimeFormat('en-GB', { timeZone: content.store.timezone, timeStyle: 'short' }).format(new Date(receipt.received_at)));
  }
  const cans = structuredClone(content);
  Object.assign(cans.ingredients[0], { base_unit: 'mL', purchase_unit: '박스(350mL×24)', purchase_qty_base: 8400, unit_price_krw_per_purchase_unit: 13200 });
  const water = generate(cans, options).rows;
  assert.deepEqual([water.purchase_item[0].purchase_unit, water.purchase_item[0].minimum_qty, water.purchase_item[0].order_step, water.purchase_item[0].unit_price], ['pcs', 24, 24, 550]);
  const line = water.purchase_order_line.find(p => p.item_id === water.inventory_item[0].item_id);
  assert.equal(line.unit_snapshot, 'pcs');
  assert.equal(line.base_per_unit, 350);
  assert.equal(line.qty_ordered % 24, 0);
  const missing = structuredClone(cans);
  missing.ingredients[0].purchase_unit = 'unknown pack';
  assert.throws(() => generate(missing, options), /i-bean.*exact.*unit/);
});

// Catches missing v1.1 conversion defaults, snapshot drift, and drawer timing errors.
test('v1.1 purchase defaults and drawer count times match their source events', () => {
  const cans = structuredClone(content);
  Object.assign(cans.ingredients[0], { base_unit: 'mL', purchase_unit: '박스(350mL×24)', purchase_qty_base: 8400, unit_price_krw_per_purchase_unit: 13200 });
  const { rows, sql } = generate(cans, options);
  assert.equal(rows.store[0].timezone, cans.store.timezone);
  assert.equal(rows.store[0].business_day_start, cans.store.business_day_start);
  assert.equal(rows.purchase_item[0].base_per_unit, 350);
  assert.equal(rows.purchase_item[1].base_per_unit, 1);
  for (const line of rows.purchase_order_line) {
    const item = rows.purchase_item.find(x => x.item_id === line.item_id);
    assert.equal(line.base_per_unit, item.base_per_unit);
    assert.equal(line.unit_snapshot, item.purchase_unit);
  }
  for (const day of rows.business_day) {
    const closing = rows.day_closing.find(x => x.business_day_id === day.business_day_id);
    assert.equal(day.drawer_counted_at, closing.closed_at);
    for (const payment of rows.payment.filter(x => x.business_day_id === day.business_day_id && x.counted_method === 'cash')) {
      assert.ok(day.drawer_counted_at >= payment.paid_at);
    }
  }
  assert.match(sql, /"drawer_counted_at"/);
  assert.match(sql, /"purchase_unit", "base_per_unit"/);
  for (const mutate of [
    r => { r.purchase_order_line[0].base_per_unit++; },
    r => { r.purchase_order_line[0].unit_snapshot = 'wrong'; },
    r => { r.purchase_item[0].base_per_unit = null; },
    r => { r.store[0].timezone = null; },
    r => { r.store[0].business_day_start = null; },
    r => { r.business_day[0].drawer_counted_at = null; },
    r => { r.business_day[0].drawer_counted_at = '2000-01-01T00:00:00.000Z'; },
  ]) {
    const broken = generate(cans, options).rows;
    mutate(broken);
    assert.throws(() => verifyConsistency(broken, cans));
  }
});

// Catches plaintext leaking into renamed bytea fields or unsalted phone hashes.
test('v1 encrypts inquiry bodies and preserves normalized phone search fields', () => {
  const { rows: r, sql } = generate(content, options);
  const digest = value => createHash('sha256').update(value).digest();
  const decrypt = bytes => {
    const cipher = createDecipheriv('aes-256-gcm', digest(`PUBLIC-FIXTURE-KEY:${options.seed}`), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  };
  assert.equal(r.customer[0].phone_last4, '0000');
  assert.equal(r.customer[0].phone_hash, digest(`${r.store[0].store_id}:01000000000`).toString('hex'));
  for (const thread of r.inquiry_thread) {
    assert.ok(Buffer.isBuffer(thread.body_enc));
    assert.equal(Object.hasOwn(thread, 'body'), false);
    assert.equal(thread.is_public, thread.type === 'review');
    assert.equal(thread.sentiment, null);
    assert.equal(decrypt(thread.body_enc), thread.type === 'review' ? content.reviews[0].text : content.inquiries[0].text);
  }
  assert.ok(!sql.includes(content.inquiries[0].text));
  for (const reservation of r.reservation) {
    assert.equal(Object.hasOwn(reservation, 'guest_name'), false);
    assert.equal(reservation.guest_name_enc, null);
    assert.equal(reservation.request_enc, null);
    assert.equal(reservation.capacity_override, false);
    assert.equal(reservation.confirmed_by, 'auto');
  }
});

// Catches refund amounts stored as gross and cancellations losing discount IDs.
test('v1 corrections retain kind-specific values and original discount lineage', () => {
  const { rows: r, summary } = generate(content, options);
  assert.ok(r.correction_discount.length > 0);
  for (const correction of r.payment_correction) {
    assert.equal(correction.target, 'recognized_sale');
    assert.equal(correction.created_by, r.app_user[0].user_id);
    const lines = r.correction_line.filter(l => l.correction_id === correction.correction_id);
    for (const line of lines) {
      if (correction.kind === 'refund') {
        assert.ok(line.amount > 0);
        assert.equal(line.gross, null);
        assert.equal(line.discount, null);
        assert.equal(line.cost, null);
      } else {
        assert.equal(line.amount, null);
        const parts = r.correction_discount.filter(d => d.correction_line_id === line.correction_line_id);
        assert.equal(sum(parts, 'amount'), line.discount);
        for (const part of parts) {
          const original = r.discount_allocation.find(d => d.discount_id === part.discount_id && d.allocation_id === line.allocation_id);
          assert.equal(part.amount, original.amount);
        }
      }
    }
    assert.equal(lines.reduce((n, l) => n + (correction.kind === 'refund' ? l.amount : l.gross - l.discount), 0), correction.amount);
  }
  assert.ok(r.settlement_line.every(l => l.option_cost_at_sale === 0));
  for (const discount of r.bill_discount) {
    assert.equal(Object.hasOwn(discount, 'bill_id'), false);
    const bill = r.bill.find(b => b.bill_id === discount.origin_bill_id);
    assert.equal(discount.contribution_member_id, bill.member_id);
  }
  for (const table of ['demand_forecast', 'cart', 'cart_line', 'payment_part_line']) {
    assert.deepEqual(r[table], []);
    assert.equal(summary.rowCounts[table], 0);
    assert.ok(summary.skipped.some(s => s.includes(table)));
  }
});

// Catches silently dropped recipe references before any file is written.
test('missing recipe ingredient fails with the menu and missing id', () => {
  const broken = structuredClone(content);
  broken.menu[0].recipe[0].ingredient = 'i-missing';
  assert.throws(() => generate(broken, options), /m-coffee.*missing ingredient.*i-missing/);
});

// Catches host-timezone/date-boundary mistakes, including orders after midnight.
test('business dates honor timezone and the configured rollover', () => {
  assert.equal(businessDateAt('2026-11-17T19:59:00Z', content.store), '2026-11-17');
  assert.equal(businessDateAt('2026-11-17T20:00:00Z', content.store), '2026-11-18');
  const overnight = structuredClone(content);
  for (const day of Object.keys(overnight.store.hours)) overnight.store.hours[day] = ['22:00', '02:00'];
  overnight.demand.hourly_profile = { '22': 0.25, '23': 0.25, '00': 0.25, '01': 0.25 };
  const result = generate(overnight, { ...options, days: 2 });
  assert.ok(result.rows.pos_order.some(x => new Date(x.ordered_at).getUTCHours() === 16));
  for (const order of result.rows.pos_order) {
    const day = result.rows.business_day.find(x => x.business_day_id === order.business_day_id);
    assert.equal(businessDateAt(order.ordered_at, overnight.store), day.business_date);
  }
});

test('invalid options and fractional KRW fail clearly', () => {
  assert.throws(() => generate(content, { ...options, end: '2026-02-30' }), /end.*date/);
  assert.throws(() => generate(content, { ...options, days: 0 }), /days/);
  const broken = structuredClone(content);
  broken.menu[0].price = 3700.5;
  assert.throws(() => generate(broken, options), /price.*integer KRW/);
});

// Exercises the actual CLI and its three promised filesystem artifacts.
test('CLI writes only seed.sql, summary.json, summary.md; invalid content writes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ansungjalbu-'));
  try {
    const out = join(root, 'out');
    const script = new URL('./generate.mjs', import.meta.url);
    const sample = new URL('./fixtures/content.sample.json', import.meta.url);
    const { fileURLToPath } = await import('node:url');
    const run = spawnSync(process.execPath, [fileURLToPath(script), '--content', fileURLToPath(sample), '--end', options.end, '--days', '7', '--seed', '42', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual((await readdir(out)).sort(), ['seed.sql', 'summary.json', 'summary.md']);
    const expected = generate(content, options);
    assert.equal(await readFile(join(out, 'seed.sql'), 'utf8'), expected.sql);
    assert.equal(await readFile(join(out, 'summary.json'), 'utf8'), expected.summaryJson);
    assert.equal(await readFile(join(out, 'summary.md'), 'utf8'), expected.summaryMd);
    const broken = structuredClone(content);
    broken.menu[0].recipe[0].ingredient = 'i-missing';
    const badContent = join(root, 'broken.json');
    await writeFile(badContent, JSON.stringify(broken));
    const failedOut = join(root, 'failed-out');
    const failed = spawnSync(process.execPath, [fileURLToPath(script), '--content', badContent, '--out', failedOut], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /m-coffee.*missing ingredient.*i-missing/);
    assert.equal((await readdir(root)).includes('failed-out'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
