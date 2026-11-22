import { cafePosAsOf, cafeRollupAsOf } from './cafe-fixture-now';
import { dataSourceFor } from '../reality/00/registry';
import { FIXTURE_AS_OF, fixtureOccurred, rebaseFixtureDates } from './fixture-dates';
import { seedCatalog as catalog } from './generated/catalog';
import { seedClosingHistory as closingHistory } from './generated/closing-history';
import { seedHistory as history } from './generated/history';
import { seedMembers as members } from './generated/members';
import { seedOperations as operations } from './generated/operations';
import { seedSupplement as supplement } from './generated/supplement';
import { seedTimeline } from './generated/timeline';
import { seedToday as today } from './generated/today';
import manifest from './generated/manifest.json';
import { daysBetween } from './time';

export const seedCatalog = rebaseFixtureDates(catalog);
export const seedClosingHistory = rebaseFixtureDates(closingHistory);
export const seedHistory = rebaseFixtureDates(history);
const fullToday = rebaseFixtureDates(today);
const fullOperations = rebaseFixtureDates(operations);
const fullMembers = rebaseFixtureDates(members);
const fullSupplement = rebaseFixtureDates(supplement);
const timeline = rebaseFixtureDates<{ expenseAt: Record<string, string>; bookingChangeAt: Record<string, string> }>(seedTimeline);
const day = fullToday.pos.businessDate;
const cutoff = FIXTURE_AS_OF && !fixtureOccurred(`${day}T${manifest.cutoff.localTime}`) ? FIXTURE_AS_OF : undefined;

// Before 05:00 POS can point at a closed historical date whose fixture carries totals only.
export function isArchivedCafeDay(date: string): boolean {
  return Boolean(FIXTURE_AS_OF && dataSourceFor('pos') === 'fixture' && date < day && seedHistory.days.some(row => row.date === date));
}

function operationsAsOf() {
  return {
    ...fullOperations,
    expenses: fullOperations.expenses.filter(row => fixtureOccurred(timeline.expenseAt[row.expenseId] ?? row.businessDate)),
    purchaseOrders: fullOperations.purchaseOrders.filter(row => fixtureOccurred(row.orderedOn)).map(row => {
      const lines = row.lines.map(line => ({ ...line, receipts: line.receipts.filter(receipt => fixtureOccurred(receipt.receivedAt)) }));
      const received = lines.some(line => line.receipts.length);
      const complete = lines.every(line => line.receipts.reduce((qty, receipt) => qty + receipt.qty, 0) === line.qtyOrdered);
      return { ...row, lines, status: complete ? 'complete' : received ? 'partial' : 'scheduled' };
    }),
    threads: fullOperations.threads.filter(row => fixtureOccurred(row.receivedAt)),
    membershipUses: fullOperations.membershipUses.filter(row => fixtureOccurred(row.usedAt))
      .map(row => ({ ...row, canceledAt: row.canceledAt && fixtureOccurred(row.canceledAt) ? row.canceledAt : null })),
  };
}
export const seedOperations = cutoff ? operationsAsOf() : fullOperations;

function todayAsOf(): typeof today {
  const pos = cafePosAsOf(fullToday.pos);
  const expenses = seedOperations.expenses.filter(row => row.businessDate === day).reduce((total, row) => total + row.amount, 0);
  const rollup = cafeRollupAsOf(pos, expenses);
  const visibleOrders = new Set(pos.orders.map(row => row.orderId));
  const bookings = fullToday.bookings.filter(row => visibleOrders.has(row.firstOrderId)).map(row => ({
    ...row, status: fixtureOccurred(timeline.bookingChangeAt[row.reservationId] ?? row.at) ? row.status : 'confirmed' as const,
  }));
  const receipts = new Map<string, number>();
  for (const order of seedOperations.purchaseOrders) for (const line of order.lines) {
    const units = line.receipts.filter(row => row.receivedAt.startsWith(day)).reduce((sum, row) => sum + row.qty, 0) * line.basePerUnit;
    receipts.set(line.itemId, (receipts.get(line.itemId) ?? 0) + units);
  }
  const menus = new Map<string, (typeof seedCatalog.menu)[number]>(seedCatalog.menu.map(menu => [menu.menuId, menu]));
  const used = new Map<string, number>();
  for (const [menuId, qty] of rollup.menu) for (const part of menus.get(menuId)?.recipeBase ?? []) {
    used.set(part.itemId, (used.get(part.itemId) ?? 0) + part.quantityBase * qty);
  }
  const stock = fullToday.stock.map(row => {
    const received = receipts.get(row.itemId) ?? 0, usage = used.get(row.itemId) ?? 0;
    return { ...row, receipts: received, usage, onHand: row.opening + received - usage };
  });
  return { pos, rollup, bookings, stock };
}
export const seedToday = cutoff ? todayAsOf() : fullToday;

function membersAsOf(): typeof members {
  const firstHour = new Map<string, number>();
  const bills = new Map(seedToday.pos.bills.map(row => [row.billId, row]));
  for (const order of seedToday.pos.orders) {
    const memberId = bills.get(order.originBillId)?.memberId;
    if (memberId && order.preparation !== 'canceled' && !firstHour.has(memberId)) {
      firstHour.set(memberId, Number(order.orderedAt.slice(11, 13)));
    }
  }
  const todayHour = daysBetween(fullMembers.start, day) * 24;
  return { ...fullMembers, members: fullMembers.members.map(row => {
    const hour = firstHour.get(row.memberId);
    const visits = row.visits.filter(visit => visit < todayHour);
    if (hour !== undefined) visits.push(todayHour + hour);
    return { ...row, visits };
  }) };
}
export const seedMembers = cutoff ? membersAsOf() : fullMembers;

export const seedCctvHistoryScale = fullSupplement.cctv.reduce((sum, row) => sum + row.entries, 0) / fullToday.rollup.orders;
export const seedSupplement = cutoff ? {
  ...fullSupplement,
  cctv: fullSupplement.cctv.filter(row => fixtureOccurred(`${row.date}T${String(row.hour).padStart(2, '0')}:00`)).map(row => {
    const orderCount = seedToday.rollup.hourly[row.hour];
    return { ...row, orderCount, entries: Math.round(orderCount * seedTimeline.visitsPerOrder),
      status: row.hour === Number(cutoff.slice(11, 13)) ? 'partial' as const : 'ok' as const };
  }),
  cameras: fullSupplement.cameras.map(row => ({ ...row, lastCheckedAt: cutoff })),
  localChanges: fullSupplement.localChanges.filter(row => fixtureOccurred(row.updatedAt)),
  notices: fullSupplement.notices.filter(row => fixtureOccurred(row.createdAt)),
  customOrders: fullSupplement.customOrders.filter(row => fixtureOccurred(row.receivedAt)),
  promos: fullSupplement.promos,
} : fullSupplement;
