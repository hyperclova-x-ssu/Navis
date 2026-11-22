#!/usr/bin/env node
import { createHash, createCipheriv } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const hash = value => createHash('sha256').update(value).digest();
const sum = (list, field) => list.reduce((n, r) => n + r[field], 0);
const fail = message => { throw new Error(message); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const integer = (value, name, min = 0) => ensure(Number.isSafeInteger(value) && value >= min, `${name}: expected integer >= ${min}`);
const money = (value, name) => ensure(Number.isSafeInteger(value) && value >= 0 && value <= 999999999999, `${name}: expected nonnegative integer KRW within numeric(12,0)`);
const ratio = (value, name) => ensure(Number.isFinite(value) && value >= 0 && value <= 1, `${name}: expected ratio 0..1`);
const dateOnly = (value, name) => {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, `${name}: invalid ISO date`);
  return value;
};
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const weekday = date => WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()];
function minutes(value) {
  ensure(typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value), `invalid time: ${value}`);
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
const formatters = new Map();
function localParts(instant, timezone) {
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  return Object.fromEntries(formatters.get(timezone).formatToParts(new Date(instant)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
export function businessDateAt(instant, store) {
  const p = localParts(instant, store.timezone);
  const date = `${p.year}-${p.month}-${p.day}`;
  return Number(p.hour) * 60 + Number(p.minute) < minutes(store.business_day_start) ? shiftDate(date, -1) : date;
}
function localInstant(date, minute, timezone) {
  const target = Date.parse(`${date}T00:00:00Z`) + minute * 60000;
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(instant, timezone);
    const observed = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    if (observed === target) return new Date(instant).toISOString();
    instant += target - observed;
  }
  fail(`nonexistent/unsupported local time: ${date} + ${minute} minutes (${timezone})`);
}
function windowFor(date, store) {
  const [open, close] = store.hours[weekday(date)].map(minutes);
  const start = open < minutes(store.business_day_start) ? open + 1440 : open;
  const end = start + ((close - open + 1440) % 1440 || 1440);
  ensure(end <= minutes(store.business_day_start) + 1440, `${date}: hours cross the business_day_start boundary`);
  return { start, end, open: localInstant(date, start, store.timezone), close: localInstant(date, end, store.timezone) };
}
const addSeconds = (at, seconds) => new Date(Date.parse(at) + seconds * 1000).toISOString();
function rngFor(seed) {
  let state = hash(String(seed)).readUInt32LE(0);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function choose(list, weight, random) {
  const total = list.reduce((n, item) => n + weight(item), 0);
  ensure(total > 0, 'weighted selection has no positive weight');
  let point = random() * total;
  for (const item of list) { point -= weight(item); if (point < 0) return item; }
  return list.at(-1);
}
function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) { const k = row[key]; if (!result.has(k)) result.set(k, []); result.get(k).push(row); }
  return result;
}
const indexBy = (rows, key) => new Map(rows.map(r => [r[key], r]));
const fk = (table, column) => [table, column];

// ERD v1.1 mappings: team/backend/ERD.md, including its stated team defaults.
// No DDL is emitted. References to deliberately absent source tables stay NULL.
const SCHEMA = {};
function table(name, pk, fields, refs = {}, krw = [], json = []) {
  const columns = fields.split(' ');
  if (name !== 'app_user') {
    if (!columns.includes('store_id')) columns.push('store_id');
    columns.push('created_at', 'updated_at');
    if (name !== 'store') refs = { store_id: fk('store', 'store_id'), ...refs };
  }
  SCHEMA[name] = { pk: pk.split(' '), columns, refs, krw, json };
}
table('app_user', 'user_id', 'user_id email name last_login_at');
table('store', 'store_id', 'store_id display_name business_type payment_style timezone business_day_start pos_start_tab area_key lat lng settings_revision');
table('store_member', 'store_id user_id', 'store_id user_id role', { user_id: fk('app_user', 'user_id') });
table('store_table_layout', 'layout_id', 'layout_id grid_columns grid_rows revision');
table('store_table', 'table_id', 'table_id layout_id number seats grid_col grid_row', { layout_id: fk('store_table_layout', 'layout_id') });
table('supplier', 'supplier_id', 'supplier_id name contact_name phone_enc memo deleted_at');
table('inventory_item', 'item_id', 'item_id sku name kind base_unit display_unit track_restock restock_threshold low_stock_per_channel track_expiry expires_on deleted_at');
table('purchase_item', 'purchase_item_id', 'purchase_item_id item_id supplier_id purchase_unit base_per_unit minimum_qty order_step unit_price lead_days', { item_id: fk('inventory_item', 'item_id'), supplier_id: fk('supplier', 'supplier_id') }, ['unit_price']);
table('menu_item', 'menu_id', 'menu_id kind name category price prep_min sale_status inventory_item_id photo_file_id memo deleted_at', { inventory_item_id: fk('inventory_item', 'item_id') }, ['price']);
table('menu_option_group', 'group_id', 'group_id menu_id name required sort_order archived_at', { menu_id: fk('menu_item', 'menu_id') });
table('menu_option', 'option_id', 'option_id group_id name extra_price archived_at', { group_id: fk('menu_option_group', 'group_id') }, ['extra_price']);
table('recipe_line', 'menu_id inventory_item_id', 'menu_id inventory_item_id quantity_base', { menu_id: fk('menu_item', 'menu_id'), inventory_item_id: fk('inventory_item', 'item_id') });
table('purchase_order', 'po_id', 'po_id supplier_id ordered_on due_date expected_time status', { supplier_id: fk('supplier', 'supplier_id') });
table('purchase_order_line', 'pol_id', 'pol_id po_id item_id unit_snapshot base_per_unit qty_ordered unit_price item_name_snapshot', { po_id: fk('purchase_order', 'po_id'), item_id: fk('inventory_item', 'item_id') }, ['unit_price']);
table('goods_receipt', 'receipt_id', 'receipt_id pol_id qty received_at idempotency_key', { pol_id: fk('purchase_order_line', 'pol_id') });
table('stock_daily_opening', 'item_id business_date channel', 'item_id business_date channel quantity_base', { item_id: fk('inventory_item', 'item_id') });
table('stock_movement', 'movement_id', 'movement_id item_id kind delta_base channel receipt_id reason at idempotency_key', { item_id: fk('inventory_item', 'item_id'), receipt_id: fk('goods_receipt', 'receipt_id') });
table('demand_forecast', 'forecast_id', 'forecast_id target_date hour band menu_id item_id expected average baseline generated_at source', { menu_id: fk('menu_item', 'menu_id'), item_id: fk('inventory_item', 'item_id') });
table('customer', 'customer_id', 'customer_id name_enc phone_enc phone_hash phone_last4 consent_sms consent_sms_at consent_night opted_out_at deleted_at');
table('member_profile', 'member_id', 'member_id customer_id member_code joined_on grade_override', { customer_id: fk('customer', 'customer_id') });
table('membership_product', 'product_id', 'product_id name kind uses valid_days daily_limit price', {}, ['price']);
table('membership', 'membership_id', 'membership_id customer_id product_id starts_on ends_on uses_left status', { customer_id: fk('customer', 'customer_id'), product_id: fk('membership_product', 'product_id') });
table('membership_use', 'use_id', 'use_id membership_id used_at canceled_at idempotency_key', { membership_id: fk('membership', 'membership_id') });
table('reservation', 'reservation_id', 'reservation_id start_at party_size member_id guest_name_enc guest_phone_enc request_enc table_id assignment_mode capacity_override override_reason source status confirmed_by proposed_at call_id', { member_id: fk('member_profile', 'member_id'), table_id: fk('store_table', 'table_id') });
table('reservation_change', 'change_id', 'change_id reservation_id kind before after at', { reservation_id: fk('reservation', 'reservation_id') }, [], ['before', 'after']);
table('coupon', 'coupon_id', 'coupon_id name benefit_type benefit_value target_menu_id target_option_id starts_on ends_on status origin origin_slot_keys origin_item_id origin_set_price origin_video_id max_discount_rate', { target_menu_id: fk('menu_item', 'menu_id'), target_option_id: fk('menu_option', 'option_id'), origin_item_id: fk('inventory_item', 'item_id') }, ['origin_set_price']);
table('coupon_code', 'code_id', 'code_id coupon_id code route issue_count video_id activated_at', { coupon_id: fk('coupon', 'coupon_id') });
table('business_day', 'business_day_id', 'business_day_id business_date seq revision drawer_opening drawer_actual drawer_counted_at drawer_memo', {}, ['drawer_opening', 'drawer_actual']);
table('cart', 'cart_id', 'cart_id business_day_id status locked_at frozen_quote', { business_day_id: fk('business_day', 'business_day_id') }, [], ['frozen_quote']);
table('cart_line', 'cart_line_id', 'cart_line_id cart_id menu_id qty options request', { cart_id: fk('cart', 'cart_id'), menu_id: fk('menu_item', 'menu_id') }, [], ['options']);
table('bill', 'bill_id', 'bill_id business_day_id table_id status member_id member_link_chosen reservation_id reservation_decision reservation_first_order_id cart_id requested_at settled_at recognized_at', { business_day_id: fk('business_day', 'business_day_id'), table_id: fk('store_table', 'table_id'), member_id: fk('member_profile', 'member_id'), reservation_id: fk('reservation', 'reservation_id'), reservation_first_order_id: fk('pos_order', 'order_id'), cart_id: fk('cart', 'cart_id') });
table('pos_order', 'order_id', 'order_id business_day_id order_no seq type origin_bill_id preparation reservation_id memo ordered_at prepared_at completed_at', { business_day_id: fk('business_day', 'business_day_id'), origin_bill_id: fk('bill', 'bill_id'), reservation_id: fk('reservation', 'reservation_id') });
table('order_line', 'order_line_id', 'order_line_id order_id menu_id name_at_order qty unit_price_at_order canceled_qty request', { order_id: fk('pos_order', 'order_id'), menu_id: fk('menu_item', 'menu_id') }, ['unit_price_at_order']);
table('order_line_option', 'order_line_id option_id', 'order_line_id option_id name extra_price extra_recipe', { order_line_id: fk('order_line', 'order_line_id'), option_id: fk('menu_option', 'option_id') }, ['extra_price'], ['extra_recipe']);
table('bill_allocation', 'allocation_id', 'allocation_id bill_id order_line_id qty', { bill_id: fk('bill', 'bill_id'), order_line_id: fk('order_line', 'order_line_id') });
table('settlement_line', 'allocation_id', 'allocation_id bill_id menu_id qty base_price_at_sale option_price_at_sale unit_cost_at_sale option_cost_at_sale recognized_qty', { allocation_id: fk('bill_allocation', 'allocation_id'), bill_id: fk('bill', 'bill_id'), menu_id: fk('menu_item', 'menu_id') }, ['base_price_at_sale', 'option_price_at_sale', 'unit_cost_at_sale', 'option_cost_at_sale']);
table('bill_discount', 'discount_id', 'discount_id origin_bill_id source scope amount percent coupon_code_id membership_use_id contribution_member_id reason', { origin_bill_id: fk('bill', 'bill_id'), coupon_code_id: fk('coupon_code', 'code_id'), membership_use_id: fk('membership_use', 'use_id'), contribution_member_id: fk('member_profile', 'member_id') }, ['amount']);
table('discount_allocation', 'discount_id allocation_id role', 'discount_id allocation_id role amount', { discount_id: fk('bill_discount', 'discount_id'), allocation_id: fk('bill_allocation', 'allocation_id') }, ['amount']);
table('split_plan', 'plan_id', 'plan_id bill_id kind frozen_quote', { bill_id: fk('bill', 'bill_id') }, [], ['frozen_quote']);
table('payment_part', 'part_id', 'part_id plan_id ordinal amount status', { plan_id: fk('split_plan', 'plan_id') }, ['amount']);
table('payment_part_line', 'part_id allocation_id', 'part_id allocation_id qty', { part_id: fk('payment_part', 'part_id'), allocation_id: fk('bill_allocation', 'allocation_id') });
table('payment', 'payment_id', 'payment_id bill_id part_id business_day_id seq transaction_no approval_no amount counted_method status paid_at recognized_at created_by', { bill_id: fk('bill', 'bill_id'), part_id: fk('payment_part', 'part_id'), business_day_id: fk('business_day', 'business_day_id'), created_by: fk('app_user', 'user_id') }, ['amount']);
table('payment_method_split', 'payment_id method', 'payment_id method amount', { payment_id: fk('payment', 'payment_id') }, ['amount']);
table('payment_correction', 'correction_id', 'correction_id payment_id kind target amount restock_retail reason seq at created_by', { payment_id: fk('payment', 'payment_id'), created_by: fk('app_user', 'user_id') }, ['amount']);
table('correction_method_amount', 'correction_id method', 'correction_id method amount', { correction_id: fk('payment_correction', 'correction_id') }, ['amount']);
table('correction_line', 'correction_line_id', 'correction_line_id correction_id order_line_id allocation_id qty amount gross discount cost', { correction_id: fk('payment_correction', 'correction_id'), order_line_id: fk('order_line', 'order_line_id'), allocation_id: fk('bill_allocation', 'allocation_id') }, ['amount', 'gross', 'discount', 'cost']);
table('correction_discount', 'correction_line_id discount_id', 'correction_line_id discount_id amount', { correction_line_id: fk('correction_line', 'correction_line_id'), discount_id: fk('bill_discount', 'discount_id') }, ['amount']);
table('customer_visit', 'customer_id business_date', 'customer_id business_date first_hour from_pos', { customer_id: fk('customer', 'customer_id') });
table('day_closing', 'closing_id', 'closing_id business_day_id generation status based_on_revision closed_at reopened_at sales_snapshot drawer_snapshot pos_totals_snapshot', { business_day_id: fk('business_day', 'business_day_id') }, [], ['sales_snapshot', 'drawer_snapshot', 'pos_totals_snapshot']);
table('expense', 'expense_id', 'expense_id business_date category amount supplier_id receipt_id evidence evidence_file_id status tax_check memo', { supplier_id: fk('supplier', 'supplier_id'), receipt_id: fk('goods_receipt', 'receipt_id') }, ['amount']);
table('inquiry_thread', 'thread_id', 'thread_id type channel external_id is_public received_at status needs_person_reason body_enc rating sentiment customer_id', { customer_id: fk('customer', 'customer_id') });
table('manual', 'manual_id', 'manual_id section category title cautions is_published');
table('manual_step', 'manual_id step_no', 'manual_id step_no body photo_file_id', { manual_id: fk('manual', 'manual_id') });
table('calendar_event', 'event_id', 'event_id kind category title date time memo closure_kind closure_end_date done_at');

// Full FK declarations even where the source table is deliberately not emitted.
for (const [name, column, target, targetColumn] of [
  ['menu_item', 'photo_file_id', 'file_object', 'file_id'],
  ['reservation', 'call_id', 'call_log', 'call_id'],
  ['coupon', 'origin_video_id', 'promo_video', 'video_id'],
  ['coupon_code', 'video_id', 'promo_video', 'video_id'],
  ['expense', 'evidence_file_id', 'file_object', 'file_id'],
  ['manual_step', 'photo_file_id', 'file_object', 'file_id'],
]) SCHEMA[name].refs[column] = fk(target, targetColumn);

const REQUIRED_V1 = {
  store: ['timezone', 'business_day_start'],
  inventory_item: ['track_restock'], purchase_item: ['purchase_unit', 'base_per_unit'],
  purchase_order_line: ['unit_snapshot', 'base_per_unit'], stock_daily_opening: ['channel'],
  pos_order: ['seq'], bill: ['member_link_chosen'], payment: ['seq', 'created_by'],
  payment_correction: ['target', 'created_by'], day_closing: ['based_on_revision'],
  customer: ['phone_last4'], reservation: ['capacity_override'], inquiry_thread: ['body_enc', 'is_public'],
};

const SKIPPED = [
  'demand_forecast: v1 has a source table but this generator models no forecast events or provider output; demand remains a simulation input.',
  'option_recipe_line: content에 옵션별 추가/대체 레시피 없음. 유료 옵션은 목록만 만들고 판매 선택에서 제외(M02/M05).',
  'channel_stock: removed in ERD v1; stock uses channel openings + movements - recognized recipe consumption.',
  'cart / cart_line / split_plan / payment_part / payment_part_line / table_transfer_*: no persisted carts, split payments or table transfers modeled; one order = one bill = at most one payment.',
  'cash_receipt / cash_movement / tax_payment / grant_*: content에 발행 식별자·입출금·세금·지원공고 원본 없음.',
  'staff / shift: 직원 기능은 현재 제외 범위(D-243/N02). 인건비는 expense로만 반영.',
  'camera / table_zone* / people_count_bucket / table_occupancy_bucket / table_position_check*: v1 version keys are defined, but no observation events exist in content.',
  'area_event / foot_traffic / trend_keyword / partnership_*: no administrative area code, coordinates or external source events in default content; local_events stay fictional calendar events.',
  'promo_* / music_track / file_object / message_send / coupon_target / coupon_reminder / inquiry_reply: no source files, sends or replies; no music_track_id is emitted (v1 type is varchar).',
  'dashboard_* / widget / user_* / store_onboarding / store_integration / table_session / command_ledger: 화면·명령 상태 저장 정책 또는 입력 없음.',
  'assistant_* / ai_usage / checklist_log / manual_draft / member_note / reservation call_log: 대화 저장 미승인 또는 실행/완료 원본 없음(N02).',
  'Coupon attribution / repeat-visit rates / K07/K17 cohorts / membership sales: no source events or agreed metric definitions; manual coupons have empty origin_slot_keys and NULL source references.',
  'Optional source gaps: store.area_key/lat/lng, preparation-start timestamps, memos, reservation requests/proposals, inquiry sentiment and calendar closures are not invented when absent.',
];

// All prices are exact integer KRW per ERD order unit; package labels remain in
// content. Owner-approved cans use pcs with mL per can on each order line.
function purchaseTerms(item) {
  const perBase = { g: { g: 1, kg: 1000 }, mL: { mL: 1, L: 1000 }, pcs: { pcs: 1 } }[item.base_unit];
  let unit = Object.hasOwn(perBase ?? {}, item.purchase_unit) ? item.purchase_unit : null;
  const labelUnit = item.purchase_unit?.match(/\(\d+(?:\.\d+)?(g|kg|mL|L)\)$/)?.[1];
  if (!unit && labelUnit && Object.hasOwn(perBase, labelUnit)) unit = labelUnit;
  const exact = (unit, basePerUnit) => {
    const packQty = item.purchase_qty_base / basePerUnit;
    const unitPrice = item.unit_price_krw_per_purchase_unit / packQty;
    return Number.isSafeInteger(packQty) && packQty > 0 && Number.isSafeInteger(unitPrice)
      ? { unit, basePerUnit, packQty, unitPrice } : null;
  };
  const terms = (unit && exact(unit, perBase[unit])) || exact(item.base_unit, 1);
  if (terms) return terms;
  const pieces = item.purchase_unit?.match(/\((\d+)(g|mL)×(\d+)\)$/);
  if (pieces && pieces[2] === item.base_unit && +pieces[1] * +pieces[3] === item.purchase_qty_base) {
    const cans = exact('pcs', +pieces[1]);
    if (cans) return cans;
  }
  fail(`${item.id}: no exact integer price/order unit conversion; source unit definition required`);
}

function validateContent(c) {
  ensure(c && c.store && c.demand && c.customers, 'content: store, demand, customers required');
  const text = (v, name) => ensure(typeof v === 'string' && v.length > 0 && !v.includes('\0'), `${name}: nonempty text required (no NUL)`);
  text(c.store.name, 'store.name');
  if (c.store.area_key != null) text(c.store.area_key, 'store.area_key');
  for (const [key, limit] of [['lat', 90], ['lng', 180]]) if (c.store[key] != null) ensure(Number.isFinite(c.store[key]) && Math.abs(c.store[key]) <= limit, `store.${key}: invalid coordinate`);
  ensure(['prepaid', 'postpaid'].includes(c.store.payment_style), 'store.payment_style invalid');
  ensure(['cafe', 'restaurant', 'pub', 'beauty', 'retail', 'academy', 'fitness', 'other'].includes(c.store.business_type), 'store.business_type invalid');
  localParts('2026-01-01T00:00:00Z', c.store.timezone);
  minutes(c.store.business_day_start);
  for (const day of WEEK) {
    ensure(Array.isArray(c.store.hours?.[day]) && c.store.hours[day].length === 2, `store.hours.${day}: [open,close] required`);
    c.store.hours[day].forEach(minutes);
  }
  for (const key of ['menu', 'ingredients', 'suppliers', 'memberships', 'coupons', 'expenses', 'reviews', 'inquiries', 'manuals', 'calendar', 'local_events']) ensure(Array.isArray(c[key]), `${key}: array required`);
  function ids(rows, label) {
    const seen = new Set();
    for (const row of rows) { ensure(typeof row.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id) && !seen.has(row.id), `${label}: duplicate or invalid slug ${row.id}`); seen.add(row.id); text(row.name, `${label}.${row.id}.name`); }
    return seen;
  }
  const suppliers = ids(c.suppliers, 'suppliers');
  const ingredients = ids(c.ingredients, 'ingredients');
  const menus = ids(c.menu, 'menu');
  ensure(c.menu.length > 0 && c.ingredients.length > 0 && c.suppliers.length > 0, 'menu, ingredients and suppliers cannot be empty');
  for (const s of c.suppliers) {
    integer(s.lead_days, `${s.id}.lead_days`);
    money(s.min_order_krw, `${s.id}.min_order_krw`);
    ensure(Array.isArray(s.order_weekdays) && s.order_weekdays.length > 0 && s.order_weekdays.every(d => WEEK.includes(d)), `${s.id}.order_weekdays invalid`);
  }
  for (const i of c.ingredients) {
    ensure(suppliers.has(i.supplier), `${i.id}: missing supplier ${i.supplier}`);
    ensure(['g', 'mL', 'pcs'].includes(i.base_unit), `${i.id}.base_unit invalid`);
    integer(i.purchase_qty_base, `${i.id}.purchase_qty_base`, 1);
    money(i.unit_price_krw_per_purchase_unit, `${i.id}.unit_price_krw_per_purchase_unit`);
    integer(i.opening_qty_base, `${i.id}.opening_qty_base`);
    integer(i.reorder_threshold_base, `${i.id}.reorder_threshold_base`);
    ensure(typeof i.track === 'boolean', `${i.id}.track: boolean required`);
    purchaseTerms(i);
  }
  for (const m of c.menu) {
    money(m.price, `${m.id}.price`);
    ensure(Number.isFinite(m.popularity) && m.popularity >= 0, `${m.id}.popularity invalid`);
    if (m.active_from !== null) dateOnly(m.active_from, `${m.id}.active_from`);
    ensure(Array.isArray(m.recipe) && m.recipe.length > 0, `${m.id}.recipe required`);
    const recipeIds = new Set();
    for (const r of m.recipe) {
      ensure(ingredients.has(r.ingredient), `${m.id}: missing ingredient ${r.ingredient}`);
      ensure(!recipeIds.has(r.ingredient), `${m.id}: duplicate ingredient ${r.ingredient}`); recipeIds.add(r.ingredient);
      integer(r.qty_base, `${m.id}.${r.ingredient}.qty_base`, 1);
    }
    ensure(Array.isArray(m.options), `${m.id}.options: array required`);
    for (const g of m.options) {
      text(g.group, `${m.id}.option group`);
      ensure(typeof g.required === 'boolean' && Array.isArray(g.items) && g.items.length > 0, `${m.id}.${g.group}: invalid options`);
      for (const o of g.items) { text(o.name, `${m.id}.option name`); money(o.price_delta, `${m.id}.${o.name}.price_delta`); }
      ensure(!g.required || g.items.some(o => o.price_delta === 0), `${m.id}.${g.group}: required options need a zero-price choice without missing option recipes`);
    }
  }
  ensure(Array.isArray(c.store.tables) && c.store.tables.length > 0 && c.store.tables.length <= 20, 'store.tables: 1..20 required');
  const numbers = new Set();
  for (const t of c.store.tables) { integer(t.number, 'table.number', 1); integer(t.seats, 'table.seats', 1); ensure(t.seats <= 12 && !numbers.has(t.number), 'table seats/duplicate number invalid'); numbers.add(t.number); }
  const d = c.demand;
  integer(d.base_orders_weekday, 'base_orders_weekday'); integer(d.base_orders_weekend, 'base_orders_weekend');
  for (const key of ['hourly_profile', 'weekday_multipliers', 'payment_mix', 'items_per_order']) ensure(d[key] && typeof d[key] === 'object', `demand.${key} required`);
  for (const day of WEEK) ensure(Number.isFinite(d.weekday_multipliers[day]) && d.weekday_multipliers[day] >= 0, `weekday_multipliers.${day} invalid`);
  for (const key of ['hourly_profile', 'payment_mix', 'items_per_order']) {
    for (const [label, value] of Object.entries(d[key])) ensure(Number.isFinite(value) && value >= 0, `${key}.${label}: nonnegative finite weight required`);
    ensure(Object.values(d[key]).some(v => v > 0), `${key}: positive weight required`);
  }
  ensure(Object.keys(d.hourly_profile).every(k => /^\d{2}$/.test(k) && +k < 24), 'hourly_profile keys: 00..23 required');
  ensure(Object.keys(d.payment_mix).every(k => ['card', 'easy_pay', 'cash'].includes(k)), 'payment_mix: unsupported method');
  ensure(Object.keys(d.items_per_order).every(k => /^\d+$/.test(k) && +k >= 1 && +k <= 99), 'items_per_order keys: 1..99 required');
  for (const key of ['takeout_ratio', 'refund_rate', 'cancel_rate', 'discount_rate_member']) ratio(d[key], key);
  ensure(d.refund_rate + d.cancel_rate <= 1, 'refund_rate + cancel_rate must be <= 1');
  ensure(Array.isArray(d.academic_calendar), 'academic_calendar required');
  for (const a of d.academic_calendar) { dateOnly(a.start, 'academic start'); dateOnly(a.end, 'academic end'); ensure(a.start <= a.end && Number.isFinite(a.multiplier) && a.multiplier >= 0, 'academic interval/multiplier invalid'); }
  integer(c.customers.members, 'customers.members'); ensure(c.customers.members <= 10000, 'customers.members: maximum 10000 fictional phone numbers');
  ratio(c.customers.walkin_member_ratio, 'walkin_member_ratio');
  ensure(Array.isArray(c.customers.segments) && c.customers.segments.length > 0, 'customers.segments required');
  for (const s of c.customers.segments) { text(s.name, 'segment name'); ratio(s.share, 'segment share'); integer(s.visits_per_month, 'segment visits_per_month', 1); ensure(Array.isArray(s.favorite) && s.favorite.every(id => menus.has(id)), `segment ${s.name}: missing favorite menu`); }
  ensure(c.customers.segments.some(s => s.share > 0), 'segment share has no positive weight');
  for (const p of c.memberships) { text(p.name, 'membership name'); money(p.price, 'membership.price'); integer(p.uses, 'membership.uses', 1); ensure(menus.has(p.menu), `membership: missing menu ${p.menu}`); }
  for (const p of c.coupons) { text(p.name, 'coupon name'); ensure(['percent', 'amount'].includes(p.type), 'coupon.type: percent or amount required'); money(p.value, 'coupon.value'); ensure(p.type !== 'percent' || p.value <= 100, 'coupon percent exceeds 100'); dateOnly(p.start, 'coupon.start'); dateOnly(p.end, 'coupon.end'); ensure(p.start <= p.end, 'coupon start exceeds end'); }
  for (const e of c.expenses) { money(e.amount, 'expense.amount'); ensure(/^monthly:(?:[1-9]|[12]\d|3[01])$/.test(e.schedule), 'expense.schedule: monthly:1..31 required'); }
  for (const r of c.reviews) { integer(r.rating, 'review.rating', 1); ensure(r.rating <= 5, 'review.rating exceeds 5'); integer(r.days_ago, 'review.days_ago'); text(r.text, 'review.text'); }
  for (const i of c.inquiries) {
    ensure(['waiting', 'draft-ready', 'send-failed', 'done'].includes(i.status), 'inquiry.status invalid');
    if (i.received_time != null) ensure(/^([01]\d|2[0-3]):[0-5]\d$/.test(i.received_time), 'inquiry.received_time invalid');
    text(i.text, 'inquiry.text');
  }
  for (const item of [...c.reviews, ...c.inquiries]) if (item.sentiment != null) ensure(['positive', 'negative', 'neutral'].includes(item.sentiment), 'sentiment invalid');
  for (const item of [...c.menu, ...c.expenses]) if (item.memo != null) text(item.memo, 'memo');
  for (const m of c.manuals) { text(m.title, 'manual.title'); ensure(Array.isArray(m.steps) && m.steps.length > 0, 'manual.steps required'); m.steps.forEach(s => text(s, 'manual step')); }
  for (const e of c.calendar) {
    dateOnly(e.date, 'calendar.date');
    if (e.closure_kind != null) ensure(['regular', 'temporary'].includes(e.closure_kind), 'calendar.closure_kind invalid');
    if (e.closure_end_date != null) { dateOnly(e.closure_end_date, 'calendar.closure_end_date'); ensure(e.closure_kind != null && e.closure_end_date >= e.date, 'calendar closure range invalid'); }
  }
  for (const e of c.local_events) { dateOnly(e.start, 'local event start'); dateOnly(e.end, 'local event end'); ensure(e.start <= e.end, 'local event start exceeds end'); }
  // PostgreSQL text cannot contain NUL, including JSON string leaves.
  ensure(!JSON.stringify(c).includes('\\u0000'), 'content: NUL text is not supported');
}

