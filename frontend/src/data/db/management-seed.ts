import type { DataTables, DataText, MenuItem, Reservation } from './types';
import type { BaseUnit, ManagementTables, Payment, PaymentLine, RecipeLine } from './management-types';
import { addDays } from './time';
const TODAY = '2026-10-26';
const LATTE_RECIPE = { beansG: 24, milkMl: 300 };
import { paymentDailyAdapters } from '../derive/payments';
import { createPosSeedCatalog } from '../../pos/seed/legacy';
import type { PosMenuPhotoKey } from '../../contracts/pos';

type LegacyTables = Omit<DataTables, keyof ManagementTables>;
const key = (key: string): DataText => ({ key });
const cid = (n: number) => `mc-${String(n).padStart(2, '0')}`;
const mid = (n: number) => `M-${String(n).padStart(4, '0')}`;
const menuSeed = [
  ['m-americano', 'data.menu.americano', 4_500, 700, 'drink', 'data.management.menuMemo.americano', 3],
  ['m-latte', 'data.menu.latte', 5_000, 1_750, 'drink', 'data.management.menuMemo.latte', 4],
  ['m-vanilla', 'data.menu.vanillaLatte', 5_500, 2_000, 'drink', null, 4],
  ['m-croissant', 'data.item.croissant', 3_500, 1_200, 'dessert', 'data.management.menuMemo.croissant', 2],
  ['m-financier', 'data.item.financier', 3_000, 1_000, 'dessert', null, 1],
  ['m-beans200', 'data.item.beans200', 12_000, 6_000, 'retail', null, 1],
  ['m-dripbag', 'data.item.dripBagSet', 15_000, 7_500, 'retail', null, 1],
] as const;
const seededMenuPhotos: Partial<Record<typeof menuSeed[number][0], PosMenuPhotoKey>> = {
  'm-americano': 'menu-photo-01',
  'm-latte': 'menu-photo-03',
  'm-croissant': 'menu-photo-04',
  'm-financier': 'menu-photo-05',
  'm-beans200': 'menu-photo-06',
  'm-dripbag': 'menu-photo-07',
};
const materials = [
  ['it-milk', 'RM-001', 'data.item.milk', 'L', 32_400, 4, 3_500, 4, 1, 1, 'sup-a'],
  ['it-beans', 'RM-002', 'data.item.beans', 'kg', 6_632, 3, 25_000, 1, 1, 2, 'sup-b'],
  ['it-cups', 'RM-003', 'data.item.cups', 'pcs', 313, 150, 100, 100, 100, 3, 'sup-c'],
  ['it-vanilla', 'RM-004', 'data.item.vanilla', 'L', 2_100, 1, 12_500, 1, 1, 2, 'sup-a'],
  ['it-croissant', 'RM-005', 'data.item.croissant', 'pcs', 41, null, 1_200, 10, 1, 1, 'sup-d'],
  ['it-financier', 'RM-006', 'data.item.financier', 'pcs', 49, 10, 1_000, 10, 10, 1, 'sup-d'],
] as const;
const recipes: readonly (readonly [string, string, number, BaseUnit])[] = [
  ['m-americano', 'it-beans', 24, 'g'], ['m-americano', 'it-cups', 1, 'pcs'],
  ['m-latte', 'it-beans', LATTE_RECIPE.beansG, 'g'], ['m-latte', 'it-milk', LATTE_RECIPE.milkMl, 'mL'], ['m-latte', 'it-cups', 1, 'pcs'],
  ['m-vanilla', 'it-beans', 24, 'g'], ['m-vanilla', 'it-milk', 300, 'mL'], ['m-vanilla', 'it-vanilla', 20, 'mL'], ['m-vanilla', 'it-cups', 1, 'pcs'],
  ['m-croissant', 'it-croissant', 1, 'pcs'], ['m-financier', 'it-financier', 1, 'pcs'],
];
function paymentsSeed(): { payment: Payment[]; paymentLine: PaymentLine[] } {
  const payment: Payment[] = [], paymentLine: PaymentLine[] = [];
  let earlier = 14 * 60 + 54;
  const add = (paymentId: string, method: Payment['method'], quantities: readonly number[], time?: string, discount = 0) => {
    const minutes = earlier--;
    const stamp = time ?? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const gross = quantities.reduce((sum, qty, i) => sum + qty * menuSeed[i][2], 0);
    payment.push({ paymentId, businessDate: TODAY, time: stamp, method, kind: 'payment', gross, discount, refundAmount: 0, summary: key('data.management.paymentSummary') });
    quantities.forEach((qty, i) => { if (qty) paymentLine.push({ paymentLineId: `${paymentId}:${menuSeed[i][0]}`, paymentId, menuId: menuSeed[i][0], qty, unitPriceAtSale: menuSeed[i][2], unitCostAtSale: menuSeed[i][3] }); });
  };
  add('pay-001', 'card', [3, 0, 0, 0, 0, 0, 0], '15:42');
  add('pay-002', 'easy_pay', [0, 1, 0, 1, 0, 0, 0], '15:30');
  add('pay-003', 'cash', [1, 0, 0, 0, 0, 0, 0], '15:18');
  earlier = 14 * 60 + 54;
  add('pay-004', 'card', [0, 2, 0, 0, 0, 0, 0]);
  add('pay-005', 'card', [5, 0, 0, 0, 0, 0, 0], undefined, 21_000);
  const groups = [
    ['card', 63, [47, 43, 30, 23, 15, 5, 8]],
    ['easy_pay', 21, [20, 29, 0, 7, 10, 0, 0]],
    ['cash', 5, [9, 3, 0, 4, 0, 0, 0]],
  ] as const;
  let index = 6;
  for (const [method, count, totals] of groups) {
    const parts = Array.from({ length: count }, () => Array<number>(7).fill(0));
    let cursor = 0;
    totals.forEach((qty, menu) => { for (let n = 0; n < qty; n++) parts[cursor++ % count][menu]++; });
    for (const quantities of parts) add(`pay-${String(index++).padStart(3, '0')}`, method, quantities);
  }
  payment.push({ paymentId: 'refund-001', refundOf: 'pay-004', businessDate: TODAY, time: '14:55', method: 'card', kind: 'refund', gross: 0, discount: 0, refundAmount: 10_000, summary: key('data.management.refundSummary') });
  paymentLine.push({ paymentLineId: 'refund-001:m-latte', paymentId: 'refund-001', menuId: 'm-latte', qty: 2, unitPriceAtSale: 5_000, unitCostAtSale: 1_750 });
  return { payment, paymentLine };
}

