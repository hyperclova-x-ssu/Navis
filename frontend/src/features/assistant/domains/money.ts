import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import { handlers } from '../../../data/commands/handlers';
import { findExpenseDuplicate, findTaxDuplicate, isExpenseDayClosed, selectNextTaxPayment } from '../../../data/commands/management-guards';
import type { DataCommand } from '../../../data/commands/types';
import { addDays, isIsoDate, TODAY } from '../../../data/db/time';
import type { DataSnapshot, DataText, Evidence, Expense, ExpenseCategory } from '../../../data/db/types';
import { selectMoneyRead } from '../../../data/pos/projection';
import { normalizeCondition, readModel, resolveDataText, selectClosing, selectPayments, selectWidget, supportedConditions, type LedgerExpenseRow, type LedgerModel, type TaxModel } from '../../../data/widget-data';
import { createTranslator } from '../../../i18n';
import { validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill, type AgentFact, type AgentRefusal } from '../../../../shared/navis-agent-schema.mjs';
import { mgmtMoneyBundle } from '../../widgets/mgmt-money/messages';
import { navisTranslator } from '../messages';
import { navisMoneySpans, normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisNumber, parseNavisPeriod } from '../navis-input';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainLookup, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter, RecordSearch, RecordTargets } from './registry';

type MoneyFeature = 'ledger' | 'tax';
type Payment = TaxModel['payments'][number];
type MoneyCommand = Exclude<Extract<DataCommand, { type: `ledger.${string}` | `tax.${string}` }>, { type: 'tax.markPaid' | 'tax.export' }>;
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
const signedNet = (row: DataSnapshot['tables']['dailySales'][number]) => row.recognizedNet ?? row.gross - row.discount - row.refund;
const periodCondition = (start: string, end: string): QueryCondition => ({ kind: 'dateRange', start, end });
const defaultCondition = { kind: 'default' } as const;

function fact(key: string, label: string, value: string | number, unit: string, display = String(value), date?: string): AgentFact {
  return { key, label, value, unit, display, ...(date ? { date } : {}) };
}

