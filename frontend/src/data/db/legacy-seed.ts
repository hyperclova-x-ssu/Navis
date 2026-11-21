/**
 * Seed tables (DATA_MODEL 10.9). Every value in the “시드가 지켜야 할 값” table holds and is pinned by
 * `seed.test.ts` / `models.test.ts`. All rows are deterministic (no random, no clock).
 */
import { createLegacyNoticeSeed, createInitialClosure } from '../iteration7/notices/seed';
import { createLegacyEnvironmentSeed } from '../iteration7/environment/seed';
import { createLegacyCustomOrderSeed } from '../iteration7/custom-orders/seed';
import type {
  CalendarEvent, CallLog, CctvHourly, DailySales, DataTables, DemandActual, DemandBand, DemandDay, DemandForecast, DemandHourly, Expense, ExpenseCategory, Evidence,
  HiringLoad, InquiryThread, InventoryItem, InventoryStock, Manual, ManualStep, Membership, MembershipUse, MenuDaily, MenuItem,
  PurchaseOrder, PurchaseOrderLine, Reservation, SeedOverrides, Shift, TableSpot,
} from './types';
import { dateRange, dayNumber, weekdayOf, addDays } from './time';
import { upgradeManagementSeed } from './management-seed';
const LATTE_RECIPE = { beansG: 24, milkMl: 300 };
import { createLegacyMarketingSeed } from '../marketing/seed';
import { createLegacyStaffSeed } from '../iteration7/staff/seed';

const round100 = (n: number): number => Math.round(n / 100) * 100;
const k = (key: string) => ({ key });

export { deepFreeze } from './freeze';
import { deepFreeze } from './freeze';

/* ───────────── 돈: 매출·메뉴·지출 ───────────── */
export const SALES_START = '2026-09-01';
const fixedNets: Readonly<Record<string, number>> = {
  '2026-10-13': 1_045_000, '2026-10-14': 998_000, '2026-10-15': 1_190_000, '2026-10-16': 1_128_000, '2026-10-17': 1_468_000, '2026-10-18': 1_352_000,
  '2026-10-19': 1_186_700,
  '2026-10-20': 1_080_000, '2026-10-21': 1_012_000, '2026-10-22': 1_236_000, '2026-10-23': 1_164_000, '2026-10-24': 1_512_000, '2026-10-25': 1_408_000,
  '2026-10-26': 1_284_000,
};
const weekdayBase = [0, 1_150_000, 1_050_000, 1_000_000, 1_180_000, 1_130_000, 1_450_000, 1_340_000];
const netOf = (date: string): number => fixedNets[date] ?? weekdayBase[weekdayOf(date)] + (((dayNumber(date) * 37) % 9) - 4) * 10_000;

const fixedSales: Readonly<Record<string, DailySales>> = {
  '2026-10-26': { businessDate: '2026-10-26', gross: 1_322_000, discount: 32_000, refund: 6_000, card: 1_002_000, cash: 118_000, easyPay: 202_000 },
  '2026-10-19': { businessDate: '2026-10-19', gross: 1_240_000, discount: 49_300, refund: 4_000, card: 942_000, cash: 112_000, easyPay: 186_000 },
};
function salesRow(date: string): DailySales {
  const fixed = fixedSales[date];
  if (fixed) return fixed;
  const net = netOf(date);
  const discount = round100(net * 0.025);
  const refund = dayNumber(date) % 3 === 0 ? 5_000 : 0;
  const gross = net + discount + refund;
  const card = round100(gross * 0.76), cash = round100(gross * 0.09);
  return { businessDate: date, gross, discount, refund, card, cash, easyPay: gross - card - cash };
}

const menuItems: readonly MenuItem[] = [
  { menuId: 'm-latte', nameKey: 'data.menu.latte', price: 5_000, categoryKey: 'data.menuCategory.coffee', costEffectiveFrom: '2026-10-01', recipe: [
    { nameKey: 'data.item.beans', qty: LATTE_RECIPE.beansG / 1000, unit: 'kg', cost: 600 }, { nameKey: 'data.item.milk', qty: LATTE_RECIPE.milkMl / 1000, unit: 'L', cost: 750 }, { nameKey: 'data.recipe.cupSet', qty: 1, unit: 'pcs', cost: 400 }] },
  { menuId: 'm-americano', nameKey: 'data.menu.americano', price: 4_500, categoryKey: 'data.menuCategory.coffee', costEffectiveFrom: '2026-10-01', recipe: [
    { nameKey: 'data.item.beans', qty: 0.01, unit: 'kg', cost: 300 }, { nameKey: 'data.recipe.cupSet', qty: 1, unit: 'pcs', cost: 400 }] },
  { menuId: 'm-vanilla', nameKey: 'data.menu.vanillaLatte', price: 5_500, categoryKey: 'data.menuCategory.coffee', costEffectiveFrom: '2026-10-01', recipe: [
    { nameKey: 'data.item.beans', qty: 0.02, unit: 'kg', cost: 600 }, { nameKey: 'data.item.milk', qty: 0.3, unit: 'L', cost: 750 }, { nameKey: 'data.recipe.syrup', qty: 0.03, unit: 'L', cost: 350 }, { nameKey: 'data.recipe.cupSet', qty: 1, unit: 'pcs', cost: 400 }] },
  { menuId: 'm-coldbrew', nameKey: 'data.menu.coldBrew', price: 5_000, categoryKey: 'data.menuCategory.coffee', costEffectiveFrom: '2026-10-01', recipe: [
    { nameKey: 'data.item.beans', qty: 0.025, unit: 'kg', cost: 750 }, { nameKey: 'data.recipe.ice', qty: 1, unit: 'pcs', cost: 200 }, { nameKey: 'data.recipe.cupSet', qty: 1, unit: 'pcs', cost: 400 }] },
  { menuId: 'm-croissant', nameKey: 'data.item.croissant', price: 3_500, categoryKey: 'data.menuCategory.bakery', costEffectiveFrom: '2026-10-01', recipe: [
    { nameKey: 'data.item.croissant', qty: 1, unit: 'pcs', cost: 1_050 }, { nameKey: 'data.recipe.bag', qty: 1, unit: 'pcs', cost: 150 }] },
];
const unitCosts = menuItems.map((m) => m.recipe.reduce((sum, part) => sum + part.cost, 0)); // 1750, 700, 2100, 1350, 1200
const fixedMenu: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  // [qty, netSales] per menu in menuItems order. Σ qty×price = gross, Σ net = daily net, Σ qty×cost = 413,000 / 401,000
  // (plan-2 prices: americano 4,500/700, croissant 3,500/1,200; quantities rebalanced by T-058).
  '2026-10-26': [[95, 462_000], [54, 236_000], [58, 309_000], [29, 141_000], [40, 136_000]],
  '2026-10-19': [[88, 421_700], [37, 159_000], [59, 311_000], [24, 115_000], [54, 180_000]],
};
/** 샷 추가 원가 300 (0.01 kg beans, Q-41) for the slot-coupon benefit comparison. */
const menuOptions = [{ optionId: 'opt-extra-shot', nameKey: 'data.menu.extraShot', cost: 300 }] as const;
const baseMix = fixedMenu['2026-10-26'];
function menuRows(date: string): MenuDaily[] {
  const fixed = fixedMenu[date];
  const net = netOf(date);
  const rows = fixed ?? (() => {
    const s = net / 1_284_000;
    const scaled = baseMix.map(([qty, sales]) => [Math.max(1, Math.round(qty * s)), round100(sales * s)] as [number, number]);
    const others = scaled.reduce((sum, [, sales], i) => (i === 1 ? sum : sum + sales), 0);
    scaled[1] = [scaled[1][0], net - others];
    return scaled;
  })();
  return rows.map(([qty, netSales], i) => ({ businessDate: date, menuId: menuItems[i].menuId, qty, netSales, unitCost: unitCosts[i] }));
}

