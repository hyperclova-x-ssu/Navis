import { seedHistory } from '../../../data/db/generated/history';
import { seedCatalog } from '../../../data/db/generated/catalog';
import manifest from '../../../data/db/generated/manifest.json';
import { addDays, LAST_MONTH_END, LAST_MONTH_START, MONTH_START, TODAY, weekdayOf, YESTERDAY } from '../../../data/db/time';
import { createWidgetDataStore, deriveStock, posFacts, readDemand, readModel, selectMembers, selectMenus } from '../../../data/widget-data';
import { navisTranslator } from '../messages';
import { cafeFacts, cafeSnapshot, cafeWeek } from './cafe';

const tr = navisTranslator('ko');
const ko = tr.format;
const krw = (value: number) => ko.money(value, 'full');
const money = (value: number) => ko.money(value, 'compact');
const numeric = (feature: Parameters<typeof cafeFacts>[0], key: string, condition?: Parameters<typeof cafeFacts>[1]) => {
  const value = cafeFacts(feature, condition).find(fact => fact.key === key)?.value;
  if (typeof value !== 'number') throw new Error(`Missing café fact ${feature}/${key}`);
  return value;
};
const menu = (id: string) => {
  const row = selectMenus(cafeSnapshot, {}).rows.find(row => row.menuId === id);
  if (!row?.name || !('raw' in row.name) || row.cost === null || row.rate === null) throw new Error(`Missing café menu ${id}`);
  return { id, name: row.name.raw, price: row.price, cost: row.cost, rate: row.rate };
};
const inventory = (itemId: string) => {
  const row = deriveStock(cafeSnapshot, { date: TODAY }).rows.find(row => row.itemId === itemId);
  if (!row?.name || !('raw' in row.name)) throw new Error(`Missing café ingredient ${itemId}`);
  return { name: row.name.raw, stock: ko.quantity(row.stock, row.unit), usage: ko.quantity(row.usedToday, row.unit),
    threshold: row.restockThreshold === null ? null : ko.quantity(row.restockThreshold, row.unit) };
};
function recipe(id: string) {
  const source = seedCatalog.menu.find(row => row.menuId === id);
  if (!source) throw new Error(`Missing café recipe ${id}`);
  return source.recipeBase.map(({ itemId, quantityBase, unitDimension }) => ({ itemId: String(itemId), quantity: Number(quantityBase), unit: unitDimension }));
}
function recipeChange(menuId: string, lines: ReturnType<typeof recipe>) {
  const store = createWidgetDataStore();
  const result = store.dispatch({ type: 'menu.setRecipe', menuId, lines });
  if (!result.ok) throw new Error(`Invalid café recipe change for ${menuId}`);
  const snapshot = store.getSnapshot();
  const row = selectMenus(snapshot, {}).rows.find(row => row.menuId === menuId)!;
  return { cost: row.cost, rate: row.rate,
    milkUsage: deriveStock(snapshot, { date: TODAY }).rows.find(item => item.itemId === 'i-milk')!.usedToday };
}