function ledgerFacts(snapshot: DataSnapshot, model: LedgerModel, locale: Locale): AgentFact[] {
  const tr = selectText(locale), { start, end } = model.period;
  const size = snapshot.tables.dailySales.filter(row => row.businessDate >= start && row.businessDate <= end).length;
  const complete = size === model.periodTrend.length;
  const currency = (key: string, label: string, amount: number) => ({ ...fact(key, label, amount, 'KRW', tr.money(amount), start === end ? start : undefined), start, end });
  const rows = (key: string, items: readonly LedgerExpenseRow[]) => items.map(row => {
    const name = row.memo ? tr.data(row.memo) : tr.t(row.categoryKey);
    return fact(key, name, row.amount, 'KRW', [tr.money(row.amount), tr.date(row.date), tr.t(row.evidenceKey)].join(' · '), row.date);
  });
  const salesRows = snapshot.tables.menuDaily.filter(row => row.businessDate >= start && row.businessDate <= end && row.netSales !== null);
  const perMenu = new Map<string, number>();
  for (const row of salesRows) perMenu.set(row.menuId, (perMenu.get(row.menuId) ?? 0) + row.netSales!);
  const menuFacts = [...perMenu.entries()].sort((a, b) => b[1] - a[1]).flatMap(([id, amount]) => {
    const menu = snapshot.tables.menuItem.find(row => row.menuId === id);
    return menu ? [currency('ledger.sales.menu', tr.data(menu.name ?? { key: menu.nameKey }), amount)] : [];
  });
  const totals = new Map<number, number>();
  if (start === end) {
    const entries = snapshot.pos?.money
      ? selectMoneyRead(snapshot).state.recognitions.filter(row => row.businessDate === start).map(row => [Number(row.at.slice(11, 13)), row.amount] as const)
      : selectPayments(snapshot, { date: start, scenario: 'normal' }).rows.map(row => [Number(row.time.slice(0, 2)), row.net] as const);
    for (const [hour, amount] of entries) if (amount) totals.set(hour, (totals.get(hour) ?? 0) + amount);
  }
  const hourly = [...totals.entries()].sort((a, b) => a[0] - b[0]);
  const hourlyLabel = (hour: number) => `${tr.widget('widget.ledger.hourlySales')} ${String(hour).padStart(2, '0')}:00`;
  const peak = [...hourly].sort((a, b) => b[1] - a[1])[0];
  const closing = start === end ? selectClosing(snapshot, { date: start, scenario: 'normal' }) : undefined;
  const coverage = tr.format.dateRange(start, end);
  const salesLabel = start === end ? tr.t('data.fact.ledger.sales.net') :
    tr.widget('widget.ledger.salesIn', { period: start === addDays(end, -6) ? tr.t('format.period.last7') : coverage });
  const yesterday = addDays(end, -1);
  const recent = model.periodTrend.filter(point => point.date === end || point.date === yesterday);
  return [
    ...(!size ? [] : [{ ...currency('ledger.sales.net', salesLabel, model.sales.net),
      display: start === end ? tr.format.money(model.sales.net, 'compact') : tr.money(model.sales.net) }]),
    ...(model.comparison ? [
      fact('ledger.sales.delta', tr.l('비교 기간 대비', 'Versus comparison period', '与对比期间相比', '與對比期間相比'), model.comparison.delta.value, 'percent', `${model.comparison.delta.value}%`),
      currency('ledger.sales.base', tr.format.dateRange(model.comparison.base.start, model.comparison.base.end), model.comparison.baseNet),
    ] : []),
    currency('ledger.expenses.total', tr.widget('widget.ledger.expenses'), model.expenses.total),
    ...model.expenses.byCategory.map(row => currency('ledger.expenses.category', tr.t(row.categoryKey), row.amount)),
    ...(model.remaining === null ? [] : [currency('ledger.remaining', tr.widget('widget.ledger.remaining'), model.remaining)]),
    ...(model.profitRate == null ? [] : [fact('ledger.profitRate', tr.widget('widget.ledger.profitRate'), model.profitRate, 'percent', `${model.profitRate.toFixed(1)}%`)]),
    fact('ledger.coverage', tr.l('조회 기간', 'Reporting period', '查询期间', '查詢期間'), coverage, 'text',
      complete ? coverage : `${coverage} · ${tr.l('일부 매출 자료 없음', 'Some sales data missing', '部分销售数据缺失', '部分銷售資料缺失')}`),
    fact('ledger.evidence.missing', tr.widget('widget.ledger.missingEvidenceLabel'), model.missingEvidenceCount, 'count', tr.count(model.missingEvidenceCount)),
    fact('ledger.candidates.count', tr.widget('widget.ledger.candidates'), model.candidates.length, 'count', tr.count(model.candidates.length)),
    ...rows('ledger.expense.row', model.expenses.items),
    ...rows('ledger.evidence.row', model.expenses.items.filter(row => row.evidence === 'none')),
    ...rows('ledger.candidate.row', model.candidates),
    ...model.periodTrend.filter(point => snapshot.tables.dailySales.some(row => row.businessDate === point.date)).map(point =>
      fact('ledger.sales.daily', tr.date(point.date), point.net, 'KRW', tr.money(point.net), point.date)),
    ...recent.filter(point => snapshot.tables.dailySales.some(row => row.businessDate === point.date)).map(point =>
      fact('ledger.sales.dayComparison', tr.date(point.date), point.net, 'KRW', tr.money(point.net), point.date)),
    ...hourly.map(([hour, amount]) => fact('ledger.sales.hourly', hourlyLabel(hour), amount, 'KRW', tr.money(amount), start)),
    ...(peak ? [fact('ledger.sales.peak', hourlyLabel(peak[0]), peak[1], 'KRW', tr.money(peak[1]), start)] : []),
    ...menuFacts,
    ...(closing ? [fact('ledger.closing.status', tr.l('마감', 'Closing', '结账', '結帳'), closing.status, 'text', closing.status === 'closed'
      ? tr.l('정산 완료', 'Closed', '结账完成', '結帳完成') : tr.l('정산 전', 'Open', '尚未结账', '尚未結帳'), start)] : []),
  ];
}

function taxPaymentLine(payment: Payment, tr: ReturnType<typeof selectText>) {
  const date = payment.paidOn ?? payment.dueOn;
  return [tr.money(payment.amount), tr.date(date), payment.status === 'paid'
    ? tr.l('납부 완료', 'Paid', '已缴纳', '已繳納') : payment.overdue ? tr.l('기한 지남', 'Overdue', '已逾期', '已逾期') : tr.l('미납', 'Unpaid', '未缴纳', '未繳納')].join(' · ');
}