const memo = (name: string) => k(`data.expense.memo.${name}`);
function expenseRows(date: string, index: number): Expense[] {
  if (date === '2026-10-26') return [
    { expenseId: 'e-1026-1', businessDate: date, category: 'ingredients', amount: 186_000, supplierId: 'sup-b', receiptId: null, evidence: 'tax-invoice', status: 'confirmed', memo: memo('beans') },
    { expenseId: 'e-1026-2', businessDate: date, category: 'ingredients', amount: 100_000, supplierId: null, receiptId: null, evidence: 'card', status: 'confirmed', memo: memo('syrup') },
    { expenseId: 'e-1026-3', businessDate: date, category: 'operations', amount: 124_000, supplierId: null, receiptId: null, evidence: 'tax-invoice', status: 'confirmed', memo: memo('electricity') },
    { expenseId: 'e-1026-4', businessDate: date, category: 'supplies', amount: 52_000, supplierId: null, receiptId: null, evidence: 'none', status: 'confirmed', memo: memo('napkins') },
  ];
  const id = date.slice(5).replace('-', '');
  const rows: Expense[] = [];
  const add = (category: ExpenseCategory, amount: number, evidence: Evidence, supplierId: string | null, note: string) =>
    rows.push({ expenseId: `e-${id}-${rows.length + 1}`, businessDate: date, category, amount, supplierId, receiptId: null, evidence, status: 'confirmed', memo: memo(note) });
  const kind = index % 3;
  add('ingredients', 150_000 + ((dayNumber(date) * 53) % 11) * 10_000, index % 2 === 0 ? 'tax-invoice' : 'card', kind === 0 ? 'sup-b' : kind === 1 ? 'sup-a' : null, kind === 0 ? 'beans' : kind === 1 ? 'milk' : 'bakery');
  const wd = weekdayOf(date), dom = Number(date.slice(8));
  if (wd === 3) add('operations', 80_000, 'card', null, 'utilities');
  if (wd === 5) add('supplies', 45_000, 'receipt', null, 'cleaning');
  if (dom === 5) add('rent', 1_800_000, 'tax-invoice', null, 'rent');
  if (dom === 10) add('labor', 2_400_000, 'receipt', null, 'payroll');
  return rows;
}

/* ───────────── 손님: CCTV·근무·예측·회원권·예약 ───────────── */
const pastHours = [6, 12, 20, 16, 22, 18, 14, 12, 16, 10, 6]; // 10..20시
const weekdayFactor = [0, 9, 8, 8, 10, 10, 13, 12];
function cctvRows(): CctvHourly[] {
  const rows: CctvHourly[] = [];
  for (const date of dateRange('2026-10-19', '2026-10-25'))
    pastHours.forEach((base, i) => rows.push({ businessDate: date, hour: 10 + i, entries: Math.round((base * weekdayFactor[weekdayOf(date)]) / 10), status: 'ok', reviewMarked: false }));
  [8, 14, 22, 18, 24].forEach((entries, i) => rows.push({ businessDate: '2026-10-26', hour: 10 + i, entries, status: 'ok', reviewMarked: false }));
  return rows;
}

const shifts: readonly Shift[] = [
  { shiftId: 'sh-1', staffKey: 'data.person.kim', date: '2026-10-26', start: '08:00', end: '17:30', source: 'roster' },
  { shiftId: 'sh-2', staffKey: 'data.person.lee', date: '2026-10-26', start: '12:00', end: '17:30', source: 'roster' },
  { shiftId: 'sh-3', staffKey: 'data.person.park', date: '2026-10-26', start: '17:30', end: '22:00', source: 'roster' },
  { shiftId: 'sh-4', staffKey: 'data.person.choi', date: '2026-10-26', start: '17:30', end: '22:00', source: 'roster' },
  { shiftId: 'sh-5', staffKey: 'data.person.kim', date: '2026-10-27', start: '08:00', end: '16:00', source: 'roster' },
  { shiftId: 'sh-6', staffKey: 'data.person.lee', date: '2026-10-27', start: '12:00', end: '16:00', source: 'roster' },
  { shiftId: 'sh-7', staffKey: 'data.person.park', date: '2026-10-27', start: '15:00', end: '22:00', source: 'roster' },
  { shiftId: 'sh-8', staffKey: 'data.person.kim', date: '2026-10-31', start: '10:00', end: '18:00', source: 'roster' },
  { shiftId: 'sh-9', staffKey: 'data.person.jung', date: '2026-10-31', start: '13:00', end: '18:00', source: 'roster' },
  { shiftId: 'sh-10', staffKey: 'data.person.park', date: '2026-10-31', start: '17:00', end: '22:00', source: 'roster' },
  { shiftId: 'sh-11', staffKey: 'data.person.kim', date: '2026-11-01', start: '10:00', end: '18:00', source: 'roster' },
  { shiftId: 'sh-12', staffKey: 'data.person.jung', date: '2026-11-01', start: '13:00', end: '18:00', source: 'roster' },
  { shiftId: 'sh-13', staffKey: 'data.person.park', date: '2026-11-01', start: '17:00', end: '22:00', source: 'roster' },
];

// [morning, afternoon, evening] as [expected, baseline, weather, event]
type Band4 = readonly [number, number, number, number];
const forecastSeed: Readonly<Record<string, readonly [Band4, Band4, Band4]>> = {
  '2026-10-19': [[20, 20, 0, 0], [42, 42, 0, 0], [22, 22, 0, 0]],
  '2026-10-20': [[20, 20, 0, 0], [42, 41, 1, 0], [21, 21, 0, 0]],
  '2026-10-21': [[19, 19, 0, 0], [39, 39, 0, 0], [20, 20, 0, 0]],
  '2026-10-22': [[22, 22, 0, 0], [45, 44, 1, 0], [23, 23, 0, 0]],
  '2026-10-23': [[21, 21, 0, 0], [44, 44, 0, 0], [23, 23, 0, 0]],
  '2026-10-24': [[30, 30, 0, 0], [66, 64, 2, 0], [32, 32, 0, 0]],
  '2026-10-25': [[28, 28, 0, 0], [58, 58, 0, 0], [30, 30, 0, 0]],
  '2026-10-26': [[20, 20, 0, 0], [44, 44, 0, 0], [24, 24, 0, 0]],
  '2026-10-27': [[22, 21, 1, 0], [48, 46, 2, 0], [22, 23, -1, 0]],
  '2026-10-28': [[19, 19, 0, 0], [42, 41, 1, 0], [20, 20, 0, 0]],
  '2026-10-29': [[22, 22, 0, 0], [47, 46, 1, 0], [23, 23, 0, 0]],
  '2026-10-30': [[21, 21, 0, 0], [46, 45, 1, 0], [25, 24, 1, 0]],
  '2026-10-31': [[30, 30, 0, 0], [72, 60, 0, 12], [34, 30, 0, 4]],
  '2026-11-01': [[28, 28, 0, 0], [62, 60, 0, 2], [30, 30, 0, 0]],
};
const bands: readonly DemandBand[] = ['morning', 'afternoon', 'evening'];
const forecastRows = (): DemandForecast[] => Object.entries(forecastSeed).flatMap(([targetDate, triple]) =>
  triple.map(([expected, baseline, adjWeather, adjEvent], i) => ({ targetDate, band: bands[i], expected, baseline, adjWeather, adjEvent })));
const demandDays: readonly DemandDay[] = dateRange('2026-10-19', '2026-11-01').map((targetDate) => ({
  targetDate,
  busyStart: weekdayOf(targetDate) >= 6 ? 14 : 13,
  busyEnd: weekdayOf(targetDate) >= 6 ? 17 : 15,
  weatherKey: targetDate === '2026-10-27' || targetDate === '2026-10-22' ? 'data.weather.rain' : weekdayOf(targetDate) % 2 === 0 ? 'data.weather.cloudy' : 'data.weather.clear',
  eventKey: targetDate === '2026-10-31' || targetDate === '2026-11-01' ? 'data.localChange.streetEvent' : null,
}));
/**
 * plan-2 (T-058): 1-hour forecast and same weekday/hour 4-week average for 10-26 … 11-01. Each band's hours
 * sum to its `demandForecast` row (expected and baseline). Only 10-27 10–12, 10-28 16–17 and 10-29 16–17
 * fall below 60% of the average (R2 RELAY ①, AC-288·316).
 */
