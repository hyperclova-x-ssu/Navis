import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { businessDateAt, generate } from '../../db/seed/ansungjalbu/generate.mjs';

const contentPath = new URL('../../db/seed/ansungjalbu/content.json', import.meta.url);
const generatorPath = new URL('../../db/seed/ansungjalbu/generate.mjs', import.meta.url);
const outputPath = fileURLToPath(new URL('../src/data/db/generated/', import.meta.url));
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const formatJson = value => `${JSON.stringify(value, null, 2)}\n`;
const shiftDay = (date, days) => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
const weekday = date => weekdays[new Date(date).getUTCDay()];
const local = at => at === null ? null : new Date(Date.parse(at) + KST_MS).toISOString().slice(0, 19);
const atCutoff = (date, time) => new Date(`${date}T${time}+09:00`).toISOString();
const hourOf = at => Number(local(at).slice(11, 13));
const sumBy = (list, value) => list.reduce((sum, row) => sum + value(row), 0);
const sumAmount = list => sumBy(list, row => row.amount);
const tally = (counts, key, amount = 1) => { counts[key] = (counts[key] ?? 0) + amount; };
const mapBy = (rows, key) => new Map(rows.map(row => [row[key], row]));
const compare = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const ordered = (rows, ...keys) => [...rows].sort((a, b) => {
  for (const key of keys) {
    const result = compare(a[key], b[key]);
    if (result) return result;
  }
  return 0;
});
const realAmounts = () => ({ card: 0, easy_pay: 0, cash: 0 });
const readText = path => readFile(path, 'utf8');

function group(rows, key) {
  const index = new Map();
  for (const row of rows) {
    const id = typeof key === 'function' ? key(row) : row[key];
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(row);
  }
  return id => index.get(id) ?? [];
}

function requireRow(index, id) {
  assert.ok(index.has(id), `Unknown seed source ID ${id}`);
  return index.get(id);
}