function taxFacts(model: TaxModel, locale: Locale): AgentFact[] {
  const tr = selectText(locale), next = selectNextTaxPayment(model.payments);
  const paymentFact = (key: string, payment: Payment) => fact(key, tr.data(payment.type), payment.amount, 'KRW', taxPaymentLine(payment, tr), payment.paidOn ?? payment.dueOn);
  const unpaid = model.payments.filter(row => row.status === 'unpaid');
  const paid = model.payments.filter(row => row.status === 'paid');
  const overdue = model.payments.filter(row => row.overdue);
  const unpaidTotal = unpaid.reduce((sum, row) => sum + row.amount, 0);
  const { cashReceipts } = model.exportPreview;
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
    ...model.connections.map(row => fact('tax.connection', tr.t(row.sourceKey), row.status, 'text', tr.t(row.statusKey))),
    ...(model.estimate ? [
      fact('tax.estimate', tr.widget('widget.tax.estimate'), model.estimate.amount, 'KRW',
        `${tr.money(model.estimate.amount)} · ${tr.date(model.estimate.basisDate)}`, model.estimate.basisDate),
      fact('tax.estimate.basis', tr.widget('widget.tax.estimate'), tr.t(model.estimate.assumptionKey), 'text'),
    ] : []),
    fact('tax.cashReceipts', tr.l('현금영수증', 'Cash receipts', '现金收据', '現金收據'), cashReceipts.count, 'count',
      `${tr.count(cashReceipts.count)} · ${tr.money(cashReceipts.amount)}`),
  ];
}

export function projectMoneyFacts(snapshot: DataSnapshot, featureId: FeatureId, condition: QueryCondition, locale: Locale) {
  if (featureId === 'ledger') {
    const view = selectWidget(snapshot, featureId, condition, 'normal');
    if (view.status === 'ready') return { facts: ledgerFacts(snapshot, view.model, locale) };
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
    return view.status === 'ready' ? { facts: taxFacts(view.model, locale) }
      : { status: view.status === 'error' ? 'unsupported_period' as const : 'missing' as const };
  }
}

type RecordRow = { readonly id: string; readonly label: string; readonly fields: Record<string, string | number | boolean> };
type SearchRow = RecordRow & { readonly handle: string };

function expenseLabel(row: Pick<Expense, 'memo' | 'category'>, locale: Locale) {
  const tr = selectText(locale);
  return row.memo ? tr.data(row.memo) : tr.t(`data.expenseCategory.${row.category}`);
}
const taxAlias = (value: string) => normalizeNavisName(value)
  .replace(/종소세|종합소득세|^소득세$/gu, '종합소득세').replace(/부가가치세/gu, '부가세').replace(/지방세/gu, '지방소득세');