const BAND_HOURS: Readonly<Record<DemandBand, readonly number[]>> = { morning: [8, 9, 10, 11], afternoon: [12, 13, 14, 15, 16], evening: [17, 18, 19, 20, 21] };
const BAND_WEIGHTS: Readonly<Record<DemandBand, readonly number[]>> = { morning: [4, 5, 5, 6], afternoon: [9, 11, 12, 10, 8], evening: [13, 12, 10, 9, 6] };
/** Largest-remainder split of an integer total by integer weights (ties: earlier hour first). */
function spread(total: number, weights: readonly number[]): number[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.floor((total * w) / sumW));
  const order = weights.map((w, i) => [(total * w) % sumW, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0, left = total - parts.reduce((a, b) => a + b, 0); k < left; k++) parts[order[k][1]] += 1;
  return parts;
}
const quietHours: Readonly<Record<string, Partial<Record<DemandBand, { readonly expected: readonly number[]; readonly average: readonly number[] }>>>> = {
  '2026-10-27': { morning: { expected: [9, 9, 2, 2], average: [6, 6, 5, 4] } },
  '2026-10-28': { afternoon: { expected: [8, 10, 12, 9, 3], average: [7, 9, 10, 8, 7] } },
  '2026-10-29': { afternoon: { expected: [9, 12, 13, 9, 4], average: [8, 10, 11, 9, 8] } },
};
const hourlyRows = (): DemandHourly[] => dateRange('2026-10-26', '2026-11-01').flatMap((targetDate) => bands.flatMap((band, i) => {
  const [expected, baseline] = forecastSeed[targetDate][i];
  const fixed = quietHours[targetDate]?.[band];
  const exp = fixed ? fixed.expected : spread(expected, BAND_WEIGHTS[band]);
  const avg = fixed ? fixed.average : spread(baseline, BAND_WEIGHTS[band]);
  return BAND_HOURS[band].map((hour, h) => ({ targetDate, hour, expected: exp[h], average: avg[h] }));
}));
const demandActuals: readonly DemandActual[] = [
  { date: '2026-10-19', total: 86 }, { date: '2026-10-20', total: 85 }, { date: '2026-10-21', total: 80 }, { date: '2026-10-22', total: 87 },
  { date: '2026-10-23', total: 91 }, { date: '2026-10-24', total: 132 }, { date: '2026-10-25', total: 112 },
];

const hourLevels = [1, 2, 2, 3, 4, 4, 3, 3, 3, 3, 2, 2, 1, 1]; // 8..21시
function hiringRows(): HiringLoad[] {
  const rows: HiringLoad[] = [];
  for (let weekday = 1; weekday <= 7; weekday++)
    hourLevels.forEach((base, i) => {
      const hour = 8 + i;
      const weekend = weekday >= 6;
      const level = weekend ? (hour >= 14 && hour <= 16 ? 5 : hour >= 12 && hour <= 17 ? 4 : Math.min(4, base + 1)) : Math.min(4, base + (weekday === 5 && hour >= 18 ? 1 : 0));
      rows.push({ weekday, hour, level });
    });
  return rows;
}

const people = ['kim', 'lee', 'park', 'choi', 'jung', 'kang', 'cho', 'yoon', 'jang', 'lim'] as const;
const person = (i: number): string => `data.person.${people[i % people.length]}`;
function membershipRows(): Membership[] {
  const rows: Membership[] = [];
  const add = (productId: string, endsOn: string, usesLeft: number | null, status: Membership['status'] = 'active') => {
    const validDays = productId === 'p-americano10' ? 90 : 30;
    const n = rows.length + 1;
    rows.push({ membershipId: `ms-${String(n).padStart(2, '0')}`, customerKey: person(n - 1), productId, startsOn: addDays(endsOn, -validDays), endsOn, usesLeft, status });
  };
  add('p-americano10', '2026-10-28', 1); // ms-01: 이번 주 끝, 마지막 1회
  add('p-morning20', '2026-10-29', 4); // ms-02
  add('p-monthly', '2026-10-31', null); // ms-03
  add('p-americano10', '2026-11-01', 3); // ms-04
  add('p-morning20', '2026-11-02', 6); // ms-05: 곧 끝나요(이번 주 밖)
  for (let i = 0; i < 18; i++) add('p-americano10', addDays('2026-11-05', i * 4), 2 + (i % 8));
  for (let i = 0; i < 8; i++) add('p-morning20', addDays('2026-11-06', i * 3), 3 + ((i * 5) % 16));
  for (let i = 0; i < 7; i++) add('p-monthly', addDays('2026-11-07', i * 3), null);
  add('p-americano10', '2026-10-20', 2, 'ended');
  add('p-monthly', '2026-10-15', null, 'ended');
  add('p-americano10', '2026-11-30', 0); // 모두 사용함(이용 중에서 빠짐)
  return rows;
}
const membershipUses: readonly MembershipUse[] = [
  ['ms-01', '2026-10-20T10:12'], ['ms-01', '2026-10-23T09:40'], ['ms-02', '2026-10-25T08:55'], ['ms-03', '2026-10-25T09:05'],
  ['ms-04', '2026-10-24T11:30'], ['ms-06', '2026-10-22T13:10'], ['ms-07', '2026-10-21T10:45'], ['ms-24', '2026-10-24T09:20'],
  ['ms-25', '2026-10-19T08:30'], ['ms-32', '2026-10-25T09:00'], ['ms-33', '2026-10-24T09:15'], ['ms-08', '2026-10-12T15:20'],
].map(([membershipId, usedAt], i) => ({ useId: `mu-${String(i + 1).padStart(2, '0')}`, membershipId, usedAt, canceledAt: null }));

const reservations: readonly Reservation[] = [
  { reservationId: 'rv-1', date: '2026-10-26', time: '11:00', partySize: 2, nameKey: 'data.person.kim', requestKey: null, source: 'phone_ai', status: 'confirmed', confirmedBy: 'auto', callId: 'call-1', proposedTime: null, variant: null },
  { reservationId: 'rv-2', date: '2026-10-26', time: '11:00', partySize: 2, nameKey: 'data.person.lee', requestKey: null, source: 'phone_ai', status: 'confirmed', confirmedBy: 'auto', callId: 'call-2', proposedTime: null, variant: null },
  { reservationId: 'rv-3', date: '2026-10-26', time: '11:00', partySize: 2, nameKey: 'data.person.park', requestKey: null, source: 'direct', status: 'confirmed', confirmedBy: 'person', callId: null, proposedTime: null, variant: null },
  { reservationId: 'rv-4', date: '2026-10-26', time: '11:00', partySize: 2, nameKey: 'data.person.choi', requestKey: 'data.reservation.request.window', source: 'phone_ai', status: 'confirmed', confirmedBy: 'person', callId: 'call-3', proposedTime: null, variant: null },
  { reservationId: 'rv-5', date: '2026-10-26', time: '14:30', partySize: 3, nameKey: 'data.person.jung', requestKey: 'data.reservation.request.highChair', source: 'phone_ai', status: 'confirmed', confirmedBy: 'person', callId: 'call-4', proposedTime: null, variant: null },
  { reservationId: 'rv-6', date: '2026-10-26', time: '17:00', partySize: 4, nameKey: 'data.person.kang', requestKey: null, source: 'phone_ai', status: 'confirmed', confirmedBy: 'auto', callId: 'call-5', proposedTime: null, variant: null },
  { reservationId: 'rv-7', date: '2026-10-26', time: '17:00', partySize: 4, nameKey: 'data.person.yoon', requestKey: 'data.reservation.request.cake', source: 'direct', status: 'confirmed', confirmedBy: 'person', callId: null, proposedTime: null, variant: null },
  { reservationId: 'rv-8', date: '2026-10-26', time: '17:00', partySize: 20, nameKey: 'data.person.jang', requestKey: 'data.reservation.request.group', source: 'phone_ai', status: 'needs-check', confirmedBy: null, callId: 'call-6', proposedTime: null, variant: 'needs-confirmation' },
  { reservationId: 'rv-9', date: '2026-10-26', time: '18:30', partySize: 2, nameKey: 'data.person.lim', requestKey: null, source: 'phone_ai', status: 'canceled', confirmedBy: null, callId: 'call-7', proposedTime: null, variant: null },
];
const callSummary = (time: string, party: number, requestKey: string | null) => requestKey
  ? { key: 'data.call.summary.reservationWithRequest', params: { time, party }, keyParams: { request: requestKey } }
  : { key: 'data.call.summary.reservation', params: { time, party } };
