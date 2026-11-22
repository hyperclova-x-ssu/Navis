import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import { handlers } from '../../../data/commands/handlers';
import { findExpenseDuplicate, findTaxDuplicate, isExpenseDayClosed, selectNextTaxPayment } from '../../../data/commands/management-guards';
import type { DataCommand } from '../../../data/commands/types';
import { addDays, daysBetween, isIsoDate, TODAY } from '../../../data/db/time';
import type { DataSnapshot, DataText, Evidence, Expense, ExpenseCategory } from '../../../data/db/types';
import { selectMoneyRead } from '../../../data/pos/projection';
import { totalsIn } from '../../../data/reality/09/dto';
import { realHourlySales, realMenuSales } from '../../../data/reality/09/views';
import type { TaxRealCommand } from '../../../data/reality/18/commands';
import { normalizeCondition, readModel, resolveDataText, selectClosing, selectPayments, selectWidget, supportedConditions, type LedgerExpenseRow, type LedgerModel, type TaxModel } from '../../../data/widget-data';
import { createTranslator } from '../../../i18n';
import { selectCashReceiptTotals } from '../../../pos/reversals/receipt';
import { validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill, type AgentFact, type AgentRefusal } from '../../../../shared/navis-agent-schema.mjs';
import { mgmtMoneyBundle } from '../../widgets/mgmt-money/messages';
import { navisTranslator } from '../messages';
import { navisMoneySpans, normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisNumber, parseNavisPeriod } from '../navis-input';
import type { AgentHandoff } from '../types';
import { moneyMessages } from './money.messages';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainLookup, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter, RecordSearch, RecordTargets } from './registry';

type MoneyFeature = 'ledger' | 'tax';
type Payment = TaxModel['payments'][number];
type MoneyCommand = Exclude<Extract<DataCommand, { type: `ledger.${string}` | `tax.${string}` }>, TaxRealCommand | { type: 'tax.markPaid' | 'tax.export' }>;
type CommandName = MoneyCommand['type'];
type MoneyRecord = 'expense' | 'candidate' | 'taxPayment' | 'taxItem';
// D-326 Q2: editing one past expense is a card. `allowExpenseEdit` is the default-off switch.
type MoneyPolicy = { readonly allowExpenseEntry?: boolean; readonly allowTaxDelete?: boolean; readonly allowExpenseEdit?: boolean };

const selectText = (locale: Locale) => {
  const { t, format } = navisTranslator(locale);
  const widget = createTranslator(locale, mgmtMoneyBundle).t;
  return { t, widget, format, money: (amount: number) => format.money(amount, 'full'),
    date: (date: string) => format.date(date, 'monthDay'),
    data: (value: DataText) => resolveDataText(t, value),
    count: (count: number) => format.count(count, 'count'),
    l: (ko: string, en: string, hans: string, hant: string) => ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale] };
};
const dateOf = (snapshot: DataSnapshot) => snapshot.pos?.businessDate ?? TODAY;
const taxDateOf = (snapshot: DataSnapshot) => snapshot.tables.realTax?.today ?? dateOf(snapshot);
const taxDate = taxDateOf;
const signedNet = (row: DataSnapshot['tables']['dailySales'][number]) => row.recognizedNet ?? row.gross - row.discount - row.refund;
const periodCondition = (start: string, end: string): QueryCondition => ({ kind: 'dateRange', start, end });
const defaultCondition = { kind: 'default' } as const;

function fact(key: string, label: string, value: string | number, unit: string, display = String(value), date?: string): AgentFact {
  return { key, label, value, unit, display, ...(date ? { date } : {}) };
}

function ledgerExpenseFacts(key: string, items: readonly LedgerExpenseRow[], tr: ReturnType<typeof selectText>) {
  return items.map(row => fact(key, row.memo ? tr.data(row.memo) : tr.t(row.categoryKey), row.amount, 'KRW',
    [tr.money(row.amount), tr.date(row.date), tr.t(row.evidenceKey)].join(' · '), row.date));
}

function ledgerFacts(snapshot: DataSnapshot, model: LedgerModel, locale: Locale): AgentFact[] {
  const tr = selectText(locale), { start, end } = model.period;
  const size = snapshot.tables.dailySales.filter(row => row.businessDate >= start && row.businessDate <= end).length;
  const complete = size === model.periodTrend.length;
  const currency = (key: string, label: string, amount: number) => ({ ...fact(key, label, amount, 'KRW', tr.money(amount), start === end ? start : undefined), start, end });
  const real = snapshot.tables.realFinance;
  // Over HTTP the per-menu sales are the service's sale-time rows of that period (none for a period it was not asked for), never the sample history.
  const perMenu = real ? new Map(realMenuSales(real, start, end) ?? []) : new Map<string, number>();
  if (!real) for (const row of snapshot.tables.menuDaily.filter(row => row.businessDate >= start && row.businessDate <= end && row.netSales !== null)) perMenu.set(row.menuId, (perMenu.get(row.menuId) ?? 0) + row.netSales!);
  const menuFacts = [...perMenu.entries()].sort((a, b) => b[1] - a[1]).flatMap(([id, amount]) => {
    const menu = snapshot.tables.menuItem.find(row => row.menuId === id);
    return menu ? [currency('ledger.sales.menu', tr.data(menu.name ?? { key: menu.nameKey }), amount)] : [];
  });
  const totals = new Map<number, number>();
  if (start === end) {
    const entries = real ? realHourlySales(real, start) : snapshot.pos?.money
      ? selectMoneyRead(snapshot).state.recognitions.filter(row => row.businessDate === start).map(row => [Number(row.at.slice(11, 13)), row.amount] as const)
      : selectPayments(snapshot, { date: start, scenario: 'normal' }).rows.map(row => [Number(row.time.slice(0, 2)), row.net] as const);
    for (const [hour, amount] of entries) if (amount) totals.set(hour, (totals.get(hour) ?? 0) + amount);
  }
  const hourly = [...totals.entries()].sort((a, b) => a[0] - b[0]);
  const hourlyLabel = (hour: number) => `${tr.l('시간대별 매출', 'Hourly sales', '分时销售额', '分時銷售額')} ${String(hour).padStart(2, '0')}:00`;
  const peak = [...hourly].sort((a, b) => b[1] - a[1])[0];
  const closing = start === end ? selectClosing(snapshot, { date: start, scenario: 'normal' }) : undefined;
  const coverage = start === end ? tr.date(start) : tr.format.dateRange(start, end);
  const comparison = model.comparison;
  const basePeriod = comparison && (comparison.base.start === comparison.base.end
    ? tr.date(comparison.base.start) : tr.format.dateRange(comparison.base.start, comparison.base.end));
  const salesLabel = start === end ? tr.t('data.fact.ledger.sales.net') :
    tr.widget('widget.ledger.salesIn', { period: start === addDays(end, -6) ? tr.t('format.period.last7') : coverage });
  const yesterday = addDays(end, -1);
  const recent = model.periodTrend.filter(point => point.date === end || point.date === yesterday);
  // REAL-PLAN F09-2 (B09-2 `sales.byMethod`): over HTTP the service's net sales by recorded tender, one fact each. `mixed` is an overlapping subtotal (sales paid
  // with two or more methods) that is already inside the other amounts, so it is named as such and never offered as a share of the day's sales.
  const split = real ? totalsIn(real, start, end).sales.byMethod : undefined;
  const methodFacts = split ? ([
    ['card', tr.widget('widget.ledger.method.card')], ['easy_pay', tr.widget('widget.ledger.method.easyPay')], ['cash', tr.widget('widget.ledger.method.cash')],
    ['charge', tr.l('충전금 사용분', 'Paid with charge', '储值金支付', '儲值金支付')], ['receivable', tr.l('외상 판매분', 'Sold on receivable', '赊账销售', '賒帳銷售')],
  ] as const).map(([method, label]) => currency(`ledger.sales.method.${method}`, label, split[method]))
    .concat([{ ...currency('ledger.sales.method.mixed', tr.l('섞어 낸 결제', 'Mixed payments', '混合支付', '混合支付'), split.mixed),
      display: `${tr.money(split.mixed)} · ${tr.l('위 금액에 이미 들어 있는 겹치는 소계예요', 'An overlapping subtotal already inside the amounts above', '已包含在上述金额内的重叠小计', '已包含在上述金額內的重疊小計')}` }]) : [];
  return [
    ...(!size ? [] : [{ ...currency('ledger.sales.net', salesLabel, model.sales.net),
      display: start === end ? tr.format.money(model.sales.net, 'compact') : tr.money(model.sales.net) }]),
    ...(comparison ? [
      fact('ledger.sales.delta', tr.l('비교 기간 대비', 'Change vs. comparison period', '较对比期间的变化', '較比較期間的變化'), comparison.delta.value, 'percent', `${comparison.delta.value}%`),
      currency('ledger.sales.base', tr.l(`비교 기간(${basePeriod}) 매출`, `Sales in comparison period (${basePeriod})`, `对比期间(${basePeriod})销售额`, `比較期間(${basePeriod})銷售額`), comparison.baseNet),
    ] : []),
    currency('ledger.expenses.total', tr.widget('widget.ledger.expenses'), model.expenses.total),
    ...model.expenses.byCategory.map(row => currency('ledger.expenses.category', tr.t(row.categoryKey), row.amount)),
    ...(model.remaining === null ? [] : [currency('ledger.remaining', tr.l('순이익', 'Net profit', '净利润', '淨利潤'), model.remaining)]),
    ...(model.profitRate == null ? [] : [fact('ledger.profitRate', tr.l('순이익률', 'Net profit margin', '净利润率', '淨利潤率'), model.profitRate, 'percent', `${model.profitRate.toFixed(1)}%`)]),
    fact('ledger.coverage', tr.l('조회 기간', 'Reporting period', '查询期间', '查詢期間'), coverage, 'text',
      complete ? coverage : `${coverage} · ${tr.l('일부 매출 자료 없음', 'Some sales data missing', '部分销售数据缺失', '部分銷售資料缺失')}`),
    fact('ledger.evidence.missing', tr.l('증빙이 빠진 지출', 'Expenses missing proof', '缺少凭证的支出', '缺少憑證的支出'), model.missingEvidenceCount, 'count',
      tr.l(tr.count(model.missingEvidenceCount), tr.format.number(model.missingEvidenceCount), tr.count(model.missingEvidenceCount), tr.count(model.missingEvidenceCount))),
    fact('ledger.candidates.count', tr.l('확인할 지출 후보', 'Expenses to review', '待核对支出', '待核對支出'), model.candidates.length, 'count',
      tr.l(tr.count(model.candidates.length), tr.format.number(model.candidates.length), tr.count(model.candidates.length), tr.count(model.candidates.length))),
    ...(!model.candidates.length ? [fact('ledger.candidates.empty', tr.l('확인할 지출 후보', 'Expenses to review', '待核对支出', '待核對支出'), 0, 'count',
      tr.l(moneyMessages.noCandidates, 'There are no expenses waiting for review.', '没有待核对的支出。', '沒有待核對的支出。'))] : []),
    ...ledgerExpenseFacts('ledger.expense.row', model.expenses.items, tr),
    ...ledgerExpenseFacts('ledger.evidence.row', model.expenses.items.filter(row => row.evidence === 'none'), tr),
    ...ledgerExpenseFacts('ledger.candidate.row', model.candidates, tr),
    ...model.periodTrend.filter(point => snapshot.tables.dailySales.some(row => row.businessDate === point.date)).map(point =>
      fact('ledger.sales.daily', tr.date(point.date), point.net, 'KRW', tr.money(point.net), point.date)),
    ...recent.filter(point => snapshot.tables.dailySales.some(row => row.businessDate === point.date)).map(point =>
      fact('ledger.sales.dayComparison', tr.date(point.date), point.net, 'KRW', tr.money(point.net), point.date)),
    ...hourly.map(([hour, amount]) => fact('ledger.sales.hourly', hourlyLabel(hour), amount, 'KRW', tr.money(amount), start)),
    ...(peak ? [fact('ledger.sales.peak', hourlyLabel(peak[0]), peak[1], 'KRW', tr.money(peak[1]), start)] : []),
    ...menuFacts,
    ...methodFacts,
    ...(closing ? [fact('ledger.closing.status', tr.l('마감', 'Closing', '结账', '結帳'), closing.status, 'text', closing.status === 'closed'
      ? tr.l('정산 완료', 'Closed', '日结完成', '日結完成') : tr.l('정산 전', 'Before closing', '日结前', '日結前'), start)] : []),
  ];
}