function allocate(amount, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!amount) return weights.map(() => 0);
  ensure(total >= amount, 'discount/refund exceeds available line total');
  const values = weights.map(w => Math.floor(amount * w / total));
  const order = weights.map((w, i) => ({ i, remainder: (amount * w) % total })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let left = amount - values.reduce((a, b) => a + b, 0), i = 0; i < left; i++) values[order[i].i]++;
  return values;
}

export function generate(content, supplied = {}) {
  const config = { end: '2026-11-17', days: 90, seed: 42, ...supplied };
  dateOnly(config.end, 'end'); integer(config.days, 'days', 1); ensure(config.days <= 3660, 'days: maximum 3660');
  integer(config.seed, 'seed'); validateContent(content);
  const c = content, d = c.demand;
  const start = shiftDate(config.end, 1 - config.days);
  const dates = Array.from({ length: config.days }, (_, i) => shiftDate(start, i));
  const random = rngFor(config.seed);
  const id = key => {
    const h = hash(`ansungjalbu:v1:${config.seed}:${key}`).subarray(0, 16);
    h[6] = (h[6] & 15) | 0x50; h[8] = (h[8] & 63) | 0x80;
    const s = h.toString('hex'); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  };
  // Public, seed-derived fixture encryption, never a credential or a production key.
  const encrypt = (text, key) => {
    const cipher = createCipheriv('aes-256-gcm', hash(`PUBLIC-FIXTURE-KEY:${config.seed}`), hash(`iv:${config.seed}:${key}`).subarray(0, 12));
    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([hash(`iv:${config.seed}:${key}`).subarray(0, 12), cipher.getAuthTag(), ciphertext]);
  };
  const rows = Object.fromEntries(Object.keys(SCHEMA).map(t => [t, []]));
  const storeId = id('store');
  const firstAt = localInstant(start, minutes(c.store.business_day_start), c.store.timezone);
  const add = (name, row, at = firstAt) => {
    const full = name === 'app_user' ? row : { ...row, store_id: storeId, created_at: at, updated_at: at };
    for (const column of SCHEMA[name].columns) if (!(column in full)) full[column] = null;
    rows[name].push(full); return full;
  };
  add('app_user', { user_id: id('owner'), email: `fixture-${id('owner')}@example.invalid`, name: '가상 사장님', last_login_at: null });
  add('store', { store_id: storeId, display_name: c.store.name, business_type: c.store.business_type, payment_style: c.store.payment_style, timezone: c.store.timezone, business_day_start: c.store.business_day_start, pos_start_tab: c.store.payment_style === 'prepaid' ? 'order' : 'tables', area_key: c.store.area_key ?? null, lat: c.store.lat ?? null, lng: c.store.lng ?? null, settings_revision: 1 });
  add('store_member', { user_id: id('owner'), role: 'owner' });
  add('store_table_layout', { layout_id: id('layout'), grid_columns: 9, grid_rows: 6, revision: 1 });
  c.store.tables.forEach((t, i) => add('store_table', { table_id: id(`table:${t.number}`), layout_id: id('layout'), number: t.number, seats: t.seats, grid_col: (i % 7) + 1, grid_row: Math.floor(i / 7) * 2 + 1 }));
  const supplierBySlug = new Map(c.suppliers.map(s => [s.id, s]));
  const ingredientBySlug = new Map(c.ingredients.map(i => [i.id, i]));
  for (const [n, s] of c.suppliers.entries()) {
    const contact = s.test_contact;
    add('supplier', { supplier_id: id(`supplier:${s.id}`), name: s.name,
      contact_name: contact?.email ?? `가상 담당자 ${n + 1}`,
      phone_enc: encrypt(contact?.phone ?? `02-0000-${String(n).padStart(4, '0')}`, `supplier:${s.id}`),
      memo: contact ? `${contact.name} · 시험용 연락처` : '가상 거래처; 실제 연락/발주 금지' });
  }
  for (const [n, i] of c.ingredients.entries()) {
    const terms = purchaseTerms(i);
    add('inventory_item', { item_id: id(`item:${i.id}`), sku: `RM-${String(n + 1).padStart(3, '0')}`, name: i.name, kind: 'ingredient', base_unit: i.base_unit, display_unit: ['g', 'kg', 'mL', 'L', 'pcs'].includes(i.purchase_unit) ? i.purchase_unit : i.base_unit, track_restock: i.track, restock_threshold: i.reorder_threshold_base, low_stock_per_channel: null, track_expiry: false });
    add('purchase_item', { purchase_item_id: id(`purchase-item:${i.id}`), item_id: id(`item:${i.id}`), supplier_id: id(`supplier:${i.supplier}`), purchase_unit: terms.unit, base_per_unit: terms.basePerUnit, minimum_qty: terms.packQty, order_step: terms.packQty, unit_price: terms.unitPrice, lead_days: supplierBySlug.get(i.supplier).lead_days });
  }
  const menuBySlug = new Map();
  for (const m of c.menu) {
    const menu = { ...m, menuId: id(`menu:${m.id}`), optionGroups: [] };
    menu.cost = Math.round(m.recipe.reduce((n, r) => { const i = ingredientBySlug.get(r.ingredient); return n + r.qty_base * i.unit_price_krw_per_purchase_unit / i.purchase_qty_base; }, 0));
    menuBySlug.set(m.id, menu);
    add('menu_item', { menu_id: menu.menuId, kind: 'menu', name: m.name, category: /디저트|dessert/.test(m.category) ? 'dessert' : 'drink', price: m.price, prep_min: /디저트|dessert/.test(m.category) ? 2 : 3, sale_status: 'selling', memo: m.memo ?? null });
    m.options.forEach((g, gi) => {
      const groupId = id(`group:${m.id}:${gi}`);
      add('menu_option_group', { group_id: groupId, menu_id: menu.menuId, name: g.group, required: g.required, sort_order: gi });
      const options = g.items.map((o, oi) => add('menu_option', { option_id: id(`option:${m.id}:${gi}:${oi}`), group_id: groupId, name: o.name, extra_price: o.price_delta }));
      menu.optionGroups.push({ required: g.required, options: options.filter(o => o.extra_price === 0) });
    });
    for (const r of m.recipe) add('recipe_line', { menu_id: menu.menuId, inventory_item_id: id(`item:${r.ingredient}`), quantity_base: r.qty_base });
  }
  const customers = [];
  for (let n = 0; n < c.customers.members; n++) {
    const customerId = id(`customer:${n}`), memberId = id(`member:${n}`);
    const phone = `0100000${String(n).padStart(4, '0')}`;
    const segment = choose(c.customers.segments, s => s.share, random);
    const consent = random() < 0.65;
    add('customer', { customer_id: customerId, name_enc: encrypt(`가상손님${String(n + 1).padStart(4, '0')}`, `name:${n}`), phone_enc: encrypt(phone, `phone:${n}`), phone_hash: hash(`${storeId}:${phone}`).toString('hex'), phone_last4: phone.slice(-4), consent_sms: consent, consent_sms_at: consent ? firstAt : null, consent_night: false });
    add('member_profile', { member_id: memberId, customer_id: customerId, member_code: `M-${String(n + 1).padStart(4, '0')}`, joined_on: shiftDate(start, -Math.floor(random() * 180)) });
    customers.push({ customerId, memberId, segment, pass: null });
  }
  c.memberships.forEach((p, n) => add('membership_product', { product_id: id(`product:${n}`), name: p.name, kind: 'count', uses: p.uses, valid_days: 60, daily_limit: null, price: p.price }));
  for (const [n, customer] of customers.entries()) if (c.memberships.length && n % 7 === 0) {
    const pn = n % c.memberships.length, product = c.memberships[pn];
    const row = add('membership', { membership_id: id(`pass:${n}`), customer_id: customer.customerId, product_id: id(`product:${pn}`), starts_on: start, ends_on: shiftDate(start, 59), uses_left: product.uses, status: 'active' });
    customer.pass = { row, menu: product.menu };
  }
  const coupons = c.coupons.map((p, n) => {
    const couponId = id(`coupon:${n}`), codeId = id(`code:${n}`);
    add('coupon', { coupon_id: couponId, name: p.name, benefit_type: p.type, benefit_value: p.value, starts_on: p.start, ends_on: p.end, status: p.end < config.end ? 'ended' : 'active', origin: 'manual', origin_slot_keys: [], max_discount_rate: null });
    add('coupon_code', { code_id: codeId, coupon_id: couponId, code: `ASJB-${String(n + 1).padStart(3, '0')}`, route: p.channel === '문자' ? 'sms' : 'place_news', issue_count: Math.max(1, Math.round(customers.length * 0.65)), activated_at: localInstant(p.start, 12 * 60, c.store.timezone) });
    return { ...p, codeId };
  });
  const visits = new Map();
  const requirements = [];
  const returnsByDay = [];
  const tableUntil = new Map();
  for (const [di, date] of dates.entries()) {
    const win = windowFor(date, c.store);
    const available = [...menuBySlug.values()].filter(m => !m.active_from || m.active_from <= date);
    ensure(available.some(m => m.popularity > 0), `${date}: no active menu with positive popularity`);
    const activeCoupons = coupons.filter(p => p.start <= date && p.end >= date);
    const weekend = ['sat', 'sun'].includes(weekday(date));
    const calendarMultiplier = d.academic_calendar.filter(a => a.start <= date && a.end >= date).reduce((n, a) => n * a.multiplier, 1);
    const orderCount = Math.round((weekend ? d.base_orders_weekend : d.base_orders_weekday) * d.weekday_multipliers[weekday(date)] * calendarMultiplier * (0.93 + random() * 0.14));
    const businessDayId = id(`day:${date}`);
    const day = add('business_day', { business_day_id: businessDayId, business_date: date, seq: orderCount, revision: orderCount, drawer_opening: 200000, drawer_actual: 200000 }, win.open);
    const hourly = [];
    for (let h = Math.floor(win.start / 60); h < Math.ceil(win.end / 60); h++) {
      const from = Math.max(win.start, h * 60), to = Math.min(win.end - 2, (h + 1) * 60);
      const weight = (d.hourly_profile[String(h % 24).padStart(2, '0')] ?? 0) * (to - from) / 60;
      if (weight > 0) hourly.push({ from, to, weight });
    }
    ensure(orderCount === 0 || hourly.length > 0, `${date}: hourly_profile has no overlap with opening hours`);
    const times = Array.from({ length: orderCount }, () => {
      const hour = choose(hourly, h => h.weight, random);
      const minute = hour.from + Math.floor(random() * (hour.to - hour.from));
      return addSeconds(localInstant(date, minute, c.store.timezone), Math.floor(random() * 30));
    }).sort();
    const needs = new Map(c.ingredients.map(i => [i.id, 0]));
    const returned = new Map(c.ingredients.map(i => [i.id, 0]));
    const totals = { version: 1, gross: 0, discount: 0, canceledGross: 0, canceledDiscount: 0, canceled: 0, refund: 0, netSales: 0, byMethod: { card: 0, easy_pay: 0, cash: 0 }, paymentCount: 0, cancelCount: 0, refundCount: 0 };
    for (const [oi, orderedAt] of times.entries()) {
      const key = `${date}:${oi}`, billId = id(`bill:${key}`), orderId = id(`order:${key}`);
      const paidAt = addSeconds(orderedAt, 5);
      const correctionAt = addSeconds(paidAt, 20);
      const customer = customers.length && random() < c.customers.walkin_member_ratio ? choose(customers, x => x.segment.visits_per_month, random) : null;
      const takeout = random() < d.takeout_ratio;
      const count = +choose(Object.keys(d.items_per_order), k => d.items_per_order[k], random);
      const lines = Array.from({ length: count }, (_, li) => {
        const favorite = customer && random() < 0.35 ? available.filter(m => customer.segment.favorite.includes(m.id)) : [];
        const menu = choose(favorite.length ? favorite : available, m => m.popularity, random);
        const options = menu.optionGroups.flatMap(g => g.options.length && (g.required || random() < 0.12) ? [choose(g.options, () => 1, random)] : []);
        return { menu, options, orderLineId: id(`line:${key}:${li}`), allocationId: id(`allocation:${key}:${li}`), price: menu.price + sum(options, 'extra_price') };
      });
      const gross = sum(lines, 'price');
      let discount = 0, source = null, scope = 'bill', codeId = null, passLine = -1, use = null, percent = null;
      if (customer?.pass && customer.pass.row.uses_left > 0 && customer.pass.row.ends_on >= date) passLine = lines.findIndex(l => l.menu.id === customer.pass.menu);
      if (passLine >= 0) {
        discount = lines[passLine].price; source = 'membership'; scope = 'line';
        use = add('membership_use', { use_id: id(`use:${key}`), membership_id: customer.pass.row.membership_id, used_at: paidAt, canceled_at: null, idempotency_key: `use:${key}` }, paidAt);
        customer.pass.row.uses_left--;
      } else if (activeCoupons.length && random() < 0.12) {
        const coupon = choose(activeCoupons, () => 1, random);
        source = 'coupon'; codeId = coupon.codeId;
        discount = coupon.type === 'percent' ? Math.floor(gross * coupon.value / 100) : Math.min(gross, coupon.value);
        percent = coupon.type === 'percent' ? coupon.value : null;
      } else if (customer && random() < 0.25) {
        source = 'direct'; percent = Math.round(d.discount_rate_member * 100);
        discount = Math.floor(gross * percent / 100);
      }
      const discounts = passLine >= 0 ? lines.map((l, i) => i === passLine ? discount : 0) : allocate(discount, lines.map(l => l.price));
      const payable = gross - discount;
      const event = random();
      const kind = payable > 0 ? (event < d.cancel_rate ? 'cancel' : event < d.cancel_rate + d.refund_rate ? 'refund' : null) : null;
      const refundAmount = kind === 'refund' ? Math.max(1, Math.floor(payable / 2)) : 0;
      const cancelAmount = kind === 'cancel' ? payable : 0;
      const method = choose(Object.keys(d.payment_mix), m => d.payment_mix[m], random);
      const table = !takeout ? rows.store_table.find(t => (tableUntil.get(t.table_id) ?? 0) <= Date.parse(orderedAt)) : null;
      if (table) tableUntil.set(table.table_id, Date.parse(orderedAt) + 45 * 60000);
      let reservationId = null;
      if (table && customer && random() < 0.1) {
        reservationId = id(`reservation:${key}`);
        const canceled = kind === 'cancel';
        add('reservation', { reservation_id: reservationId, start_at: orderedAt, party_size: Math.min(table.seats, Math.max(1, count)), member_id: customer.memberId, guest_name_enc: null, guest_phone_enc: null, request_enc: null, table_id: table.table_id, assignment_mode: 'auto', capacity_override: false, source: 'direct', status: canceled ? 'canceled' : 'completed', confirmed_by: 'auto' }, orderedAt);
        add('reservation_change', { change_id: id(`reservation-change:${key}`), reservation_id: reservationId, kind: 'status', before: { status: 'confirmed' }, after: { status: canceled ? 'canceled' : 'completed' }, at: canceled ? correctionAt : paidAt }, paidAt);
      }
      add('bill', { bill_id: billId, business_day_id: businessDayId, table_id: c.store.payment_style === 'postpaid' ? table?.table_id ?? null : null, status: 'paid', member_id: customer?.memberId ?? null, member_link_chosen: Boolean(customer), reservation_id: reservationId, reservation_decision: reservationId ? 'accepted' : null, reservation_first_order_id: reservationId ? orderId : null, requested_at: orderedAt, settled_at: paidAt, recognized_at: paidAt }, orderedAt);
      add('pos_order', { order_id: orderId, business_day_id: businessDayId, order_no: oi + 1, seq: oi + 1, type: takeout ? 'takeout' : 'dine_in', origin_bill_id: billId, preparation: kind === 'cancel' ? 'canceled' : 'completed', reservation_id: reservationId, ordered_at: orderedAt, prepared_at: null, completed_at: kind === 'cancel' ? null : addSeconds(orderedAt, 45) }, orderedAt);
      for (const [li, line] of lines.entries()) {
        add('order_line', { order_line_id: line.orderLineId, order_id: orderId, menu_id: line.menu.menuId, name_at_order: line.menu.name, qty: 1, unit_price_at_order: line.price, canceled_qty: kind === 'cancel' ? 1 : 0, request: '' }, orderedAt);
        for (const option of line.options) add('order_line_option', { order_line_id: line.orderLineId, option_id: option.option_id, name: option.name, extra_price: option.extra_price, extra_recipe: [] }, orderedAt);
        add('bill_allocation', { allocation_id: line.allocationId, bill_id: billId, order_line_id: line.orderLineId, qty: 1 }, paidAt);
        add('settlement_line', { allocation_id: line.allocationId, bill_id: billId, menu_id: line.menu.menuId, qty: 1, base_price_at_sale: line.menu.price, option_price_at_sale: sum(line.options, 'extra_price'), unit_cost_at_sale: line.menu.cost, option_cost_at_sale: 0, recognized_qty: 1 }, paidAt);
        for (const recipe of line.menu.recipe) {
          needs.set(recipe.ingredient, needs.get(recipe.ingredient) + recipe.qty_base);
          if (kind === 'cancel') returned.set(recipe.ingredient, returned.get(recipe.ingredient) + recipe.qty_base);
        }
      }
      if (discount > 0 || use) {
        const discountId = id(`discount:${key}`);
        add('bill_discount', { discount_id: discountId, origin_bill_id: billId, source, scope, amount: discount, percent, coupon_code_id: codeId, membership_use_id: use?.use_id ?? null, contribution_member_id: customer?.memberId ?? null, reason: source === 'direct' ? '가상 회원 할인' : source === 'coupon' ? '가상 쿠폰 사용' : '가상 회원권 사용' }, paidAt);
        discounts.forEach((amount, li) => { if (amount > 0) add('discount_allocation', { discount_id: discountId, allocation_id: lines[li].allocationId, role: 'settled', amount }, paidAt); });
      }
      const paymentId = id(`payment:${key}`);
      if (payable > 0) {
        add('payment', { payment_id: paymentId, bill_id: billId, part_id: null, business_day_id: businessDayId, seq: oi + 1, transaction_no: `거래-${date.replaceAll('-', '')}-${String(oi + 1).padStart(4, '0')}`, approval_no: method === 'cash' ? null : `FAKE-${id(`approval:${key}`).slice(0, 8)}`, amount: payable, counted_method: method, status: kind === 'cancel' ? 'canceled' : 'paid', paid_at: paidAt, recognized_at: paidAt, created_by: id('owner') }, paidAt);
        add('payment_method_split', { payment_id: paymentId, method, amount: payable }, paidAt);
        totals.paymentCount++;
      }
      if (kind) {
        const correctionId = id(`correction:${key}`), amount = cancelAmount + refundAmount;
        add('payment_correction', { correction_id: correctionId, payment_id: paymentId, kind, target: 'recognized_sale', amount, restock_retail: false, reason: kind === 'cancel' ? '가상 오주문 취소' : '가상 서비스 불편 금액 환불', seq: orderCount + oi + 1, at: correctionAt, created_by: id('owner') }, correctionAt);
        add('correction_method_amount', { correction_id: correctionId, method, amount }, correctionAt);
        const refunds = allocate(refundAmount, lines.map((l, li) => l.price - discounts[li]));
        lines.forEach((line, li) => {
          if (kind === 'cancel' || refunds[li] > 0) {
            const correctionLineId = id(`correction-line:${key}:${li}`);
            add('correction_line', { correction_line_id: correctionLineId, correction_id: correctionId, order_line_id: line.orderLineId, allocation_id: line.allocationId, qty: kind === 'cancel' ? 1 : 0, amount: kind === 'refund' ? refunds[li] : null, gross: kind === 'cancel' ? line.price : null, discount: kind === 'cancel' ? discounts[li] : null, cost: kind === 'cancel' ? line.menu.cost : null }, correctionAt);
            if (kind === 'cancel' && discounts[li] > 0) add('correction_discount', { correction_line_id: correctionLineId, discount_id: id(`discount:${key}`), amount: discounts[li] }, correctionAt);
          }
        });
        if (kind === 'cancel') {
          totals.cancelCount++; totals.canceledGross += gross; totals.canceledDiscount += discount;
          if (use) { use.canceled_at = correctionAt; customer.pass.row.uses_left++; }
        } else totals.refundCount++;
      }
      totals.gross += gross; totals.discount += discount; totals.canceled += cancelAmount; totals.refund += refundAmount;
      totals.byMethod[method] += payable - cancelAmount - refundAmount;
      if (customer && kind !== 'cancel') {
        const visitKey = `${customer.customerId}:${date}`;
        const hour = +localParts(orderedAt, c.store.timezone).hour;
        if (!visits.has(visitKey)) visits.set(visitKey, { customer_id: customer.customerId, business_date: date, first_hour: hour, from_pos: true });
      }
    }
    requirements.push(needs); returnsByDay.push(returned);
    totals.netSales = totals.gross - totals.discount - totals.canceled - totals.refund;
    day.seq = orderCount * 2; day.revision += totals.cancelCount + totals.refundCount;
    day.drawer_actual += totals.byMethod.cash;
    day.drawer_counted_at = addSeconds(win.close, -1);
    add('day_closing', { closing_id: id(`closing:${date}`), business_day_id: businessDayId, generation: 1, status: 'closed', based_on_revision: day.revision, closed_at: addSeconds(win.close, -1), sales_snapshot: totals, drawer_snapshot: { version: 1, opening: day.drawer_opening, cashNet: totals.byMethod.cash, expected: day.drawer_actual, actual: day.drawer_actual, difference: 0 }, pos_totals_snapshot: { version: 1, orders: orderCount, paymentCount: totals.paymentCount, cancelCount: totals.cancelCount, refundCount: totals.refundCount } }, addSeconds(win.close, -1));
  }
  for (const customer of customers) if (customer.pass) customer.pass.row.status = customer.pass.row.uses_left === 0 || customer.pass.row.ends_on < config.end ? 'ended' : 'active';
  for (const visit of visits.values()) add('customer_visit', visit, localInstant(visit.business_date, minutes(c.store.business_day_start), c.store.timezone));

  // Forecast the already-generated transactions; receipts precede the day's
  // first sale. Orders may be dated before the output range to honor lead time.
  const balances = new Map(c.ingredients.map(i => [i.id, i.opening_qty_base]));
  for (const [di, date] of dates.entries()) {
    const at = windowFor(date, c.store).open;
    for (const i of c.ingredients) add('stock_daily_opening', { item_id: id(`item:${i.id}`), business_date: date, channel: 'store', quantity_base: balances.get(i.id) }, at);
    for (const supplier of c.suppliers) {
      const purchase = [];
      for (const i of c.ingredients.filter(i => i.supplier === supplier.id)) {
        const horizon = Math.max(7, supplier.lead_days + 7);
        const forecast = requirements.slice(di, di + horizon).reduce((n, map) => n + map.get(i.id), 0);
        const needed = forecast + i.reorder_threshold_base - balances.get(i.id);
        if (balances.get(i.id) < requirements[di].get(i.id) + i.reorder_threshold_base && needed > 0) purchase.push({ item: i, packs: Math.ceil(needed / i.purchase_qty_base) });
      }
      if (!purchase.length) continue;
      let cost = purchase.reduce((n, p) => n + p.packs * p.item.unit_price_krw_per_purchase_unit, 0);
      if (cost < supplier.min_order_krw) {
        const positive = purchase.find(p => p.item.unit_price_krw_per_purchase_unit > 0);
        ensure(positive, `${supplier.id}: minimum order cannot be met with zero-priced items`);
        positive.packs += Math.ceil((supplier.min_order_krw - cost) / positive.item.unit_price_krw_per_purchase_unit);
      }
      let orderedOn = shiftDate(date, -supplier.lead_days);
      while (!supplier.order_weekdays.includes(weekday(orderedOn))) orderedOn = shiftDate(orderedOn, -1);
      const poId = id(`po:${date}:${supplier.id}`);
      const arrival = localParts(at, c.store.timezone);
      add('purchase_order', { po_id: poId, supplier_id: id(`supplier:${supplier.id}`), ordered_on: orderedOn, due_date: date, expected_time: `${arrival.hour}:${arrival.minute}`, status: 'complete' }, localInstant(orderedOn, minutes(c.store.business_day_start), c.store.timezone));
      for (const p of purchase) {
        const i = p.item, terms = purchaseTerms(i), qty = p.packs * terms.packQty, qtyBase = qty * terms.basePerUnit, polId = id(`pol:${date}:${i.id}`), receiptId = id(`receipt:${date}:${i.id}`);
        add('purchase_order_line', { pol_id: polId, po_id: poId, item_id: id(`item:${i.id}`), unit_snapshot: terms.unit, base_per_unit: terms.basePerUnit, qty_ordered: qty, unit_price: terms.unitPrice, item_name_snapshot: i.name }, at);
        add('goods_receipt', { receipt_id: receiptId, pol_id: polId, qty, received_at: at, idempotency_key: `receipt:${date}:${i.id}` }, at);
        add('stock_movement', { movement_id: id(`receive:${date}:${i.id}`), item_id: id(`item:${i.id}`), kind: 'receive', delta_base: qtyBase, channel: 'store', receipt_id: receiptId, reason: '가상 발주 입고; 판매 차감은 정산×레시피로 계산', at, idempotency_key: `receive:${date}:${i.id}` }, at);
        add('expense', { expense_id: id(`receipt-expense:${date}:${i.id}`), business_date: date, category: 'ingredients', amount: p.packs * i.unit_price_krw_per_purchase_unit, supplier_id: id(`supplier:${i.supplier}`), receipt_id: receiptId, evidence: 'none', status: 'confirmed', tax_check: 'needs-check' }, at);
        balances.set(i.id, balances.get(i.id) + qtyBase);
      }
    }
    for (const i of c.ingredients) balances.set(i.id, balances.get(i.id) - requirements[di].get(i.id) + returnsByDay[di].get(i.id));
    for (const [ei, expense] of c.expenses.entries()) if (+date.slice(8) === +expense.schedule.split(':')[1]) {
      const category = /임대/.test(expense.category) ? 'rent' : /인건/.test(expense.category) ? 'labor' : /소모/.test(expense.category) ? 'supplies' : /공과/.test(expense.category) ? 'operations' : 'other';
      add('expense', { expense_id: id(`expense:${date}:${ei}`), business_date: date, category, amount: expense.amount, evidence: 'none', status: 'confirmed', tax_check: 'needs-check', memo: expense.memo ?? null }, at);
    }
  }
  const inRange = date => date >= start && date <= config.end;
  for (const [n, review] of c.reviews.entries()) {
    const date = shiftDate(config.end, -review.days_ago);
    if (inRange(date)) add('inquiry_thread', { thread_id: id(`review:${n}`), type: 'review', channel: 'naverReview', external_id: `FICTIONAL-REVIEW-${n}`, is_public: true, received_at: localInstant(date, 16 * 60, c.store.timezone), status: 'waiting', body_enc: encrypt(review.text, `review-body:${n}`), rating: review.rating, sentiment: review.sentiment ?? null, customer_id: customers.length ? customers[n % customers.length].customerId : null }, localInstant(date, 16 * 60, c.store.timezone));
  }
  for (const [n, inquiry] of c.inquiries.entries()) {
    const date = shiftDate(config.end, -(n % Math.min(config.days, 14)));
    const receivedAt = localInstant(date, minutes(inquiry.received_time ?? '14:00'), c.store.timezone);
    add('inquiry_thread', { thread_id: id(`inquiry:${n}`), type: inquiry.channel === '전화' ? 'call' : 'message', channel: inquiry.channel, external_id: `FICTIONAL-INQUIRY-${n}`, is_public: false, received_at: receivedAt, status: inquiry.status, body_enc: encrypt(inquiry.text, `inquiry-body:${n}`), rating: null, sentiment: inquiry.sentiment ?? null, customer_id: customers.length ? customers[n % customers.length].customerId : null }, receivedAt);
  }
  for (const [n, manual] of c.manuals.entries()) {
    const manualId = id(`manual:${n}`);
    const category = /오픈/.test(manual.title) ? 'opening' : /마감/.test(manual.title) ? 'closing' : 'new-staff';
    add('manual', { manual_id: manualId, section: 'handover', category, title: manual.title, cautions: '가상 교육용 매뉴얼', is_published: true });
    manual.steps.forEach((body, si) => add('manual_step', { manual_id: manualId, step_no: si + 1, body, photo_file_id: null }));
  }
  for (const [n, event] of c.calendar.entries()) if (inRange(event.date)) add('calendar_event', { event_id: id(`calendar:${n}`), kind: 'event', category: /세무|세금/.test(event.title) ? 'tax-admin' : /입고|발주/.test(event.title) ? 'purchasing' : 'store-operations', title: event.title, date: event.date, time: null, memo: 'content의 가상 직접 일정', closure_kind: event.closure_kind ?? null, closure_end_date: event.closure_end_date ?? null, done_at: null });
  for (const [n, event] of c.local_events.entries()) if (event.start <= config.end && event.end >= start) add('calendar_event', { event_id: id(`local-event:${n}`), kind: 'event', category: 'store-operations', title: event.title, date: event.start < start ? start : event.start, time: null, memo: `가상 지역 일정 ${event.start}~${event.end}; 지역 통계 원본 아님`, done_at: null });

  const checked = verifyConsistency(rows, c);
  const daily = rows.business_day.map(day => {
    const closing = checked.closings.get(day.business_day_id);
    return { date: day.business_date, orders: closing.pos_totals_snapshot.orders, ...closing.sales_snapshot };
  });
  const sortedSales = daily.map(day => day.netSales).sort((a, b) => a - b);
  const middle = Math.floor(sortedSales.length / 2);
  const menuSales = new Map(rows.menu_item.map(m => [m.menu_id, { menuId: m.menu_id, name: m.name, quantity: 0, grossSales: 0 }]));
  for (const s of rows.settlement_line) {
    const qty = s.recognized_qty - (checked.canceledQty.get(s.allocation_id) ?? 0);
    const item = menuSales.get(s.menu_id); item.quantity += qty; item.grossSales += qty * (s.base_price_at_sale + s.option_price_at_sale);
  }
  const stock = c.ingredients.map(i => ({ id: i.id, name: i.name, baseUnit: i.base_unit, tracked: i.track, closingQtyBase: checked.stock.get(id(`item:${i.id}`)), thresholdBase: i.reorder_threshold_base, purchaseQtyBase: i.purchase_qty_base, purchaseUnit: i.purchase_unit }));
  const stockWarnings = stock.filter(i => i.tracked && i.closingQtyBase < i.thresholdBase).map(i => `${i.id}: closing ${i.closingQtyBase}${i.baseUnit} < threshold ${i.thresholdBase}`);
  const summary = {
    generator: 'ansungjalbu-erd-v1.1', erdVersion: 'v1.1', contentSha256: hash(JSON.stringify(content)).toString('hex'),
    config: { start, end: config.end, days: config.days, seed: config.seed, timezone: c.store.timezone, businessDayStart: c.store.business_day_start },
    store: c.store.name, rowCounts: Object.fromEntries(Object.entries(rows).map(([table, values]) => [table, values.length])),
    totalRows: Object.values(rows).reduce((n, list) => n + list.length, 0),
    tableCount: Object.keys(rows).length, populatedTableCount: Object.values(rows).filter(list => list.length > 0).length,
    netSales: { total: sum(daily, 'netSales'), min: sortedSales[0], median: sortedSales.length % 2 ? sortedSales[middle] : Math.round((sortedSales[middle - 1] + sortedSales[middle]) / 2), max: sortedSales.at(-1) },
    bestSellers: [...menuSales.values()].sort((a, b) => b.quantity - a.quantity || a.menuId.localeCompare(b.menuId, 'en')).slice(0, 10),
    corrections: { cancels: rows.payment_correction.filter(r => r.kind === 'cancel').length, refunds: rows.payment_correction.filter(r => r.kind === 'refund').length, amount: sum(rows.payment_correction, 'amount') },
    daily, stock, stockWarnings, checks: checked.checks, skipped: SKIPPED,
  };
  return { rows, summary, sql: toSql(rows), summaryJson: `${JSON.stringify(summary, null, 2)}\n`, summaryMd: toMarkdown(summary) };
}