const callLogs: readonly CallLog[] = [
  { callId: 'call-1', time: '2026-10-25T16:20', summary: callSummary('11:00', 2, null), extracted: { date: '2026-10-26', time: '11:00', party: 2, requestKey: null }, status: 'processed', variant: null },
  { callId: 'call-2', time: '2026-10-25T18:05', summary: callSummary('11:00', 2, null), extracted: { date: '2026-10-26', time: '11:00', party: 2, requestKey: null }, status: 'processed', variant: null },
  { callId: 'call-3', time: '2026-10-26T08:40', summary: callSummary('11:00', 2, 'data.reservation.request.window'), extracted: { date: '2026-10-26', time: '11:00', party: 2, requestKey: 'data.reservation.request.window' }, status: 'processed', variant: null },
  { callId: 'call-4', time: '2026-10-26T09:15', summary: callSummary('14:30', 3, 'data.reservation.request.highChair'), extracted: { date: '2026-10-26', time: '14:30', party: 3, requestKey: 'data.reservation.request.highChair' }, status: 'processed', variant: null },
  { callId: 'call-5', time: '2026-10-26T10:02', summary: callSummary('17:00', 4, null), extracted: { date: '2026-10-26', time: '17:00', party: 4, requestKey: null }, status: 'processed', variant: null },
  { callId: 'call-6', time: '2026-10-26T13:48', summary: k('data.call.summary.group'), extracted: { date: '2026-10-26', time: '17:00', party: 20, requestKey: 'data.reservation.request.group' }, status: 'processed', variant: 'needs-confirmation' },
  { callId: 'call-7', time: '2026-10-26T12:30', summary: k('data.call.summary.cancel'), extracted: { date: '2026-10-26', time: '18:30', party: 2, requestKey: null }, status: 'processed', variant: null },
];

/* ───────────── 운영: 캘린더·재고·거래처·매뉴얼·공간 ───────────── */
const calendarEvents: readonly CalendarEvent[] = [
  { eventId: 'ev-hygiene', kind: 'event', title: k('data.calendar.hygiene'), date: '2026-10-26', time: '14:00', memo: null },
  { eventId: 'ev-filter', kind: 'event', title: k('data.calendar.filterCleaning'), date: '2026-10-14', time: '10:00', memo: null },
  { eventId: 'ev-menuboard', kind: 'event', title: k('data.calendar.menuBoard'), date: '2026-10-21', time: '16:00', memo: null },
];
const inventoryItems: readonly InventoryItem[] = [
  { itemId: 'it-milk', nameKey: 'data.item.milk', kind: 'ingredient', unit: 'L', restockThreshold: 4, trackRestock: true, lowStockPerChannel: null, sales7d: null, updatedAt: '2026-10-26T08:30', trackExpiry: false, expiresOn: null },
  { itemId: 'it-beans', nameKey: 'data.item.beans', kind: 'ingredient', unit: 'kg', restockThreshold: 3, trackRestock: true, lowStockPerChannel: null, sales7d: null, updatedAt: '2026-10-26T08:30', trackExpiry: false, expiresOn: null },
  { itemId: 'it-cups', nameKey: 'data.item.cups', kind: 'ingredient', unit: 'pcs', restockThreshold: 150, trackRestock: true, lowStockPerChannel: null, sales7d: null, updatedAt: '2026-10-26T08:30', trackExpiry: false, expiresOn: null },
  { itemId: 'it-croissant', nameKey: 'data.item.croissant', kind: 'ingredient', unit: 'pcs', restockThreshold: null, trackRestock: false, lowStockPerChannel: null, sales7d: null, updatedAt: '2026-10-26T07:50', trackExpiry: true, expiresOn: '2026-10-26' },
  { itemId: 'it-beans200', nameKey: 'data.item.beans200', kind: 'retail', unit: 'pcs', restockThreshold: null, trackRestock: false, lowStockPerChannel: 30, sales7d: { store: 34, online: 18 }, updatedAt: '2026-10-26T09:00', trackExpiry: false, expiresOn: null },
  { itemId: 'it-dripbag', nameKey: 'data.item.dripBagSet', kind: 'retail', unit: 'pcs', restockThreshold: null, trackRestock: false, lowStockPerChannel: 30, sales7d: { store: 21, online: 15 }, updatedAt: '2026-10-26T09:00', trackExpiry: false, expiresOn: null },
];
const inventoryStock: readonly InventoryStock[] = [
  { itemId: 'it-milk', channel: 'store', qty: 0 }, { itemId: 'it-beans', channel: 'store', qty: 2 }, { itemId: 'it-cups', channel: 'store', qty: 120 },
  { itemId: 'it-croissant', channel: 'store', qty: 6 },
  { itemId: 'it-beans200', channel: 'store', qty: 120 }, { itemId: 'it-beans200', channel: 'online', qty: 40 },
  { itemId: 'it-dripbag', channel: 'store', qty: 60 }, { itemId: 'it-dripbag', channel: 'online', qty: 28 },
];
const purchaseOrders: readonly PurchaseOrder[] = [
  { poId: 'po-090', supplierId: 'sup-a', dueDate: '2026-10-19', expectedTime: '09:00', status: 'complete', variant: null },
  { poId: 'po-099', supplierId: 'sup-b', dueDate: '2026-10-24', expectedTime: '10:00', status: 'scheduled', variant: 'overdue' },
  { poId: 'po-101', supplierId: 'sup-a', dueDate: '2026-10-26', expectedTime: '09:00', status: 'scheduled', variant: null },
  { poId: 'po-102', supplierId: 'sup-b', dueDate: '2026-10-27', expectedTime: '11:00', status: 'scheduled', variant: null },
  { poId: 'po-103', supplierId: 'sup-a', dueDate: '2026-10-28', expectedTime: null, status: 'scheduled', variant: null },
];
const purchaseOrderLines: readonly PurchaseOrderLine[] = [
  { polId: 'pol-090', poId: 'po-090', itemId: 'it-milk', qtyOrdered: 12, unitPrice: 2_500 },
  { polId: 'pol-099', poId: 'po-099', itemId: 'it-beans', qtyOrdered: 3, unitPrice: 30_000 },
  { polId: 'pol-101', poId: 'po-101', itemId: 'it-milk', qtyOrdered: 12, unitPrice: 2_500 },
  { polId: 'pol-102', poId: 'po-102', itemId: 'it-beans', qtyOrdered: 5, unitPrice: 30_000 },
  { polId: 'pol-103', poId: 'po-103', itemId: 'it-cups', qtyOrdered: 300, unitPrice: 120 },
];

const manualSeed: readonly (readonly [string, Manual['category'], string, string, number])[] = [
  ['mn-open', 'opening', 'opening', '2026-10-20T21:00', 5],
  ['mn-close', 'closing', 'closing', '2026-10-22T22:10', 4],
  ['mn-newstaff', 'new-staff', 'newStaff', '2026-10-24T18:00', 3],
  ['mn-latte', 'recipe', 'latteRecipe', '2026-10-12T16:30', 3],
  ['mn-americano', 'recipe', 'americanoRecipe', '2026-10-05T15:00', 2],
  ['mn-machine', 'cleaning', 'machineCleaning', '2026-10-15T21:40', 3],
  ['mn-restroom', 'cleaning', 'restroom', '2026-09-28T20:00', 2],
  ['mn-recycling', 'cleaning', 'recycling', '2026-10-02T19:30', 2],
];
const manuals: readonly Manual[] = manualSeed.map(([manualId, category, name, updatedAt]) => ({ manualId, title: k(`data.manual.${name}`), category, isPublished: true, updatedAt }));
const manualSteps: readonly ManualStep[] = manualSeed.flatMap(([manualId, , name, , count]) =>
  Array.from({ length: count }, (_, i) => ({ manualId, stepNo: i + 1, body: k(`data.manual.${name}.step${i + 1}`) })));