function taxPaymentLine(payment: Payment, tr: ReturnType<typeof selectText>) {
  const date = payment.paidOn ?? payment.dueOn;
  return [tr.money(payment.amount), tr.date(date), payment.status === 'paid'
    ? tr.l('납부 완료', 'Paid', '已缴纳', '已繳納') : payment.overdue ? tr.l('기한 지남', 'Overdue', '已逾期', '已逾期') : tr.l('미납', 'Unpaid', '未缴纳', '未繳納'),
  ...(payment.real ? [payment.real.evidenceFiles.length ? '증빙 있음' : '증빙 없음'] : [])].join(' · ');
}

function cashReceiptFact(totals: TaxModel['exportPreview']['cashReceipts'], tr: ReturnType<typeof selectText>, date?: string) {
  if (!totals) return fact('tax.cashReceipts', '현금영수증', 'unavailable', 'text', '현금영수증 자료가 없어요', date);
  const { count, amount } = totals;
  return fact('tax.cashReceipts', tr.l('현금영수증', 'Cash receipts', '现金收据', '現金收據'), count, 'count',
    `${tr.count(count)} · ${tr.money(amount)}`, date);
}

function taxFacts(model: TaxModel, locale: Locale): AgentFact[] {
  const tr = selectText(locale), next = selectNextTaxPayment(model.payments);
  const paymentFact = (key: string, payment: Payment) => fact(key, tr.data(payment.type), payment.amount, 'KRW', taxPaymentLine(payment, tr), payment.paidOn ?? payment.dueOn);
  const unpaid = model.payments.filter(row => row.status === 'unpaid');
  const paid = model.payments.filter(row => row.status === 'paid');
  const overdue = model.payments.filter(row => row.overdue);
  const unpaidTotal = unpaid.reduce((sum, row) => sum + row.amount, 0);
  return [
    next ? fact('tax.nextDue', tr.data(next.type), next.dueOn, 'date', tr.date(next.dueOn), next.dueOn) :
      fact('tax.nextDue', tr.l('다음 납부', 'Next payment', '下次缴税', '下次繳稅'), 'none', 'text', tr.l('없어요', 'None', '没有', '沒有')),
    ...unpaid.map(row => paymentFact('tax.payment', row)),
    ...paid.map(row => paymentFact('tax.payment.paid', row)),
    ...overdue.map(row => paymentFact('tax.payment.overdue', row)),
    fact('tax.unpaid.total', tr.l('미납 합계', 'Unpaid total', '未缴合计', '未繳合計'),
      unpaidTotal, 'KRW', tr.money(unpaidTotal)),
    fact('tax.payment.overdueCount', tr.l('기한 지난 세금', 'Overdue taxes', '逾期税款', '逾期稅款'),
      overdue.length, 'count', overdue.length ? tr.count(overdue.length) : tr.l('없어요', 'None', '没有', '沒有')),
    fact('tax.payment.paidCount', tr.l('납부 이력', 'Payment history', '缴税记录', '繳稅記錄'),
      paid.length, 'count', paid.length ? tr.count(paid.length) : tr.l('없어요', 'None', '没有', '沒有')),
    fact('tax.review.count', tr.widget('widget.tax.list'), model.reviewCount, 'count', tr.count(model.reviewCount)),
    ...model.items.map(row => fact('tax.review.row', row.memo ? tr.data(row.memo) : tr.t(row.categoryKey),
      row.amount, 'KRW', `${tr.money(row.amount)} · ${row.status === 'checked' ? tr.t('common.badge.checked') : tr.t(row.reasonKey)}`, row.date)),
    ...model.connections.map(row => fact('tax.connection', tr.t(row.sourceKey), row.status, 'text', tr.t(row.statusKey), model.period?.end)),
    ...(model.estimate ? [
      fact('tax.estimate', tr.widget('widget.tax.estimate'), model.estimate.amount, 'KRW',
        `${tr.money(model.estimate.amount)} · ${tr.date(model.estimate.basisDate)}`, model.estimate.basisDate),
      fact('tax.estimate.basis', tr.widget('widget.tax.estimate'), tr.t(model.estimate.assumptionKey), 'text'),
    ] : []),
    cashReceiptFact(model.exportPreview.cashReceipts, tr, model.real ? model.period?.end : undefined),
  ];
}

function ledgerHistoryFacts(snapshot: DataSnapshot, start: string, end: string, locale: Locale) {
  // The ledger's rolling view supplies the dated expense rows. Sales coverage
  // comes from recorded days so a missing day is not counted as zero sales.
  const historyCondition = supportedConditions('ledger')[2];
  if (historyCondition.kind !== 'dateRange' || start < historyCondition.start || end > historyCondition.end || start > end) return;
  const history = selectWidget(snapshot, 'ledger', historyCondition, 'normal');
  if (history.status !== 'ready') return;
  const tr = selectText(locale);
  const sales = snapshot.tables.dailySales.filter(row => row.businessDate >= start && row.businessDate <= end);
  const real = snapshot.tables.realFinance;
  const covered = real ? start >= real.from && end <= real.to : sales.length === daysBetween(start, end) + 1;
  const net = real && covered ? totalsIn(real, start, end).sales.total : sales.reduce((sum, row) => sum + signedNet(row), 0);
  const items = history.model.expenses.items.filter(row => row.date >= start && row.date <= end);
  const withoutEvidence = items.filter(row => row.evidence === 'none');
  const period = tr.format.dateRange(start, end);
  const currency = (key: string, label: string, value: number) => ({ ...fact(key, label, value, 'KRW', tr.money(value)), start, end });
  return [
    ...(covered || sales.length ? [currency('ledger.sales.net', tr.widget('widget.ledger.salesIn', { period }), net)] : []),
    fact('ledger.coverage', tr.l('조회 기간', 'Reporting period', '查询期间', '查詢期間'), period, 'text',
      covered ? period : `${period} · ${tr.l('일부 매출 자료 없음', 'Some sales data missing', '部分销售数据缺失', '部分銷售資料缺失')}`),
    currency('ledger.expenses.total', tr.widget('widget.ledger.expenses'), items.reduce((sum, row) => sum + row.amount, 0)),
    ...ledgerExpenseFacts('ledger.expense.row', items, tr),
    fact('ledger.evidence.missing', tr.widget('widget.ledger.missingEvidenceLabel'), withoutEvidence.length, 'count', tr.count(withoutEvidence.length)),
    ...ledgerExpenseFacts('ledger.evidence.row', withoutEvidence, tr),
  ];
}

export function projectMoneyFacts(snapshot: DataSnapshot, featureId: FeatureId, condition: QueryCondition, locale: Locale) {
  if (featureId === 'ledger') {
    const view = selectWidget(snapshot, featureId, condition, 'normal');
    if (view.status === 'ready') return { facts: ledgerFacts(snapshot, view.model, locale) };
    if (condition.kind === 'dateRange') {
      const facts = ledgerHistoryFacts(snapshot, condition.start, condition.end, locale);
      if (facts) return { facts };
    }
    // Historical day sales are available even when a historical detail period is not.
    if (condition.kind === 'dateRange' && condition.start === condition.end) {
      const row = snapshot.tables.dailySales.find(row => row.businessDate === condition.start);
      const tr = selectText(locale);
      if (row) return { facts: [fact('ledger.sales.net', tr.date(row.businessDate), signedNet(row), 'KRW',
        tr.money(signedNet(row)), row.businessDate)] };
    }
    return { status: view.status === 'error' ? 'unsupported_period' as const : 'missing' as const };
  }
  if (featureId === 'tax') {
    const view = selectWidget(snapshot, featureId, condition, 'normal');
    if (view.status === 'ready') return { facts: taxFacts(view.model, locale) };
    if (snapshot.tables.realTax && condition.kind === 'dateRange' && condition.start === condition.end && condition.end === snapshot.tables.realTax.today) {
      return { facts: [cashReceiptFact(null, selectText(locale), condition.end)] };
    }
    if (!snapshot.tables.realTax && condition.kind === 'dateRange' && condition.start === condition.end && condition.end === dateOf(snapshot) && snapshot.pos) {
      return { facts: [cashReceiptFact(selectCashReceiptTotals(snapshot.pos, condition), selectText(locale), condition.end)] };
    }
    return { status: view.status === 'error' ? 'unsupported_period' as const : 'missing' as const };
  }
}

type RecordRow = { readonly id: string; readonly label: string; readonly fields: Record<string, string | number | boolean> };
type SearchRow = RecordRow & { readonly handle: string };

function expenseLabel(row: Pick<Expense, 'memo' | 'category'>, locale: Locale) {
  const tr = selectText(locale);
  return row.memo ? tr.data(row.memo) : tr.t(`data.expenseCategory.${row.category}`);
}
function receiptExpenseLabel(snapshot: DataSnapshot, row: Expense, locale: Locale) {
  const receipt = row.receiptId && snapshot.tables.receipt.find(item => item.receiptId === row.receiptId);
  const line = receipt && snapshot.tables.purchaseOrderLine.find(item => item.polId === receipt.polId);
  const item = line && snapshot.tables.inventoryItem.find(item => item.itemId === line.itemId);
  if (!item) return expenseLabel(row, locale);
  const tr = selectText(locale);
  return tr.t('data.expense.memo.delivery', { item: tr.data(line.itemNameSnapshot ?? item.name ?? { key: item.nameKey }) });
}
const taxAlias = (value: string) => normalizeNavisName(value)
  .replace(/종소세|종합소득세|^소득세$/gu, '종합소득세').replace(/부가가치세/gu, '부가세').replace(/지방세/gu, '지방소득세');