function quoted(value) {
  return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}'`;
}
function sqlValue(value, json) {
  if (value === null) return 'NULL';
  if (Buffer.isBuffer(value)) return `decode('${value.toString('hex')}', 'hex')`;
  if (json) return `${quoted(JSON.stringify(value))}::jsonb`;
  if (Array.isArray(value)) return `ARRAY[${value.map(quoted).join(', ')}]::text[]`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') { ensure(Number.isFinite(value), 'SQL: non-finite number'); return String(value); }
  return quoted(String(value));
}
function toSql(rows) {
  const output = ['-- Fictional cafe fixture only; requires a separately prepared ERD v1 schema.', '-- No CREATE, DELETE, TRUNCATE, external calls or real credentials.', 'BEGIN;', "SET LOCAL TIME ZONE 'UTC';"];
  for (const [name, schema] of Object.entries(SCHEMA)) {
    const records = rows[name];
    for (let i = 0; i < records.length; i += 500) {
      // Break the bill/order FK cycle without requiring deferred constraints.
      output.push(`INSERT INTO "${name}" (${schema.columns.map(c => `"${c}"`).join(', ')}) VALUES\n${records.slice(i, i + 500).map(r => `  (${schema.columns.map(c => sqlValue(name === 'bill' && c === 'reservation_first_order_id' ? null : r[c], schema.json.includes(c))).join(', ')})`).join(',\n')};`);
    }
  }
  for (const bill of rows.bill) if (bill.reservation_first_order_id !== null) output.push(`UPDATE "bill" SET "reservation_first_order_id" = ${quoted(bill.reservation_first_order_id)} WHERE "store_id" = ${quoted(bill.store_id)} AND "bill_id" = ${quoted(bill.bill_id)};`);
  output.push('COMMIT;', ''); return output.join('\n');
}
function toMarkdown(s) {
  return [
    `# ${s.store} 가상 DB 시드 요약`, '',
    `${s.config.start}~${s.config.end} (${s.config.days}영업일), seed=${s.config.seed}, ${s.config.timezone}, 영업일 경계 ${s.config.businessDayStart}.`,
    `ERD ${s.erdVersion}: 총 ${s.tableCount}표(행 있음 ${s.populatedTableCount}표), ${s.totalRows}행. 순매출 합계 ${s.netSales.total}원, 일별 최소/중앙/최대 ${s.netSales.min}/${s.netSales.median}/${s.netSales.max}원.`,
    `취소 ${s.corrections.cancels}건, 금액 환불 ${s.corrections.refunds}건.`, '',
    '## 일관성 검사', '', ...s.checks.map(c => `- 통과: ${c}`), '',
    '## 표별 행 수', '', '| 표 | 행 |', '| --- | ---: |', ...Object.entries(s.rowCounts).map(([name, count]) => `| ${name} | ${count} |`), '',
    '## 판매 상위 메뉴', '', '| 메뉴 | 취소 제외 수량 | 할인 전 매출(원) |', '| --- | ---: | ---: |', ...s.bestSellers.map(m => `| ${m.name.replaceAll('|', '\\|')} | ${m.quantity} | ${m.grossSales} |`), '',
    '## 재고 경고', '', ...(s.stockWarnings.length ? s.stockWarnings.map(w => `- ${w}`) : ['- 없음. 추적 품목의 모든 판매 시점 및 일별 이월 잔량 >= 0.']), '',
    '## 생략한 표·지표와 ERD 미확정 사항', '', ...s.skipped.map(t => `- ${t}`), '',
    'ERD v1 maps tracking, order units, separate option costs and correction discounts. Membership target-menu/sales sources and default purchase-unit conversion remain gaps; keep content and mappings together. DDL, PostgreSQL loading, RLS and app integration are unverified.', '',
  ].join('\n');
}