const spots = (layoutId: string, zones: readonly (readonly [TableSpot['zone'], number])[]): TableSpot[] =>
  zones.map(([zone, seats], i) => ({ tableId: `${layoutId}-t${i + 1}`, layoutId, zone, seats }));

/** plan-2 (T-058, D-64): reviews carry `sentiment`; 6 positive reviews are all answered, the waiting review is negative (AC-318). */
const praise = (n: number, receivedAt: string, body: string, rating: number, author: string): InquiryThread => ({ threadId: `th-r${n}`, type: 'review', channelKey: 'data.channel.naverReview', isPublic: true, receivedAt, status: 'done', needsPersonReason: null, bodyKey: `data.marketing.review.${body}`, draftKey: 'data.marketing.review.reply', groundKeys: [], rating, sentiment: 'positive', author });
const inquiryThreads: readonly InquiryThread[] = [
  { threadId: 'th-1', type: 'message', channelKey: 'data.channel.kakao', isPublic: false, receivedAt: '2026-10-26T09:12', status: 'waiting', needsPersonReason: 'refund', bodyKey: 'data.inquiry.body.refund', draftKey: null, groundKeys: [], rating: null, sentiment: null },
  { threadId: 'th-2', type: 'message', channelKey: 'data.channel.naverTalk', isPublic: false, receivedAt: '2026-10-26T11:40', status: 'draft-ready', needsPersonReason: null, bodyKey: 'data.inquiry.body.parking', draftKey: 'data.inquiry.draft.parking', groundKeys: ['data.storeInfo.parking'], rating: null, sentiment: null },
  { threadId: 'th-3', type: 'message', channelKey: 'data.channel.kakao', isPublic: false, receivedAt: '2026-10-26T13:05', status: 'draft-ready', needsPersonReason: null, bodyKey: 'data.inquiry.body.hours', draftKey: 'data.inquiry.draft.hours', groundKeys: ['data.storeInfo.hours'], rating: null, sentiment: null },
  { threadId: 'th-4', type: 'review', channelKey: 'data.channel.naverReview', isPublic: true, receivedAt: '2026-10-25T20:30', status: 'draft-ready', needsPersonReason: null, bodyKey: 'data.inquiry.body.review', draftKey: 'data.inquiry.draft.review', groundKeys: [], rating: 3, sentiment: 'negative', author: '박서연' },
  { threadId: 'th-5', type: 'message', channelKey: 'data.channel.kakao', isPublic: false, receivedAt: '2026-10-25T15:02', status: 'done', needsPersonReason: null, bodyKey: 'data.inquiry.body.location', draftKey: 'data.inquiry.draft.location', groundKeys: ['data.storeInfo.location'], rating: null, sentiment: null },
  praise(1, '2026-10-24T19:40', 'decaf', 5, '김민수'), praise(2, '2026-10-23T12:15', 'croissant', 5, 'Emma Johnson'), praise(3, '2026-10-22T16:30', 'staff', 5, '이지훈'),
  praise(4, '2026-10-20T10:05', 'foam', 4, '최유나'), praise(5, '2026-10-18T14:50', 'window', 5, '정하늘'), praise(6, '2026-10-15T09:20', 'americano', 4, 'Daniel Park'),
];