function moneyRows(snapshot: DataSnapshot, kind: MoneyRecord, locale: Locale): RecordRow[] {
  const tr = selectText(locale);
  if (kind === 'taxPayment') return readModel(snapshot, 'tax').payments.map(row => ({
    id: row.taxPaymentId, label: tr.data(row.type), fields: { date: row.dueOn, amount: row.amount, status: row.status,
      ...(!row.real?.evidenceFiles.length ? { evidence: row.evidence } : {}),
      ...(row.paidOn ? { paidOn: row.paidOn } : {}) },
  }));
  if (kind === 'taxItem') {
    const rows = [...readModel(snapshot, 'tax').items];
    const previous = selectWidget(snapshot, 'tax', supportedConditions('tax')[1], 'normal');
    if (previous.status === 'ready') rows.push(...previous.model.items);
    return rows.map(row => ({ id: row.refId, label: row.memo ? tr.data(row.memo) : tr.t(row.categoryKey),
      fields: { date: row.date, amount: row.amount, status: row.status } }));
  }
  return snapshot.tables.expense.filter(row => kind !== 'candidate' || row.status === 'candidate').map(row => ({
    id: row.expenseId, label: receiptExpenseLabel(snapshot, row, locale), fields: { date: row.businessDate, amount: row.amount, status: row.status,
      // D-326 Q2: a settled day keeps its expenses; the card never opens for it.
      ...(kind === 'expense' ? { closed: expenseDayClosed(snapshot, row.businessDate) } : {}) },
  }));
}
/** The same rule the ledger edit handler uses: that business day's normal closing is settled. */
const expenseDayClosed = (snapshot: DataSnapshot, date: string) => isExpenseDayClosed(snapshot.tables, date);
const allRows = '*';
function matchedRows(input: RecordSearch, kind: MoneyRecord): SearchRow[] {
  const { snapshot, query, locale, querySlot, command } = input;
  const [name, date, amount, paidStart, paidEnd] = query.split('\n');
  const key = kind === 'taxPayment' ? taxAlias(name) : normalizeNavisName(name);
  const labelKey = kind === 'taxPayment' ? taxAlias : normalizeNavisName;
  const exactOnly = command === 'tax.createPayment' || querySlot === 'taxType';
  const rows = moneyRows(snapshot, kind, locale).map((row, index) => ({ ...row, handle: `money-${kind}-${snapshot.revision}-${index}` }));
  return rows.filter(row => {
    const label = labelKey(row.label);
    const explicit = name === allRows || row.id === name;
    if (querySlot === 'paidHistory') {
      const { status, paidOn } = row.fields;
      if (status !== 'paid' || paidStart && (typeof paidOn !== 'string' || paidOn < paidStart || paidOn > paidEnd)) return false;
    }
    if (date && row.fields.date !== date || amount && row.fields.amount !== Number(amount)) return false;
    return explicit || (!!key && (label === key || !exactOnly && label.includes(key)));
  });
}

function reader(kind: MoneyRecord): RecordAdapter {
  return {
    kind,
    search(input) {
      const tr = selectText(input.locale), rows = matchedRows(input, kind);
      return rows.map(row => ({ handle: row.handle, match: rows.length === 1 || input.querySlot === 'taxType' ? 'exact' : 'similar',
        fields: row.fields, ...(!input.privateLookup ? { label: [row.label, typeof row.fields.date === 'string' ? tr.date(row.fields.date) : null,
          typeof row.fields.amount === 'number' ? tr.money(row.fields.amount) : null].filter(Boolean).join(' · ').slice(0, 180) } : {}) }));
    },
    resolve(input, handle) { return matchedRows(input, kind).find(row => row.handle === handle)?.id; },
    describe(match, locale, input) {
      const row = input && matchedRows(input, kind).find(row => row.handle === match.handle);
      if (!row) return;
      const tr = selectText(locale);
      if (kind === 'taxItem' && row.fields.status === 'checked') {
        return `${row.label} · ${tr.money(Number(row.fields.amount))} · ${tr.l('이미 확인했어요.', 'Already checked.', '已核对。', '已核對。')}`;
      }
      if (kind === 'taxPayment') {
        const payment = readModel(input.snapshot, 'tax').payments.find(payment => payment.taxPaymentId === row.id);
        if (payment) return `${row.label} ${taxPaymentLine(payment, tr)}`;
      }
      return match.label;
    },
  };
}

const positiveWon = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
const categories: readonly ExpenseCategory[] = ['ingredients', 'operations', 'supplies', 'labor', 'rent', 'other'];
const evidenceKinds: readonly Evidence[] = ['receipt', 'tax-invoice', 'card', 'none'];

type RecognizedReceiptValue<T> = { readonly value: T; readonly needsReview: boolean } | null;
export interface ReceiptRecognition {
  readonly requestId: string;
  readonly merchant: RecognizedReceiptValue<string>;
  readonly date: RecognizedReceiptValue<string>;
  readonly totalWon: RecognizedReceiptValue<number>;
  readonly items: readonly {
    readonly name: RecognizedReceiptValue<string>;
    readonly quantity: RecognizedReceiptValue<number>;
    readonly amountWon: RecognizedReceiptValue<number>;
  }[];
}

export interface ReceiptExpenseFields {
  readonly date: string | null;
  readonly amount: number | null;
  readonly category: ExpenseCategory | '';
  readonly merchant: string;
  readonly memo: string;
}

export const receiptExpenseCategories = categories;
export const receiptExpenseBusinessDate = dateOf;

export function receiptExpenseDraft(receipt?: ReceiptRecognition) {
  const items = receipt?.items ?? [];
  const money = selectText('ko').money;
  const fields: ReceiptExpenseFields = {
    date: receipt?.date?.value ?? null,
    amount: receipt?.totalWon?.value ?? null,
    category: '',
    merchant: receipt?.merchant?.value ?? '',
    memo: items.map(({ name, quantity, amountWon }) => [name?.value, quantity?.value, amountWon && money(amountWon.value)]
      .filter(part => part != null).join(' · ')).filter(Boolean).join(', '),
  };
  return { fields, review: {
    date: receipt?.date?.needsReview ?? false,
    amount: receipt?.totalWon?.needsReview ?? false,
    merchant: receipt?.merchant?.needsReview ?? false,
    memo: items.some(({ name, quantity, amountWon }) => name?.needsReview || quantity?.needsReview || amountWon?.needsReview),
  } };
}

export function receiptExpenseProposal(fields: ReceiptExpenseFields, businessDate: string, hasPhoto: boolean) {
  const { date, amount, category } = fields;
  if (!isIsoDate(date) || date > businessDate) return { invalid: 'date' } as const;
  if (!positiveWon(amount)) return { invalid: 'amount' } as const;
  if (!category || !categories.includes(category)) return { invalid: 'category' } as const;

  // Keep the ledger form's convention for a free-text merchant with no supplier ID.
  const memo = [fields.merchant.trim(), fields.memo.trim()].filter(Boolean).join(' · ');
  if (memo && !isText(memo)) return { invalid: 'memo' } as const;
  return {
    args: {
      date: { slot: 'date' }, amount: { slot: 'amount' }, category,
      evidence: hasPhoto ? 'receipt' as const : 'none' as const,
      ...(memo && { memo: { slot: 'memo' } }),
    },
    slots: { date, amount, ...(memo && { memo }) },
  };
}

const slots = {
  date: isIsoDate, dueOn: isIsoDate, amount: positiveWon, memo: isText, taxType: isText, type: isText,
  category: (value: unknown) => categories.includes(value as ExpenseCategory),
  evidence: (value: unknown) => value === 'example' || evidenceKinds.includes(value as Evidence),
};
const targetKinds: Record<string, readonly string[]> = { taxPaymentId: ['taxPayment'], expenseId: ['candidate', 'expense'], refId: ['taxItem'], supplierId: ['supplier'] };
function resolveFields(wire: object, locals: LocalSlots, targets: RecordTargets): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(wire)) {
    if (field === 'patch') {
      const patch = resolveFields(value, locals, targets);
      if (!patch) return;
      output.patch = patch;
    } else if (value && typeof value === 'object' && 'handle' in value) {
      const target = targets.get(value.handle);
      if (!target || !targetKinds[field]?.includes(target.kind)) return;
      output[field] = target.id;
    } else if (value && typeof value === 'object' && value.slot === field && Object.hasOwn(locals, field)) {
      output[field] = locals[field];
    } else if (field === 'category' && categories.includes(value as ExpenseCategory) ||
        field === 'evidence' && (value === 'example' || evidenceKinds.includes(value as Evidence))) {
      output[field] = value;
    } else return;
  }
  return output;
}

function simulate(snapshot: DataSnapshot, command: MoneyCommand) {
  let seq = snapshot.seq;
  const ctx = { snapshot, tables: snapshot.tables, nextId: (prefix: string) => `navis-${prefix}-${++seq}` };
  switch (command.type) {
    case 'ledger.recordExpense': return handlers[command.type](ctx, command);
    case 'ledger.confirmCandidate': return handlers[command.type](ctx, command);
    case 'ledger.updateExpense': return handlers[command.type](ctx, command);
    case 'tax.createPayment': return handlers[command.type](ctx, command);
    case 'tax.updatePayment': return handlers[command.type](ctx, command);
    case 'tax.deletePayment': return handlers[command.type](ctx, command);
    case 'tax.setEvidence': return handlers[command.type](ctx, command);
    case 'tax.markChecked': return handlers[command.type](ctx, command);
  }
}