export function verifyConsistency(rows, content) {
  const checks = [], keys = new Map();
  for (const [name, schema] of Object.entries(SCHEMA)) {
    ensure(Array.isArray(rows[name]), `missing output table ${name}`);
    const primary = new Set();
    for (const row of rows[name]) {
      ensure(Object.keys(row).every(k => schema.columns.includes(k)), `${name}: unknown ERD column`);
      const key = JSON.stringify(schema.pk.map(k => row[k]));
      ensure(schema.pk.every(k => row[k] !== null && row[k] !== undefined) && !primary.has(key), `${name}: null/duplicate PK ${key}`); primary.add(key);
      for (const column of schema.columns) {
        ensure(row[column] !== undefined, `${name}.${column}: undefined`);
        if (column.endsWith('_id') && column !== 'external_id' && row[column] !== null) ensure(typeof row[column] === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row[column]), `${name}.${column}: invalid fixture UUID`);
        if (typeof row[column] === 'number') {
          const decimal = (name === 'store' && ['lat', 'lng'].includes(column)) || (name === 'demand_forecast' && ['expected', 'average', 'baseline'].includes(column));
          ensure(decimal ? Number.isFinite(row[column]) : Number.isSafeInteger(row[column]), `${name}.${column}: invalid numeric value`);
        }
        if (column.endsWith('_enc') && row[column] !== null) ensure(Buffer.isBuffer(row[column]) && row[column].length >= 28, `${name}.${column}: encrypted bytea required`);
      }
      for (const column of REQUIRED_V1[name] ?? []) ensure(row[column] !== null, `${name}.${column}: required v1 value missing`);
      if (name === 'coupon') ensure(Array.isArray(row.origin_slot_keys) && row.origin_slot_keys.every(k => typeof k === 'string'), 'coupon.origin_slot_keys: text[] required');
      if (name === 'customer') ensure(/^\d{4}$/.test(row.phone_last4) && /^[a-f0-9]{64}$/.test(row.phone_hash), 'customer: invalid phone search fields');
      if (name === 'inquiry_thread') ensure(typeof row.is_public === 'boolean' && (row.sentiment === null || ['positive', 'negative', 'neutral'].includes(row.sentiment)), 'inquiry: invalid public/sentiment fields');
      for (const column of schema.krw) if (row[column] !== null) money(row[column], `${name}.${column}`);
    }
    for (const column of schema.columns) keys.set(`${name}.${column}`, new Set(rows[name].map(r => r[column])));
  }
  ensure(rows.store.length === 1, 'one fixture store required');
  for (const [name, schema] of Object.entries(SCHEMA)) for (const row of rows[name]) {
    if (name !== 'app_user') ensure(row.store_id === rows.store[0].store_id, `${name}: cross-store row`);
    for (const [column, [target, targetColumn]] of Object.entries(schema.refs)) if (row[column] !== null) ensure(keys.get(`${target}.${targetColumn}`)?.has(row[column]), `${name}.${column}: missing FK ${target}.${targetColumn}=${row[column]}`);
  }
  checks.push('all PKs/FKs, single-store scope, integer KRW');
  const bills = indexBy(rows.bill, 'bill_id'), days = indexBy(rows.business_day, 'business_day_id');
  const orders = indexBy(rows.pos_order, 'order_id'), lines = indexBy(rows.order_line, 'order_line_id');
  const allocations = indexBy(rows.bill_allocation, 'allocation_id'), settlements = indexBy(rows.settlement_line, 'allocation_id');
  const payments = indexBy(rows.payment, 'payment_id'), corrections = indexBy(rows.payment_correction, 'correction_id');
  const linesByBill = groupBy(rows.settlement_line, 'bill_id'), paymentsByBill = groupBy(rows.payment, 'bill_id');
  const discountsByBill = groupBy(rows.bill_discount, 'origin_bill_id'), discounts = indexBy(rows.bill_discount, 'discount_id');
  const allocationsByDiscount = groupBy(rows.discount_allocation, 'discount_id');
  const optionsByLine = groupBy(rows.order_line_option, 'order_line_id');
  const discountByAllocation = new Map();
  for (const d of rows.bill_discount) {
    const parts = allocationsByDiscount.get(d.discount_id) ?? [];
    ensure(sum(parts, 'amount') === d.amount, `discount ${d.discount_id}: allocation sum mismatch`);
    ensure(d.contribution_member_id === bills.get(d.origin_bill_id).member_id, 'discount contribution member differs from origin bill');
    for (const p of parts) { ensure(p.role === 'settled' && allocations.get(p.allocation_id).bill_id === d.origin_bill_id, 'discount allocation references another bill'); discountByAllocation.set(p.allocation_id, (discountByAllocation.get(p.allocation_id) ?? 0) + p.amount); }
  }
  for (const line of rows.order_line) {
    integer(line.qty, 'order_line.qty', 1); integer(line.canceled_qty, 'order_line.canceled_qty');
    ensure(line.canceled_qty <= line.qty, 'canceled order quantity exceeds original');
  }
  const allocatedQty = new Map();
  for (const s of rows.settlement_line) {
    const a = allocations.get(s.allocation_id), line = lines.get(a.order_line_id);
    ensure(a.bill_id === s.bill_id && line.menu_id === s.menu_id && a.qty === s.qty && s.recognized_qty === s.qty && s.qty > 0, `settlement ${s.allocation_id}: order/quantity mismatch`);
    ensure(s.option_price_at_sale === sum(optionsByLine.get(line.order_line_id) ?? [], 'extra_price') && (s.base_price_at_sale + s.option_price_at_sale) === line.unit_price_at_order, `settlement ${s.allocation_id}: order price mismatch`);
    ensure(orders.get(line.order_id).origin_bill_id === s.bill_id, 'settlement references another order bill');
    allocatedQty.set(line.order_line_id, (allocatedQty.get(line.order_line_id) ?? 0) + s.qty);
    ensure((discountByAllocation.get(s.allocation_id) ?? 0) <= s.qty * line.unit_price_at_order, 'line discount exceeds gross');
  }
  for (const line of rows.order_line) ensure(allocatedQty.get(line.order_line_id) === line.qty, `order line ${line.order_line_id}: settlement quantity mismatch`);
  ensure(rows.bill_allocation.length === rows.settlement_line.length, 'allocation missing settlement');
  for (const bill of rows.bill) {
    ensure(typeof bill.member_link_chosen === 'boolean' && bill.member_link_chosen === (bill.member_id !== null), 'bill member-link source mismatch');
    ensure(bill.requested_at !== null && bill.requested_at <= bill.settled_at, 'bill requested_at after settlement or missing');
    if (bill.reservation_id !== null) {
      const first = orders.get(bill.reservation_first_order_id);
      ensure(bill.reservation_decision === 'accepted' && first?.origin_bill_id === bill.bill_id && first.reservation_id === bill.reservation_id, 'bill reservation decision/first order mismatch');
    } else ensure(bill.reservation_decision === null && bill.reservation_first_order_id === null, 'bill without reservation has decision/order');
    const gross = (linesByBill.get(bill.bill_id) ?? []).reduce((n, s) => n + s.qty * (s.base_price_at_sale + s.option_price_at_sale), 0);
    const discount = sum(discountsByBill.get(bill.bill_id) ?? [], 'amount');
    ensure(sum(paymentsByBill.get(bill.bill_id) ?? [], 'amount') === gross - discount, `bill ${bill.bill_id}: payments do not equal bill total`);
  }
  const splits = groupBy(rows.payment_method_split, 'payment_id');
  for (const p of rows.payment) {
    ensure(sum(splits.get(p.payment_id) ?? [], 'amount') === p.amount, `payment ${p.payment_id}: method sum mismatch`);
    ensure(bills.get(p.bill_id).business_day_id === p.business_day_id, 'payment references another business day');
    integer(p.seq, 'payment.seq', 1);
    ensure(p.seq <= days.get(p.business_day_id).seq, 'payment seq exceeds business-day sequence');
  }
  checks.push('payments equal original bill totals; settlement matches every order line; discount/method sums');
  const correctionLines = groupBy(rows.correction_line, 'correction_id');
  const correctionMethods = groupBy(rows.correction_method_amount, 'correction_id');
  const byPayment = groupBy(rows.payment_correction, 'payment_id');
  const correctionDiscounts = groupBy(rows.correction_discount, 'correction_line_id');
  const originalDiscountParts = new Map(rows.discount_allocation.map(d => [JSON.stringify([d.discount_id, d.allocation_id]), d.amount]));
  const canceledByDiscountPart = new Map();
  const canceledQty = new Map(), canceledDiscount = new Map(), refundedByAllocation = new Map();
  for (const p of rows.payment) {
    const returns = byPayment.get(p.payment_id) ?? [];
    ensure(sum(returns, 'amount') <= p.amount, `payment ${p.payment_id}: corrections exceed original`);
    const originalMethods = new Map((splits.get(p.payment_id) ?? []).map(s => [s.method, s.amount]));
    for (const c of returns) {
      ensure(['cancel', 'refund'].includes(c.kind) && c.amount > 0 && c.at >= p.paid_at, `correction ${c.correction_id}: invalid kind/amount/time`);
      ensure(c.target === 'recognized_sale' && p.recognized_at !== null && c.at >= p.recognized_at, 'correction target must be recognized sale');
      const parts = correctionMethods.get(c.correction_id) ?? [];
      ensure(sum(parts, 'amount') === c.amount, `correction ${c.correction_id}: method sum mismatch`);
      for (const part of parts) { const remaining = (originalMethods.get(part.method) ?? 0) - part.amount; ensure(remaining >= 0, 'correction method exceeds original'); originalMethods.set(part.method, remaining); }
      const cl = correctionLines.get(c.correction_id) ?? [];
      ensure(cl.reduce((n, l) => n + (c.kind === 'refund' ? l.amount : l.gross - l.discount), 0) === c.amount, `correction ${c.correction_id}: line sum mismatch`);
      for (const l of cl) {
        const a = allocations.get(l.allocation_id), s = settlements.get(l.allocation_id);
        ensure(a.bill_id === p.bill_id && a.order_line_id === l.order_line_id, 'correction references another bill/order line');
        if (c.kind === 'cancel') {
          const cost = s.unit_cost_at_sale === null || s.option_cost_at_sale === null ? null : l.qty * (s.unit_cost_at_sale + s.option_cost_at_sale);
          ensure(l.amount === null && l.discount !== null && l.qty > 0 && l.gross === l.qty * (s.base_price_at_sale + s.option_price_at_sale) && l.cost === cost, 'cancel quantity/gross/cost/null rule mismatch');
          const parts = correctionDiscounts.get(l.correction_line_id) ?? [];
          ensure(sum(parts, 'amount') === l.discount, 'correction_discount sum differs from canceled discount');
          for (const part of parts) {
            const key = JSON.stringify([part.discount_id, l.allocation_id]);
            const total = (canceledByDiscountPart.get(key) ?? 0) + part.amount;
            ensure(originalDiscountParts.has(key) && total <= originalDiscountParts.get(key), 'correction_discount exceeds original discount allocation');
            canceledByDiscountPart.set(key, total);
          }
          canceledQty.set(l.allocation_id, (canceledQty.get(l.allocation_id) ?? 0) + l.qty);
          canceledDiscount.set(l.allocation_id, (canceledDiscount.get(l.allocation_id) ?? 0) + l.discount);
        } else {
          ensure(l.qty === 0 && l.amount > 0 && l.gross === null && l.discount === null && l.cost === null && !correctionDiscounts.has(l.correction_line_id), 'money-only refund kind-specific null rule mismatch');
          refundedByAllocation.set(l.allocation_id, (refundedByAllocation.get(l.allocation_id) ?? 0) + l.amount);
        }
      }
    }
  }
  for (const s of rows.settlement_line) {
    const a = allocations.get(s.allocation_id), qty = canceledQty.get(s.allocation_id) ?? 0;
    ensure(qty <= s.qty && qty === lines.get(a.order_line_id).canceled_qty, 'cancel quantity exceeds original/mismatches order');
    ensure((canceledDiscount.get(s.allocation_id) ?? 0) <= (discountByAllocation.get(s.allocation_id) ?? 0), 'cancel discount exceeds original');
    const remainingNet = (s.qty - qty) * (s.base_price_at_sale + s.option_price_at_sale) - ((discountByAllocation.get(s.allocation_id) ?? 0) - (canceledDiscount.get(s.allocation_id) ?? 0));
    ensure((refundedByAllocation.get(s.allocation_id) ?? 0) <= remainingNet, 'refund exceeds original line net');
  }
  checks.push('recognized-sale corrections; kind-specific NULLs; original correction_discount lineage and amount limits');
  const closingsByDay = groupBy(rows.day_closing, 'business_day_id');
  const paymentsByDay = groupBy(rows.payment, 'business_day_id');
  const billsByDay = groupBy(rows.bill, 'business_day_id');
  const ordersByDay = groupBy(rows.pos_order, 'business_day_id');
  const closings = new Map();
  for (const day of rows.business_day) {
    const found = closingsByDay.get(day.business_day_id) ?? [];
    ensure(found.length === 1 && found[0].status === 'closed', `${day.business_date}: expected one closing per business_day`);
    const closing = found[0], snapshot = closing.sales_snapshot;
    ensure(closing.based_on_revision === day.revision, 'stale closing revision');
    ensure(snapshot.version === 1 && closing.drawer_snapshot.version === 1 && closing.pos_totals_snapshot.version === 1, 'closing snapshots require version 1');
    closings.set(day.business_day_id, closing);
    const dayPayments = paymentsByDay.get(day.business_day_id) ?? [];
    const dayCorrections = dayPayments.flatMap(p => byPayment.get(p.payment_id) ?? []);
    const daySettlements = (billsByDay.get(day.business_day_id) ?? []).flatMap(b => linesByBill.get(b.bill_id) ?? []);
    const gross = daySettlements.reduce((n, s) => n + s.qty * (s.base_price_at_sale + s.option_price_at_sale), 0);
    const discount = (billsByDay.get(day.business_day_id) ?? []).reduce((n, b) => n + sum(discountsByBill.get(b.bill_id) ?? [], 'amount'), 0);
    ensure(snapshot.gross === gross && snapshot.discount === discount && snapshot.refund === sum(dayCorrections.filter(c => c.kind === 'refund'), 'amount') && snapshot.canceled === sum(dayCorrections.filter(c => c.kind === 'cancel'), 'amount'), 'closing gross/discount/corrections mismatch');
    ensure(snapshot.netSales === sum(dayPayments, 'amount') - sum(dayCorrections, 'amount'), `${day.business_date}: closing sales mismatch`);
    for (const [method, amount] of Object.entries(snapshot.byMethod)) {
      money(amount, `closing.byMethod.${method}`);
      const paid = dayPayments.reduce((n, p) => n + sum((splits.get(p.payment_id) ?? []).filter(s => s.method === method), 'amount'), 0);
      const returned = dayCorrections.reduce((n, c) => n + sum((correctionMethods.get(c.correction_id) ?? []).filter(m => m.method === method), 'amount'), 0);
      ensure(amount === paid - returned, 'closing method mismatch');
    }
    ensure(Object.values(snapshot.byMethod).reduce((a, b) => a + b, 0) === snapshot.netSales, 'closing method total mismatch');
    for (const [key, value] of Object.entries(snapshot)) if (key !== 'byMethod') money(value, `closing.${key}`);
    for (const value of Object.values(closing.drawer_snapshot)) integer(value, 'drawer snapshot');
    for (const value of Object.values(closing.pos_totals_snapshot)) integer(value, 'pos totals snapshot');
    ensure((day.drawer_counted_at === null) === (day.drawer_actual === null), 'drawer count time/actual null mismatch');
    if (day.drawer_counted_at !== null) {
      const countedAt = Date.parse(day.drawer_counted_at);
      ensure(Number.isFinite(countedAt), 'invalid drawer count time');
      for (const payment of dayPayments) {
        if ((splits.get(payment.payment_id) ?? []).some(split => split.method === 'cash')) {
          ensure(countedAt >= Date.parse(payment.paid_at), 'drawer counted before cash payment');
        }
      }
    }
    ensure(day.drawer_actual === day.drawer_opening + snapshot.byMethod.cash && closing.drawer_snapshot.expected === day.drawer_actual && closing.drawer_snapshot.actual === day.drawer_actual && closing.drawer_snapshot.difference === 0, 'closing drawer mismatch');
    ensure(closing.pos_totals_snapshot.orders === (ordersByDay.get(day.business_day_id) ?? []).length, 'closing order count mismatch');
    const dayOrders = ordersByDay.get(day.business_day_id) ?? [];
    ensure(new Set(dayOrders.map(o => o.seq)).size === dayOrders.length, 'duplicate order seq in business day');
    for (const order of dayOrders) {
      integer(order.seq, 'pos_order.seq', 1);
      ensure(order.seq <= day.seq, 'order seq exceeds business-day sequence');
      if (order.prepared_at !== null) ensure(order.prepared_at >= order.ordered_at && (order.completed_at === null || order.prepared_at <= order.completed_at), 'preparation start outside order timeline');
      ensure(businessDateAt(order.ordered_at, content.store) === day.business_date, `order ${order.order_id}: timezone/business_day_start mismatch`);
    }
    for (const p of dayPayments) { ensure(businessDateAt(p.paid_at, content.store) === day.business_date && p.recognized_at <= closing.closed_at, 'payment outside business day/closing'); for (const c of byPayment.get(p.payment_id) ?? []) ensure(businessDateAt(c.at, content.store) === day.business_date && c.at <= closing.closed_at, 'correction outside business day/closing'); }
    ensure(businessDateAt(closing.closed_at, content.store) === day.business_date, 'closing outside business day');
  }
  ensure(new Set(rows.business_day.map(d => d.business_date)).size === rows.business_day.length, 'duplicate business_date');
  checks.push('one current closing per business_day; drawer count timing, based_on_revision and versioned snapshots; timezone and order sequences');

  const purchaseLines = indexBy(rows.purchase_order_line, 'pol_id');
  const purchaseItems = indexBy(rows.purchase_item, 'item_id');
  const purchaseOrders = indexBy(rows.purchase_order, 'po_id');
  const movementsByReceipt = groupBy(rows.stock_movement, 'receipt_id');
  const expensesByReceipt = groupBy(rows.expense.filter(e => e.receipt_id), 'receipt_id');
  const receiptsByLine = groupBy(rows.goods_receipt, 'pol_id');
  for (const [n, item] of rows.inventory_item.entries()) {
    ensure(item.track_restock === content.ingredients[n].track && typeof item.track_restock === 'boolean', 'inventory track_restock differs from source');
    const terms = purchaseTerms(content.ingredients[n]), pi = purchaseItems.get(item.item_id);
    ensure(pi.purchase_unit === terms.unit && pi.base_per_unit === terms.basePerUnit && pi.minimum_qty === terms.packQty && pi.order_step === terms.packQty && pi.unit_price === terms.unitPrice, 'purchase item unit/package/source mismatch');
  }
  for (const pol of rows.purchase_order_line) {
    const pi = purchaseItems.get(pol.item_id);
    ensure(pi, 'purchase order item missing');
    integer(pol.base_per_unit, 'purchase_order_line.base_per_unit', 1);
    integer(pol.qty_ordered, 'purchase_order_line.qty_ordered', 1);
    ensure(pol.unit_snapshot === pi.purchase_unit && pol.base_per_unit === pi.base_per_unit && pol.unit_price === pi.unit_price && pol.qty_ordered >= pi.minimum_qty, 'purchase order unit/price snapshot mismatch');
  }
  for (const receipt of rows.goods_receipt) {
    const pol = purchaseLines.get(receipt.pol_id), pi = purchaseItems.get(pol.item_id), po = purchaseOrders.get(pol.po_id);
    integer(receipt.qty, 'receipt.qty', 1);
    ensure(sum(receiptsByLine.get(pol.pol_id), 'qty') <= pol.qty_ordered && pol.qty_ordered % pi.order_step === 0, 'receipt exceeds order/package quantity');
    const move = movementsByReceipt.get(receipt.receipt_id) ?? [];
    ensure(move.length === 1 && move[0].kind === 'receive' && move[0].channel === 'store' && move[0].delta_base === receipt.qty * pol.base_per_unit && move[0].item_id === pol.item_id && move[0].at === receipt.received_at, 'receipt must affect stock exactly once with base-unit conversion');
    const receivedOn = businessDateAt(receipt.received_at, content.store);
    ensure(shiftDate(po.ordered_on, pi.lead_days) <= receivedOn && po.due_date === receivedOn, 'receipt violates supplier lead time/due date');
    const expense = expensesByReceipt.get(receipt.receipt_id) ?? [];
    ensure(expense.length === 1 && expense[0].amount === receipt.qty * pol.unit_price, 'receipt expense/unit conversion mismatch');
    const time = localParts(receipt.received_at, content.store.timezone);
    ensure(po.expected_time === `${time.hour}:${time.minute}`, 'purchase expected_time differs from modeled arrival');
  }
  const recipeByMenu = groupBy(rows.recipe_line, 'menu_id');
  const eventsByDate = new Map(rows.business_day.map(day => [day.business_date, []]));
  const event = (at, itemId, delta, priority) => {
    const date = businessDateAt(at, content.store);
    ensure(eventsByDate.has(date), `stock event outside generated days: ${at}`);
    eventsByDate.get(date).push({ at, itemId, delta, priority });
  };
  for (const m of rows.stock_movement) event(m.at, m.item_id, m.delta_base, 0);
  for (const s of rows.settlement_line) for (const r of recipeByMenu.get(s.menu_id) ?? []) event(bills.get(s.bill_id).recognized_at, r.inventory_item_id, -s.recognized_qty * r.quantity_base, 1);
  for (const line of rows.correction_line) if (corrections.get(line.correction_id).kind === 'cancel') for (const r of recipeByMenu.get(settlements.get(line.allocation_id).menu_id) ?? []) event(corrections.get(line.correction_id).at, r.inventory_item_id, line.qty * r.quantity_base, 2);
  const openingsByDate = groupBy(rows.stock_daily_opening, 'business_date');
  const tracked = new Map(rows.inventory_item.map(i => [i.item_id, i.track_restock]));
  const stock = new Map();
  for (const day of rows.business_day) {
    const openings = openingsByDate.get(day.business_date) ?? [];
    ensure(openings.length === rows.inventory_item.length, 'missing daily opening stock');
    for (const opening of openings) {
      integer(opening.quantity_base, 'opening.quantity_base');
      ensure(opening.channel === 'store', 'opening channel has no modeled stock source');
      if (stock.has(opening.item_id)) ensure(stock.get(opening.item_id) === opening.quantity_base, `${day.business_date}: opening does not carry prior closing`);
      stock.set(opening.item_id, opening.quantity_base);
    }
    for (const e of eventsByDate.get(day.business_date).sort((a, b) => a.at.localeCompare(b.at) || a.priority - b.priority)) {
      stock.set(e.itemId, stock.get(e.itemId) + e.delta);
      if (tracked.get(e.itemId)) ensure(stock.get(e.itemId) >= 0, `${day.business_date} ${e.at}: tracked stock went negative for ${e.itemId}; generate receipt first`);
    }
  }
  checks.push('tracked stock never negative at any sale; daily carryover; exactly one receipt movement; purchase/expense units');
  const uses = groupBy(rows.membership_use, 'membership_id');
  const products = indexBy(rows.membership_product, 'product_id');
  const discountsByUse = groupBy(rows.bill_discount.filter(d => d.membership_use_id), 'membership_use_id');
  for (const membership of rows.membership) {
    const useRows = uses.get(membership.membership_id) ?? [];
    ensure(membership.uses_left === products.get(membership.product_id).uses - useRows.filter(u => !u.canceled_at).length && membership.uses_left >= 0, 'membership uses_left mismatch');
    for (const u of useRows) {
      ensure((discountsByUse.get(u.use_id) ?? []).length === 1, 'membership use must reference one discount');
      const date = businessDateAt(u.used_at, content.store); ensure(date >= membership.starts_on && date <= membership.ends_on, 'membership used outside validity');
    }
  }
  checks.push('membership uses and canceled-use restoration');
  return { checks, closings, canceledQty, stock };
}