export function upgradeManagementSeed(t: LegacyTables): DataTables {
  const recipeLine: RecipeLine[] = recipes.map(([menuId, itemId, quantity, unit]) => ({ recipeLineId: `recipe:${menuId}:${itemId}`, menuId, itemId, quantity, unit }));
  const catalog = createPosSeedCatalog();
  const menuItem: MenuItem[] = menuSeed.map(([menuId, nameKey, price, , category, memo, prepMin]) => ({
    menuId, nameKey, name: key(nameKey), kind: category === 'retail' ? 'retail' : 'menu', category, categoryKey: category === 'drink' ? 'data.menuCategory.coffee' : 'data.menuCategory.bakery', price, memo: memo ? key(memo) : null,
    costEffectiveFrom: '2026-10-01', recipe: [], prepMin, saleStatus: 'selling', photoKey: seededMenuPhotos[menuId] ?? null, optionGroups: catalog.items.find(m => m.menuId === menuId)?.groups ?? [], ...(category === 'retail' ? { itemId: menuId === 'm-beans200' ? 'it-beans200' : 'it-dripbag' } : {}),
  }));
  menuItem.push(...t.menuItem.filter((m) => m.menuId === 'm-coldbrew').map((m) => ({ ...m, kind: 'menu' as const, name: key(m.nameKey), category: 'drink' as const, deletedAt: '2026-10-25T21:00' })));
  const purchaseItem = materials.map(([itemId, , , , , , unitPrice, minimumQty, orderStep, leadDays, supplierId]) => ({ purchaseItemId: `pi-${itemId.slice(3)}`, itemId, supplierId, minimumQty, unitPrice, orderStep, leadDays }));
  const inventoryItem = materials.map(([itemId, sku, nameKey, unit, , restockThreshold]) => ({
    itemId, sku, nameKey, name: key(nameKey), kind: 'ingredient' as const, unit, restockThreshold, trackRestock: restockThreshold !== null,
    lowStockPerChannel: null, sales7d: null, updatedAt: `${TODAY}T08:30`, trackExpiry: itemId === 'it-croissant', expiresOn: itemId === 'it-croissant' ? TODAY : null,
  }));
  const orders = [
    ['101', '2026-10-25', '2026-10-26', '09:00', 0, 12], ['102', '2026-10-24', '2026-10-27', '11:00', 1, 5],
    ['103', '2026-10-23', '2026-10-28', null, 2, 300], ['104', '2026-10-20', '2026-10-22', null, 5, 30],
    ['105', '2026-10-24', '2026-10-25', null, 4, 41], ['106', '2026-10-19', '2026-10-21', null, 1, 5], ['107', '2026-10-12', '2026-10-15', null, 2, 300],
  ] as const;
  const paymentTables = paymentsSeed();
  const marketing = { ...t.marketing, mktCustomer: [...t.marketing.mktCustomer], mktVisit: [...t.marketing.mktVisit] };
  const extraVisits = [['mc-01', ['2026-10-02', '2026-10-10', '2026-10-18', '2026-10-25', '2026-10-26']], ['mc-59', ['2026-10-18']], ['mc-02', ['2026-10-18', '2026-10-25']]] as const;
  marketing.mktVisit = marketing.mktVisit.map((v) => v.customerId === 'mc-49' ? { ...v, businessDate: '2026-10-09' } : v);
  for (const [customerId, dates] of extraVisits) for (const businessDate of dates) marketing.mktVisit.push({ customerId, businessDate, hour: 15 });
  for (let n = 62; n <= 126; n++) {
    const customerId = cid(n);
    marketing.mktCustomer.push({ customerId, maskKey: 'data.management.exampleMember', consentSms: false, consentNight: false, variant: null });
    for (const businessDate of n <= 98 ? ['2026-10-03', '2026-10-24'] : n <= 121 ? ['2026-09-10', '2026-10-24'] : ['2026-09-14', '2026-09-28']) marketing.mktVisit.push({ customerId, businessDate, hour: 15 });
  }
  const representatives = ['mc-01', 'mc-59', 'mc-49', 'mc-40', 'mc-02'];
  const names = ['김도현', '이준호', '박서영', '최지민', '정수아', '강민서'];
  const phones = ['01000002481', '01000007310', '01000005592', '01000000846', '01000003307', '01000001626'];
  const ids = [...representatives, ...marketing.mktCustomer.filter((c) => c.variant === null && !representatives.includes(c.customerId)).map((c) => c.customerId).sort()];
  marketing.mktCustomer = marketing.mktCustomer.map((c) => {
    const i = ids.indexOf(c.customerId);
    return i < 0 ? c : { ...c, name: names[i] ?? `예시회원 ${i + 1}`, phone: phones[i] ?? `010${String(10000000 + i).padStart(8, '0')}` };
  });
  const links: Record<string, number> = { 'ms-04': 1, 'ms-02': 3, 'ms-03': 4, 'ms-06': 5, 'ms-01': 6 };
  let memberIndex = 7;
  const membership = t.membership.map((m) => {
    const n = links[m.membershipId] ?? memberIndex++;
    const end = ({ 'ms-04': '2026-10-29', 'ms-02': '2026-10-30', 'ms-03': '2026-11-01', 'ms-06': '2026-12-20', 'ms-01': '2026-10-31' } as Record<string, string>)[m.membershipId];
    const uses = ({ 'ms-04': 3, 'ms-02': 1, 'ms-06': 7, 'ms-01': 1 } as Record<string, number>)[m.membershipId];
    return { ...m, customerId: ids[n - 1], ...(end ? { endsOn: end, startsOn: addDays(end, -(m.productId === 'p-americano10' ? 90 : 30)) } : {}), ...(uses !== undefined ? { usesLeft: uses } : {}) };
  });
  const guestNames = ['김○현', '한○○', '오○○', '서○○', '정○아', '윤○○', '장○○'];
  const tables = ['T1', 'T2', 'T3', 'T4', 'T4', 'T5', 'T6'];
  const reservation: Reservation[] = t.reservation.filter((r):r is Reservation=>r.kind!=='pickup').map((r, i) => ({ ...r,
    tableId: i < 7 ? tables[i] : null, assignmentMode: 'auto', capacityOverride: false,
    guestName: { raw: guestNames[i] ?? (r.reservationId === 'rv-9' ? '문○○' : '장○○') },
    ...(r.reservationId === 'rv-1' ? { memberId: mid(1) } : r.reservationId === 'rv-5' ? { memberId: mid(5) } : {}),
    ...(r.reservationId === 'rv-9' ? { time: '12:30' } : {}),
  }));
  const baseReservation = reservation[0];
  reservation.push({ ...baseReservation, reservationId: 'rv-10', date: '2026-10-27', time: '12:00', partySize: 4, memberId: mid(2), guestName: { raw: '이○우' }, tableId: 'T5', callId: null }, { ...baseReservation, reservationId: 'rv-11', date: '2026-10-27', time: '15:00', guestName: { raw: '한○○' }, memberId: undefined, tableId: 'T1', callId: null });
  const result: DataTables = {
    ...t, ...paymentTables, menuItem, recipeLine, purchaseItem,
    inventoryItem: [...inventoryItem, ...t.inventoryItem.filter((i) => i.kind === 'retail').map((i, n) => ({ ...i, sku: `PD-00${n + 1}`, name: key(i.nameKey) }))],
    inventoryStock: t.inventoryStock.filter((i) => ['it-beans200', 'it-dripbag'].includes(i.itemId)),
    stockOpening: materials.map(([itemId, , , , quantityBase]) => ({ itemId, businessDate: TODAY, quantityBase })), stockAdjustment: [],
    supplier: ['a', 'b', 'c', 'd'].map((id, i) => ({ supplierId: `sup-${id}`, nameKey: `data.supplier.${id}`, name: key(`data.supplier.${id}`), contactKey: 'data.person.park', contact: key(i === 0 ? 'data.management.supplier.contactA' : 'data.management.contact'), phoneMask: ['010-****-1023', '02-***-4410', '031-***-7702', '010-****-5518'][i] })),
    purchaseOrder: orders.map(([n, orderedOn, dueDate, expectedTime, material], i) => ({ poId: `po-${n}`, supplierId: materials[material][10], orderedOn, dueDate, expectedTime, status: i >= 4 ? 'complete' : 'scheduled', variant: null })),
    purchaseOrderLine: orders.map(([n, , , , material, qtyOrdered]) => ({ polId: `pol-${n}`, poId: `po-${n}`, itemId: materials[material][0], qtyOrdered, unitPrice: materials[material][6], itemNameSnapshot: key(materials[material][2]), unitSnapshot: materials[material][3] })),
    receipt: orders.slice(4).map(([n, , dueDate, , , qty]) => ({ receiptId: `rc-${n}`, polId: `pol-${n}`, qty, receivedAt: `${dueDate}T09:00`, idempotencyKey: null })),
    marketing, membership, memberProfile: ids.map((customerId, i) => ({ memberId: mid(i + 1), customerId, joinedOn: '2026-09-01', gradeOverride: null })),
    memberNote: [0, 1, 4].map((i) => ({ noteId: `note-${i + 1}`, memberId: mid(i + 1), body: key(['data.management.memberNote.shot', 'data.management.memberNote.parking', '', '', 'data.management.memberNote.pickup'][i]), updatedAt: `${TODAY}T09:00` })),
    reservation, reservationChange: [
      { changeId: 'rvc-1', reservationId: 'rv-5', at: `${TODAY}T09:15`, kind: 'updated', before: { partySize: 2 }, after: { partySize: 3 } },
      { changeId: 'rvc-2', reservationId: 'rv-9', at: `${TODAY}T12:30`, kind: 'canceled', before: { status: 'confirmed' }, after: { status: 'canceled' } },
    ],
    shopSettings: { businessType: null, paymentStyle: null, tableLayout: null, revision: 0, layoutActivated: false },
    dayClosing: [], commandLedger: {}, categoryVisibility: { 'store-operations': true, purchasing: true, 'tax-admin': true },
    taxPayment: [
      ['tp-income', 'data.management.tax.income', 2_315_000, '2026-06-01', '2026-05-28'], ['tp-vat1', 'data.management.tax.vat1', 1_842_000, '2026-07-27', '2026-07-24'],
      ['tp-vat2', 'data.management.tax.vat2', 921_000, '2026-10-25', '2026-10-23'], ['tp-withholding', 'data.management.tax.withholding', 132_000, '2026-11-10', null],
    ].map(([taxPaymentId, type, amount, dueOn, paidOn]) => ({ taxPaymentId: String(taxPaymentId), type: key(String(type)), amount: Number(amount), dueOn: String(dueOn), paidOn: paidOn as string | null, status: paidOn ? 'paid' : 'unpaid', evidence: paidOn ? 'example' : 'none' })),
    grantNotice: [...t.grantNotice, { noticeId: 'g-digital', titleKey: 'data.management.grant.digital', agencyKey: 'data.agency.smallBusiness', regionKey: 'data.region.nationwide', applyStart: '2026-09-01T09:00', applyEnd: '2026-09-15T18:00', conditionKeys: [], summaryKey: 'data.management.grantGuide', matchStatus: 'matched' as const }].map((n) => ({ ...n, template: key('data.management.grantTemplate'), guide: key('data.management.grantGuide') })),
    grantApplication: [{ applicationId: 'ga-digital', noticeId: 'g-digital', appliedOn: '2026-09-15', status: 'reviewing', resultMemo: key('data.management.grant.awaiting') }],
    manual: [...t.manual.map((m) => ({ ...m, section: 'handover' as const, cautions: { raw: '' } })), ...['data.management.info.hours', 'data.management.info.rules', 'data.management.info.equipment'].map((title, i) => ({ manualId: `info-${i + 1}`, title: key(title), category: 'store-info' as const, section: 'store-info' as const, isPublished: true, updatedAt: `${TODAY}T08:00`, cautions: { raw: '' } }))],
    manualStep: [...t.manualStep, ...['data.management.info.hours.body', 'data.management.info.rules.body', 'data.management.info.equipment.body'].map((body, i) => ({ manualId: `info-${i + 1}`, stepNo: 1, body: key(body) }))],
    cctvCamera: ['data.management.camera.entrance', 'data.management.camera.counter', 'data.management.camera.hall'].map((name, i) => ({ cameraId: `camera-${i + 1}`, name: key(name), connection: 'connected', operation: 'recording', lastCheckedAt: `${TODAY}T15:00`, stillImageKey: '' })),
  };
  return { ...result, ...paymentDailyAdapters(result, TODAY) };
}