function previewChange(command: MoneyCommand, before: DataSnapshot, after: DataSnapshot, locale: Locale) {
  const tr = selectText(locale), fields: { label: string; before: string; after: string }[] = [];
  const add = (label: string, prior?: string, next?: string) => {
    if ((prior ?? '—') !== (next ?? '—')) fields.push({ label, before: prior ?? '—', after: next ?? '—' });
  };
  const amount = (row?: { readonly amount: number }) => row && tr.money(row.amount);
  let title: string;
  if (command.type === 'ledger.recordExpense' || command.type === 'ledger.confirmCandidate') {
    const a = command.type === 'ledger.confirmCandidate' ? before.tables.expense.find(row => row.expenseId === command.expenseId) : undefined;
    const b = a ? after.tables.expense.find(row => row.expenseId === a.expenseId) : after.tables.expense.at(-1);
    if (!b) return;
    title = command.type === 'ledger.recordExpense' ? tr.t('common.recordExpense') : receiptExpenseLabel(after, b, locale);
    add(tr.widget('widget.ledger.field.category'), undefined, tr.t(`data.expenseCategory.${b.category}`));
    add(tr.widget('widget.ledger.field.date'), undefined, tr.date(b.businessDate));
    add(tr.widget('widget.ledger.field.amount'), undefined, amount(b));
    add(tr.widget('widget.ledger.field.evidence'), undefined, tr.t(`data.evidence.${b.evidence}`));
    if (b.memo && !a) add(tr.widget('widget.ledger.field.memo'), undefined, tr.data(b.memo));
    const supplier = b.supplierId && after.tables.supplier.find(row => row.supplierId === b.supplierId);
    if (supplier) add(tr.l('거래처', 'Supplier', '供应商', '供應商'), undefined, tr.data(supplier.name ?? { key: supplier.nameKey }));
    const dayTotal = (state: DataSnapshot) => state.tables.expense.filter(row => row.businessDate === b.businessDate && row.status === 'confirmed').reduce((n, row) => n + row.amount, 0);
    add(tr.widget('widget.ledger.expenses'), tr.money(dayTotal(before)), tr.money(dayTotal(after)));
  } else if (command.type === 'ledger.updateExpense') {
    // D-326 Q2: the card shows each changed field as before → after, plus the day total it moves.
    const a = before.tables.expense.find(row => row.expenseId === command.expenseId);
    const b = after.tables.expense.find(row => row.expenseId === command.expenseId);
    if (!a || !b) return;
    title = expenseLabel(a, locale);
    add(tr.widget('widget.ledger.field.category'), tr.t(`data.expenseCategory.${a.category}`), tr.t(`data.expenseCategory.${b.category}`));
    add(tr.widget('widget.ledger.field.date'), tr.date(a.businessDate), tr.date(b.businessDate));
    add(tr.widget('widget.ledger.field.amount'), amount(a), amount(b));
    add(tr.widget('widget.ledger.field.memo'), a.memo ? tr.data(a.memo) : undefined, b.memo ? tr.data(b.memo) : undefined);
    const dayTotal = (state: DataSnapshot, date: string) => state.tables.expense.filter(row => row.businessDate === date && row.status === 'confirmed').reduce((n, row) => n + row.amount, 0);
    for (const date of new Set([a.businessDate, b.businessDate])) add(`${tr.widget('widget.ledger.expenses')} ${tr.date(date)}`, tr.money(dayTotal(before, date)), tr.money(dayTotal(after, date)));
  } else if (command.type === 'tax.markChecked') {
    const row = before.tables.expense.find(row => row.expenseId === command.refId);
    if (!row || before.tables.taxReview.some(r => r.refId === row.expenseId && r.status === 'checked')) return;
    title = expenseLabel(row, locale);
    add(tr.widget('widget.tax.check'), tr.t('common.badge.needsReview'), tr.t('common.badge.checked'));
  } else {
    const a = command.type !== 'tax.createPayment' ? before.tables.taxPayment.find(row => row.taxPaymentId === command.taxPaymentId) : undefined;
    const b = a ? after.tables.taxPayment.find(row => row.taxPaymentId === a.taxPaymentId) : after.tables.taxPayment.at(-1);
    const row = b ?? a;
    if (!row) return;
    title = tr.data(row.type);
    add(tr.widget('widget.tax.type'), a && tr.data(a.type), b && tr.data(b.type));
    add(tr.widget('widget.tax.amount'), amount(a), amount(b));
    add(tr.widget('widget.tax.due'), a && tr.date(a.dueOn), b && tr.date(b.dueOn));
    const evidence = (record?: typeof row) => record && tr.widget(record.evidence === 'example' ? 'widget.tax.hasEvidence' : 'widget.tax.noEvidence');
    add(tr.widget('widget.ledger.field.evidence'), evidence(a), evidence(b));
    const aNext = selectNextTaxPayment(before.tables.taxPayment), bNext = selectNextTaxPayment(after.tables.taxPayment);
    add(tr.l('다음 납부일', 'Next due date', '下次缴税日', '下次繳稅日'),
      aNext ? tr.date(aNext.dueOn) : undefined, bNext ? tr.date(bNext.dueOn) : undefined);
  }
  return fields.length ? { title, target: title, fields } : undefined;
}

function makeCommand(command: CommandName): CommandAdapter<MoneyCommand, { command: MoneyCommand; locale: Locale }> {
  return {
    command, featureId: command.startsWith('tax.') ? 'tax' : 'ledger', slots,
    resolve(wire, locals, _snapshot, targets) {
      if (!wire || typeof wire !== 'object' || !validateAgentDraft(command, wire)) return;
      const args = resolveFields(wire, locals, targets);
      if (!args || !validateAgentCommandArgs(command, args)) return;
      const locale = locals.navisLocale;
      return { command: { type: command, ...args } as MoneyCommand,
        locale: locale === 'en' || locale === 'zh-Hans' || locale === 'zh-Hant' ? locale : 'ko' };
    },
    preflight(draft, { snapshot, idempotencyKey }) {
      const base = draft.command;
      if (snapshot.tables.realTax && base.type === 'tax.setEvidence') return { kind: 'invalid', messageKey: 'data.real.error.SOURCE_UNAVAILABLE' };
      if (snapshot.tables.realTax && base.type === 'tax.markChecked') {
        const item = moneyRows(snapshot, 'taxItem', draft.locale).find(row => row.id === base.refId);
        if (!item) return { kind: 'invalid' };
        if (item.fields.status === 'checked') return { kind: 'unchanged' };
        const tr = selectText(draft.locale);
        return { kind: 'ready', command: base, preview: { title: item.label, target: item.label, fields: [{
          label: tr.widget('widget.tax.check'), before: tr.t('common.badge.needsReview'), after: tr.t('common.badge.checked'),
        }] } };
      }
      if (base.type === 'tax.updatePayment' && ('paidOn' in base.patch || 'status' in base.patch) ||
          base.type === 'tax.deletePayment' && snapshot.tables.taxPayment.find(row => row.taxPaymentId === base.taxPaymentId)?.status !== 'unpaid' ||
          base.type === 'ledger.confirmCandidate' && !snapshot.tables.expense.some(row => row.expenseId === base.expenseId && row.status === 'candidate')) {
        return { kind: 'invalid' };
      }
      const dispatch = base.type === 'tax.createPayment' || base.type === 'ledger.updateExpense' ? { ...base, idempotencyKey } : base;
      const result = simulate(snapshot, dispatch);
      if (!result.ok) return { kind: result.code === 'CONFLICT' ? 'conflict' : 'invalid', field: result.field, messageKey: result.messageKey };
      if (result.tables === snapshot.tables) return { kind: 'unchanged' };
      const preview = previewChange(dispatch, snapshot, { ...snapshot, tables: result.tables }, draft.locale);
      return preview ? { kind: 'ready', command: dispatch, preview, ...(base.type === 'tax.deletePayment' ? { tier: 'extra-confirm' } : {}) }
        : { kind: 'unchanged' };
    },
    undoToken: result => result.undoToken,
  };
}