function moneyRows(snapshot: DataSnapshot, kind: MoneyRecord, locale: Locale): RecordRow[] {
  const tr = selectText(locale);
  if (kind === 'taxPayment') return readModel(snapshot, 'tax').payments.map(row => ({
    id: row.taxPaymentId, label: tr.data(row.type), fields: { date: row.dueOn, amount: row.amount, status: row.status, evidence: row.evidence,
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
    id: row.expenseId, label: expenseLabel(row, locale), fields: { date: row.businessDate, amount: row.amount, status: row.status,
      // D-326 Q2: a settled day keeps its expenses; the card never opens for it.
      ...(kind === 'expense' ? { closed: expenseDayClosed(snapshot, row.businessDate) } : {}) },
  }));
}
/** The same rule the ledger edit handler uses: that business day's normal closing is settled. */
const expenseDayClosed = (snapshot: DataSnapshot, date: string) => isExpenseDayClosed(snapshot.tables, date);
const allRows = '*';
function matchedRows(input: RecordSearch, kind: MoneyRecord): SearchRow[] {
  const { snapshot, query, locale, querySlot, command } = input;
  const [name, date, amount] = query.split('\n');
  const key = kind === 'taxPayment' ? taxAlias(name) : normalizeNavisName(name);
  const labelKey = kind === 'taxPayment' ? taxAlias : normalizeNavisName;
  const exactOnly = command === 'tax.createPayment' || querySlot === 'taxType';
  const rows = moneyRows(snapshot, kind, locale).map((row, index) => ({ ...row, handle: `money-${kind}-${snapshot.revision}-${index}` }));
  return rows.filter(row => {
    const label = labelKey(row.label);
    const explicit = name === allRows || row.id === name;
    if (querySlot === 'paidHistory' && row.fields.status !== 'paid') return false;
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
    title = command.type === 'ledger.recordExpense' ? tr.t('common.recordExpense') : tr.widget('widget.ledger.confirmCandidate');
    add(tr.widget('widget.ledger.field.category'), a && tr.t(`data.expenseCategory.${a.category}`), tr.t(`data.expenseCategory.${b.category}`));
    add(tr.widget('widget.ledger.field.date'), a && tr.date(a.businessDate), tr.date(b.businessDate));
    add(tr.widget('widget.ledger.field.amount'), amount(a), amount(b));
    add(tr.widget('widget.ledger.field.evidence'), a && tr.t(`data.evidence.${a.evidence}`), tr.t(`data.evidence.${b.evidence}`));
    if (b.memo && !a) add(tr.widget('widget.ledger.field.memo'), undefined, tr.data(b.memo));
    const supplier = b.supplierId && after.tables.supplier.find(row => row.supplierId === b.supplierId);
    if (supplier && !a) add(tr.l('거래처', 'Supplier', '供应商', '供應商'), undefined, tr.data(supplier.name ?? { key: supplier.nameKey }));
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

const taxWords = /세금|세무|원천세|종합소득세|종소세|부가(?:가치)?세|지방(?:소득)?세|납부|현금영수증|ㅅㅁㄱㄹ/u;
const taxReportPeriod = /(?:이번|지난|저번)\s*달|\d{1,2}\s*월\s*기준/u;
const expenseWords = /가계부|지출|소모품|청소용품|전기(?:요금|세)|임대료|월세|간식|직원.*커피|(?:우유|원두)값|대금/u;
const remove = /삭제|지워|없애/u;
const bulkDelete = /모두|전부|전체|한꺼번에|한\s*번에|싹|(?:^|\s)다\s|두\s*건|둘\s*다|\b(?:all|every|both)\b|全部|所有/iu;
const change = /바꾸|바꿔|변경|정정|고쳐|수정|미뤄|당겨/u;
const add = /추가|등록/u;
const logPaid = /납부\s*(?:완료|취소|전|처리|했다고)|납부했어.*(?:기록|표시|처리)|안\s*낸|냈(?:음|어|다고)|입금함|낸\s*(?:걸로|날짜)|납부\s*(?:일자|일)(?!정).*(?:고쳐|정정|수정|변경)/u;
const open = /열어|열고|보여|탭|화면|상세|어디서\s*봐/u;
const boardWords = /(?:위젯|패널|보드|대시보드).*?(?:추가|넣어|올려|옮겨|보내)|페이지.*(?:보내|옮겨)|(?:보내|옮겨).*페이지/u;
const doNot = /하지\s*마|말아|무시|ignore\s+|\b(?:don't|never|do not)\b/u;
const anyDate = /오늘|어제|그저께|내일|모레|글피|(?:이번|다음|지난|저번|담)\s*(?:주|달)|\d{1,2}\s*월|\d{1,2}\s*일|\d[/-]\d|날짜|월요일|화요일|수요일|목요일|금요일|토요일|일요일/u;
const quotedInstruction = /^(?:["“'‘]|.*인용(?:문|한\s*문장))|["”'’](?:라고|고)\s*(?:써|했|읽|말)/u;
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
  const bare = value.match(/(?:^|\s)(-?(?:\d[\d,]*)(?:\.\d+)?)(?:\s*(?:으로|로)|\s|$)(?!\s*(?:월|일|명|건|분))/u);
  return bare && !/\d[/.-]\d/u.test(value) ? parseNavisNumber(bare[1]) : undefined;
};
const readDate = (value: string, today: string) => {
  const scrubbed = [...navisMoneySpans(value)].reverse().reduce((text, span) => text.slice(0, span.start) + ' ' + text.slice(span.end), value)
    .replace(/담\s*주/u, '다음 주').replace(/((?:이번|다음|지난|저번)\s*주)\s*([월화수목금토일])(?=\s|으로|로|까지|$)(?!요일)/u, '$1 $2요일');
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
const expenseMemo = (value: string) => value.match(/(?:메모(?:는|를)?\s+)(.+?)(?:으로\s*(?:기록|저장)|$)/u)?.[1] ??
  value.match(/\(([^()]+)\)\s*$/u)?.[1] ?? value.match(/전기요금|전기세/u)?.[0];

const textAnswer = (answer: string): DomainRoute => ({ kind: 'answer', answer });
const refusal = (reason: AgentRefusal['reason'], answer: string, alternative?: { featureId: string; command?: string; draft?: Record<string, unknown> }): DomainRoute =>
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
  const explicitSupplier = value.match(/(?:[A-Z]|에이|비|씨|디)\s*(?:유통|로스터리|포장|베이커리|농산)/iu)?.[0];
  const liveSupplier = snapshot.tables.supplier.find(row => !row.deletedAt &&
    normalizeNavisName(value).includes(normalizeNavisName(tr.data(row.name ?? { key: row.nameKey }))));
  if (explicitSupplier && !liveSupplier) return refusal('invalid_target', tr.l('해당 거래처가 없어요.', 'No matching supplier.', '未找到该供应商。', '未找到該供應商。'));
  const duplicateInput = { date, category, amount, supplierId: liveSupplier?.supplierId ?? null, memo: memo ?? '' };
  const duplicate = findExpenseDuplicate(snapshot.tables.expense, duplicateInput);
  if (duplicate) return ask('confirmDuplicate', tr.l('같은 지출이 있어요.', 'A matching expense exists.', '已有相同支出。', '已有相同支出。') +
    '\n' + [tr.date(duplicate.businessDate), expenseLabel(duplicate, locale), tr.money(duplicate.amount)].join(' · '));
  if (!allowExpenseEntry) return refusal('widget_only', tr.l('가계부에서 지출을 기록해 주세요.', 'Record the expense in the ledger.', '请在账本记录支出。', '請在帳本記錄支出。'),
    { featureId: 'ledger', command: 'ui.setDraftField', draft: { featureId: 'ledger', field: 'amount', value: amount } });
  const fields = { date, category, amount, evidence, ...(memo ? { memo } : {}) };
  return liveSupplier ? commandTurn('ledger.recordExpense', locale, fields, { supplier: tr.data(liveSupplier.name ?? { key: liveSupplier.nameKey }) },
    [lookup('supplier', 'supplier', 'supplierId')]) : commandTurn('ledger.recordExpense', locale, fields);
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
  const repeated = /한\s*번\s*더|또|다시|방금/u.test(value);
  if (!rows.length) {
    const confirmed = snapshot.tables.expense.some(row => row.receiptId && row.status === 'confirmed');
    return textAnswer(repeated && confirmed ? tr.l('지출 후보를 이미 넣었어요.', 'The expense candidate was already recorded.', '候选支出已入账。', '候選支出已入帳。')
      : tr.l('확인할 지출 후보가 없어요.', 'No expense candidates to review.', '没有待审核的候选支出。', '沒有待審核的候選支出。'));
  }
  const target = rows.find(row => normalizeNavisName(value).includes(normalizeNavisName(row.label)));
  const item = value.match(/([가-힣]+)\s+입고/u)?.[1];
  const query = target?.id ?? (item && !['생긴', '확인할'].includes(item) ? item : allRows);
  const matches = matchedRows({ snapshot, query, locale, privateLookup: false }, 'candidate');
  if (!matches.length) return textAnswer(tr.l('해당 지출 후보가 없어요.', 'No matching expense candidate.', '未找到该候选支出。', '未找到該候選支出。'));
  return commandTurn('ledger.confirmCandidate', locale, {}, { candidate: query }, [lookup('candidate', 'candidate', 'expenseId')]);
}

function createTax(value: string, snapshot: DataSnapshot, locale: Locale, overrides: LocalSlots = {}): DomainRoute {
  const tr = selectText(locale), today = dateOf(snapshot);
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
  const label = /냅킨|빨대/u.test(value) ? '냅킨' : /전기요금|원두\s*구매|시럽/u.exec(value)?.[0];
  const target = label || positiveWon(amount) ? [label ?? allRows, '', positiveWon(amount) ? amount : ''].join('\n') : undefined;
  if (!target) return ask('taxItem', tr.l('어느 자료를 확인했나요?', 'Which item did you check?', '您核对了哪项资料？', '您核對了哪項資料？'),
    next => routeCheck(next, snapshot, locale));
  const candidates = matchedRows({ snapshot, query: target, locale, privateLookup: false }, 'taxItem');
  if (!candidates.length) return refusal('invalid_target', tr.l('확인 목록에 해당 자료가 없어요.', 'That item is not in the review list.', '核对列表中没有这项资料。', '核對清單中沒有這項資料。'));
  if (candidates.length === 1 && rows.find(row => row.id === candidates[0].id)?.fields.status === 'checked') {
    return textAnswer(tr.l('이미 확인했어요.', 'Already checked.', '已核对。', '已核對。'));
  }
  return commandTurn('tax.markChecked', locale, {}, { taxItem: target }, [lookup('taxItem', 'taxItem', 'refId')]);
}

function changeTax(value: string, snapshot: DataSnapshot, locale: Locale, policy: MoneyPolicy, overrides: LocalSlots = {}): DomainRoute {
  const tr = selectText(locale), [from, to] = value.split(/\s*(?:이름(?:을)?|항목명|말고)\s*/u);
  const mentioned = typeof overrides.target === 'string' ? overrides.target : canonicalTaxType(from);
  const deleting = remove.test(value) && !/증빙|영수증/u.test(value);
  const obligationDate = deleting ? readDate(from, dateOf(snapshot)) : undefined;
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
    return refusal('widget_only', tr.l('세금계산에서 납부 상태를 확인해 주세요.', 'Review payment status in the tax widget.', '请在税务小组件查看缴税状态。', '請在稅務小工具查看繳稅狀態。'), paymentHandoff(row));
  }
  const evidence = /증빙|영수증/u.test(value) ? /없|지워|삭제/u.test(value) ? 'none' : 'example' : undefined;
  const question = () => ask('taxPaymentId', tr.l('어느 납부 기록인가요?', 'Which tax payment record?', '是哪一笔缴税记录？', '是哪一筆繳稅記錄？'),
    next => changeTax(value, snapshot, locale, policy, { ...overrides, target: canonicalTaxType(next) ?? next.trim() }));
  if (deleting && !mentioned && !obligationDate) return question();
  if (!matches.length) {
    const answer = tr.l('해당 납부 기록이 없어요.', 'No matching tax payment record.', '未找到该缴税记录。', '未找到該繳稅記錄。');
    return evidence ? refusal('invalid_target', answer) : textAnswer(answer);
  }
  const bound = [lookup('taxPayment', 'taxPayment', 'taxPaymentId')];
  const args = { taxPayment: query };
  if (deleting) {
    if (!policy.allowTaxDelete || row?.fields.status === 'paid') return refusal('widget_only',
      tr.l('세금계산에서 납부 기록을 확인해 주세요.', 'Review the payment record in the tax widget.', '请在税务小组件查看缴税记录。', '請在稅務小工具查看繳稅記錄。'), paymentHandoff(row));
    return commandTurn('tax.deletePayment', locale, {}, args, bound);
  }
  if (evidence) {
    if (!mentioned && matches.length > 1) return question();
    if (row?.fields.evidence === evidence) return textAnswer(tr.l('이미 같은 증빙 상태예요.', 'The evidence status is already set.', '凭证状态已经相同。', '憑證狀態已經相同。'));
    return commandTurn('tax.setEvidence', locale, { evidence }, args, bound);
  }
  const due = /기한|마감|기일까지|미뤄|당겨/u.test(value);
  const type = to ? canonicalTaxType(to) ?? to.match(/(\d{1,2})월분/u)?.[0] : undefined;
  const nextType = type && /^\d{1,2}월분$/u.test(type) && /원천세/u.test(from) ? `원천세(${type})` : type;
  const amount = overrides.amount ?? (due || nextType ? undefined : moneyOf(value));
  const dueOn = overrides.dueOn ?? (due ? readDate(value, dateOf(snapshot)) : undefined);
  if (!row && !mentioned) return question();
  if (!row && !dueOn && !nextType && !positiveWon(amount)) return question();
  if (due && typeof dueOn !== 'string') return ask('dueOn', tr.l('납부 기한을 알려 주세요.', 'When is it due?', '请告诉我缴税期限。', '請告訴我繳稅期限。'),
    next => changeTax(value, snapshot, locale, policy, { ...overrides, dueOn: readDate(next, dateOf(snapshot)) }));
  if (!due && !nextType && !positiveWon(amount)) return ask('amount', tr.l('새 금액을 알려 주세요.', 'What is the new amount?', '请告诉我新金额。', '請告訴我新金額。'),
    next => changeTax(value, snapshot, locale, policy, { ...overrides, amount: moneyOf(next) ?? parseNavisNumber(next) }));
  if (row && (amount !== undefined && row.fields.amount === amount || dueOn && row.fields.date === dueOn || nextType === row.label)) {
    const display = positiveWon(amount) ? tr.money(amount) : typeof dueOn === 'string' ? tr.date(dueOn) : row.label;
    return textAnswer(`${display} · ${tr.l('이미 같아요.', 'Already set.', '已经相同。', '已經相同。')}`);
  }
  return commandTurn('tax.updatePayment', locale, nextType ? { type: nextType } : typeof dueOn === 'string' ? { dueOn } : { amount }, args, bound);
}

function reportCondition(featureId: MoneyFeature, value: string, snapshot: DataSnapshot): QueryCondition {
  const today = dateOf(snapshot);
  if (/작년/u.test(value)) {
    const year = String(Number(today.slice(0, 4)) - 1);
    const month = /\d{1,2}(?=\s*월)/u.exec(value)?.[0]?.padStart(2, '0') ?? today.slice(5, 7);
    if (Number(month) >= 1 && Number(month) <= 12) {
      const start = year + '-' + month + '-01';
      const following = month === '12' ? String(Number(year) + 1) + '-01-01' : year + '-' + String(Number(month) + 1).padStart(2, '0') + '-01';
      return periodCondition(start, addDays(following, -1));
    }
  }
  const date = readDate(value, today);
  const supported = supportedConditions(featureId);
  if (date) return date === today ? defaultCondition : periodCondition(date, date);
  if (/(?:월요일부터|이번\s*주)/u.test(value) && featureId === 'ledger') return supported[1] ?? defaultCondition;
  const period = parseNavisPeriod(value, today);
  if (period) return periodCondition(period.start, period.end);
  return defaultCondition;
}

function routeTax(value: string, snapshot: DataSnapshot, locale: Locale, policy: MoneyPolicy): DomainRoute | undefined {
  const tr = selectText(locale);
  if (remove.test(value) && (bulkDelete.test(value) ||
    value.split(/(?:이랑|하고|및|[과와랑])\s+|[,·]\s*/u).filter(part => canonicalTaxType(part)).length > 1)) {
    return { kind: 'refusal', reason: 'unsupported' };
  }
  if (/캘린더|달력/u.test(value) && remove.test(value)) return refusal('widget_only',
    tr.l('세금계산에서 납부 일정을 확인해 주세요.', 'Review the due date in the tax widget.', '请在税务小组件查看缴税日期。', '請在稅務小工具查看繳稅日期。'), { featureId: 'tax' });
  if (/송금|이체|결제해|납부해\s*(?:줘|주세요)|대신\s*내/u.test(value)) return refusal('widget_only',
    tr.l('세금계산에서 납부 일정을 확인해 주세요.', 'Review the due date in the tax widget.', '请在税务小组件查看缴税日期。', '請在稅務小工具查看繳稅日期。'), paymentHandoff());
  if (/내보내|다운로드|제출/u.test(value)) return refusal('widget_only',
    tr.l('세금계산에서 자료를 확인해 주세요.', 'Review the data in the tax widget.', '请在税务小组件查看资料。', '請在稅務小工具查看資料。'), { featureId: 'tax', command: 'tax.export', draft: {} });
  if (/확인했|확인\s*완료|확인함|체크\s*(?:했|다\s*했|완료)|확인\s*처리|처리\s*다시/u.test(value)) return routeCheck(value, snapshot, locale);
  if (add.test(value) && !/증빙|영수증/u.test(value)) return createTax(value, snapshot, locale);
  if (!change.test(value) && /다음\s*(?:세금\s*)?납부|담\s*납부|세금\s*마감일/u.test(value)) {
    return read('tax', ['tax.nextDue']);
  }
  const named = canonicalTaxType(value);
  if (named && /내역|얼마\s*냈|금액\s*알려|언제\s*냈|납부했나/u.test(value) && !change.test(value)) {
    const querySlot = 'paidHistory';
    return { intent: { kind: 'read', recordKind: 'taxPayment', querySlot }, slots: { [querySlot]: named }, browse: true,
      onMissing: { answer: tr.l('해당 납부 이력이 없어요.', 'No matching payment history.', '没有对应的缴税历史。', '沒有對應的繳稅歷史。') } };
  }
  if (change.test(value) || remove.test(value) || logPaid.test(value) || /(?:증빙|영수증).*(?:추가|처리|표시|걸로)/u.test(value)) return changeTax(value, snapshot, locale, policy);
  if (/현금영수증/u.test(value)) return read('tax', ['tax.cashReceipts'], reportCondition('tax', value, snapshot));
  if (/기한\s*지난|연체|늦은/u.test(value)) return read('tax', ['tax.payment.overdueCount', 'tax.payment.overdue']);
  if (/세무\s*자료|증빙|체크\s*항목|확인할\s*자료/u.test(value) && /연결|연동/u.test(value)) return read('tax', ['tax.connection']);
  if (/확인할\s*세무|증빙\s*없는\s*지출|체크\s*항목/u.test(value)) return read('tax', ['tax.review.count', 'tax.review.row']);
  if (/예상|추정/u.test(value)) return read('tax', ['tax.estimate', 'tax.estimate.basis'], reportCondition('tax', value, snapshot));
  if (/미납|내야\s*하는|세금\s*낼/u.test(value)) return read('tax', ['tax.payment', 'tax.unpaid.total']);
  if (/납부\s*이력|낸\s*세금|세금\s*낸/u.test(value)) return read('tax', ['tax.payment.paidCount', 'tax.payment.paid']);
  if (taxReportPeriod.test(value) && /세무|세금/u.test(value)) return read('tax', ['tax.review.count', 'tax.connection'], reportCondition('tax', value, snapshot));
  const date = readDate(value, dateOf(snapshot));
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
    tr.l('가계부에서 지출 기록을 확인해 주세요.', 'Review the expense in the ledger.', '请在账本核对支出。', '請在帳本核對支出。'), { featureId: 'ledger' });
  if (/지출\s*후보|후보\s*지출|입고\s*지출/u.test(value) && /확인|확정|넣어/u.test(value)) return routeCandidate(value, snapshot, locale);
  const writesExpense = /썼|쓴\s*거|샀|냈어|나갔|줬어|지출.*(?:넣어|기록|올려)|(?:기록|넣어).*지출|값\s*넣어|쓸\s*(?:거|예정)/u.test(value)
    && !/뭐뭐\s*샀|지출\s*내역/u.test(value);
  const unnamedSpend = /(?:오늘|어제).*(?:썼|쓴)/u.test(value) && navisMoneySpans(value).length > 0;
  if (writesExpense && (expenseWords.test(value) || unnamedSpend)) return routeExpense(value, snapshot, locale, policy);
  if (expenseCategory(value) && positiveWon(moneyOf(value)) &&
      (anyDate.test(value) && /전기(?:요금|세).*카드/u.test(value) ||
       /청소용품.*\([^()]+\)$|영수증\s*안\s*받았|원재료로\s*넣어/u.test(value))) return routeExpense(value, snapshot, locale, policy);
  const condition = reportCondition('ledger', value, snapshot);
  if (/순이익률|남는\s*비율/u.test(value)) return read('ledger', ['ledger.profitRate'], condition);
  if (/어제보다|어제\s*대비/u.test(value)) return read('ledger', ['ledger.sales.dayComparison'], periodCondition(addDays(today, -6), today));
  if (/지출\s*내역|오늘\s*뭐뭐\s*샀|오늘\s*지출\s*\d+건/u.test(value)) return read('ledger', ['ledger.expense.row', 'ledger.expenses.total'], condition);
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
  if (doNot.test(value) || quotedInstruction.test(value) || boardWords.test(value) || !open.test(value) || /삭제|지워|없애|처리해|수정해/u.test(value)) return;
  const tax = taxWords.test(value) && !/세금계산서/u.test(value);
  if (tax) {
    if (/미납|낼\s*거|확인할\s*세무|뭐야|얼마/u.test(value) && !/탭|화면|열어|상세/u.test(value)) return;
    const type = canonicalTaxType(value);
    const editing = /(?:추가|등록).*?(?:폼|양식|화면)|(?:폼|양식).*?(?:추가|등록)/u.test(value);
    const payments = editing || /납부\s*이력|낸\s*세금|납부\s*(?:항목|기록)|납부\s*탭|세금\s*항목/u.test(value) || !!type;
    const view = payments ? 'payments' : /증빙/u.test(value) ? 'evidence' : 'checks';
    const condition = !editing && taxReportPeriod.test(value) ? reportCondition('tax', value, snapshot) : undefined;
    if (condition && selectWidget(snapshot, 'tax', condition, 'normal').status !== 'ready') return null;
    const date = !editing && payments ? readDate(value, dateOf(snapshot)) : undefined;
    const query = date ? [type ?? allRows, date].join('\n') : type;
    const rows = query ? matchedRows({ snapshot, query, locale, privateLookup: false }, 'taxPayment') : [];
    if (date && rows.length !== 1) return null;
    const amount = moneyOf(value), dueOn = readDate(value, dateOf(snapshot));
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
    route(raw, snapshot, locale) {
      const value = normalizeNavisInput(raw);
      if (doNot.test(value) || quotedInstruction.test(value) || boardWords.test(value)) return;
      if (/(?:냅킨|빨대|(?:^|\s)\d[\d,]*원\s*건)/u.test(value) && /확인했|확인\s*완료|또\s*확인/u.test(value)) return routeCheck(value, snapshot, locale);
      if (/(?:직원|알바|누구|시급|월급|급여).*(?:시급|월급|급여)|(?:시급|월급|급여).*(?:얼마|알려)/u.test(value) && !expenseWords.test(value)) {
        const tr = selectText(locale);
        return textAnswer(tr.l('직원별 급여 자료는 없어요.', 'Individual staff pay is unavailable.', '没有员工个人薪资资料。', '沒有員工個人薪資資料。'));
      }
      if (/세금계산서/u.test(value) && expenseWords.test(value)) return routeLedger(value, snapshot, locale, policy);
      return taxWords.test(value) || /(?:증빙|영수증).*(?:있는|있음|없는|없음|추가)/u.test(value) && !expenseWords.test(value)
        ? routeTax(value, snapshot, locale, policy) : routeLedger(value, snapshot, locale, policy);
    },
    handoff(command, fields) {
      if (command === 'tax.markPaid' && typeof fields.taxPaymentId === 'string') return { featureId: 'tax', view: 'payments', itemId: fields.taxPaymentId };
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