async function main(args) {
  const options = { content: resolve(ROOT, 'content.json'), end: '2026-11-17', days: 90, seed: 42, out: resolve(ROOT, 'out') };
  if (args.includes('--help')) { process.stdout.write('node generate.mjs [--content content.json] [--end YYYY-MM-DD] [--days 90] [--seed 42] [--out out/]\nDefaults: sibling content.json/out, end 2026-11-17 (fixed for reproducibility).\n'); return; }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    ensure(args[i].startsWith('--') && Object.hasOwn(options, key) && args[i + 1] !== undefined, `unknown option or missing value: ${args[i]}`);
    options[key] = ['days', 'seed'].includes(key) ? Number(args[i + 1]) : args[i + 1];
  }
  const content = JSON.parse(await readFile(resolve(options.content), 'utf8'));
  const result = generate(content, { end: options.end, days: options.days, seed: options.seed });
  await mkdir(resolve(options.out), { recursive: true });
  for (const [name, data] of [['seed.sql', result.sql], ['summary.json', result.summaryJson], ['summary.md', result.summaryMd]]) await writeFile(resolve(options.out, name), data, 'utf8');
  process.stdout.write(`${JSON.stringify({ output: resolve(options.out), totalRows: result.summary.totalRows, netSales: result.summary.netSales, corrections: result.summary.corrections, stockWarnings: result.summary.stockWarnings.length, checks: result.summary.checks.length }, null, 2)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Seed generation failed: ${error.message}\n`); process.exitCode = 1; });
}