const taxWords = /세금|세무|원천세|소득세|종소세|부가(?:가치)?세|지방(?:소득)?세|납부|현금영수증|ᄉᄆᄀᄅ/u;
const taxReportPeriod = /(?:이번|지난|저번)\s*달|\d{1,2}\s*월\s*기준/u;
const expenseWords = /가계부|지출|원재료|소모품|청소용품|전기(?:요금|세)|임대료|월세|간식|직원.*커피|(?:우유|원두)값|대금/u;
const candidateWords = /지출\s*후보|후보\s*지출|입고\s*지출/u;
const confirmCandidate = /확인|확정|넣어/u;
const expenseHistory = /지출\s*내역|오늘\s*뭐뭐\s*샀|오늘\s*지출\s*\d+건/u;
const expenseEntry = /썼|쓴\s*거|샀|냈어|나갔|줬어|지출.*(?:넣어|기록|올려)|(?:기록|넣어).*지출|값\s*넣어|쓸\s*(?:거|예정)|(?:기록|기입)(?:해|\s|$)|원재료로\s*넣어/u;
const remove = /삭제|지워|없애/u;
const bulkDelete = /모두|전부|전체|한꺼번에|한\s*번에|싹|(?:^|\s)다\s|두\s*건|둘\s*다|\b(?:all|every|both)\b|全部|所有/iu;
const change = /바꾸|바꿔|변경|정정|고쳐|수정|미뤄|당겨|늦춰/u;
const add = /추가|등록/u;
const logPaid = /납부\s*(?:완료|취소|전|처리|했다고)|납부했어.*(?:기록|표시|처리)|안\s*낸|냈(?:음|어|다고)|입금함|낸\s*(?:걸로|날짜)|납부\s*(?:일자|일)(?!정).*(?:고쳐|정정|수정|변경)/u;
const taxReviewAction = /확인했|확인\s*완료|확인함|체크\s*(?:했|다\s*했|완료)|확인\s*처리|처리\s*다시|또\s*확인/u;
const taxHistory = /납부\s*이력|낸\s*세금|세금\s*낸/u;
const namedTaxHistory = /내역|얼마\s*냈|낸\s*금액|금액\s*알려|언제\s*냈|납부했나/u;
const taxScheduleEntry = /납부\s*(?:일정|기록)|(?:기한|기일까지).*기록|\d+\s*일까지/u;
const open = /열어|열고|보여|탭|화면|상세|어디서\s*봐/u;
const boardWords = /(?:위젯|패널|보드|대시보드).*?(?:추가|넣어|올려|옮겨|보내)|(?:위젯|패널)(?:을|를)?\s*(?:삭제|지워|없애|빼)|페이지.*(?:보내|옮겨)|(?:보내|옮겨).*페이지/u;
const doNot = /하지\s*마|말아|무시|ignore\s+|\b(?:don't|never|do not)\b/u;
const anyDate = /오늘|어제|그저께|내일|모레|글피|(?:이번|다음|지난|저번|담)\s*(?:주|달)|\d{1,2}\s*월|\d{1,2}\s*일|\d[/-]\d|날짜|월요일|화요일|수요일|목요일|금요일|토요일|일요일/u;
const quotedInstruction = /^(?:["“'‘]|.*인용(?:문|한\s*문장))|["”'’](?:라고|고)\s*(?:써|했|읽|말)/u;
const outsideMoney = (value: string) => doNot.test(value) || quotedInstruction.test(value) || boardWords.test(value);
const taxTypePattern = /종합소득세|종소세|소득세|(?:하반기\s*)?부가(?:가치)?세(?:\s*(?:[12]기(?:\s*예정\s*고지)?|준비))?|원천세(?:\s*[（(]?\s*\d{1,2}월분\s*[)）]?)?|\d{1,2}월\s*원천세|지방(?:소득)?세/u;
const taxTypeName = (value: string) => value.replace(/부가가치세/u, '부가세').replace(/종소세|^소득세$/u, '종합소득세').replace(/지방세/u, '지방소득세');
const canonicalTaxType = (value: string) => {
  const match = taxTypePattern.exec(value)?.[0];
  if (!match) return;
  const month = /^원천세\s*\(?\s*(\d{1,2})월분\s*\)?$/u.exec(match);
  return month ? `원천세(${month[1]}월분)` : taxTypeName(match);
};
const moneyOf = (value: string) => {
  const explicit = navisMoneySpans(value);
  if (explicit.length) return explicit.length === 1 ? explicit[0].value : undefined;
  const bare = value.match(/(?:^|\s)(-?(?:\d[\d,]*)(?:\.\d+)?)(?=\s|으로|로|$)(?!\s*(?:월|일|명|건|분))/u);
  return bare ? parseNavisNumber(bare[1]) : undefined;
};
const readDate = (value: string, today: string) => {
  const scrubbed = [...navisMoneySpans(value)].reverse().reduce((text, span) => text.slice(0, span.start) + ' ' + text.slice(span.end), value)
    .replace(/담\s*주/u, '다음 주')
    .replace(/(?<![가-힣])((?:이번|다음|지난|저번))\s*([월화수목금토일]요일)/u, '$1 주 $2')
    .replace(/((?:이번|다음|지난|저번)\s*주)\s*([월화수목금토일])(?=\s|으로|로|까지|$)(?!요일)/u, '$1 $2요일');
  const date = parseNavisDate(scrubbed, today);
  if (date) return date;
  const monthEnd = /(?<!\d)(\d{1,2})\s*월\s*말/u.exec(scrubbed);
  if (monthEnd) {
    const start = parseNavisDate(monthEnd[1] + '월 1일', today);
    if (start) {
      const following = addDays(start, 32).slice(0, 8) + '01';
      return addDays(following, -1);
    }
  }
  const day = /(?<!\d)(\d{1,2})일(?:로|까지|에)?(?:\s*[^0-9]+)?\(\s*(\d{1,2})월\s*\)/u.exec(scrubbed);
  if (day) return parseNavisDate(`${day[2]}월 ${day[1]}일`, today);
};
const expenseCategory = (text: string): ExpenseCategory | undefined => {
  if (/원재료|우유값|원두값|우유\s*(?:대금|값)/u.test(text)) return 'ingredients';
  if (/임대료|월세/u.test(text)) return 'rent';
  if (/운영비|전기(?:요금|세)/u.test(text)) return 'operations';
  if (/소모품|청소용품/u.test(text)) return 'supplies';
  if (/인건비/u.test(text)) return 'labor';
  if (/기타/u.test(text)) return 'other';
};
const expenseEvidence = (text: string): Evidence => /증빙\s*없|영수증\s*(?:없이|안\s*받)/u.test(text) ? 'none'
  : /세금계산서/u.test(text) ? 'tax-invoice' : /카드/u.test(text) ? 'card' : /영수증/u.test(text) ? 'receipt' : 'none';
const expenseMemo = (value: string) => value.match(/(?:메모(?:는|를)?\s+)(.+?)(?:(?:으로|로)\s*(?:기록|저장)|$)/u)?.[1] ??
  value.match(/\(([^()]+)\)\s*$/u)?.[1] ?? value.match(/전기요금|전기세/u)?.[0];
const explicitExpenseEntry = (value: string) => expenseWords.test(value) && !expenseHistory.test(value) && (
  expenseEntry.test(value) || !!expenseCategory(value) && moneyOf(value) !== undefined && (
    /날짜\s*(?:는|가)|영수증\s*안\s*받았/u.test(value) ||
    anyDate.test(value) && /\([^()]+\)$|전기(?:요금|세).*카드/u.test(value) ||
    /청소용품.*\([^()]+\)$/u.test(value)
  )
);

const textAnswer = (answer: string): DomainRoute => ({ kind: 'answer', answer });
const refusal = (reason: AgentRefusal['reason'], answer: string, alternative?: AgentHandoff): DomainRoute =>
  ({ kind: 'refusal', reason, answer, alternative });
const ask = (field: string, answer: string, resume?: (value: string) => DomainRoute | undefined): DomainRoute => ({ kind: 'clarification', field, answer, resume });
const lookup = (kind: DomainLookup['kind'], querySlot: string, bind?: string): DomainLookup => ({ kind, querySlot, ...(bind ? { bind: [bind] } : {}) });
const read = (featureId: MoneyFeature, factKeys: readonly string[], condition: QueryCondition = defaultCondition): DomainTurnInput =>
  ({ intent: { kind: 'read', featureId, condition }, factKeys });
function commandTurn(command: CommandName, locale: Locale, values: LocalSlots, queries: LocalSlots = {}, lookups: readonly DomainLookup[] = []): DomainTurnInput {
  const refs = Object.fromEntries(Object.entries(values).map(([field, value]) =>
    [field, field === 'category' || field === 'evidence' ? value : { slot: field }]));
  return { intent: { kind: 'command', command, args: command === 'tax.updatePayment' ? { patch: refs } : refs,
    ...(lookups[0] ? { querySlot: lookups[0].querySlot } : {}) }, slots: { ...values, ...queries, navisLocale: locale }, lookups };
}
function paymentHandoff(target?: RecordRow) {
  return target ? { featureId: 'tax', command: 'tax.markPaid', draft: { taxPaymentId: target.id } } : { featureId: 'tax' };
}

function routeExpense(value: string, snapshot: DataSnapshot, locale: Locale, { allowExpenseEntry }: MoneyPolicy, overrides: LocalSlots = {}): DomainRoute {
  const tr = selectText(locale), today = dateOf(snapshot);
  const category = (overrides.category as ExpenseCategory | undefined) ?? expenseCategory(value);
  const amount = overrides.amount ?? moneyOf(value);
  const monthlyRent = category === 'rent' && !readDate(value, today) && !overrides.date;
  const timePhrase = monthlyRent ? value.replace(/이번\s*달(?:은|에)?/u, '') : value;
  const date = typeof overrides.date === 'string' ? overrides.date : readDate(timePhrase, today) ?? (!anyDate.test(timePhrase) ? today : undefined);
  if (!date) return ask('date', tr.l('지출한 날짜를 알려 주세요.', 'What was the expense date?', '请告诉我支出日期。', '請告訴我支出日期。'),
    next => routeExpense(value, snapshot, locale, { allowExpenseEntry }, { ...overrides, date: readDate(next, today) }));
  if (date > today) return refusal('invalid_target', tr.l('지난 지출만 기록할 수 있어요.', 'Only incurred expenses can be recorded.', '只能记录已发生的支出。', '只能記錄已發生的支出。'));
  if (!positiveWon(amount)) return ask('amount', tr.l('지출 금액을 알려 주세요.', 'What was the expense amount?', '请告诉我支出金额。', '請告訴我支出金額。'),
    next => routeExpense(value, snapshot, locale, { allowExpenseEntry }, { ...overrides, amount: moneyOf(next) ?? parseNavisNumber(next) }));
  if (!category) return ask('category', tr.l('어떤 분류에 넣을까요?', 'Which expense category?', '要记在哪个类别？', '要記在哪個類別？'),
    next => routeExpense(value, snapshot, locale, { allowExpenseEntry }, { ...overrides, category: expenseCategory(next) }));
  const evidence = expenseEvidence(value);
  const memo = expenseMemo(value);
  const explicitSupplier = overrides.supplierName ?? value.match(/(?:[A-Z]|에이|비|씨|디)\s*(?:유통|로스터리|포장|베이커리|농산)/iu)?.[0];
  const suppliers = snapshot.tables.supplier.filter(row => !row.deletedAt).map(row => ({
    id: row.supplierId, name: tr.data(row.name ?? { key: row.nameKey }),
  }));
  const matches = suppliers.filter(row => explicitSupplier !== undefined
    ? normalizeNavisName(row.name) === normalizeNavisName(String(explicitSupplier))
    : normalizeNavisName(value).includes(normalizeNavisName(row.name)));
  if ((explicitSupplier !== undefined && matches.length === 0) || matches.length > 1) {
    return ask('supplierId', matches.length ? moneyMessages.chooseSupplier : moneyMessages.supplierMissing,
      next => routeExpense(value, snapshot, locale, { allowExpenseEntry }, { ...overrides, supplierName: next.trim() }));
  }
  const duplicateInput = { date, category, amount, supplierId: matches[0]?.id ?? null, memo: memo ?? '' };
  const duplicate = findExpenseDuplicate(snapshot.tables.expense, duplicateInput);
  if (duplicate) return ask('confirmDuplicate', tr.l('같은 지출이 있어요.', 'A matching expense exists.', '已有相同支出。', '已有相同支出。') +
    '\n' + [tr.date(duplicate.businessDate), expenseLabel(duplicate, locale), tr.money(duplicate.amount)].join(' · '));
  if (!allowExpenseEntry) return refusal('widget_only', tr.l('손익 패널에서 지출을 기록해 주세요.', 'Record the expense in the ledger.', '请在账本记录支出。', '請在帳本記錄支出。'),
    { featureId: 'ledger', command: 'ui.setDraftField', draft: { featureId: 'ledger', field: 'amount', value: amount } });
  const fields = { date, category, amount, evidence, ...(memo ? { memo } : {}) };
  const supplierName = matches[0]?.name;
  return supplierName ? commandTurn('ledger.recordExpense', locale, fields, { name: supplierName },
    [lookup('supplier', 'name', 'supplierId')]) : commandTurn('ledger.recordExpense', locale, fields);
}

/**
 * D-326 Q2. The expense is named by its own words (date, item, amount) before the change verb, the new value is the
 * word in front of it ("... 4만원으로 고쳐줘"). One field per card. A settled day never opens a card.
 */
function routeExpenseEdit(value: string, snapshot: DataSnapshot, locale: Locale, pickedId?: string): DomainRoute {
  const tr = selectText(locale), today = dateOf(snapshot);
  const found = [...value.matchAll(/(\S+(?:\s+\S+)?)(?:으로|로)\s*(?:고쳐|바꿔|바꾸|변경|정정|수정|고치)/gu)].at(-1);
  const at = found?.index ?? value.length;
  const head = value.slice(0, at), capture = found?.[1] ?? '';
  const spans = navisMoneySpans(value), last = spans.at(-1);
  const amountInTail = !!found && !!last && last.start >= at;
  const nextAmount = amountInTail ? last.value : undefined;
  const oldAmount = amountInTail ? (spans.length > 1 ? spans[0].value : undefined) : spans[0]?.value;
  const memoEdit = !!found && /메모/u.test(`${head} ${capture}`) && nextAmount === undefined;
  const nextMemo = memoEdit ? capture.replace(/^(?:메모(?:를|은|는|가)?\s+)/u, '').trim() : undefined;
  const nextDate = found && nextAmount === undefined && !memoEdit ? readDate(capture, today) : undefined;
  const nextCategory = found && nextAmount === undefined && !memoEdit && !nextDate ? expenseCategory(capture) : undefined;
  const picks = (rows: readonly Expense[]) => rows.slice(0, 5).map((row, index) => ({ id: `expense-${index + 1}`,
    label: [tr.date(row.businessDate), expenseLabel(row, locale), tr.money(row.amount)].join(' · ') }));
  const confirmed = snapshot.tables.expense.filter(row => row.status === 'confirmed');
  const oldDate = readDate(head, today), oldCategory = expenseCategory(head);
  const headKey = normalizeNavisName(head);
  const named = confirmed.filter(row => row.memo && normalizeNavisName(expenseLabel(row, locale)).length > 1
    && headKey.includes(normalizeNavisName(expenseLabel(row, locale))));
  const constrained = !!pickedId || oldDate !== undefined || oldCategory !== undefined || oldAmount !== undefined || named.length > 0;
  const candidates = pickedId ? confirmed.filter(row => row.expenseId === pickedId)
    : (named.length ? named : confirmed).filter(row => (!oldDate || row.businessDate === oldDate)
      && (oldAmount === undefined || row.amount === oldAmount) && (!oldCategory || row.category === oldCategory));
  const which = tr.l('어느 지출인가요?', 'Which expense?', '是哪笔支出？', '是哪筆支出？');
  if (!constrained) return ask('expenseId', which, undefined);
  if (!candidates.length) return textAnswer(tr.l('해당 지출이 없어요.', 'No matching expense.', '未找到该支出。', '未找到該支出。'));
  if (candidates.length > 1) {
    const choices = picks(candidates);
    return { kind: 'clarification', field: 'expenseId', answer: which, choices,
      resume(next) {
        const index = choices.findIndex(choice => choice.id === next);
        return index >= 0 ? routeExpenseEdit(value, snapshot, locale, candidates[index].expenseId) : undefined;
      } };
  }
  const row = candidates[0];
  const handoff = refusal('widget_only', tr.l('마감한 날의 지출은 고칠 수 없어요.', 'Expenses on a closed day cannot be edited.', '已结账日的支出不能修改。', '已結帳日的支出不能修改。'), { featureId: 'ledger' });
  if (expenseDayClosed(snapshot, row.businessDate) || nextDate && expenseDayClosed(snapshot, nextDate)) return handoff;
  if (nextAmount === undefined && !nextDate && !nextCategory && !nextMemo) {
    return ask('amount', tr.l('새 금액을 알려 주세요.', 'What is the new amount?', '请告诉我新金额。', '請告訴我新金額。'),
      next => routeExpenseEdit(`${value.replace(change, ' ')} ${next}로 고쳐줘`, snapshot, locale, row.expenseId));
  }
  if (nextAmount !== undefined && !positiveWon(nextAmount)) return ask('amount', tr.l('새 금액을 알려 주세요.', 'What is the new amount?', '请告诉我新金额。', '請告訴我新金額。'));
  if (nextDate && nextDate > today) return refusal('invalid_target', tr.l('지난 지출만 기록할 수 있어요.', 'Only incurred expenses can be recorded.', '只能记录已发生的支出。', '只能記錄已發生的支出。'));
  const same = nextAmount !== undefined && nextAmount === row.amount || nextDate !== undefined && nextDate === row.businessDate
    || nextCategory !== undefined && nextCategory === row.category || nextMemo !== undefined && row.memo !== null && nextMemo === tr.data(row.memo);
  if (same) return textAnswer(tr.l('이미 같아요.', 'Already set.', '已经相同。', '已經相同。'));
  const fields = { ...(nextAmount !== undefined ? { amount: nextAmount } : {}), ...(nextDate ? { date: nextDate } : {}),
    ...(nextCategory ? { category: nextCategory } : {}), ...(nextMemo ? { memo: nextMemo } : {}) };
  return commandTurn('ledger.updateExpense', locale, fields, { expense: row.expenseId }, [lookup('expense', 'expense', 'expenseId')]);
}

function routeCandidate(value: string, snapshot: DataSnapshot, locale: Locale): DomainRoute {
  const tr = selectText(locale), rows = moneyRows(snapshot, 'candidate', locale);
  if (bulkDelete.test(value)) return ask('target', moneyMessages.chooseCandidate);
  const repeated = /한\s*번\s*더|또|다시|방금/u.test(value);
  const item = value.match(/([가-힣]+)\s+입고/u)?.[1];
  const name = item && !['오늘', '어제', '생긴', '확인할', '최근'].includes(item) ? item : allRows;
  const date = readDate(value, dateOf(snapshot)) ?? (repeated ? dateOf(snapshot) : undefined);
  const query = [name, date ?? '', moneyOf(value) ?? ''].join('\n');
  const matches = matchedRows({ snapshot, query, locale, privateLookup: false }, 'candidate');
  if (repeated) {
    const receiptExpenses = new Set(snapshot.tables.expense.filter(row => row.receiptId && row.status === 'confirmed').map(row => row.expenseId));
    const recorded = matchedRows({ snapshot, query, locale, privateLookup: false }, 'expense').filter(row => receiptExpenses.has(row.id));
    if (matches.length) return ask('target', moneyMessages.chooseCandidate);
    if (recorded.length === 1) return textAnswer(tr.l('지출 후보를 이미 넣었어요.', 'The expense candidate was already recorded.', '候选支出已入账。', '候選支出已入帳。'));
    if (recorded.length > 1) return textAnswer(moneyMessages.candidatesAlreadyRecorded);
  }
  if (!matches.length) {
    return rows.length && (name !== allRows || date)
      ? textAnswer(tr.l('해당 지출 후보가 없어요.', 'No matching expense candidate.', '未找到该候选支出。', '未找到該候選支出。'))
      : read('ledger', ['ledger.candidates.empty']);
  }
  return commandTurn('ledger.confirmCandidate', locale, {}, { candidate: query }, [lookup('candidate', 'candidate', 'expenseId')]);
}

function createTax(value: string, snapshot: DataSnapshot, locale: Locale, overrides: LocalSlots = {}): DomainRoute {
  const tr = selectText(locale), today = taxDateOf(snapshot);
  const taxType = typeof overrides.taxType === 'string' ? overrides.taxType : canonicalTaxType(value);
  const amount = overrides.amount ?? moneyOf(value);
  const dueOn = typeof overrides.dueOn === 'string' ? overrides.dueOn : readDate(value, today);
  if (!taxType) return ask('taxType', tr.l('어떤 세금인가요?', 'Which tax?', '是哪一种税款？', '是哪一種稅款？'),
    next => createTax(value, snapshot, locale, { ...overrides, taxType: isText(next) ? canonicalTaxType(next) ?? next.trim() : undefined }));
  if (!positiveWon(amount)) return ask('amount', tr.l('납부 금액을 알려 주세요.', 'What is the amount due?', '请告诉我应缴金额。', '請告訴我應繳金額。'),
    next => createTax(value, snapshot, locale, { ...overrides, amount: moneyOf(next) ?? parseNavisNumber(next) }));
  if (!dueOn) return ask('dueOn', tr.l('납부 기한을 알려 주세요.', 'When is it due?', '请告诉我缴税期限。', '請告訴我繳稅期限。'),
    next => createTax(value, snapshot, locale, { ...overrides, dueOn: readDate(next, today) }));
  const exact = findTaxDuplicate(snapshot.tables.taxPayment, { type: taxType, amount, dueOn })
    ?? readModel(snapshot, 'tax').payments.find(row => normalizeNavisName(tr.data(row.type)) === normalizeNavisName(taxType) && row.amount === amount && row.dueOn === dueOn);
  if (exact) return ask('confirmDuplicate', `${tr.data(exact.type)} · ${tr.money(exact.amount)} · ${tr.date(exact.dueOn)}\n${tr.l('같은 일정이 있어요.', 'This schedule already exists.', '这个日程已存在。', '這個日程已存在。')}`);
  return commandTurn('tax.createPayment', locale, { taxType, amount, dueOn }, {}, [lookup('taxPayment', 'taxType')]);
}

function routeCheck(value: string, snapshot: DataSnapshot, locale: Locale): DomainRoute {
  const tr = selectText(locale);
  const rows = moneyRows(snapshot, 'taxItem', locale);
  const amount = moneyOf(value);
  const label = /냅킨|빨대|전기요금|원두\s*구매|시럽/u.exec(value)?.[0];
  const target = label || positiveWon(amount) ? [label ?? allRows, '', positiveWon(amount) ? amount : ''].join('\n') : undefined;
  if (!target) return ask('taxItem', tr.l('어느 자료를 확인했나요?', 'Which item did you check?', '您核对了哪项资料？', '您核對了哪項資料？'),
    next => routeCheck(next, snapshot, locale));
  const candidates = matchedRows({ snapshot, query: target, locale, privateLookup: false }, 'taxItem');
  if (!candidates.length || candidates.length === 1 && rows.find(row => row.id === candidates[0].id)?.fields.status === 'checked') {
    const querySlot = 'taxItem';
    return { intent: { kind: 'read', recordKind: 'taxItem', querySlot }, slots: { [querySlot]: target }, browse: true,
      onMissing: { reason: 'invalid_target', answer: tr.l('확인 목록에 해당 자료가 없어요.', 'That item is not in the review list.', '核对列表中没有这项资料。', '核對清單中沒有這項資料。') } };
  }
  return commandTurn('tax.markChecked', locale, {}, { taxItem: target }, [lookup('taxItem', 'taxItem', 'refId')]);
}

function changeTax(value: string, snapshot: DataSnapshot, locale: Locale, policy: MoneyPolicy, overrides: LocalSlots = {}): DomainRoute {
  const tr = selectText(locale), [from, to] = value.split(/\s*(?:이름(?:을)?|항목명|말고)\s*/u);
  const mentioned = typeof overrides.target === 'string' ? overrides.target : canonicalTaxType(from);
  const deleting = remove.test(value) && !/증빙|영수증/u.test(value);
  const obligationDate = deleting ? readDate(from, taxDateOf(snapshot)) : undefined;
  const amountTarget = /부가세.*납부\s*전/u.test(value) ? moneyOf(from) : undefined;
  const query = [mentioned ?? allRows, obligationDate ?? '', amountTarget ?? ''].join('\n');
  const matches = matchedRows({ snapshot, query, locale, privateLookup: false }, 'taxPayment');
  const row = matches.length === 1 ? matches[0] : undefined;
  const paidState = !deleting && logPaid.test(value) &&
    !/증빙|영수증|기한|기록\s*(?:추가|삭제|지워)/u.test(value);
  if (paidState) {
    const already = matches.length && matches.every(item => item.fields.status === 'paid') &&
      !/취소|되돌려|안\s*낸|납부\s*전|정정|날짜|일자|수정/u.test(value);
    if (already) return textAnswer(matches.map(item => `${item.label} · ${tr.money(Number(item.fields.amount))} · ${typeof item.fields.paidOn === 'string' ? tr.date(item.fields.paidOn) + ' · ' : ''}${tr.l('이미 납부했어요.', 'Already paid.', '已缴纳。', '已繳納。')}`).join('\n'));
    return refusal('widget_only', tr.l('세무관리 패널에서 납부 상태를 확인해 주세요.', 'Review payment status in the tax panel.', '请在税务面板查看缴税状态。', '請在稅務面板查看繳稅狀態。'), paymentHandoff(row));
  }
  const evidence = /증빙|영수증/u.test(value) ? /없|지워|삭제/u.test(value) ? 'none' : 'example' : undefined;
  const question = () => ask('taxPaymentId', tr.l('어느 납부 기록인가요?', 'Which tax payment record?', '是哪一笔缴税记录？', '是哪一筆繳稅記錄？'),
    next => changeTax(value, snapshot, locale, policy, { ...overrides, target: canonicalTaxType(next) ?? next.trim() }));
  if (deleting && !mentioned && !obligationDate) return question();
  if (!matches.length) return { intent: { kind: 'read', recordKind: 'taxPayment', querySlot: 'taxPayment' },
    slots: { taxPayment: query }, browse: true,
    onMissing: { answer: tr.l('해당 납부 기록이 없어요.', 'No matching tax payment record.', '未找到该缴税记录。', '未找到該繳稅記錄。') } };
  const bound = [lookup('taxPayment', 'taxPayment', 'taxPaymentId')];
  const args = { taxPayment: query };
  if (deleting) {
    if (!policy.allowTaxDelete || row?.fields.status === 'paid') return refusal('widget_only',
      tr.l('세무관리 패널에서 납부 기록을 확인해 주세요.', 'Review the payment record in the tax panel.', '请在税务面板查看缴税记录。', '請在稅務面板查看繳稅記錄。'), paymentHandoff(row));
    return commandTurn('tax.deletePayment', locale, {}, args, bound);
  }
  if (evidence) {
    if (!mentioned && matches.length > 1) return question();
    if (snapshot.tables.realTax) {
      if (!row) return question();
      return refusal('widget_only', '세무관리에서 증빙 파일을 확인해 주세요.', evidence === 'example'
        ? { featureId: 'tax', command: 'tax.setEvidence', draft: { taxPaymentId: row.id, evidence } }
        : { featureId: 'tax', step: 'tax-evidence-removal', itemId: row.id });
    }
    if (row?.fields.evidence === evidence) return textAnswer(tr.l('이미 같은 증빙 상태예요.', 'The evidence status is already set.', '凭证状态已经相同。', '憑證狀態已經相同。'));
    return commandTurn('tax.setEvidence', locale, { evidence }, args, bound);
  }
  const due = /기한|마감|기일까지|미뤄|당겨/u.test(value);
  const type = to ? canonicalTaxType(to) ?? to.match(/(\d{1,2})월분/u)?.[0] : undefined;
  const nextType = type && /^\d{1,2}월분$/u.test(type) && /원천세/u.test(from) ? `원천세(${type})` : type;
  const amount = overrides.amount ?? (due || nextType ? undefined : moneyOf(value));
  const dueOn = overrides.dueOn ?? (due ? readDate(value, taxDate(snapshot)) : undefined);
  if (!row && !mentioned) return question();
  if (!row && !dueOn && !nextType && !positiveWon(amount)) return question();
  if (due && typeof dueOn !== 'string') return ask('dueOn', tr.l('납부 기한을 알려 주세요.', 'When is it due?', '请告诉我缴税期限。', '請告訴我繳稅期限。'),
    next => changeTax(value, snapshot, locale, policy, { ...overrides, dueOn: readDate(next, taxDate(snapshot)) }));
  if (!due && !nextType && !positiveWon(amount)) return ask('amount', tr.l('새 금액을 알려 주세요.', 'What is the new amount?', '请告诉我新金额。', '請告訴我新金額。'),
    next => changeTax(value, snapshot, locale, policy, { ...overrides, amount: moneyOf(next) ?? parseNavisNumber(next) }));
  if (row && (amount !== undefined && row.fields.amount === amount || dueOn && row.fields.date === dueOn || nextType === row.label)) {
    const display = positiveWon(amount) ? tr.money(amount) : typeof dueOn === 'string' ? tr.date(dueOn) : row.label;
    return textAnswer(`${display} · ${tr.l('이미 같아요.', 'Already set.', '已经相同。', '已經相同。')}`);
  }
  return commandTurn('tax.updatePayment', locale, nextType ? { type: nextType } : typeof dueOn === 'string' ? { dueOn } : { amount }, args, bound);
}

function reportCondition(featureId: MoneyFeature, value: string, snapshot: DataSnapshot): QueryCondition {
  const today = featureId === 'tax' ? taxDateOf(snapshot) : dateOf(snapshot);
  if (/작년/u.test(value)) {
    const year = String(Number(today.slice(0, 4)) - 1);
    const month = /\d{1,2}(?=\s*월)/u.exec(value)?.[0]?.padStart(2, '0') ?? today.slice(5, 7);
    if (Number(month) >= 1 && Number(month) <= 12) {
      const start = year + '-' + month + '-01';
      const following = month === '12' ? String(Number(year) + 1) + '-01-01' : year + '-' + String(Number(month) + 1).padStart(2, '0') + '-01';
      return periodCondition(start, addDays(following, -1));
    }
  }
  if (featureId === 'ledger' && /(?:월요일부터|이번\s*주(?!\s*[월화수목금토일]요일))/u.test(value)) {
    const week = parseNavisPeriod('이번 주', today);
    if (week) return periodCondition(week.start, today);
  }
  const date = readDate(value, today);
  if (date) return date === today ? defaultCondition : periodCondition(date, date);
  const period = parseNavisPeriod(value, today);
  if (period) return periodCondition(period.start, period.end);
  return defaultCondition;
}

function routeTax(value: string, snapshot: DataSnapshot, locale: Locale, policy: MoneyPolicy): DomainRoute | undefined {
  const tr = selectText(locale);
  const named = canonicalTaxType(value);
  const today = taxDateOf(snapshot);
  if (remove.test(value) && (bulkDelete.test(value) ||
    value.split(/(?:이랑|하고|및|[과와랑])\s+|[,·]\s*/u).filter(part => canonicalTaxType(part)).length > 1)) {
    return { kind: 'refusal', reason: 'unsupported' };
  }
  if (/캘린더|달력/u.test(value) && remove.test(value)) return refusal('widget_only',
    tr.l('세무관리 패널에서 납부 일정을 확인해 주세요.', 'Review the due date in the tax panel.', '请在税务面板查看缴税日期。', '請在稅務面板查看繳稅日期。'), { featureId: 'tax' });
  if (/송금|이체|결제해|납부해\s*(?:줘|주세요)|대신\s*내/u.test(value)) return refusal('widget_only',
    tr.l('세무관리 패널에서 납부 일정을 확인해 주세요.', 'Review the due date in the tax panel.', '请在税务面板查看缴税日期。', '請在稅務面板查看繳稅日期。'), paymentHandoff());
  if (/내보내|다운로드|제출/u.test(value)) return refusal('widget_only',
    tr.l('세무관리 패널에서 자료를 확인해 주세요.', 'Review the data in the tax panel.', '请在税务面板查看资料。', '請在稅務面板查看資料。'), { featureId: 'tax', command: 'tax.export', draft: {} });
  if (taxReviewAction.test(value)) return routeCheck(value, snapshot, locale);
  if (!/증빙|영수증/u.test(value) && (add.test(value) && (named || /납부|일정|항목/u.test(value) || moneyOf(value) !== undefined) ||
    named && !change.test(value) && !remove.test(value) && !logPaid.test(value) && taxScheduleEntry.test(value) && moneyOf(value) !== undefined)) {
    return createTax(value, snapshot, locale);
  }
  if (!change.test(value) && /다음\s*(?:세금\s*)?납부|담\s*납부|세금\s*마감일/u.test(value)) {
    return read('tax', ['tax.nextDue']);
  }
  const annualHistory = /올해/u.test(value) && taxHistory.test(value);
  if ((named && namedTaxHistory.test(value) || annualHistory) && !change.test(value) && !remove.test(value)) {
    const querySlot = 'paidHistory';
    const query = annualHistory ? [named ?? allRows, '', '', `${today.slice(0, 4)}-01-01`, today].join('\n') : named;
    return { intent: { kind: 'read', recordKind: 'taxPayment', querySlot }, slots: { [querySlot]: query }, browse: true,
      onMissing: { answer: tr.l('해당 납부 이력이 없어요.', 'No matching payment history.', '没有对应的缴税历史。', '沒有對應的繳稅歷史。') } };
  }
  if (taxHistory.test(value) && !change.test(value) && !remove.test(value) && !logPaid.test(value)) {
    return read('tax', ['tax.payment.paidCount', 'tax.payment.paid']);
  }
  if (change.test(value) || remove.test(value) || logPaid.test(value) || /(?:증빙|영수증).*(?:추가|처리|표시|걸로)/u.test(value) ||
    named && /금액/u.test(value) && moneyOf(value) !== undefined) return changeTax(value, snapshot, locale, policy);
  if (/현금영수증/u.test(value)) {
    const condition = value.replace(/몇\s*건|발행한/u, '');
    if (readDate(condition, today) === today) return read('tax', ['tax.cashReceipts'], periodCondition(today, today));
    return read('tax', ['tax.cashReceipts'], /이번\s*달/u.test(condition) ? defaultCondition : reportCondition('tax', condition, snapshot));
  }
  if (/기한\s*지난|연체|늦은/u.test(value)) return read('tax', ['tax.payment.overdueCount', 'tax.payment.overdue']);
  if (/자료|증빙|체크\s*항목/u.test(value) && /연결|연동/u.test(value)) return read('tax', ['tax.connection']);
  if (/확인할\s*세무|증빙\s*없는\s*지출|체크\s*항목/u.test(value)) return read('tax', ['tax.review.count', 'tax.review.row']);
  if (/예상|추정/u.test(value)) return read('tax', ['tax.estimate', 'tax.estimate.basis'], reportCondition('tax', value, snapshot));
  if (/미납|내야\s*하는|세금\s*낼/u.test(value)) return read('tax', ['tax.payment', 'tax.unpaid.total']);
  if (taxReportPeriod.test(value) && /세무|세금/u.test(value)) return read('tax', ['tax.review.count', 'tax.connection'], reportCondition('tax', value, snapshot));
  const date = readDate(value, today);
  if (date && /납부\s*항목|세금\s*항목/u.test(value)) {
    const querySlot = 'taxPayment';
    return { intent: { kind: 'read', recordKind: 'taxPayment', querySlot },
      slots: { [querySlot]: [named ?? allRows, date].join('\n') }, browse: true,
      onMissing: { answer: tr.l('그 날짜에 납부 일정이 없어요.', 'No payment is scheduled for that date.', '该日期没有缴税安排。', '該日期沒有繳稅安排。') } };
  }
}

function routeLedger(value: string, snapshot: DataSnapshot, locale: Locale, policy: MoneyPolicy): DomainRoute | undefined {
  const tr = selectText(locale), today = dateOf(snapshot);
  if (/^(?:재고|발주)|재고.*(?:매출|지출)|(?:매출|지출).*재고/u.test(value)) return;
  if (/지출/u.test(value) && change.test(value) && !remove.test(value) && !bulkDelete.test(value) && !/증빙/u.test(value) && policy.allowExpenseEdit) {
    return routeExpenseEdit(value, snapshot, locale);
  }
  if (/지출/u.test(value) && (remove.test(value) || change.test(value) && !/메모|증빙/u.test(value))) return refusal('widget_only',
    tr.l('손익 패널에서 지출 기록을 확인해 주세요.', 'Review the expense in the ledger.', '请在账本核对支出。', '請在帳本核對支出。'), { featureId: 'ledger' });
  if (candidateWords.test(value) && confirmCandidate.test(value)) return routeCandidate(value, snapshot, locale);
  const unnamedSpend = /(?:오늘|어제).*(?:썼|쓴)/u.test(value) && navisMoneySpans(value).length > 0;
  if (explicitExpenseEntry(value) || unnamedSpend && !expenseHistory.test(value)) {
    return routeExpense(value, snapshot, locale, policy);
  }
  const condition = reportCondition('ledger', value, snapshot);
  if (/순이익률|남는\s*비율/u.test(value)) return read('ledger', ['ledger.profitRate'], condition);
  if (/어제보다|어제\s*대비/u.test(value)) return read('ledger', ['ledger.sales.dayComparison'], periodCondition(addDays(today, -6), today));
  if (expenseHistory.test(value)) return read('ledger', ['ledger.expense.row', 'ledger.expenses.total'], condition);
  if (/시간대별\s*매출/u.test(value)) return read('ledger', ['ledger.sales.hourly'], condition);
  if (/피크\s*시간|몇\s*시에\s*제일\s*잘\s*팔/u.test(value)) return read('ledger', ['ledger.sales.peak'], condition);
  if (/오늘\s*마감했|마감\s*정산\s*아직|마감\s*끝났/u.test(value)) return read('ledger', ['ledger.closing.status']);
  if (/마감|시재/u.test(value) && /마감\s*해|영업\s*종료|마감\s*취소|시재.*(?:넣어|빼|기록)/u.test(value)) return refusal('widget_only',
    tr.l('마감 화면에서 처리해 주세요.', 'Use the closing screen.', '请在结账页面处理。', '請在結帳頁面處理。'), { featureId: 'pos-closing' });
  if (/메뉴별.*매출|제일\s*많이\s*팔.*금액|라[테떼]\s*매출/u.test(value)) return read('ledger', ['ledger.sales.menu'], condition);
  if (/평소보다\s*매출|평균보다\s*잘|매출\s*추세/u.test(value)) return read('ledger', ['ledger.sales.net', 'ledger.sales.base', 'ledger.sales.delta'], condition);
  if (/매출.*예상|예상.*매출|말까지\s*매출|이대로\s*가면\s*월\s*매출/u.test(value)) return textAnswer(
    tr.l('월 매출 예측 자료가 없어요.', 'No monthly sales forecast is available.', '没有月销售预测资料。', '沒有月銷售預測資料。'));
  if (/작년|지난\s*달|저번\s*달|9월|이번\s*주|월요일부터|최근\s*\d+일|\d{4}년/u.test(value) &&
      /매출|벌었|그럼|그러면/u.test(value)) return read('ledger', ['ledger.sales.net', 'ledger.coverage'], condition);
  if (/증빙\s*(?:없|빠진)|가계부.*증빙/u.test(value)) return read('ledger', ['ledger.evidence.missing', 'ledger.evidence.row'], condition);
}

function moneyNavigation(raw: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | null | undefined {
  const value = normalizeNavisInput(raw);
  if (outsideMoney(value) || !open.test(value) || /삭제|지워|없애|처리해|수정해/u.test(value)) return;
  const tax = taxWords.test(value) && !/세금계산서/u.test(value);
  if (tax) {
    if (taxHistory.test(value) && !/탭|화면|상세|열어|납부\s*이력/u.test(value)) return null;
    if (/미납|낼\s*거|확인할\s*세무|뭐야|얼마/u.test(value) && !/탭|화면|열어|상세/u.test(value)) return;
    const type = canonicalTaxType(value);
    const editing = /(?:추가|등록).*?(?:폼|양식|화면)|(?:폼|양식).*?(?:추가|등록)/u.test(value);
    const payments = editing || /납부\s*이력|낸\s*세금|납부\s*(?:항목|기록)|납부\s*탭|세금\s*항목/u.test(value) || !!type;
    const view = payments ? 'payments' : /증빙/u.test(value) ? 'evidence' : 'checks';
    const condition = !editing && taxReportPeriod.test(value) ? reportCondition('tax', value, snapshot) : undefined;
    if (condition && selectWidget(snapshot, 'tax', condition, 'normal').status !== 'ready') return null;
    const date = !editing && payments ? readDate(value, taxDate(snapshot)) : undefined;
    const query = date ? [type ?? allRows, date].join('\n') : type;
    const rows = query ? matchedRows({ snapshot, query, locale, privateLookup: false }, 'taxPayment') : [];
    if (date && rows.length !== 1) return null;
    const amount = moneyOf(value), dueOn = readDate(value, taxDate(snapshot));
    const prefill = editing ? { ...(type ? { taxType: type } : {}), ...(positiveWon(amount) ? { amount } : {}), ...(dueOn ? { dueOn } : {}) } : undefined;
    return { args: { featureId: 'tax', view, ...(rows.length === 1 ? { itemId: rows[0].id } : {}), ...(condition ? { condition } : {}),
      ...(editing ? { focus: 'action', ...(prefill && Object.keys(prefill).length ? { prefill } : {}) } : {}) },
      ...(rows.length === 1 ? { target: { kind: 'taxPayment', id: rows[0].id }, querySlot: 'taxPayment' } : {}) };
  }
  const editing = /지출.*(?:기록|등록).*(?:폼|양식|열어)/u.test(value);
  if (!editing && !/손익|가계부|지출\s*(?:탭|내역|후보)|순이익|증빙/u.test(value)) return;
  const view = /지출\s*후보|후보\s*지출/u.test(value) ? 'candidates' : /증빙/u.test(value) && !editing ? 'evidence'
    : /지출|expense/iu.test(value) ? 'expenses' : /순이익|이익\s*탭|손익\s*계산서/u.test(value) ? 'profit' : 'sales';
  const condition = reportCondition('ledger', value, snapshot);
  const amount = moneyOf(value), category = expenseCategory(value), date = readDate(value, dateOf(snapshot));
  const memo = expenseMemo(value);
  const prefill = editing ? { ...(positiveWon(amount) ? { amount } : {}), ...(category ? { category } : {}),
    ...(date && date <= dateOf(snapshot) ? { date } : {}), ...(memo ? { memo } : {}), evidence: expenseEvidence(value) } : undefined;
  const kind = view === 'candidates' ? 'candidate' : 'expense';
  const query = [allRows, date ?? '', positiveWon(amount) ? amount : ''].join('\n');
  const rows = !editing && (view === 'candidates' || view === 'expenses' && positiveWon(amount))
    ? matchedRows({ snapshot, query, locale, privateLookup: false }, kind) : [];
  const target: DomainDetail['target'] = rows.length === 1 ? { kind, id: rows[0].id } : undefined;
  return { args: { featureId: 'ledger', view, ...(!editing && condition.kind !== 'default' ? { condition } : {}),
    ...(target ? { itemId: target.id } : {}), ...(editing ? { focus: 'action', prefill } : {}) },
    ...(target ? { target, querySlot: kind } : {}) };
}

/** The widget validates all local prefill fields before initializing its existing editor. */
export function moneyDetailPrefill(ref: DetailRef) {
  const payload = ref.prefill;
  return payload?.kind === 'widget-draft' && ['ui.openDetail', 'ui.setDraftField'].includes(payload.command)
    && validateAgentPrefill(ref.featureId, payload.fields) ? payload.fields : undefined;
}

export function createMoneyDomain(policy: MoneyPolicy = {}): DomainAdapter {
  const commands: CommandName[] = ['ledger.confirmCandidate', 'tax.createPayment', 'tax.updatePayment', 'tax.setEvidence', 'tax.markChecked'];
  if (policy.allowExpenseEntry) commands.push('ledger.recordExpense');
  if (policy.allowTaxDelete) commands.push('tax.deletePayment');
  if (policy.allowExpenseEdit) commands.push('ledger.updateExpense');
  return {
    featureIds: ['ledger', 'tax'],
    commands: commands.map(makeCommand),
    reads: (['expense', 'candidate', 'taxPayment', 'taxItem'] as const).map(reader),
    projectWidget: projectMoneyFacts,
    navigation: moneyNavigation,
    routePresentation(raw, snapshot, locale) {
      const value = normalizeNavisInput(raw);
      if (outsideMoney(value)) return;
      if (candidateWords.test(value) && confirmCandidate.test(value) ||
        explicitExpenseEntry(value) && (!taxWords.test(value) || /세금계산서/u.test(value))) {
        return routeLedger(value, snapshot, locale, policy);
      }
      if (taxWords.test(value) && !/세금계산서|캘린더|달력/u.test(value) &&
        (canonicalTaxType(value) || /납부\s*일정|증빙\s*자료|현금영수증/u.test(value))) {
        return routeTax(value, snapshot, locale, policy);
      }
      if (taxReviewAction.test(value) && /냅킨|빨대|원두\s*구매|전기요금|시럽|\d[\d,]*원\s*건/u.test(value)) {
        return routeCheck(value, snapshot, locale);
      }
    },
    route(raw, snapshot, locale) {
      const value = normalizeNavisInput(raw);
      if (outsideMoney(value)) return;
      if (/(?:냅킨|빨대|(?:^|\s)\d[\d,]*원\s*건)/u.test(value) && /확인했|확인\s*완료|또\s*확인/u.test(value)) return routeCheck(value, snapshot, locale);
      if (/(?:직원|알바|누구|시급|월급|급여).*(?:시급|월급|급여)|(?:시급|월급|급여).*(?:얼마|알려)/u.test(value) && !expenseWords.test(value)) {
        const tr = selectText(locale);
        return textAnswer(tr.l('직원별 급여 자료는 없어요.', 'Individual staff pay is unavailable.', '没有员工个人薪资资料。', '沒有員工個人薪資資料。'));
      }
      if (/세금계산서/u.test(value) && expenseWords.test(value)) return routeLedger(value, snapshot, locale, policy);
      return taxWords.test(value) || /(?:증빙|영수증).*(?:있는|있음|없는|없음|추가)|증빙.*자료.*(?:연동|연결)/u.test(value) && !expenseWords.test(value)
        ? routeTax(value, snapshot, locale, policy) : routeLedger(value, snapshot, locale, policy);
    },
    handoff(command, fields) {
      if (command === 'tax.markPaid' && typeof fields.taxPaymentId === 'string') return { featureId: 'tax', view: 'payments', itemId: fields.taxPaymentId };
      if (command === 'tax.setEvidence' && fields.evidence === 'example' && typeof fields.taxPaymentId === 'string') {
        return { featureId: 'tax', view: 'evidence', itemId: fields.taxPaymentId, focus: 'action' };
      }
      if (command === 'tax.export') return { featureId: 'tax', view: 'checks' };
      if (command === 'ui.setDraftField' && fields.featureId === 'ledger' && fields.field === 'amount' && positiveWon(fields.value)) {
        return { featureId: 'ledger', view: 'expenses', focus: 'action',
          prefill: { kind: 'widget-draft', command, fields: { amount: fields.value } } };
      }
    },
  };
}

const dashboardMoney = createMoneyDomain({ allowExpenseEntry: true, allowTaxDelete: true, allowExpenseEdit: true });
export const moneyDomain: DomainAdapter = {
  ...dashboardMoney,
  route(text, snapshot, locale, run) {
    const routed = dashboardMoney.route?.(text, snapshot, locale, run);
    // The standalone assistant has its own simple-mode formatting for these existing queries.
    if (!run && routed && 'intent' in routed && routed.intent.kind === 'read') {
      const { featureId, condition } = routed.intent;
      if (featureId === 'ledger' && condition && !normalizeCondition('ledger', condition).ok ||
          featureId === 'tax' && routed.factKeys?.includes('tax.unpaid.total')) return;
    }
    return routed;
  },
};