// The upstream generator currently exposes SQL rows without semantic slugs.
function dbId(seed, key) {
  const bytes = Buffer.from(sha256(`ansungjalbu:v1:${seed}:${key}`).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  return bytes.toString('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

export async function readSeedInputs() {
  const [contentSource, configSource, supplementSource, generatorSource, adapterSource] = await Promise.all([
    readText(contentPath),
    readText(new URL('./seed-manifest.json', import.meta.url)),
    readText(new URL('./seed-supplement.json', import.meta.url)),
    readText(generatorPath),
    readText(new URL(import.meta.url)),
  ]);
  return { contentSource, configSource, supplementSource, generatorSource, adapterSource };
}

function buildCatalog(content, rows, id, date) {
  const ingredientRows = mapBy(rows.inventory_item, 'item_id');
  const supplierRows = mapBy(rows.supplier, 'supplier_id');
  const menuRows = mapBy(rows.menu_item, 'menu_id');
  const purchaseRows = mapBy(rows.purchase_item, 'item_id');
  const recipeByMenu = group(rows.recipe_line, 'menu_id');
  const groupsByMenu = group(rows.menu_option_group, 'menu_id');
  const optionsByGroup = group(rows.menu_option, 'group_id');

  const items = content.ingredients.map(source => {
    const row = requireRow(ingredientRows, id(`item:${source.id}`));
    const purchase = requireRow(purchaseRows, row.item_id);
    return {
      itemId: source.id, dbId: row.item_id, sku: row.sku, name: row.name, unitDimension: row.base_unit,
      displayUnit: row.display_unit, trackRestock: row.track_restock, restockThreshold: row.restock_threshold,
      purchase: {
        purchaseItemId: purchase.purchase_item_id, supplierDbId: purchase.supplier_id,
        label: source.purchase_unit, unit: purchase.purchase_unit, basePerUnit: purchase.base_per_unit,
        minimum: purchase.minimum_qty, step: purchase.order_step, unitPrice: purchase.unit_price, leadDays: purchase.lead_days,
      },
    };
  });
  const itemsByDbId = mapBy(items, 'dbId');
  const suppliers = content.suppliers.map((source, index) => {
    const row = requireRow(supplierRows, id(`supplier:${source.id}`));
    return {
      supplierId: source.id, dbId: row.supplier_id, name: row.name, contact: row.contact_name,
      phoneMask: `02-****-${String(index).padStart(4, '0')}`, memo: row.memo, leadDays: source.lead_days,
      orderWeekdays: source.order_weekdays, minimumOrder: source.min_order_krw,
    };
  });
  const menus = content.menu.map(source => {
    const row = requireRow(menuRows, id(`menu:${source.id}`));
    const parts = new Map(recipeByMenu(row.menu_id).map(part => [part.inventory_item_id, part.quantity_base]));
    const ingredients = source.recipe.map(part => requireRow(itemsByDbId, id(`item:${part.ingredient}`)));
    const recipeBase = ingredients.map(item => ({
      itemId: item.itemId, quantityBase: requireRow(parts, item.dbId), unitDimension: item.unitDimension,
    }));
    const unitCost = Math.round(sumBy(ingredients, item => requireRow(parts, item.dbId) * item.purchase.unitPrice / item.purchase.basePerUnit));
    return {
      menuId: source.id, dbId: row.menu_id, kind: row.kind, name: row.name, category: row.category,
      sourceCategory: source.category, price: row.price, unitCost, prepMin: row.prep_min, memo: row.memo,
      saleStatus: row.sale_status, activeFrom: source.active_from ?? null, season: source.seasonal ?? null,
      recipeBase, groups: ordered(groupsByMenu(row.menu_id), 'sort_order').map(g => ({
        groupId: g.group_id, menuId: source.id, name: g.name, required: g.required, sortOrder: g.sort_order,
        options: optionsByGroup(g.group_id).map(o => ({
          optionId: o.option_id, groupId: g.group_id, name: o.name, extraPrice: o.extra_price,
          extraCost: o.extra_price > 0 ? null : 0, extraRecipe: [],
        })),
      })),
    };
  });
  const tables = ordered(rows.store_table, 'number').map(t => ({
    tableId: `T${t.number}`, dbId: t.table_id, layoutDbId: t.layout_id, number: t.number, seats: t.seats, x: t.grid_col, y: t.grid_row,
  }));
  const [store] = rows.store;
  const [layout] = rows.store_table_layout;
  return {
    store: {
      storeId: store.store_id, name: store.display_name, address: content.store.area, timezone: store.timezone,
      businessDayStart: store.business_day_start, businessType: store.business_type, paymentStyle: store.payment_style,
      posStartTab: store.pos_start_tab, hours: content.store.hours, seats: sumBy(tables, t => t.seats),
    },
    layout: { layoutId: layout.layout_id, gridColumns: layout.grid_columns, gridRows: layout.grid_rows, revision: layout.revision },
    tables, suppliers: ordered(suppliers, 'supplierId'), items: ordered(items, 'itemId'),
    menu: ordered(menus.filter(menu => menu.activeFrom === null || menu.activeFrom <= date), 'menuId'),
    inactiveMenu: ordered(menus.filter(menu => menu.activeFrom !== null && menu.activeFrom > date), 'menuId'),
  };
}

function transactionIndex(rows, catalog) {
  return {
    orders: group(rows.pos_order, 'business_day_id'), bills: mapBy(rows.bill, 'bill_id'),
    lines: group(rows.order_line, 'order_id'), options: group(rows.order_line_option, 'order_line_id'),
    allocations: group(rows.bill_allocation, 'bill_id'), settlements: group(rows.settlement_line, 'bill_id'),
    discounts: group(rows.bill_discount, 'origin_bill_id'), shares: group(rows.discount_allocation, 'allocation_id'),
    payments: group(rows.payment, 'bill_id'), splits: group(rows.payment_method_split, 'payment_id'),
    corrections: group(rows.payment_correction, 'payment_id'), correctionsByLine: group(rows.correction_line, 'correction_id'),
    correctionSplits: group(rows.correction_method_amount, 'correction_id'),
    correctionDiscounts: group(rows.correction_discount, 'correction_line_id'),
    reservations: mapBy(rows.reservation, 'reservation_id'), changes: group(rows.reservation_change, 'reservation_id'),
    uses: mapBy(rows.membership_use, 'use_id'), codes: mapBy(rows.coupon_code, 'code_id'),
    menu: mapBy([...catalog.menu, ...catalog.inactiveMenu], 'dbId'), tables: mapBy(catalog.tables, 'dbId'),
    expenses: group(rows.expense, 'business_date'),
  };
}

function projectDay(index, day, cutoff, withDetail = false) {
  const date = day.business_date;
  const visible = at => at !== null && at <= cutoff;
  const pos = {
    businessDate: date, revision: 0, seq: 0,
    cart: { cartId: 'cart:prepaid', revision: 0, type: 'dine_in', memo: '', lines: [], lock: null },
    orders: [], bills: [], billAllocations: [], payments: [], refunds: [], cancellations: [],
    receipts: [], cashReceipts: [], tableSessions: [], reservationPrompts: [],
    drawer: { opening: day.drawer_opening, actual: visible(day.drawer_counted_at) ? day.drawer_actual : null, memo: day.drawer_memo ?? '', movements: [] },
    commandLedger: [],
  };
  const rollup = {
    date, orders: 0, gross: 0, discount: 0, refund: 0, canceled: 0, cost: 0, net: 0, expenses: 0,
    byMethod: realAmounts(), methodCounts: realAmounts(), refundByMethod: realAmounts(), cancelByMethod: realAmounts(),
    discountBySource: { direct: 0, coupon: 0, membership: 0 }, paymentCount: 0, refundCount: 0, cancelCount: 0,
    hourly: Array(24).fill(0), menu: [], coupons: [], expectedDrawer: 0,
  };
  const salesByMenu = new Map(), couponSales = new Map();
  const bookings = [], visits = new Map();
  const menuMetrics = id => {
    if (!salesByMenu.has(id)) salesByMenu.set(id, { qty: 0, gross: 0, discount: 0, refund: 0, cost: 0 });
    return salesByMenu.get(id);
  };
  for (const order of ordered(index.orders(day.business_day_id), 'seq')) {
    if (!visible(order.ordered_at)) continue;
    const bill = requireRow(index.bills, order.origin_bill_id);
    const currentPayments = index.payments(bill.bill_id).filter(p => visible(p.paid_at));
    const corrections = currentPayments.flatMap(p => index.corrections(p.payment_id).filter(fix => visible(fix.at)));
    const cancelRows = corrections.filter(fix => fix.kind === 'cancel');
    const refundRows = corrections.filter(fix => fix.kind === 'refund');
    assert.equal(corrections.length, cancelRows.length + refundRows.length, 'Unsupported DB payment correction');
    const canceledLines = group(cancelRows.flatMap(fix => index.correctionsByLine(fix.correction_id)), 'allocation_id');
    const refundedLines = group(refundRows.flatMap(fix => index.correctionsByLine(fix.correction_id)), 'allocation_id');
    const allocationByLine = mapBy(index.allocations(bill.bill_id), 'order_line_id');
    rollup.orders++;
    rollup.hourly[hourOf(order.ordered_at)]++;
    if (bill.member_id && !cancelRows.length && !visits.has(bill.member_id)) visits.set(bill.member_id, hourOf(order.ordered_at));
    rollup.refundCount += refundRows.length;
    rollup.cancelCount += cancelRows.length;
    rollup.refund += sumAmount(refundRows);
    rollup.canceled += sumAmount(cancelRows);
    let billNet = 0;
    let billDiscount = 0;
    let billCost = 0;
    const recognized = visible(bill.recognized_at);
    const settlements = recognized ? index.settlements(bill.bill_id) : [];
    for (const line of settlements) {
      const menu = requireRow(index.menu, line.menu_id);
      const off = sumAmount(index.shares(line.allocation_id));
      const cancel = canceledLines(line.allocation_id);
      const fullGross = line.recognized_qty * (line.base_price_at_sale + line.option_price_at_sale);
      assert.ok(line.unit_cost_at_sale !== null && line.option_cost_at_sale !== null, 'Rollup requires known COGS');
      const qty = line.recognized_qty - sumBy(cancel, c => c.qty);
      const gross = fullGross - sumBy(cancel, c => c.gross);
      const discount = off - sumBy(cancel, c => c.discount);
      const refund = sumAmount(refundedLines(line.allocation_id));
      const cost = line.recognized_qty * (line.unit_cost_at_sale + line.option_cost_at_sale) - sumBy(cancel, c => c.cost);
      assert.equal(menu.unitCost, line.unit_cost_at_sale, `Recipe costing mismatch for ${menu.menuId}`);
      const totals = menuMetrics(menu.menuId);
      for (const [key, value] of Object.entries({ qty, gross, discount, refund, cost })) totals[key] += value;
      rollup.gross += gross;
      rollup.discount += discount;
      rollup.cost += cost;
      billNet += gross - discount - refund;
      billDiscount += discount;
      billCost += cost;
    }
    let paid = 0;
    for (const payment of currentPayments) {
      const splits = index.splits(payment.payment_id);
      assert.equal(sumAmount(splits), payment.amount);
      paid += payment.amount;
      rollup.paymentCount++;
      for (const split of splits) {
        assert.ok(Object.hasOwn(rollup.byMethod, split.method), `Unsupported DB payment method ${split.method}`);
        rollup.byMethod[split.method] += split.amount;
      }
      if (!cancelRows.some(fix => fix.payment_id === payment.payment_id)) rollup.methodCounts[payment.counted_method]++;
    }
    for (const fix of corrections) {
      const splits = index.correctionSplits(fix.correction_id);
      assert.equal(sumAmount(splits), fix.amount);
      const returned = fix.kind === 'cancel' ? rollup.cancelByMethod : rollup.refundByMethod;
      for (const split of splits) {
        rollup.byMethod[split.method] -= split.amount;
        returned[split.method] += split.amount;
      }
    }
    if (recognized) {
      assert.equal(billNet, paid - sumAmount(corrections), `Settlement/payment mismatch ${bill.bill_id}`);
      for (const discount of index.discounts(bill.bill_id)) {
        if (cancelRows.length) continue;
        tally(rollup.discountBySource, discount.source, discount.amount);
        if (!discount.coupon_code_id) continue;
        const data = couponSales.get(discount.coupon_code_id) ?? [0, 0, 0, 0];
        data[0]++;
        data[1] += billDiscount;
        data[2] += billNet;
        data[3] += billCost;
        couponSales.set(discount.coupon_code_id, data);
      }
    }

    if (!withDetail) continue;
    const cancellations = group(cancelRows.flatMap(fix => index.correctionsByLine(fix.correction_id)), 'order_line_id');
    pos.orders.push({
      orderId: order.order_id, orderNo: order.order_no, orderedAt: local(order.ordered_at), seq: order.seq,
      type: order.type, originBillId: order.origin_bill_id, memo: order.memo ?? '',
      preparation: cancelRows.length ? 'canceled' : visible(order.completed_at) ? 'completed' : visible(order.prepared_at) ? 'preparing' : 'accepted',
      preparedAt: visible(order.prepared_at) ? local(order.prepared_at) : null,
      completedAt: visible(order.completed_at) ? local(order.completed_at) : null, completedInRun: false,
      ...(order.reservation_id ? { reservationId: order.reservation_id } : {}),
      lines: index.lines(order.order_id).map(line => ({
        orderLineId: line.order_line_id, menuId: requireRow(index.menu, line.menu_id).menuId, nameAtOrder: line.name_at_order,
        qty: line.qty, unitPriceAtOrder: line.unit_price_at_order, request: line.request ?? '',
        canceledQty: sumBy(cancellations(line.order_line_id), fix => fix.qty),
        optionsAtOrder: index.options(line.order_line_id).map(option => {
          assert.deepEqual(option.extra_recipe, [], 'Add recipe adapter for DB option lines with stock effects');
          return { optionId: option.option_id, name: option.name, extraPrice: option.extra_price, extraRecipe: [] };
        }),
      })),
    });
    pos.seq = Math.max(pos.seq, order.seq);
    pos.billAllocations.push(...[...allocationByLine.values()].filter(a => visible(a.created_at)).map(a => ({
      allocationId: a.allocation_id, billId: a.bill_id, orderLineId: a.order_line_id, qty: a.qty,
    })));
    const discounts = recognized ? index.discounts(bill.bill_id) : [];
    pos.bills.push({
      billId: bill.bill_id, originOrderNo: order.order_no, tableId: bill.table_id ? requireRow(index.tables, bill.table_id).tableId : null,
      status: recognized ? 'paid' : paid ? 'partial' : 'open', memberLinkChosen: bill.member_link_chosen,
      ...(bill.member_id ? { memberId: bill.member_id } : {}), ...(bill.reservation_id ? { reservationId: bill.reservation_id } : {}),
      ...(visible(bill.requested_at) ? { requestedAt: local(bill.requested_at) } : {}),
      ...(visible(bill.settled_at) ? { settledAt: local(bill.settled_at) } : {}),
      ...(recognized ? { recognizedAt: local(bill.recognized_at) } : {}),
      discounts: discounts.map(d => {
        assert.ok(['direct', 'coupon', 'membership'].includes(d.source), `Unsupported DB discount ${d.source}`);
        const allocations = settlements.flatMap(line => index.shares(line.allocation_id)
          .filter(share => share.discount_id === d.discount_id)
          .map(share => ({ allocationId: share.allocation_id, amount: share.amount })));
        assert.equal(sumAmount(allocations), d.amount);
        return {
          discountId: d.discount_id, billId: bill.bill_id, source: d.source, scope: d.scope, amount: d.amount,
          ...(d.percent !== null ? { percent: d.percent } : {}),
          ...(d.coupon_code_id ? { codeId: d.coupon_code_id, couponId: requireRow(index.codes, d.coupon_code_id).coupon_id } : {}),
          ...(d.membership_use_id ? { useId: d.membership_use_id, membershipId: requireRow(index.uses, d.membership_use_id).membership_id } : {}),
          ...(d.contribution_member_id ? { contributionMemberId: d.contribution_member_id } : {}),
          ...(d.scope === 'line' && allocations.length === 1 ? { allocationId: allocations[0].allocationId } : {}),
          reason: d.reason ?? '', fixedAllocations: allocations,
        };
      }),
      settlementLines: settlements.map(line => ({
        allocationId: line.allocation_id, menuId: requireRow(index.menu, line.menu_id).menuId, qty: line.qty,
        basePriceAtSale: line.base_price_at_sale, optionPriceAtSale: line.option_price_at_sale,
        unitCostAtSale: line.unit_cost_at_sale, optionCostAtSale: line.option_cost_at_sale, recognizedQty: line.recognized_qty,
        discountAllocations: index.shares(line.allocation_id).map(share => ({ discountId: share.discount_id, amount: share.amount })),
      })),
    });
    for (const payment of currentPayments) {
      pos.payments.push({
        paymentId: payment.payment_id, billId: bill.bill_id, at: local(payment.paid_at), seq: payment.seq,
        transactionNo: payment.transaction_no, approvalNo: payment.approval_no ?? '', amount: payment.amount,
        splits: index.splits(payment.payment_id).map(({ method, amount }) => ({ method, amount })), countedMethod: payment.counted_method,
        status: cancelRows.some(fix => fix.payment_id === payment.payment_id) ? 'canceled' : 'paid',
        recognizedAt: visible(payment.recognized_at) ? local(payment.recognized_at) : null,
      });
      pos.receipts.push({ paymentId: payment.payment_id, billId: bill.bill_id });
      pos.seq = Math.max(pos.seq, payment.seq);
    }
    for (const fix of corrections) {
      const fields = {
        paymentId: fix.payment_id, billId: bill.bill_id, at: local(fix.at), seq: fix.seq, amount: fix.amount,
        methodAmounts: index.correctionSplits(fix.correction_id).map(({ method, amount }) => ({ method, amount })), reason: fix.reason,
      };
      if (fix.kind === 'refund') pos.refunds.push({
        ...fields, refundId: fix.correction_id, lineAmounts: index.correctionsByLine(fix.correction_id).map(l => ({
          orderLineId: l.order_line_id, qty: l.qty, amount: l.amount,
        })),
      });
      else pos.cancellations.push({
        ...fields, cancellationId: fix.correction_id, restockRetail: fix.restock_retail,
        allocations: index.correctionsByLine(fix.correction_id).map(l => ({
          lineId: l.order_line_id, allocationId: l.allocation_id, qty: l.qty, gross: l.gross, discount: l.discount, cost: l.cost,
          discountAllocations: index.correctionDiscounts(l.correction_line_id).map(d => ({ discountId: d.discount_id, amount: d.amount })),
        })),
      });
      pos.seq = Math.max(pos.seq, fix.seq);
    }
    if (bill.reservation_id) {
      const reservation = requireRow(index.reservations, bill.reservation_id);
      const change = ordered(index.changes(reservation.reservation_id).filter(c => visible(c.at)), 'at').at(-1);
      const at = local(reservation.start_at);
      bookings.push({
        reservationId: reservation.reservation_id, date, time: at.slice(11, 16), at,
        memberId: reservation.member_id, status: change?.after.status ?? 'confirmed', source: reservation.source,
        partySize: reservation.party_size, tableId: requireRow(index.tables, reservation.table_id).tableId,
        assignmentMode: reservation.assignment_mode, capacityOverride: reservation.capacity_override,
        confirmedBy: reservation.confirmed_by, firstOrderId: order.order_id,
      });
      pos.reservationPrompts.push({ reservationId: reservation.reservation_id, billId: bill.bill_id, firstOrderId: order.order_id, decision: bill.reservation_decision });
    }
  }
  rollup.expenses = sumAmount(index.expenses(date).filter(e => visible(e.created_at)));
  rollup.net = rollup.gross - rollup.discount - rollup.refund;
  rollup.expectedDrawer = day.drawer_opening + rollup.byMethod.cash;
  assert.equal(rollup.net, sumBy(Object.values(rollup.byMethod), n => n), `Daily net mismatch ${date}`);
  rollup.menu = [...salesByMenu].sort(([a], [b]) => compare(a, b)).map(([id, totals]) =>
    [id, totals.qty, totals.gross, totals.discount, totals.refund, totals.cost]);
  rollup.coupons = [...couponSales].sort(([a], [b]) => compare(a, b)).map(([id, totals]) => [id, ...totals]);
  return { pos, rollup, bookings, visits };
}

function buildMembers(rows, start, date, cutoff, visitsToday) {
  const customers = mapBy(rows.customer, 'customer_id');
  const visits = group(rows.customer_visit.filter(row => row.business_date < date), 'customer_id');
  const dayOffset = day => (Date.parse(day) - Date.parse(start)) / DAY_MS;
  return {
    start,
    members: ordered(rows.member_profile, 'member_code').map(p => {
      const customer = requireRow(customers, p.customer_id);
      const earlier = visits(p.customer_id).map(row => dayOffset(row.business_date) * 24 + row.first_hour);
      if (visitsToday.has(p.member_id)) earlier.push(dayOffset(date) * 24 + visitsToday.get(p.member_id));
      return {
        memberId: p.member_id, customerId: p.customer_id, code: p.member_code, joinedOn: p.joined_on,
        maskedName: `가○손님${p.member_code.slice(2)}`, phoneLast4: customer.phone_last4,
        consentSms: customer.consent_sms && customer.consent_sms_at <= cutoff, consentNight: customer.consent_night,
        visits: earlier.sort((a, b) => a - b),
      };
    }),
  };
}

function buildOperations(content, rows, catalog, id, date, cutoff) {
  const membersByCustomer = mapBy(rows.member_profile, 'customer_id');
  const itemsByDbId = mapBy(catalog.items, 'dbId');
  const suppliersByDbId = mapBy(catalog.suppliers, 'dbId');
  const purchaseLines = group(rows.purchase_order_line, 'po_id');
  const receipts = group(rows.goods_receipt, 'pol_id');
  const movements = mapBy(rows.stock_movement, 'receipt_id');
  const purchaseOrders = ordered(rows.purchase_order.filter(row => row.created_at <= cutoff), 'due_date', 'expected_time', 'po_id').map(po => {
    const supplier = requireRow(suppliersByDbId, po.supplier_id);
    const lines = ordered(purchaseLines(po.po_id), 'pol_id').map(line => ({
      polId: line.pol_id, itemId: requireRow(itemsByDbId, line.item_id).itemId,
      unit: line.unit_snapshot, basePerUnit: line.base_per_unit, qtyOrdered: line.qty_ordered,
      unitPrice: line.unit_price, itemName: line.item_name_snapshot,
      receipts: ordered(receipts(line.pol_id).filter(r => r.received_at <= cutoff), 'received_at', 'receipt_id').map(r => {
        const movement = requireRow(movements, r.receipt_id);
        assert.equal(movement.delta_base, r.qty * line.base_per_unit);
        return {
          receiptId: r.receipt_id, qty: r.qty, receivedAt: local(r.received_at), idempotencyKey: r.idempotency_key,
          movementId: movement.movement_id, movementKey: movement.idempotency_key,
        };
      }),
    }));
    const received = sumBy(lines, line => sumBy(line.receipts, r => r.qty));
    const complete = lines.every(line => sumBy(line.receipts, r => r.qty) === line.qtyOrdered);
    return {
      poId: po.po_id, supplierId: supplier.supplierId, orderedOn: po.ordered_on, dueDate: po.due_date,
      expectedTime: po.expected_time, status: complete ? 'complete' : received ? 'partial' : 'scheduled', lines,
    };
  });
  const expenses = ordered(rows.expense.filter(e => e.created_at <= cutoff), 'business_date', 'expense_id').map(e => ({
    expenseId: e.expense_id, businessDate: e.business_date, category: e.category, amount: e.amount,
    supplierId: e.supplier_id ? requireRow(suppliersByDbId, e.supplier_id).supplierId : null,
    receiptId: e.receipt_id, evidence: e.evidence, status: e.status, taxCheck: e.tax_check, memo: e.memo,
  }));
  const sourceContent = (list, key) => new Map(list.map((entry, i) => [id(`${key}:${i}`), entry]));
  const productSource = sourceContent(content.memberships, 'product');
  const membershipProducts = rows.membership_product.map(p => ({
    productId: p.product_id, name: p.name, kind: p.kind, uses: p.uses, validDays: p.valid_days, dailyLimit: p.daily_limit, price: p.price,
    menuId: requireRow(productSource, p.product_id).menu,
  }));
  const membershipUses = ordered(rows.membership_use.filter(u => u.used_at <= cutoff), 'used_at', 'use_id').map(u => ({
    useId: u.use_id, membershipId: u.membership_id, usedAt: local(u.used_at),
    canceledAt: u.canceled_at && u.canceled_at <= cutoff ? local(u.canceled_at) : null,
  }));
  const usesFor = group(membershipUses, 'membershipId');
  const products = mapBy(membershipProducts, 'productId');
  const memberships = ordered(rows.membership.filter(p => p.starts_on <= date), 'membership_id').map(p => {
    const product = requireRow(products, p.product_id);
    const usesLeft = product.uses - usesFor(p.membership_id).filter(u => !u.canceledAt).length;
    return {
      membershipId: p.membership_id, customerId: p.customer_id, memberId: requireRow(membersByCustomer, p.customer_id).member_id,
      productId: p.product_id, startsOn: p.starts_on, endsOn: p.ends_on, usesLeft, status: usesLeft > 0 && p.ends_on >= date ? 'active' : 'ended',
    };
  });
  const couponSource = sourceContent(content.coupons, 'coupon');
  const coupons = ordered(rows.coupon, 'starts_on', 'coupon_id').map(c => ({
    couponId: c.coupon_id, name: c.name, kind: c.benefit_type, value: c.benefit_value, scope: 'bill',
    startsOn: c.starts_on, endsOn: c.ends_on, sourceChannel: requireRow(couponSource, c.coupon_id).channel,
    status: date < c.starts_on ? 'scheduled' : date > c.ends_on ? 'ended' : 'active',
  }));
  const couponCodes = ordered(rows.coupon_code, 'code').map(c => ({
    codeId: c.code_id, couponId: c.coupon_id, code: c.code, route: c.route, issueCount: c.issue_count, activatedAt: local(c.activated_at),
  }));

  const authoredThreads = new Map([...sourceContent(content.reviews, 'review'), ...sourceContent(content.inquiries, 'inquiry')]);
  const threads = ordered(rows.inquiry_thread.filter(t => t.received_at <= cutoff), 'received_at', 'thread_id').map(t => {
    const source = requireRow(authoredThreads, t.thread_id);
    return {
      threadId: t.thread_id, type: t.type, channel: t.channel, isPublic: t.is_public, receivedAt: local(t.received_at),
      status: t.status, body: source.text, topic: source.topic ?? null, customerId: t.customer_id,
      rating: t.rating, sentiment: t.sentiment,
    };
  });
  const steps = group(rows.manual_step, 'manual_id');
  const manuals = ordered(rows.manual, 'manual_id').map(m => ({
    manualId: m.manual_id, section: m.section, category: m.category, title: m.title, cautions: m.cautions,
    isPublished: m.is_published, updatedAt: local(m.updated_at),
    steps: ordered(steps(m.manual_id), 'step_no').map(s => ({ stepNo: s.step_no, body: s.body })),
  }));
  const localEvents = sourceContent(content.local_events, 'local-event');
  const calendar = ordered(rows.calendar_event, 'date', 'event_id').map(e => ({
    eventId: e.event_id, kind: e.kind, category: e.category, title: e.title, date: e.date, time: e.time,
    closureKind: e.closure_kind, closureEndDate: e.closure_end_date,
    ...(localEvents.has(e.event_id) ? { localRange: [localEvents.get(e.event_id).start, localEvents.get(e.event_id).end] } : {}),
  }));
  return { purchaseOrders, expenses, membershipProducts, memberships, membershipUses, coupons, couponCodes, threads, manuals, calendar };
}

function buildStock(rows, content, catalog, date, cutoff, today) {
  const itemByDbId = mapBy(catalog.items, 'dbId');
  const menu = mapBy(catalog.menu, 'menuId');
  const openings = rows.stock_daily_opening.filter(row => row.business_date === date);
  const movements = group(rows.stock_movement.filter(row => row.at <= cutoff && businessDateAt(row.at, content.store) === date), 'item_id');
  const ingredientUse = {};
  for (const [menuId, qty] of today.rollup.menu) {
    for (const part of requireRow(menu, menuId).recipeBase) tally(ingredientUse, part.itemId, part.quantityBase * qty);
  }
  return ordered(openings.map(row => {
    const item = requireRow(itemByDbId, row.item_id);
    assert.equal(row.channel, 'store', 'Add a channel-aware recipe usage adapter');
    const receipts = sumBy(movements(item.dbId), m => m.delta_base);
    const usage = ingredientUse[item.itemId] ?? 0;
    const onHand = row.quantity_base + receipts - usage;
    assert.ok(!item.trackRestock || onHand >= 0, `Negative cutoff stock for ${item.itemId}`);
    return { itemId: item.itemId, channel: row.channel, opening: row.quantity_base, receipts, usage, onHand };
  }), 'itemId', 'channel');
}

function addProvenance(data) {
  return Object.fromEntries(Object.entries(data).map(([section, records]) =>
    [section, records.map(record => ({ ...record, provenance: 'sample' }))]));
}

function buildSupplement(input, content, catalog, operations, members, today, cutoffTime) {
  const date = today.pos.businessDate;
  const day = n => shiftDay(date, n);
  const shortTime = cutoffTime.slice(0, 5);
  const now = `${date}T${cutoffTime}`;
  const menu = mapBy(catalog.menu, 'menuId');
  const item = mapBy(catalog.items, 'itemId');
  const stock = mapBy(today.stock, 'itemId');
  const member = mapBy(members.members, 'code');
  const staffById = mapBy(input.staff, 'staffId');
  const memberFields = code => {
    const row = requireRow(member, code);
    return { memberId: row.memberId, customerId: row.customerId, memberName: row.maskedName, phoneLast4: row.phoneLast4 };
  };
  const assertHours = (date, start, end) => {
    assert.ok([start, end].every(time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)), 'Invalid sample time');
    const [open, close] = catalog.store.hours[weekday(date)];
    assert.ok(open <= start && start < end && end <= close, `Sample interval outside store hours: ${date} ${start} ${end}`);
  };
  const roleRows = { manager: content.staff.find(row => row.role === '매니저'), hourly: content.staff.find(row => row.role === '알바') };
  assert.equal(staffById.size, input.staff.length, 'Duplicate sample staff ID');
  for (const [role, model] of Object.entries(roleRows)) {
    assert.equal(input.staff.filter(row => row.role === role).length, model?.count);
  }
  const staff = input.staff.map(s => ({ ...s, hourlyWage: requireRow(new Map(Object.entries(roleRows)), s.role).hourly_wage ?? null }));
  const shifts = input.shifts.map(({ staffId, day: offset, start, end }) => {
    requireRow(staffById, staffId);
    const date = day(offset);
    assertHours(date, start, end);
    return { shiftId: `sample-shift:${staffId}:${date}:${start}`, staffId, date, start, end };
  });
  const staffShifts = group(shifts, 'staffId');
  for (const shift of shifts) assert.ok(!staffShifts(shift.staffId).some(other =>
    other !== shift && other.date === shift.date && other.start < shift.end && shift.start < other.end), 'Overlapping sample shifts');

  const bookingTables = ordered(catalog.tables, 'seats', 'number');
  const bookings = [];
  for (const { id, memberCode, ...booking } of ordered(input.bookings, 'start', 'id')) {
    assertHours(date, booking.start, booking.end);
    assert.ok(booking.start > shortTime && Number.isInteger(booking.partySize) && booking.partySize > 0);
    const occupied = bookings.filter(b => b.start < booking.end && booking.start < b.end);
    const table = bookingTables.find(table => table.seats >= booking.partySize && !occupied.some(b => b.tableId === table.tableId));
    assert.ok(table, `Sample booking exceeds available table capacity: ${id}`);
    bookings.push({ reservationId: id, date, ...booking, ...memberFields(memberCode), tableId: table.tableId });
  }
  const products = mapBy(operations.membershipProducts, 'menuId');
  const activePasses = input.activePasses.map(({ id, memberCode, menuId, daysAgo, usesLeft }) => {
    requireRow(menu, menuId);
    // More than one count pass may cover the same menu. Choose the lowest-priced catalog product.
    const product = ordered(operations.membershipProducts.filter(row => row.menuId === menuId), 'price', 'productId')[0];
    assert.ok(products.has(menuId) && product.validDays > daysAgo && daysAgo >= 0 && usesLeft > 0 && usesLeft <= product.uses);
    const startsOn = day(-daysAgo);
    return { membershipId: id, ...memberFields(memberCode), menuId, productId: product.productId, startsOn,
      endsOn: shiftDay(startsOn, product.validDays - 1), usesLeft, status: 'active' };
  });
  const balances = input.balances.map(({ memberCode, chargeBalance, receivableBalance }) => {
    assert.ok([chargeBalance, receivableBalance].every(value => Number.isSafeInteger(value) && value >= 0));
    return { ...memberFields(memberCode), chargeBalance, receivableBalance };
  });
  const calendar = input.calendar.map(({ day: offset, ...event }) => ({ ...event, date: day(offset), kind: 'event' }));
  const localChanges = input.localChanges.map(({ day: offset, throughDay, ...change }) => ({
    ...change, startDate: day(offset), endDate: throughDay === null ? null : day(throughDay), updatedAt: now,
  }));
  const taxPayments = input.taxPayments.map(({ sampleRate, ...tax }) => {
    const source = operations.expenses.filter(row => row.businessDate.startsWith(tax.basisMonth) && row.category === tax.basisCategory);
    const basisAmount = sumAmount(source);
    assert.ok(tax.dueOn > date && basisAmount > 0 && sampleRate > 0 && sampleRate <= 1);
    return { ...tax, basisAmount, amount: Math.round(basisAmount * sampleRate), paidOn: null, status: 'unpaid' };
  });
  const grants = input.grants.map(grant => {
    assert.ok(grant.applyStart <= date && date < grant.applyEnd);
    return grant;
  });
  const customOrders = input.customOrders.map(({ memberCode, menuId, pickupDay, ...order }) => {
    const product = requireRow(menu, menuId);
    const pickupDate = day(pickupDay);
    const [open, close] = catalog.store.hours[weekday(pickupDate)];
    assert.ok(open <= order.pickupTime && order.pickupTime < close && Number.isSafeInteger(order.quantity) && order.quantity > 0);
    return { ...order, ...memberFields(memberCode), menuId, menuName: product.name, quoteAmount: product.price * order.quantity, pickupDate, receivedAt: now };
  });
  const expiryQuantities = {};
  const expiryBatches = input.expiryBatches.map(batch => {
    const ingredient = requireRow(item, batch.itemId);
    const product = requireRow(menu, batch.menuId);
    assert.ok(ingredient.trackRestock && product.recipeBase.some(part => part.itemId === ingredient.itemId) && batch.quantityBase > 0);
    tally(expiryQuantities, ingredient.itemId, batch.quantityBase);
    assert.ok(expiryQuantities[ingredient.itemId] <= requireRow(stock, ingredient.itemId).onHand);
    return { ...batch, expiresOn: date };
  });
  const promos = input.promos.map(promo => ({
    ...promo, menuName: requireRow(menu, promo.menuId).name, storeName: catalog.store.name, createdAt: now,
  }));

  const hour = Number(shortTime.slice(0, 2));
  const openHour = Number(catalog.store.hours[weekday(date)][0].slice(0, 2));
  const cctv = [];
  for (let h = openHour; h <= hour; h++) {
    const orderCount = today.rollup.hourly[h];
    cctv.push({ date, hour: h, orderCount, unit: 'visits', entries: Math.round(orderCount * input.cctv.visitsPerOrder),
      dwellMinutes: input.cctv.dwellMinutes[(h - openHour) % input.cctv.dwellMinutes.length], status: h === hour ? 'partial' : 'ok' });
  }
  assert.ok(Number.isFinite(input.cctv.visitsPerOrder) && input.cctv.visitsPerOrder > 0 && input.cctv.visitsPerOrder !== 1);
  assert.ok(input.cctv.dwellMinutes.length && input.cctv.dwellMinutes.every(value => Number.isFinite(value) && value > 0));
  const occupancy = input.cctv.occupancy.map(row => ({ ...row, at: now }));
  assert.equal(sumBy(occupancy, row => row.seats), catalog.store.seats);
  assert.ok(occupancy.every(row => row.occupied >= 0 && row.occupied <= row.seats));
  // D-313 sample values do not create sales, payment, or expense events.
  return addProvenance({
    staff, shifts: ordered(shifts, 'date', 'start', 'staffId'), bookings, activePasses, balances, calendar, localChanges,
    tradeArea: input.tradeArea.map(row => ({ ...row, date })),
    trends: input.trends.map(row => ({ ...row, date, priorDate: day(-7) })), taxPayments, grants,
    environment: input.environment.map(row => ({ ...row, measuredAt: now })),
    notices: input.notices.map(row => ({ ...row, createdAt: now, status: 'draft' })),
    customOrders, expiryBatches, promos, cctv, occupancy,
    cameras: input.cctv.cameras.map(row => ({ ...row, lastCheckedAt: now, connection: 'connected' })),
    onDuty: [{ date, count: shifts.filter(row => row.date === date && row.start <= shortTime && shortTime < row.end).length }],
    community: input.community.map(({ startDay, endDay, ...row }) => ({ ...row, startsOn: day(startDay), endsOn: day(endDay) })),
  });
}

function moduleText(name, value, { imports = '', suffix = ' as const' } = {}) {
  // Keep the generated diff to one record per line without making the source payload large.
  const array = (rows, indent) => rows.length ? `[\n${rows.map(row => indent + json(row)).join(',\n')}\n${indent.slice(2)}]` : '[]';
  const object = entries => `{\n${entries.map(([key, value]) => `  ${json(key)}: ${Array.isArray(value) ? array(value, '    ') : json(value)}`).join(',\n')}\n}`;
  const literal = Array.isArray(value) ? array(value, '  ') : object(Object.entries(value));
  return `// Generated by npm run seed:generate.\n${imports}export const ${name} = ${literal}${suffix}\n`;
}

// Intern object shapes and repeated strings in large eager modules. UUIDs, prices and timestamps
// come back verbatim. The regular catalog and feature data stay directly readable as source.
function packedModuleText(name, value, type, imports = '') {
  const occurrences = new Map();
  function count(value) {
    if (typeof value === 'string') occurrences.set(value, (occurrences.get(value) ?? 0) + 1);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(count);
  }
  count(value);
  const strings = [...occurrences].filter(([value, count]) => value.length >= 11 && count >= 3).map(([value]) => value).sort();
  const stringIndex = new Map(strings.map((value, index) => [value, index]));
  const shapes = [];
  const shapeIndex = new Map();
  function pack(value) {
    if (stringIndex.has(value)) return [-1, stringIndex.get(value)];
    if (Array.isArray(value)) return [0, ...value.map(pack)];
    if (!value || typeof value !== 'object') return value;

    const keys = Object.keys(value);
    const signature = json(keys);
    if (!shapeIndex.has(signature)) {
      shapeIndex.set(signature, shapes.length);
      shapes.push(keys);
    }
    return [shapeIndex.get(signature) + 1, ...Object.values(value).map(pack)];
  }
  const root = pack(value);
  // Partition the top-level object into lines to keep diff and editor navigation workable.
  const payload = root.map(child => json(child)).join(',\n');
  return `// Generated by npm run seed:generate.
${imports}
type Packed = string | number | boolean | null | readonly Packed[];
const strings: readonly string[] = ${json(strings)};
const shapes: readonly (readonly string[])[] = ${json(shapes)};
const payload: Packed = [${payload}];

function decode(value: Packed): unknown {
  if (!Array.isArray(value)) return value;
  const [tag, ...parts] = value;
  if (tag === -1) return strings[parts[0] as number];
  if (tag === 0) return parts.map(decode);
  return Object.fromEntries(shapes[tag - 1].map((key, index) => [key, decode(parts[index])]));
}
export const ${name} = decode(payload) as ${type};
`;
}

const rollupFields = `
type RealAmounts = Readonly<Record<'card' | 'easy_pay' | 'cash', number>>;
interface CafeDay {
  readonly date: string;
  readonly orders: number;
  readonly gross: number;
  readonly discount: number;
  readonly refund: number;
  readonly canceled: number;
  readonly cost: number;
  readonly net: number;
  readonly expenses: number;
  readonly byMethod: RealAmounts;
  readonly methodCounts: RealAmounts;
  readonly refundByMethod: RealAmounts;
  readonly cancelByMethod: RealAmounts;
  readonly discountBySource: Readonly<Record<'direct' | 'coupon' | 'membership', number>>;
  readonly paymentCount: number;
  readonly refundCount: number;
  readonly cancelCount: number;
  readonly hourly: readonly number[];
  /** Menu ID, quantity, gross, discount, refund, cost. */
  readonly menu: readonly (readonly [string, number, number, number, number, number])[];
  /** Code ID, redemptions, discount, associated net, associated cost. */
  readonly coupons: readonly (readonly [string, number, number, number, number])[];
  readonly expectedDrawer: number;
}
`;

const todayFields = `import type { PosState } from '../../../contracts/pos';
${rollupFields}
interface CafeToday {
  readonly pos: PosState;
  readonly rollup: CafeDay;
  readonly bookings: readonly {
    readonly reservationId: string;
    readonly date: string;
    readonly time: string;
    readonly at: string;
    readonly memberId: string;
    readonly status: 'confirmed' | 'completed' | 'canceled';
    readonly source: 'direct';
    readonly partySize: number;
    readonly tableId: string;
    readonly assignmentMode: 'auto';
    readonly capacityOverride: boolean;
    readonly confirmedBy: 'auto';
    readonly firstOrderId: string;
  }[];
  readonly stock: readonly {
    readonly itemId: string;
    readonly channel: 'store';
    readonly opening: number;
    readonly receipts: number;
    readonly usage: number;
    readonly onHand: number;
  }[];
}
`;

const memberFields = `
interface CafeMembers {
  readonly start: string;
  readonly members: readonly {
    readonly memberId: string;
    readonly customerId: string;
    readonly code: string;
    readonly joinedOn: string;
    readonly maskedName: string;
    readonly phoneLast4: string;
    readonly consentSms: boolean;
    readonly consentNight: boolean;
    /** (Days since start) × 24 + first local hour. */
    readonly visits: readonly number[];
  }[];
}
`;

export function buildSeedFiles(inputs) {
  const content = JSON.parse(inputs.contentSource);
  const config = JSON.parse(inputs.configSource);
  const supplementInput = JSON.parse(inputs.supplementSource);
  const { formatVersion, generator, cutoffTime } = config;
  assert.equal(formatVersion, 1);
  assert.deepEqual(Object.keys(generator).sort(), ['days', 'end', 'seed']);
  assert.match(cutoffTime, /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/);
  assert.equal(content.store.timezone, 'Asia/Seoul', 'Update the app timestamp adapter to support a different timezone');
  const date = generator.end;
  const cutoff = atCutoff(date, cutoffTime);
  assert.equal(date, businessDateAt(cutoff, content.store));
  const id = key => dbId(generator.seed, key);

  const { rows, summary } = generate(content, generator);
  const catalog = buildCatalog(content, rows, id, date);
  const index = transactionIndex(rows, catalog);
  const orderedDays = ordered(rows.business_day, 'business_date');
  const dayByDate = mapBy(orderedDays, 'business_date');
  const sameWeekday = shiftDay(date, -7);
  const today = projectDay(index, requireRow(dayByDate, date), cutoff, true);
  const members = buildMembers(rows, summary.config.start, date, cutoff, today.visits);
  delete today.visits;
  today.stock = buildStock(rows, content, catalog, date, cutoff, today);
  const daySnapshots = mapBy(summary.daily, 'date');
  const history = {
    comparison: projectDay(index, requireRow(dayByDate, sameWeekday), atCutoff(sameWeekday, cutoffTime)).rollup,
    // DB input uses the whole last business day. The app loads that date from today.ts.
    days: orderedDays.filter(day => day.business_date < date).map(day => {
      const { rollup } = projectDay(index, day, '\uffff');
      const expected = requireRow(daySnapshots, day.business_date);
      assert.deepEqual(rollup.byMethod, expected.byMethod);
      assert.equal(rollup.net, expected.netSales);
      assert.equal(rollup.orders, expected.orders);
      assert.equal(rollup.paymentCount, expected.paymentCount);
      assert.equal(rollup.cancelCount, expected.cancelCount);
      assert.equal(rollup.refundCount, expected.refundCount);
      return rollup;
    }),
  };
  const dayById = mapBy(orderedDays, 'business_day_id');
  const closingHistory = ordered(rows.day_closing.filter(c => c.closed_at <= cutoff), 'closed_at', 'closing_id').map(c => ({
    closingId: c.closing_id, businessDate: requireRow(dayById, c.business_day_id).business_date, generation: c.generation,
    status: c.status, basedOnRevision: c.based_on_revision, closedAt: local(c.closed_at), reopenedAt: local(c.reopened_at),
    salesSnapshot: c.sales_snapshot, drawerSnapshot: c.drawer_snapshot, posTotalsSnapshot: c.pos_totals_snapshot,
  }));
  const operations = buildOperations(content, rows, catalog, id, date, cutoff);
  const supplier = mapBy(catalog.suppliers, 'supplierId');
  const deliveries = operations.purchaseOrders.filter(po => po.dueDate >= date && po.dueDate <= shiftDay(date, 7)).map(po => ({
    poId: po.poId, supplierId: po.supplierId, date: po.dueDate, time: po.expectedTime, status: po.status,
    title: `${requireRow(supplier, po.supplierId).name} 입고`,
  }));
  const supplement = buildSupplement(supplementInput, content, catalog, operations, members, today, cutoffTime);
  const files = new Map([
    ['catalog.ts', moduleText('seedCatalog', catalog)],
    ['today.ts', packedModuleText('seedToday', today, 'CafeToday', todayFields)],
    ['history.ts', packedModuleText('seedHistory', history, '{ readonly comparison: CafeDay; readonly days: readonly CafeDay[] }', rollupFields)],
    ['members.ts', packedModuleText('seedMembers', members, 'CafeMembers', memberFields)],
    ['closing-history.ts', moduleText('seedClosingHistory', closingHistory)],
    ['operations.ts', moduleText('seedOperations', { ...operations, deliveries }, { suffix: '' })],
    ['supplement.ts', moduleText('seedSupplement', supplement)],
    ['widget-drafts.json', formatJson({
      grants: supplement.grants,
      manuals: operations.manuals.map(({ manualId, title, category, cautions, steps }) =>
        ({ manualId, title, category, cautions, steps: steps.map(step => step.body) })),
      threads: operations.threads.map(({ threadId, type, body, sentiment }) => ({ threadId, type, body, sentiment })),
    })],
  ]);
  const digests = {
    content: sha256(inputs.contentSource), supplement: sha256(inputs.supplementSource),
    config: sha256(inputs.configSource), dbGenerator: sha256(inputs.generatorSource), appGenerator: sha256(inputs.adapterSource),
  };
  const manifest = {
    formatVersion, snapshotSha256: sha256(json(digests)), sha256: digests,
    generator: { name: summary.generator, start: summary.config.start, ...generator },
    cutoff: { businessDate: date, localTime: cutoffTime, utc: cutoff },
    comparison: { businessDate: sameWeekday, localTime: cutoffTime },
    store: catalog.store,
    latteRecipe: catalog.menu.find(row => row.menuId === 'm-cafe-latte').recipeBase,
    counts: {
      dbRows: summary.totalRows, historicalDays: history.days.length, payments: today.pos.payments.length,
      menu: catalog.menu.length, members: members.members.length, closings: closingHistory.length,
    },
    files: Object.fromEntries([...files].map(([name, contents]) => [name, {
      sha256: sha256(contents), bytes: Buffer.byteLength(contents),
    }])),
  };
  files.set('manifest.json', formatJson(manifest));
  return files;
}

export async function publishSeedFiles(directory, files, { check = false } = {}) {
  const current = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const unexpected = current.filter(name => !files.has(name)).sort();
  if (check) {
    const mismatches = await Promise.all([...files].map(async ([name, expected]) => {
      const actual = await readText(join(directory, name)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      return actual === expected ? null : name;
    }));
    const drift = [...mismatches.filter(Boolean), ...unexpected];
    assert.equal(drift.length, 0, `Generated seed drift: ${drift.join(', ')}. Run npm run seed:generate and review the manifest.`);
    return;
  }
  assert.equal(unexpected.length, 0, `Unexpected files in generated seed directory: ${unexpected.join(', ')}`);
  await mkdir(directory, { recursive: true });
  // Stage every file before replacing any output. Publish the manifest last.
  const staging = await mkdtemp(join(dirname(directory), '.seed-build-'));
  try {
    await Promise.all([...files].map(([name, contents]) => writeFile(join(staging, name), contents)));
    for (const name of files.keys()) await rename(join(staging, name), join(directory, name));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main(args) {
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'Usage: seed-from-content.mjs [--check]');
  const files = buildSeedFiles(await readSeedInputs());
  const check = args[0] === '--check';
  await publishSeedFiles(outputPath, files, { check });
  const manifest = JSON.parse(files.get('manifest.json'));
  console.log(`${check ? 'Checked' : 'Generated'} ${files.size} cafe seed files (${manifest.snapshotSha256})`);
  console.log(json({ counts: manifest.counts, sizes: Object.fromEntries(Object.entries(manifest.files).map(([name, { bytes }]) => [name, { bytes, gzipBytes: gzipSync(files.get(name)).length }])) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