function buildSeed(): DataTables {
  const salesDates = dateRange(SALES_START, '2026-10-26');
  return upgradeManagementSeed({
    dailySales: salesDates.map(salesRow),
    menuItem: menuItems,
    menuDaily: salesDates.flatMap(menuRows),
    menuOption: menuOptions,
    expense: salesDates.flatMap((date, i) => expenseRows(date, i)),
    taxReview: [{ refType: 'expense', refId: 'e-1026-4', status: 'needs-check' }],
    grantNotice: [
      { noticeId: 'g-stability', titleKey: 'data.grant.stability', agencyKey: 'data.agency.smallBusiness', regionKey: 'data.region.nationwide', applyStart: '2026-10-01T09:00', applyEnd: '2026-10-30T18:00', conditionKeys: ['data.grant.condition.revenue', 'data.grant.condition.businessYears'], summaryKey: 'data.grant.summary.stability', matchStatus: 'matched' },
      { noticeId: 'g-smart', titleKey: 'data.grant.smartStore', agencyKey: 'data.agency.city', regionKey: 'data.region.city', applyStart: '2026-10-15T09:00', applyEnd: '2026-11-06T18:00', conditionKeys: ['data.grant.condition.employees', 'data.grant.condition.pos'], summaryKey: 'data.grant.summary.smartStore', matchStatus: 'matched' },
    ],
    grantReview: [{ noticeId: 'g-stability', reviewStatus: 'before' }, { noticeId: 'g-smart', reviewStatus: 'before' }],
    cctvHourly: cctvRows(),
    shift: shifts,
    ...createLegacyStaffSeed(),
    demandForecast: forecastRows(),
    demandDay: demandDays,
    demandActual: demandActuals,
    demandHourly: hourlyRows(),
    hiringLoad: hiringRows(),
    jobPostDraft: null,
    membershipProduct: [
      { productId: 'p-americano10', nameKey: 'data.membership.americano10', kind: 'count', uses: 10, validDays: 90, dailyLimit: null, price: 40_000 },
      { productId: 'p-morning20', nameKey: 'data.membership.morningDrinks', kind: 'count', uses: 20, validDays: 30, dailyLimit: null, price: 70_000 },
      { productId: 'p-monthly', nameKey: 'data.membership.monthly', kind: 'period', uses: null, validDays: 30, dailyLimit: 1, price: 55_000 },
    ],
    membership: membershipRows(),
    membershipUse: membershipUses,
    ...createLegacyNoticeSeed(),
    ...createLegacyEnvironmentSeed(),
    customTemplate: createLegacyCustomOrderSeed().tables.customTemplate,
    customOrder: createLegacyCustomOrderSeed().tables.customOrder,
    reservation: reservations.map(r => ({ ...r, kind:'visit' as const })),
    callLog: callLogs,
    calendarEvent: [...calendarEvents, createInitialClosure()],
    calendarSettings: { pickup:true, delivery: true, reservation: false, shift: true, deadline: true, direct: true },
    inventoryItem: inventoryItems,
    inventoryStock,
    inventoryTxn: [],
    supplier: [
      { supplierId: 'sup-a', nameKey: 'data.supplier.a', phoneMask: '010-****-2481', contactKey: 'data.person.park' },
      { supplierId: 'sup-b', nameKey: 'data.supplier.b', phoneMask: '02-***-7310', contactKey: 'data.person.choi' },
    ],
    purchaseOrder: purchaseOrders,
    purchaseOrderLine: purchaseOrderLines,
    receipt: [{ receiptId: 'rc-090', polId: 'pol-090', qty: 12, receivedAt: '2026-10-19T09:10', idempotencyKey: null }],
    manual: manuals,
    manualStep: manualSteps,
    checklistLog: [1, 2, 3].map((stepNo) => ({ date: '2026-10-26', manualId: 'mn-open', stepNo })),
    manualDraft: [],
    floorSpace: { photoKeys: ['floor-photo-1', 'floor-photo-2', 'floor-photo-3'], planGenerated: true },
    floorLayout: [
      { layoutId: 'lay-current', name: k('data.layout.current'), isCurrent: true, aisleCm: 100 },
      { layoutId: 'lay-window', name: k('data.layout.windowPlus2'), isCurrent: false, aisleCm: 95 },
      { layoutId: 'lay-extra', name: k('data.layout.extraTable'), isCurrent: false, aisleCm: 70 },
    ],
    tableSpot: [
      ...spots('lay-current', [['window', 2], ['window', 2], ['window', 2], ['center', 4], ['center', 4], ['bar', 4]]),
      ...spots('lay-window', [['window', 2], ['window', 2], ['window', 2], ['window', 2], ['center', 4], ['center', 4], ['bar', 4]]),
      ...spots('lay-extra', [['window', 2], ['window', 2], ['window', 2], ['center', 4], ['center', 4], ['center', 4], ['bar', 4]]),
    ],
    interiorPlan: { mood: 'warm-wood', materials: ['wood', 'gray'], memo: k('data.interior.memo.window') },
    localChange: [
      { changeId: 'lc-0', kind: 'construction', titleKey: 'data.localChange.roadWork', whenKey: 'data.localChange.when.lastWeekdays', startDate: '2026-10-19', endDate: '2026-10-23', distanceM: 250, sameCategory: false, sourceKey: 'data.source.sample', updatedAt: '2026-10-19T07:00', ackedAt: '2026-10-19T10:00' },
      { changeId: 'lc-1', kind: 'opening', titleKey: 'data.localChange.newCafe', whenKey: 'data.localChange.when.openingThisWeek', startDate: '2026-10-26', endDate: null, distanceM: 120, sameCategory: true, sourceKey: 'data.source.sample', updatedAt: '2026-10-26T08:00', ackedAt: null },
      { changeId: 'lc-2', kind: 'event', titleKey: 'data.localChange.streetEvent', whenKey: 'data.localChange.when.saturdayAfternoon', startDate: '2026-10-31', endDate: '2026-10-31', distanceM: 300, sameCategory: false, sourceKey: 'data.source.sample', updatedAt: '2026-10-26T08:00', ackedAt: null },
    ],
    footTraffic: [60, 140, 180, 190, 230, 260, 250, 320, 240, 210, 230, 250, 200, 150, 110, 70].map((estPeople, i) => ({ hour: 7 + i, estPeople })),
    trendKeyword: [
      { keywordId: 'kw-decaf', keywordKey: 'data.keyword.decaf', categoryKey: 'data.keywordCategory.drinks', mentions: 180, prevMentions: 120 },
      { keywordId: 'kw-takeout', keywordKey: 'data.keyword.takeout', categoryKey: 'data.keywordCategory.service', mentions: 240, prevMentions: 200 },
      { keywordId: 'kw-iced', keywordKey: 'data.keyword.icedDrinks', categoryKey: 'data.keywordCategory.drinks', mentions: 150, prevMentions: 210 },
      { keywordId: 'kw-halloween', keywordKey: 'data.keyword.halloween', categoryKey: 'data.keywordCategory.season', mentions: 90, prevMentions: null },
    ],
    inquiryThread: inquiryThreads,
    autoReplyRule: (['data.channel.kakao', 'data.channel.naverTalk'] as const).flatMap((channelKey) => (['hours', 'location', 'parking'] as const).map((topic) => ({ channelKey, topic, enabled: false }))),
    partnershipOffer: [
      { offerId: 'of-0', fromStoreKey: 'data.store.bakery', visibility: 'direct', titleKey: 'data.offer.cupGroupBuy', categoryKey: 'data.offerCategory.groupBuy', termsKey: 'data.offer.terms.cupGroupBuy', periodStart: '2026-10-10', periodEnd: '2026-10-31', respondBy: '2026-10-20T18:00', status: 'expired', sharedContactKey: null },
      { offerId: 'of-1', fromStoreKey: 'data.store.bakery', visibility: 'direct', titleKey: 'data.offer.beanGroupBuy', categoryKey: 'data.offerCategory.groupBuy', termsKey: 'data.offer.terms.beanGroupBuy', periodStart: '2026-11-01', periodEnd: '2026-11-30', respondBy: '2026-10-29T18:00', status: 'pending', sharedContactKey: null },
      { offerId: 'of-2', fromStoreKey: 'data.store.bookshop', visibility: 'direct', titleKey: 'data.offer.stampExchange', categoryKey: 'data.offerCategory.crossReward', termsKey: 'data.offer.terms.stampExchange', periodStart: '2026-11-04', periodEnd: '2026-12-31', respondBy: '2026-11-03T18:00', status: 'pending', sharedContactKey: null },
      { offerId: 'of-3', fromStoreKey: 'data.store.florist', visibility: 'public', titleKey: 'data.offer.alleySale', categoryKey: 'data.offerCategory.jointEvent', termsKey: 'data.offer.terms.alleySale', periodStart: '2026-11-09', periodEnd: '2026-11-15', respondBy: '2026-11-06T18:00', status: 'pending', sharedContactKey: null },
    ],
    offerInterest: [],
    integration: { calendar: true, phone: true, pos: true, channels: true },
    marketing: createLegacyMarketingSeed(),
    appliedKeys: {},
  });
}

const upgradedSeed = buildSeed();
const BASE_SEED: DataTables = deepFreeze({...upgradedSeed,shopSettings:{...upgradedSeed.shopSettings,cctvPosLinks:[]},reservation:[...upgradedSeed.reservation,...createLegacyCustomOrderSeed().tables.reservation] as DataTables['reservation']});

/** The frozen seed (shared safely because it is immutable). Overrides replace whole tables. */
export function createLegacySeedTables(overrides?: SeedOverrides): DataTables {
  return overrides ? deepFreeze({ ...BASE_SEED, ...overrides }) : BASE_SEED;
}