export function cafeScenarioValues() {
  const americano = menu('m-americano'), latte = menu('m-cafe-latte'), vanilla = menu('m-vanilla-latte');
  const caramel = menu('m-caramel-macchiato');
  const latteChoices = selectMenus(cafeSnapshot, {}).rows.flatMap(row =>
    row.name && 'raw' in row.name && /라[떼테]/u.test(row.name.raw) ? [{ id: row.menuId, name: row.name.raw }] : [],
  ).slice(0, 5);
  const latteRecipe = recipe(latte.id), americanoRecipe = recipe(americano.id);
  const lessMilk = latteRecipe.map(line => line.itemId === 'i-milk' ? { ...line, quantity: 250 } : line);
  const withSyrup = [...latteRecipe, { itemId: 'i-vanilla-syrup', quantity: 10, unit: 'mL' as const }];
  const noCup = americanoRecipe.filter(line => line.itemId !== 'i-cup-takeout');
  const net = numeric('ledger', 'ledger.sales.net');
  const yesterdayNet = seedHistory.days.find(day => day.date === YESTERDAY)!.net;
  const weekNet = numeric('ledger', 'ledger.sales.net', cafeWeek);
  const monthToDate = { kind: 'dateRange' as const, start: MONTH_START, end: TODAY };
  const monthNet = numeric('ledger', 'ledger.sales.net', monthToDate);
  const promoRevenue = numeric('marketing-performance', 'perf.revenue');
  const members = selectMembers(cafeSnapshot, {});
  const milkPurchase = cafeSnapshot.tables.purchaseItem.find(row => row.itemId === 'i-milk')!;
  const template = cafeSnapshot.tables.customTemplate[0];
  const pos = posFacts(cafeSnapshot);
  const fromPos = (key: string) => Number(pos.find(fact => fact.key === key)!.value);
  const widgetIds = [
    'ai-response', 'briefing', 'calendar', 'coupon-status', 'credit-receivable', 'custom-order', 'customer-analysis',
    'customer-groups', 'grants', 'ledger', 'local-changes', 'local-trends', 'margin', 'marketing-performance',
    'marketing-today', 'members', 'notice-send', 'promo-video', 'slot-coupon', 'staff-schedule',
    'store-environment', 'tax', 'trade-area', 'voice-booking',
  ] as const;
  const widget = Object.fromEntries(widgetIds.map(id => [
    id, Object.fromEntries(cafeFacts(id).map(({ key, value }) => [key.replaceAll('.', '_'), value])),
  ]));
  return {
    today: TODAY, yesterday: YESTERDAY, clock: manifest.cutoff.localTime.slice(0, 5),
    weekday: new Intl.DateTimeFormat('en', { timeZone: 'UTC', weekday: 'short' }).format(new Date(TODAY)),
    september: { kind: 'dateRange', start: '2026-09-01', end: '2026-09-30' },
    todayRange: { kind: 'dateRange', start: TODAY, end: TODAY },
    yesterdayRange: { kind: 'dateRange', start: YESTERDAY, end: YESTERDAY },
    thisSaturday: addDays(TODAY, 6 - weekdayOf(TODAY)),
    week: cafeWeek, rollingMonth: { kind: 'dateRange', start: addDays(TODAY, -29), end: TODAY },
    monthToDate, priorMonth: { kind: 'dateRange', start: LAST_MONTH_START, end: LAST_MONTH_END },
    inventoryToday: { kind: 'snapshot', asOf: TODAY },
    menuCount: selectMenus(cafeSnapshot, {}).rows.length, storeName: manifest.store.name,
    americano, latte, vanilla, caramel, latteChoices, latteChoiceNames: latteChoices.map(row => row.name),
    latteBeanGrams: latteRecipe.find(line => line.itemId === 'i-bean-house')!.quantity,
    latteMilkMl: latteRecipe.find(line => line.itemId === 'i-milk')!.quantity,
    recipe: { lessMilk, withSyrup, noCup, lessMilkResult: recipeChange(latte.id, lessMilk),
      withSyrupResult: recipeChange(latte.id, withSyrup), noCupResult: recipeChange(americano.id, noCup) },
    stock: { milk: inventory('i-milk'), beans: inventory('i-bean-house'), cup: inventory('i-cup-takeout'),
      restock: numeric('inventory-booking', 'inventory.restock.count'), out: numeric('inventory-booking', 'inventory.outOfStock.count') },
    milkPurchaseId: milkPurchase.purchaseItemId,
    template: { id: template.templateId, name: template.name, fields: template.fields, revision: template.revision },
    net, yesterdayNet, weekNet, yesterdayKrw: krw(yesterdayNet),
    widget,
    expensesByCategory: cafeFacts('ledger').filter(fact => fact.key === 'ledger.expenses.category').map(fact =>
      `${fact.labelText && 'key' in fact.labelText ? tr.t(fact.labelText.key) : ''} ${krw(Number(fact.value))}`),
    depositsByMethod: ['card', 'easyPay', 'cash'].map(method => krw(fromPos(`accounting.deposits.${method}`))),
    refunds: { count: fromPos('pos.refunds.count'), amount: krw(fromPos('pos.sales.refund')) },
    manualsCount: readModel(cafeSnapshot, 'manuals').manuals.length,
    october25Krw: krw(seedHistory.days.find(day => day.date === '2026-10-25')!.net),
    nextTax: { amount: numeric('tax', 'tax.payment.next'), label: '다음 세금 납부', display: money(numeric('tax', 'tax.payment.next')) },
    ledger: { todayKrw: krw(net), todayCompact: money(net), yesterdayCompact: money(yesterdayNet), weekKrw: krw(weekNet), weekCompact: money(weekNet),
      expenses: krw(numeric('ledger', 'ledger.expenses.total')), remaining: krw(numeric('ledger', 'ledger.remaining')),
      delta: ko.percent(numeric('ledger', 'ledger.sales.delta')), deposits: krw(fromPos('accounting.deposits.total')) },
    margin: { cost: krw(numeric('margin', 'margin.cost')), rate: ko.percent(numeric('margin', 'margin.rate')),
      grossProfit: krw(numeric('margin', 'margin.grossProfit')) },
    members: { total: members.total, regular: members.gradeCounts.regular },
    credit: { charge: krw(numeric('credit-receivable', 'account.charge.total')), receivable: krw(numeric('credit-receivable', 'account.receivable.total')) },
    cctv: { visits: numeric('customer-analysis', 'cctv.visits.total'), hour: numeric('customer-analysis', 'cctv.peak.hour'),
      peak: numeric('customer-analysis', 'cctv.peak.visits'), staff: numeric('customer-analysis', 'cctv.peak.staff') },
    demand: readDemand(cafeSnapshot).day.expected,
    marketing: { revenue: krw(promoRevenue), share: ko.percent(Math.round(promoRevenue / monthNet * 1000) / 10), monthNet: krw(monthNet), profit: krw(numeric('marketing-performance', 'perf.profit')),
      revenueDelta: krw(numeric('marketing-performance', 'perf.revenue.delta')) },
    booking: { count: numeric('voice-booking', 'booking.today.count'), waiting: numeric('voice-booking', 'booking.needsCheck.count'),
      seats: numeric('voice-booking', 'booking.seats') },
    displays: Object.fromEntries((['ko', 'en', 'zh-Hans', 'zh-Hant'] as const).map(locale => {
      const tr = navisTranslator(locale);
      return [locale, { today: tr.format.money(net, 'compact'), yesterday: tr.format.money(yesterdayNet, 'compact'),
        salesLabel: tr.t('data.fact.ledger.sales.net') }];
    })),
    menuDisplay: { lattePrice: krw(latte.price), vanillaCost: money(vanilla.cost), americanoCost: money(americano.cost) },
  };
}