/** PRD12.6: recompose today's recorded transactions once; historical rows are untouched. */
export function createM3PosSeed(initial: import('../../contracts/pos').PosState): import('../../contracts/pos').PosState {
  if (initial.money) return initial;
  const t=createLegacySeedTables(), catalog= new Map(t.menuItem.map(m=>[m.menuId,m]));
  const selected=['B-024','B-025','B-026','B-027','B-028','B-029','B-030','B-031'];
  const donor='B-050', ids=new Set([...selected,donor]);
  const oldLines=initial.bills.filter(b=>ids.has(b.billId)).flatMap(b=>b.settlementLines);
  const pool=new Map<string,{qty:number;line:typeof oldLines[number]}>();
  for(const l of oldLines){const row=pool.get(l.menuId);pool.set(l.menuId,{qty:(row?.qty??0)+l.qty,line:l});}
  const portions=[['m-latte',1],['m-latte',1],['m-americano',1],['m-americano',1],['m-americano',1],['m-latte',2],['m-latte',1],['m-latte',2]] as const;
  for(const [menuId,qty]of portions)pool.get(menuId)!.qty-=qty;
  const specifications=new Map<string,readonly (readonly [string,number])[]>(selected.map((id,i)=>[id,[portions[i]]]));
  specifications.set(donor,[...pool].filter(([,r])=>r.qty).map(([id,r])=>[id,r.qty]));
  const allDiscounts=initial.bills.filter(b=>ids.has(b.billId)).flatMap(b=>b.discounts);
  const movedDiscounts=allDiscounts.map((d,i)=>({...d,billId:donor,discountId:`${donor}:m3:direct:${i}`,amount:d.amount-836}));
  const orders=initial.orders.map(o=>!ids.has(o.originBillId)?o:{...o,lines:specifications.get(o.originBillId)!.map(([menuId,qty],i)=>({orderLineId:`${o.orderId}:M3-${i+1}`,menuId,nameAtOrder:initial.orders.flatMap(o=>o.lines).find(l=>l.menuId===menuId)!.nameAtOrder,qty,unitPriceAtOrder:catalog.get(menuId)!.price,optionsAtOrder:[],request:'',canceledQty:0}))});
  const allocations=initial.billAllocations.filter(a=>!ids.has(a.billId));
  for(const o of orders.filter(o=>ids.has(o.originBillId)))for(const l of o.lines)allocations.push({billId:o.originBillId,allocationId:`${o.originBillId}:${l.orderLineId}`,orderLineId:l.orderLineId,qty:l.qty});
  const bills=initial.bills.map(b=>{
    if(!ids.has(b.billId))return b;
    const o=orders.find(o=>o.originBillId===b.billId)!,index=selected.indexOf(b.billId);
    const membership=index>=0&&index<5;
    const periodRows=t.membership.filter(m=>m.status==='active'&&m.productId==='p-monthly');
    const memberId=index>=0&&index<3?t.memberProfile.find(p=>p.customerId===periodRows[index+1].customerId)?.memberId:index>=3&&index<5?'M-0006':index===5?'M-0001':index===6?'M-0003':index===7?'M-0005':b.memberId;
    const off=index>=0&&index<3?portions[index][1]*catalog.get(portions[index][0])!.price:index>=3&&index<5?500:0;
    const discounts=b.billId===donor?movedDiscounts:membership?[{discountId:`${b.billId}:m3:membership`,billId:b.billId,source:'membership' as const,scope:'bill' as const,amount:off}]:[];
    return {...b,...(memberId?{memberId}:{}),discounts,settlementLines:o.lines.map(l=>{const old=pool.get(l.menuId)!.line;return {...old,allocationId:`${b.billId}:${l.orderLineId}`,qty:l.qty,recognizedQty:l.qty,discountAllocations:discounts.map(d=>({discountId:d.discountId,amount:Math.floor(d.amount*l.qty*l.unitPriceAtOrder/o.lines.reduce((n,l)=>n+l.qty*l.unitPriceAtOrder,0))}))};})};
  });
  // Allocate every final won to a line, so receipts, gross and discounts reconcile exactly.
  for(const b of bills.filter(b=>ids.has(b.billId)))for(const d of b.discounts){const shares=allocateSeedWon(d.amount,b.settlementLines.map(l=>({id:l.allocationId,amount:l.qty*(l.basePriceAtSale+l.optionPriceAtSale)})));for(const l of b.settlementLines){const a=l.discountAllocations.find(a=>a.discountId===d.discountId);if(a)(a as {amount:number}).amount=shares[l.allocationId];}}
  const payments=initial.payments.filter(p=>!selected.includes(p.billId)).map(p=>p.billId!==donor?p:{...p,amount:bills.find(b=>b.billId===donor)!.settlementLines.reduce((n,l)=>n+l.qty*(l.basePriceAtSale+l.optionPriceAtSale)-l.discountAllocations.reduce((n,d)=>n+d.amount,0),0),splits:[{method:'card' as const,amount:bills.find(b=>b.billId===donor)!.settlementLines.reduce((n,l)=>n+l.qty*(l.basePriceAtSale+l.optionPriceAtSale)-l.discountAllocations.reduce((n,d)=>n+d.amount,0),0)}]});
  let pos={...initial,orders,bills,billAllocations:allocations,payments,receipts:initial.receipts.filter(r=>payments.some(p=>p.paymentId===r.paymentId))};
  const money=createRecordedMoney(pos,t,selected);
  return deepFreeze({...pos,money});
}
import { allocatePosAmount as allocateSeedWon } from '../../pos/domain/money';
import type { MoneyRead, MoneyState, Settlement, SalesRecognition, MemberAccountTxn, MembershipTerms, MembershipUse as MoneyUse, MoneySource } from '../iteration7/accounting/types';
import { emptyMoneyState, planMembershipServiceDay } from '../iteration7/accounting';
import { legacyMembershipProducts } from '../iteration7/memberships';
function createRecordedMoney(pos:import('../../contracts/pos').PosState,t:DataTables,selected:readonly string[]):MoneyState {
  const date=pos.businessDate, at=`${date}T15:45`;
  const products=legacyMembershipProducts.map(p=>({...p,productId:p.productId.replace('mp-','p-')}));
  let memberships:MembershipTerms[]=t.membership.filter(m=>m.status==='active').map(m=>{const p=products.find(p=>p.productId===m.productId)!;return {...p,membershipId:m.membershipId,memberId:t.memberProfile.find(x=>x.customerId===m.customerId)!.memberId,startsOn:m.startsOn,endsOn:m.endsOn,saleSettlementId:`opening-pass:${m.membershipId}`};});
  const count=memberships.find(m=>m.memberId==='M-0006'&&m.kind==='count')!;
  const activePeriods=memberships.filter(m=>m.kind==='period');
  const uses:MoneyUse[]=[], settlements:Settlement[]=[],recognitions:SalesRecognition[]=[];
  const accountTxns:MemberAccountTxn[]=[];
  const txn=(id:string,memberId:string,account:'charge'|'receivable',kind:MemberAccountTxn['kind'],amount:number,time:string,settlementId:string|null=null,allocationId:string|null=null,sourceAmounts?:MemberAccountTxn['sourceAmounts'])=>accountTxns.push({txnId:id,memberId,account,kind,amount,at:time,settlementId,allocationId,sourceRef:settlementId?{kind:'settlement',id:settlementId}:null,originalTxnId:null,reason:'',...(sourceAmounts?{sourceAmounts}:{})});
  txn('opening-charge','M-0003','charge','opening',20000,'2026-10-25T09:00');txn('opening-debt','M-0005','receivable','opening',15000,'2026-10-25T09:00');
  const moneyPayments:MoneyState['payments'][number][]=[];
  for(const b of pos.bills){
    const index=selected.indexOf(b.billId),id=`seed:${b.billId}`,methodPayments=pos.payments.filter(p=>p.billId===b.billId);
    const line=b.settlementLines[0],memberPass=index>=0&&index<3?activePeriods[index+1]:index>=3&&index<5?count:undefined;
    const kind=index<0?'method':index<3?'membership_period':index<5?'membership_count':index<7?'charge':'receivable';
    const amount=b.settlementLines.reduce((n,l)=>n+l.qty*(l.basePriceAtSale+l.optionPriceAtSale)-l.discountAllocations.reduce((n,d)=>n+d.amount,0),0);
    const useId=memberPass?`seed-use:${b.billId}`:undefined;
    const allocations=kind==='method'?methodPayments.flatMap(p=>p.splits.map((s,i)=>({allocationId:`${id}:${p.paymentId}:${i}`,kind:'method' as const,...s}))):[{allocationId:`${id}:a0`,kind,amount,...(memberPass?{membershipId:memberPass.membershipId,useId,billAllocationId:line.allocationId,quantity:1,membershipDiscount:index<3?amount+line.discountAllocations.reduce((n,d)=>n+d.amount,0):500}:{})}];
    const source:MoneySource={sourceRef:{kind:'bill',id:b.billId},purpose:'sale',billId:b.billId,memberId:b.memberId??null,amountDue:b.settlementLines.reduce((n,l)=>n+l.qty*(l.basePriceAtSale+l.optionPriceAtSale),0),fingerprint:`recorded:${b.billId}`,orderIds:pos.orders.filter(o=>o.originBillId===b.billId).map(o=>o.orderId),prepared:true,lines:b.settlementLines.map(l=>({allocationId:l.allocationId,orderLineId:pos.billAllocations.find(a=>a.allocationId===l.allocationId)!.orderLineId,menuId:l.menuId,quantity:l.qty,unitPrice:l.basePriceAtSale+l.optionPriceAtSale,unitCost:l.unitCostAtSale,recipe:t.recipeLine.filter(r=>r.menuId===l.menuId).map(r=>({itemId:r.itemId,quantityBase:r.quantity}))}))};
    const s:Settlement={settlementId:id,purpose:'sale',sourceRef:source.sourceRef,billId:b.billId,partId:null,memberId:b.memberId??null,at:b.settledAt??at,amount,allocations:allocations as Settlement['allocations'],status:'paid',sourceSnapshot:source};settlements.push(s);
    for(const p of methodPayments)moneyPayments.push({paymentId:p.paymentId,settlementId:id,purpose:'sale',sourceRef:s.sourceRef,at:p.at,amount:p.amount,splits:p.splits});
    const shares=allocateSeedWon(amount,b.settlementLines.map(l=>({id:l.allocationId,amount:l.qty*(l.basePriceAtSale+l.optionPriceAtSale)-l.discountAllocations.reduce((n,d)=>n+d.amount,0)})));
    for(const l of b.settlementLines){const discounts={direct:0,coupon:0,membership:0};for(const a of l.discountAllocations){const d=b.discounts.find(d=>d.discountId===a.discountId)!;discounts[d.source]+=a.amount;}
      const category=kind==='method'?methodPayments[0].countedMethod:kind==='membership_period'?'membership_count':kind;
      recognitions.push({recognitionId:`${id}:${l.allocationId}`,source:kind==='membership_count'?'membership_count':'menu',sourceId:b.billId,businessDate:date,at:s.at,amount:kind==='method'?0:shares[l.allocationId],cost:(l.unitCostAtSale!+l.optionCostAtSale!)*l.qty,settlementCategory:category as SalesRecognition['settlementCategory'],settlementId:id,settlementAllocationId:s.allocations[0].allocationId,billAllocationId:l.allocationId,orderLineId:source.lines.find(x=>x.allocationId===l.allocationId)!.orderLineId,menuId:l.menuId,quantity:l.qty,gross:l.qty*(l.basePriceAtSale+l.optionPriceAtSale),discountBySource:discounts,originalRecognitionId:null,...(memberPass?{membershipId:memberPass.membershipId,useId}:{})});
    }
    if(kind==='method')for(const allocation of s.allocations){const amounts=allocateSeedWon(allocation.amount,b.settlementLines.map(l=>({id:l.allocationId,amount:shares[l.allocationId]})));for(const l of b.settlementLines)recognitions.push({recognitionId:`${id}:money:${allocation.allocationId}:${l.allocationId}`,source:'menu',sourceId:b.billId,businessDate:date,at:s.at,amount:amounts[l.allocationId],cost:0,quantity:0,menuId:l.menuId,billAllocationId:l.allocationId,orderLineId:source.lines.find(x=>x.allocationId===l.allocationId)!.orderLineId,settlementCategory:allocation.method!,settlementId:id,settlementAllocationId:allocation.allocationId,originalRecognitionId:null});}
    if(memberPass)uses.push({useId:useId!,membershipId:memberPass.membershipId,at:s.at,sourceRef:s.sourceRef,coveredQuantities:[{allocationId:line.allocationId,quantity:1}],recognizedAmount:amount,membershipDiscount:index<3?line.qty*(line.basePriceAtSale+line.optionPriceAtSale):500,canceledAt:null});
    if(index===5)txn('seed-charge1','M-0001','charge','use',-10000,`${date}T12:10`,id,s.allocations[0].allocationId,[{txnId:'seed-topup',amount:10000}]);
    if(index===6)txn('seed-charge2','M-0003','charge','use',-5000,`${date}T13:50`,id,s.allocations[0].allocationId,[{txnId:'opening-charge',amount:5000}]);
    if(index===7)txn('seed-debt','M-0005','receivable','sale',10000,s.at,id,s.allocations[0].allocationId);
  }
  const fund=(id:string,purpose:Settlement['purpose'],memberId:string,amount:number,method:'card'|'easy_pay'|'cash',time:string)=>{settlements.push({settlementId:id,purpose,sourceRef:{kind:purpose,id:memberId},billId:null,partId:null,memberId,at:`${date}T${time}`,amount,allocations:[{allocationId:`${id}:a`,kind:'method',method,amount}],status:'paid'});moneyPayments.push({paymentId:`payment:${id}`,settlementId:id,purpose,sourceRef:{kind:purpose,id:memberId},at:`${date}T${time}`,amount,splits:[{method,amount}]});};
  fund('seed-topup','charge_topup','M-0001',50000,'card','10:15');txn('seed-topup','M-0001','charge','topup',50000,`${date}T10:15`,'seed-topup');
  fund('seed-collection','receivable_collection','M-0005',15000,'cash','11:30');txn('seed-collection','M-0005','receivable','collection',-15000,`${date}T11:30`,'seed-collection',null,[{txnId:'opening-debt',amount:15000}]);
  fund('seed-pass-sale','membership_sale','M-0002',40000,'easy_pay','13:10');
  // The recorded sale is already one of the 38 active passes.
  const sold=memberships.find(m=>m.productId==='p-americano10' && m.membershipId!==count.membershipId && !['M-0001','M-0002','M-0003','M-0004','M-0005','M-0006'].includes(m.memberId))!;
  memberships=memberships.map(m=>m===sold?{...m,memberId:'M-0002',startsOn:date,endsOn:addDays(date,89),saleSettlementId:'seed-pass-sale'}:m);
  for(const oldUse of t.membershipUse){const pass=memberships.find(m=>m.membershipId===oldUse.membershipId);if(pass)uses.push({useId:oldUse.useId,membershipId:pass.membershipId,at:oldUse.usedAt,sourceRef:{kind:'history',id:pass.membershipId},coveredQuantities:[],recognizedAmount:pass.kind==='count'?Math.floor(pass.soldPrice/pass.totalUses!):0,membershipDiscount:0,canceledAt:oldUse.canceledAt});}
  for(const m of memberships.filter(m=>m.kind==='count')){const old=t.membership.find(x=>x.membershipId===m.membershipId)!;const n=m.saleSettlementId==='seed-pass-sale'?0:Math.max(0,m.totalUses!-(old.usesLeft??m.totalUses!)-uses.filter(u=>u.membershipId===m.membershipId).length);for(let i=0;i<n;i++)uses.push({useId:`opening-use:${m.membershipId}:${i}`,membershipId:m.membershipId,at:'2026-10-25T09:00',sourceRef:{kind:'history',id:m.membershipId},coveredQuantities:[],recognizedAmount:Math.floor(m.soldPrice/m.totalUses!),membershipDiscount:0,canceledAt:null});}
  // Prior recognized count value accompanies historical uses, without touching today's sales.
  for(const u of uses.filter(u=>u.at.slice(0,10)<date))recognitions.push({recognitionId:u.useId,source:'membership_count',sourceId:u.useId,membershipId:u.membershipId,useId:u.useId,businessDate:u.at.slice(0,10),at:u.at,amount:u.recognizedAmount,cost:0,settlementCategory:'membership_count',originalRecognitionId:null});
  const corrections:MoneyState['corrections'][number][]=[];
  for(const r of pos.refunds){const s=settlements.find(s=>s.billId===r.billId)!,original=recognitions.find(x=>x.settlementId===s.settlementId&&x.amount>=r.amount&&x.menuId===r.lineAmounts.map(a=>pos.orders.flatMap(o=>o.lines).find(l=>l.orderLineId===a.orderLineId)?.menuId)[0])??recognitions.find(x=>x.settlementId===s.settlementId&&x.amount>0)!;const reversal={...original,recognitionId:r.refundId,at:r.at,amount:-r.amount,cost:0,quantity:0,gross:0,discountBySource:{direct:0,coupon:0,membership:0},originalRecognitionId:original.recognitionId};recognitions.push(reversal);corrections.push({correctionId:r.refundId,settlementId:s.settlementId,at:r.at,kind:'refund',amount:r.amount,originalAllocationEffects:[{allocationId:s.allocations[0].allocationId!,amount:r.amount}],realMethodReturns:r.methodAmounts,accountEffects:[],membershipEffects:[],recognitionEffects:[reversal],lineEffects:[]});}
  for(const s of pos.customSettlements??[])settlements.push({...s,sourceSnapshot:{sourceRef:s.sourceRef,purpose:'custom_order',memberId:s.memberId,amountDue:s.amount,fingerprint:s.settlementId,lines:[],orderIds:[],paymentTiming:s.paymentTiming}});
  moneyPayments.push(...(pos.customPayments??[]));
  let state:MoneyState={...emptyMoneyState(),settlements,payments:moneyPayments,recognitions,accountTxns,memberships,uses,corrections};
  const read:MoneyRead={runId:'seed',revision:0,generation:0,businessDate:date,now:at,scenario:'normal',dayClosed:false,state,members:[],products,sources:[]};
  const service=planMembershipServiceDay(read,{date});if(service.ok)state=service.nextState;
  return state;
}
