import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
/** 가계부 (F-27, SCR-30/31): panel for the 16 sizes, detail with period/tabs/expense form, and the key sentence. */
import { createContext, useContext, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { QueryCondition, WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataExecute, useRealPort, useRealRetry, useWidgetDataStore, useWidgetView } from '../../../data/react';
import { TODAY, selectPayments, selectClosing, resolveDataText, supportedConditions, type DataCommand, type DataCommandResult, type ExpenseCategory, type Evidence, type LedgerExpenseRow, type LedgerModel } from '../../../data/widget-data';
import { selectHourlySales } from '../../../data/derive/payments';
import { ActionButton, ChipChoice, PosMoney, Spinner, DataGrid, DateField, DateStepper, DetailTabs, Icon, InlineEmpty, InlineForm, NumberField, StatusBadge, Table, TextField, type GridColumn, type GridFocus, type GridSort, layoutTokens, formatPosMoney } from '../../../ui';
import {
  DetailViewState, Kpi, MiniSeries, MoneyPanel, MONEY_FIT, NoteLine, PERIOD_KEYS, ViewState, addIsoDays, copyLang, splitFormatted, splitMoney, useMoneyT, useRunCommand, useSizeCtx,
  type ChartData, type PanelSpec, type RowData, type T,
} from './shared';
import { ValueSlot } from './value-slot';
import { CustomSalesBreakdown } from '../i7-custom/accounting';
import type { AccountingDay, RealMethod, SettlementPurpose } from '../../../data/iteration7/accounting/types';
import type { PosDrawerSnapshot } from '../../../contracts/pos';
import { accountingCopy as ac, customAccountingCopy, depositCoverageNote } from './iteration7-accounting-messages';
import { moneyDetailPrefill } from '../../assistant/domains/money';
import { ReceiptReviewField, ReceiptScanEntry, type ReceiptField } from './receipt-ocr';
import { dateRangeWithWeekdays } from '../date-range';

export interface AccountingTransaction {
  readonly id: string;
  readonly transactionNo?: string;
  readonly at: string;
  readonly purpose: SettlementPurpose;
  readonly kind: 'receipt' | 'cancel' | 'refund';
  /** Signed amounts are supplied by the accounting projection, including original returns. */
  readonly amount: number;
  /** `null`: the finance service does not attribute recognized sales to a tender row. */
  readonly salesAmount: number | null;
  readonly methods: readonly { readonly method: RealMethod; readonly amount: number }[];
  readonly settlementKinds: readonly ('charge' | 'receivable' | 'membership_count' | 'membership_period')[];
  readonly settlementId: string;
  readonly paymentId?: string;
  readonly originalId?: string;
  readonly sourceRef?: { readonly kind: string; readonly id: string };
}
export type AccountingPeriod = { readonly start: string; readonly end: string };
export type AccountingSummary = Pick<AccountingDay, 'sales' | 'deposits' | 'orderCount' | 'realPaymentCount'>;
export type AccountingUnknownCost = AccountingDay['unknownCostSales'][number] & { readonly label?: string };
export type AccountingView = {
  readonly status: 'ready'; readonly period: AccountingPeriod;
  /** `http`: figures of the finance service. It splits recognized sales by recorded tender (`sales.byMethod`, B09-2) but not by membership source, so those groups are not shown. */
  readonly source?: 'http'; readonly summary: AccountingSummary;
  readonly transactions: readonly AccountingTransaction[];
  readonly drawer?: PosDrawerSnapshot;
  readonly unknownCostSales?: readonly AccountingUnknownCost[];
  readonly legacySales?: number;
  readonly depositCoverage?: AccountingPeriod & { readonly complete: boolean };
} | { readonly status: 'loading' | 'empty' | 'error' | 'unavailable'; readonly period: AccountingPeriod };
export type OpenAccountingReceipt = (row: AccountingTransaction) => void;
export interface AccountingPresentation {
  /** The composition owner supplies period projections and rerenders this value on source revisions. */
  readonly views: readonly AccountingView[];
  /** Frozen closing records, never today's live projection reused for a prior date. */
  readonly history?: readonly AccountingView[];
  readonly onOpenReceipt?: OpenAccountingReceipt;
  readonly onRetry?: () => void;
}
const AccountingContext = createContext<AccountingPresentation | null>(null);
export function AccountingPresentationProvider({ value, children }: { readonly value: AccountingPresentation; readonly children?: ReactNode }) {
  return <AccountingContext.Provider value={value}>{children}</AccountingContext.Provider>;
}
export const useAccountingPresentation = () => useContext(AccountingContext);
export function accountingForPeriod(presentation: AccountingPresentation | null, period: AccountingPeriod, explicit?: AccountingView): AccountingView | undefined {
  const candidate = explicit ?? presentation?.views.find(view => view.period.start === period.start && view.period.end === period.end);
  if (candidate?.period.start === period.start && candidate.period.end === period.end) return candidate;
  return presentation || explicit ? { status: 'unavailable', period } : undefined;
}
export type AccountingDetailProps = WidgetDetailProps & { readonly accounting?: AccountingView; readonly onOpenAccountingReceipt?: OpenAccountingReceipt };
const realMethods = ['card', 'easy_pay', 'cash'] as const;
const recognitionFields = ['chargeUsed', 'receivableCreated', 'membershipCount', 'subscriptionDaily', 'membershipExpiry', 'customPickup'] as const;
const closingMembershipLabels = { membershipCount: '횟수형 회원권 이용분', subscriptionDaily: '기간형 회원권 이용분' } as const;
const depositPurposes = ['sale', 'charge_topup', 'receivable_collection', 'membership_sale', 'custom_order'] as const;
const won = (amount: number) => formatPosMoney(amount);
type AmountRow = { readonly id: string; readonly label: string; readonly amount: number | string };
function AmountTable({ title, rows }: { readonly title: string; readonly rows: readonly AmountRow[] }) {
  return <Table className="mm-table"><caption className="mm-table__caption">{title}</caption><tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.label}</th><td>{typeof row.amount === 'number' ? won(row.amount) : row.amount}</td></tr>)}</tbody></Table>;
}
/** REAL-PLAN F09-2 copy (Korean-only like this card; for R2/R4 review). */
const methodCopy = {
  /** The one row a snapshot without `sales.byMethod` shows in place of the tender rows. */
  unavailableLabel: '카드 · 간편결제 · 현금 판매분', unavailable: '아직 기록 없음',
  /** The subtotal that is already inside the amounts above: never added to them or to the day's sales. */
  overlapTitle: '다른 항목과 겹치는 금액(합계에 넣지 않아요)', mixed: '복합 결제', marginTitle: '매출을 받은 수단',
} as const;
type ReadyAccountingView = Extract<AccountingView, { readonly status: 'ready' }>;
/** The sales of receipts paid with more than one tender, from the example transactions (over HTTP the finance service sends it as `sales.byMethod.mixed`). */
const exampleMixedSales = (view: ReadyAccountingView) => view.transactions.filter(row => row.methods.length > 1).reduce((total, row) => total + (row.salesAmount ?? 0), 0);
/**
 * The same tables over HTTP (B09-2 `sales.byMethod`) and with the example data (PAR-1, D-355): the sales by real tender (card, easy pay, cash), the
 * sales by settlement type, and the subtotal of mixed tenders, which overlaps the tender rows and which the owner must not add up (PRD F-287 keeps
 * tender and settlement type apart). The finance service does not split recognized sales by membership source, so those three rows say "집계 없음"
 * over HTTP instead of showing a zero; a summary without the tender split (an archived closing) shows one "not available" row and no subtotal.
 */
export function SalesMethodTables({ view, zerosBelow = false }: { readonly view: ReadyAccountingView; readonly zerosBelow?: boolean }) {
  const { sales } = view.summary;
  const http = view.source === 'http';
  const split = http ? sales.byMethod : sales.byRealMethodSale;
  const methods: readonly AmountRow[] = split ? realMethods.map((method, index) => ({ id: method, label: [ac.cardSale, ac.easyPaySale, ac.cashSale][index]!, amount: split[method] }))
    : [{ id: 'unavailable', label: methodCopy.unavailableLabel, amount: methodCopy.unavailable }];
  const settlement: readonly AmountRow[] = recognitionFields.map(field => ({
    id: field, label: zerosBelow && (field === 'membershipCount' || field === 'subscriptionDaily') ? closingMembershipLabels[field] : ac[field],
    amount: http && (field === 'membershipCount' || field === 'subscriptionDaily' || field === 'membershipExpiry') ? methodCopy.unavailable : sales[field],
  }));
  const mixed = http ? sales.byMethod?.mixed : exampleMixedSales(view);
  const groups = [
    { title: ac.salesMethods, rows: methods },
    { title: ac.settlementSales, rows: settlement },
    { title: methodCopy.overlapTitle, rows: mixed === undefined ? [] : [{ id: 'mixed', label: zerosBelow ? ac.mixed : methodCopy.mixed, amount: mixed }] },
  ];
  const zeros = zerosBelow ? groups.flatMap(group => group.rows.filter(row => row.amount === 0)) : [];
  return <>
    {groups.map(({ title, rows }) => {
      const visible = zerosBelow ? rows.filter(row => row.amount !== 0) : rows;
      return visible.length ? <AmountTable key={title} title={title} rows={visible} /> : null;
    })}
    {zeros.length > 0 ? <dl className="app-closing-sales-notes">{zeros.map(row => <div key={row.id}><dt>{row.label}</dt><dd>{won(0)}</dd></div>)}</dl> : null}
  </>;
}
/** The margin widget's card: the same tender split for the margin period. */
export function SalesMethodCard({ view }: { readonly view: AccountingView | undefined }) {
  if (view?.status !== 'ready') return null;
  return <section className="mm-card" lang="ko" aria-label={methodCopy.marginTitle}><h3 className="mm-card__title">{methodCopy.marginTitle}</h3><SalesMethodTables view={view} /></section>;
}
/** A controlled projection: rendering never creates recognition or calculates financial totals. */
export function SalesDepositSplitCard({ view, onRetry, featureId = 'ledger', stacked = false, showSalesTotal = true, closing = false }: { readonly view: AccountingView; readonly onRetry?: () => void; readonly featureId?: 'ledger' | 'tax'; readonly stacked?: boolean; readonly showSalesTotal?: boolean; readonly closing?: boolean }) {
  const instanceId = useId();
  if (view.status !== 'ready') return <section className="mm-card" lang="ko" aria-label={ac.title}>
    {view.status === 'loading' ? <p role="status" aria-live="polite">{ac.loading}</p> : view.status === 'error' ? <div role="alert"><p>{ac.error}</p>{onRetry ? <ActionButton variant="outline" onClick={onRetry}>{ac.retry}</ActionButton> : null}</div> : <InlineEmpty title={ac[view.status]} />}
  </section>;
  const { sales, deposits } = view.summary;
  const http = view.source === 'http';
  const salesLabel = showSalesTotal ? view.period.start === TODAY && view.period.end === TODAY ? ac.sales : ac.recognized : '매출 계산';
  return <section className={stacked ? "mm-detail" : undefined} tabIndex={stacked ? 0 : undefined} lang="ko" aria-label={ac.title}>
    <div className={stacked ? "mm-detail__overview" : "mm-detail__split"}>
      <section className="mm-card" aria-label={salesLabel}>
        <header className="mm-card__header"><h3 className="mm-card__title">{salesLabel}</h3></header>
        {showSalesTotal && <p className="mm-kpi__value"><ValueSlot slotId={`${featureId}.accounting.${instanceId}.sales`} featureId={featureId} scope="detail" semanticValue={sales.total}><PosMoney amount={sales.total} size="display"/></ValueSlot></p>}
        <SalesMethodTables view={view} zerosBelow={closing} />
        <p className={closing ? 'app-closing-sales-notes' : 'mm-muted'}>{http ? <>{ac.gross} {won(sales.gross)} − {ac.discount} {won(sales.discount)} − {ac.refund} {won(sales.refund)}</> : <>{ac.gross} {won(sales.gross)} − {ac.discount} {won(sales.discount)} − {ac.refund} {won(sales.refund)} + {ac.subscriptionDaily} {won(sales.subscriptionDaily)} + {ac.membershipExpiry} {won(sales.membershipExpiry)} + {ac.customPickup} {won(sales.customPickup)}{view.legacySales !== undefined ? <> + {ac.legacySales} {won(view.legacySales)}</> : null}</>}</p>
      </section>
      <section className="mm-card" aria-label={ac.deposits}>
        <header className="mm-card__header"><h3 className="mm-card__title">{ac.deposits}</h3></header>
        <p className="mm-kpi__value"><ValueSlot slotId={`${featureId}.accounting.${instanceId}.deposits`} featureId={featureId} scope="detail" semanticValue={deposits.total}><PosMoney amount={deposits.total} size="display"/></ValueSlot></p>
        {featureId === 'ledger' && view.depositCoverage?.complete === false && view.depositCoverage.start >= view.period.start && view.depositCoverage.end <= view.period.end ? <p className="mm-muted">{depositCoverageNote(view.depositCoverage.start, view.depositCoverage.end)}</p> : null}
        <AmountTable title={ac.depositMethods} rows={realMethods.map(method => ({ id: method, label: ac[method], amount: deposits.byMethod[method] }))} />
        <AmountTable title={ac.depositPurposes} rows={depositPurposes.map(purpose => ({ id: purpose, label: ac[purpose], amount: deposits.byPurpose[purpose] }))} />
        <dl className="mm-dl"><div><dt>{ac.grossReceived}</dt><dd>{won(deposits.grossReceived)}</dd></div><div><dt>{ac.returned}</dt><dd>{won(deposits.returned)}</dd></div>{deposits.pendingReceived > 0 ? <div><dt>{ac.pendingReceived}</dt><dd>{won(deposits.pendingReceived)}</dd></div> : null}</dl>
      </section>
    </div>
  </section>;
}
/** Over HTTP the rows are every sale without a registered cost (menu or pickup), so the card does not call them pickups. */
const unregisteredCostTitle = '원가가 아직 없는 매출';
export function AccountingUnknownCosts({ rows, http = false }: { readonly rows: readonly AccountingUnknownCost[]; readonly http?: boolean }) {
  if (!rows.length) return null;
  const title = http ? unregisteredCostTitle : customAccountingCopy.title;
  return <section className="mm-card" lang="ko" aria-label={title}><h3 className="mm-card__title">{title}</h3><StatusBadge kind="needsReview" label={customAccountingCopy.unknownCost} /><Table className="mm-table"><thead><tr><th scope="col">{customAccountingCopy.product}</th><th scope="col">{customAccountingCopy.sales}</th><th scope="col">{customAccountingCopy.cost}</th></tr></thead><tbody>{rows.map(row => <tr key={row.recognitionId}><th scope="row">{row.label ?? row.sourceId}</th><td>{won(row.amount)}</td><td>{customAccountingCopy.unknownCost}</td></tr>)}</tbody></Table></section>;
}
/** A reference the owner can read: the service's own ids (`legacy:…`, a bare UUID, or `기록-` + UUID) are never shown (T-25). */
const INTERNAL_REFERENCE = /^(?:legacy:|(?:기록-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$)/i;
const referenceText = (value: string | undefined): string => {
  const text = value?.trim();
  return text && !INTERNAL_REFERENCE.test(text) ? text : '—';
};
export function AccountingTransactions({ rows, onOpenReceipt, showDate = false }: { readonly rows: readonly AccountingTransaction[]; readonly onOpenReceipt?: OpenAccountingReceipt; readonly showDate?: boolean }) {
  const t = useMoneyT();
  const time = (row: AccountingTransaction) => showDate ? t.format.dateTime(row.at) : row.at.slice(11, 16);
  const gridId = useId();
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<GridSort>({ columnId: 'time', direction: 'desc' });
  const [focus, setFocus] = useState<GridFocus>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filtered = rows.filter(row => filter === 'all' || (filter === 'mixed' ? row.methods.length > 1 : filter === 'accounts' ? ['charge_topup', 'receivable_collection', 'membership_sale'].includes(row.purpose) || row.settlementKinds.length > 0 : row.methods.some(split => split.method === filter)));
  const visibleAmount = (row: AccountingTransaction) => realMethods.some(method => method === filter) ? row.methods.find(split => split.method === filter)?.amount ?? 0 : row.amount;
  const ordered = [...filtered].sort((a, b) => {
    const delta = sort?.columnId === 'amount' ? visibleAmount(a) - visibleAmount(b) : a.at.localeCompare(b.at);
    return delta * (sort?.direction === 'asc' ? 1 : -1) || a.id.localeCompare(b.id);
  });
  const open = (row: AccountingTransaction) => { setSelectedId(row.id); onOpenReceipt?.(row); };
  const columns: readonly GridColumn<AccountingTransaction>[] = [
    { id: 'time', header: showDate ? '날짜·시각' : ac.time, kind: 'text', sortable: true, minWidth: layoutTokens.targetDefault * (showDate ? 4 : 2), value: time },
    { id: 'transaction', header: ac.transaction, kind: 'text', minWidth: layoutTokens.targetDefault * 5, value: row => referenceText(row.transactionNo) },
    { id: 'purpose', header: ac.purpose, kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: row => ac[row.purpose] },
    { id: 'amount', header: ac.amount, kind: 'number', sortable: true, minWidth: layoutTokens.targetDefault * 3, value: row => won(visibleAmount(row)) },
    { id: 'recognized', header: ac.recognized, kind: 'number', minWidth: layoutTokens.targetDefault * 3, value: row => row.salesAmount === null ? '—' : won(row.salesAmount) },
    { id: 'method', header: ac.method, kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: row => row.methods.map(split => `${ac[split.method]} ${won(split.amount)}`).join(' · ') || '—' },
    { id: 'settlement', header: ac.settlement, kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: row => row.settlementKinds.map(kind => ac[kind]).join(' · ') || '—' },
    { id: 'status', header: ac.status, kind: 'status', minWidth: layoutTokens.targetDefault * 2, value: row => ac[row.kind] },
    { id: 'original', header: ac.original, kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: row => referenceText(row.originalId) },
  ];
  const visibleColumns = columns.filter(column => ['time', 'purpose', 'amount', 'status'].includes(column.id)
    || filtered.some(row => { const value = column.value(row); return value != null && value !== '' && value !== '—'; }));
  return <DataGrid renderFilters={() => <ChipChoice label={ac.transactions} value={filter} onChange={setFilter} options={['all', ...realMethods, 'accounts', 'mixed'].map(key => ({ value: key, label: ac[key as 'all' | RealMethod | 'accounts' | 'mixed'] }))} />} id={`accounting-transactions-${gridId}`} label={ac.transactions} rows={ordered} getRowId={row => row.id} getRowLabel={row => `${time(row)} ${ac[row.purpose]}`} columns={visibleColumns} sort={sort} onSortChange={setSort} selectedRowId={selectedId} onSelectionChange={onOpenReceipt ? id => { const row = ordered.find(candidate => candidate.id === id); if (row) open(row); } : undefined} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} getRowActions={onOpenReceipt ? row => [{ id: 'receipt', label: ac.openReceipt, onPress: () => open(row) }] : undefined} emptyContent={<InlineEmpty title={ac.emptyTransactions} />} />;
}


const ID = 'ledger' as const;

/**
 * Money writes over HTTP wait for the server receipt (REAL-PLAN F09): `run` returns a Promise there and the sync result in the fixture store.
 * The notice carries the receipt's own undo deadline, so the toast never outlives the server's undo window.
 */
function useMoneyRun(host: WidgetHost) {
  const http = useRealPort()?.mode('money') === 'http';
  const execute = useDataExecute();
  const runLocal = useRunCommand(host);
  return (command: DataCommand, answeredInline?: readonly string[]): DataCommandResult | Promise<DataCommandResult> => {
    if (!http) return runLocal(command, undefined, answeredInline);
    return execute(command).then(result => {
      if (result.ok) {
        const until = result.value && typeof result.value === 'object' && 'undoUntil' in result.value && typeof result.value.undoUntil === 'string' ? result.value.undoUntil : undefined;
        if (result.noticeKey && !result.duplicate) host.notify({ kind: 'success', messageKey: result.noticeKey, ...(result.undoToken ? { undoToken: result.undoToken } : {}), ...(until && result.undoToken ? { undoUntil: until } : {}) });
      } else if (!(result.reason && answeredInline?.includes(result.reason))) host.notify({ kind: 'error', messageKey: result.messageKey });
      return result;
    });
  };
}
const FORM_CATEGORIES: readonly ExpenseCategory[] = ['ingredients', 'operations', 'supplies', 'other'];
const EVIDENCES: readonly Evidence[] = ['receipt', 'tax-invoice', 'card', 'none'];
/** Closing status is the final optional slot (SCR-212). */
export const LEDGER_FIT = [{ selector: '.mm-chart' }, ...MONEY_FIT, { selector: '.mm-primary > [data-slot-id="ledger.dashboard.closing"]' }] as const;

function compareText(t: T, model: LedgerModel): string | undefined {
  const c = model.comparison;
  if (!c || (model.period.start === model.period.end && model.sales.net === 0)) return undefined;
  const delta = t.format.delta(c.delta.value, 'percent');
  return t(model.period.start === model.period.end ? 'widget.ledger.vsWeek' : 'widget.ledger.vsPrev', { delta });
}
function labelOf(t: T, model: LedgerModel): string {
  return model.period.start === model.period.end ? t('widget.ledger.todaySales') : t('widget.ledger.salesIn', { period: dateRangeWithWeekdays(t, model.period.start, model.period.end) });
}
const trendChart = (t: T, points: LedgerModel['trend'], title: string, fields: readonly ('net' | 'expenses' | 'netProfit')[]): ChartData => ({
  values: points.map(point => point[fields[0]!]), dates: points.map(point => point.date),
  labels: points.map(point => t.format.date(point.date, 'short')), kind: 'bar', ariaLabel: title, format: n => t.format.money(n, 'compact'),
  series: fields.map(id => ({ id, label: t(id === 'net' ? 'widget.ledger.sales' : id === 'expenses' ? 'widget.ledger.expenses' : 'widget.ledger.remaining'), values: points.map(point => point[id]) })),
});

type LedgerTab = 'sales' | 'expenses' | 'profit';
type LedgerSnapshot = ReturnType<ReturnType<typeof useWidgetDataStore>['getSnapshot']>;

/** Today's profit by hour: sales so far minus the day's recorded expenses (expense records carry a date, not a time), so the last bar equals the profit figure. */
function hourlyProfit(model: LedgerModel, snapshot: LedgerSnapshot) {
  let running = -model.expenses.total;
  return selectHourlySales(snapshot, { date: model.period.start }).map(({ hour, amount }) => ({ hour, amount: running += amount }));
}

function singleDayChart(t: T, model: LedgerModel, tab: LedgerTab, title: string, snapshot: LedgerSnapshot): ChartData {
  const hourLabel = (hour: number) => t('widget.ledger.hour', { hour });
  const points = tab === 'sales' ? selectHourlySales(snapshot, { date: model.period.start, includeElapsedStoreHours: true }).map(({ hour, amount }) => ({ label: hourLabel(hour), amount }))
    : tab === 'expenses' ? model.expenses.byCategory.map(({ categoryKey, amount }) => ({ label: t(categoryKey), amount }))
      : hourlyProfit(model, snapshot).map(({ hour, amount }) => ({ label: hourLabel(hour), amount }));
  const id = tab === 'sales' ? 'net' : tab === 'expenses' ? 'expenses' : 'netProfit';
  const values = points.map(point => point.amount);
  return {
    kind: 'bar', ariaLabel: title, format: n => t.format.money(n, 'compact'),
    labels: points.map(point => point.label), values, allLabels: true, valueLabels: true,
    series: [{ id, label: t(tab === 'profit' ? 'widget.ledger.remaining' : `widget.ledger.${tab}`), values }],
  };
}

function LedgerDetailChart({ data }: { data: ChartData }) {
  if (!data.valueLabels) return <MiniSeries data={data} className="mm-chart--detail" />;
  return <div className="mm-ledger-chart" style={{ '--ledger-chart-columns': data.values.length } as CSSProperties}>
    <MiniSeries data={data} className="mm-chart--detail mm-chart--labeled" />
  </div>;
}

function buildSpec(t: T, model: LedgerModel, notes: ReactNode, shape: string, closed: boolean, height = 2): PanelSpec {
  const formattedSales = splitMoney(t, model.sales.net);
  const sales = t.locale === 'en' && formattedSales.value.startsWith('₩')
    ? { value: formattedSales.value.slice(1), unit: '₩' }
    : formattedSales;
  const expensesRow: RowData = { id: 'expenses', name: t('widget.ledger.expenses'), value: t.format.money(model.expenses.total, 'compact'), semanticValue: model.expenses.total };
  const remainingRow: RowData = model.remaining === null
    ? { id: 'remaining', name: t('widget.ledger.remaining'), value: t('data.state.ledger.no-expenses') }
    : { id: 'remaining', name: t('widget.ledger.remaining'), value: t.format.money(model.remaining, 'compact'), semanticValue: model.remaining };
  const categories: RowData[] = model.expenses.byCategory.map((c) => ({ id: c.category, name: t(c.categoryKey), value: t.format.money(c.amount, 'compact'), semanticValue: c.amount }));
  const rate: RowData = { id: 'profitRate', name: t('widget.ledger.profitRate'), value: model.profitRate == null ? '–' : `${model.profitRate.toFixed(1)}%`, semanticValue: model.profitRate };
  const methods: RowData[] = (['card', 'easyPay', 'cash'] as const).map(method => ({ id: method, name: t(`widget.ledger.method.${method}`), value: t.format.money(model.sales.byMethod[method], 'compact'), semanticValue: model.sales.byMethod[method], badge: closed ? <StatusBadge kind="confirmed" /> : undefined }));
  // D-333: a card 4 rows high has room for the sale totals the model holds that the short cards leave to the detail (what was paid, the discount, the refund: each only when it is above 0)
  // and, when the day's expenses fall in two or more categories, their split (one category would only repeat the expenses row). The fit guard drops what does not fit.
  const tall = shape === 'L' && height >= 4;
  const split = model.expenses.byCategory.filter((c) => c.amount > 0);
  const saleRows: RowData[] = tall ? [
    { id: 'gross', name: t('widget.ledger.gross'), value: t.format.money(model.sales.gross, 'compact'), semanticValue: model.sales.gross },
    ...(model.sales.discount > 0 ? [{ id: 'discount', name: t('widget.ledger.discount'), value: t.format.money(model.sales.discount, 'compact'), semanticValue: model.sales.discount }] : []),
    ...(model.sales.refund > 0 ? [{ id: 'refund', name: t('widget.ledger.refund'), value: t.format.money(model.sales.refund, 'compact'), semanticValue: model.sales.refund }] : []),
  ] : [];
  const categoryRows: RowData[] = tall && split.length >= 2 ? split.map((c) => ({ id: `category-${c.category}`, name: `${t(c.categoryKey)} ${t('widget.ledger.expenses')}`, value: t.format.money(c.amount, 'compact'), semanticValue: c.amount })) : [];
  const rows = shape === 'T' ? categories : shape === 'W' ? [expensesRow, remainingRow, rate] : shape === 'S' ? [expensesRow, remainingRow, rate] : [expensesRow, remainingRow, rate, ...(model.sales.byMethodKnown === false ? [] : methods), ...saleRows, ...categoryRows];
  const missing = model.missingEvidenceCount > 0 ? <span className="mm-note"><StatusBadge kind="needsReview" label={t('widget.ledger.missingEvidence', { n: model.missingEvidenceCount })} /></span> : null;
  return {
    slot: ID, label: labelOf(t, model), value: sales.value, semanticValue: model.sales.net, unit: sales.unit, unitPlacement: t.locale === 'en' ? 'before' : undefined, sub: compareText(t, model), rows, rowsTitle: shape === 'T' ? t('widget.ledger.byCategory') : undefined, fitOrder: LEDGER_FIT,
    chart: shape === 'L' ? trendChart(t, model.trend.slice(-7), t('widget.ledger.weekComparison'), ['net', 'expenses']) : undefined, tightT: 2, tightL: true, permanent: <ValueSlot slotId="ledger.dashboard.closing" featureId={ID} scope="dashboard" semanticValue={closed}>{t(closed ? 'widget.ledger.closed' : 'widget.ledger.beforeClosing')}</ValueSlot>, status: <>{missing}{notes}</>,
  };
}

export function LedgerPanel(props: WidgetPanelProps) {
  const t = useMoneyT();
  const ctx = useSizeCtx(props);
  const store = useWidgetDataStore();
  const view = useWidgetView(ID, props.condition);
  const retry = useRealRetry('money');
  const http = useRealPort()?.mode('money') === 'http';
  if (view.status !== 'ready' && view.messageKey === 'data.real.loading') return <p className="mm-ledger-loading" role="status"><Spinner /> {t('widget.ledger.loading')}</p>;
  if (view.status !== 'ready') return <ViewState view={view} ctx={ctx} host={props.host} featureId={ID} t={t} onRetry={http ? retry : undefined} message={view.status === 'error' ? t('widget.ledger.loadError') : undefined} />;
  return <MoneyPanel spec={buildSpec(t, view.model, <NoteLine notes={view.notes} t={t} />, ctx.shape, selectClosing(store.getSnapshot(), { date: TODAY, scenario: 'normal' }).status === 'closed', ctx.height)} ctx={ctx} />;
}

export function useLedgerSummary({ condition }: { featureId: unknown; condition: QueryCondition }): string {
  const t = useMoneyT();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return t(view.messageKey);
  const label = labelOf(t, view.model), amount = t.format.money(view.model.sales.net, 'compact'), compare = compareText(t, view.model);
  return compare ? t('widget.ledger.summary', { label, amount, compare }) : t('widget.ledger.summaryPlain', { label, amount });
}

/* ---------- detail ---------- */
type PeriodKey = 'today' | 'last7' | 'last30' | 'month';
const PERIODS: readonly PeriodKey[] = ['today', 'last7', 'last30', 'month'];
const conditions = supportedConditions(ID);
const conditionFor = (p: PeriodKey): QueryCondition => conditions[PERIODS.indexOf(p)] ?? conditions[0]!;
function periodOf(condition: QueryCondition): PeriodKey {
  const index = conditions.findIndex((c) => c.kind === condition.kind && (c.kind !== 'dateRange' || (condition.kind === 'dateRange' && c.start === condition.start && c.end === condition.end)));
  return PERIODS[Math.max(0, index)] ?? 'today';
}

export function LedgerDetail({ condition, host, detailRef, accounting: explicitAccounting, onOpenAccountingReceipt }: AccountingDetailProps) {
  const t = useMoneyT(), { t: posT } = useBundle(posBundle);
  const [period, setPeriod] = useState<PeriodKey>(() => periodOf(condition));
  const expenseView = detailRef.view === 'expenses' || detailRef.view === 'candidates' || detailRef.view === 'evidence';
  const [tab, setTab] = useState<LedgerTab>(() => expenseView ? 'expenses' : detailRef.view === 'profit' ? 'profit' : 'sales');
  const store = useWidgetDataStore();
  const view = useWidgetView(ID, conditionFor(period));
  const retry = useRealRetry('money');
  const http = useRealPort()?.mode('money') === 'http';
  const onRetry = http ? retry : host.resetPreview;
  const presentation = useAccountingPresentation();
  const run = useMoneyRun(host);
  const [confirming, setConfirming] = useState<ReadonlySet<string>>(new Set());
  const [formOpen, setFormOpen] = useState(() => expenseView && detailRef.focus === 'action');
  const prefill = detailRef.focus === 'action' ? moneyDetailPrefill(detailRef) : undefined;
  const openButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(new Set<string>());
  const periodChips = (
    <ChipChoice label={t('widget.ledger.periodLabel')} value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: t(PERIOD_KEYS[p]) }))} />
  );
  const widerPeriod = PERIODS[PERIODS.indexOf(period) + 1];
  if (view.status !== 'ready') return <div className="mm-detail" data-widget={ID}>{periodChips}<DetailViewState view={view} host={host} t={t} onRetry={onRetry}
    message={view.status === 'error' ? t('widget.ledger.loadError') : view.messageKey === 'data.real.loading' ? t('widget.ledger.loading') : undefined}
    nextAction={widerPeriod && period === 'today' && view.messageKey !== 'data.real.loading' ? { label: t('widget.ledger.seePeriod', { period: t(PERIOD_KEYS[widerPeriod]) }), onPress: () => setPeriod(widerPeriod) } : undefined} /></div>;
  const m = view.model;
  const accounting = accountingForPeriod(presentation, m.period, explicitAccounting);
  const money = (n: number) => t.format.money(n, 'compact');
  const full = (n: number) => t.format.money(n, 'full');
  const recognizedSales = accounting ? accounting.status === 'ready' ? accounting.summary.sales.total : null : m.sales.net;
  const sales = recognizedSales === null ? { value: '—', unit: '' } : splitFormatted(full(recognizedSales)), expenses = splitMoney(t, m.expenses.total);
  const remaining = m.remaining === null ? null : splitMoney(t, m.remaining);
  const compare = compareText(t, m);
  const snapshot = store.getSnapshot();
  const closed = selectClosing(snapshot, { date: TODAY, scenario: 'normal' }).status === 'closed';
  const singleDay = m.period.start === m.period.end;
  const chartTitle = t(tab === 'sales' ? 'widget.ledger.periodSales'
    : tab === 'expenses' ? (singleDay ? 'widget.ledger.expensesByItem' : 'widget.ledger.periodExpenses')
      : (singleDay ? 'widget.ledger.hourlyProfit' : 'widget.ledger.periodProfit'));
  // The category card belongs to the expense tab (SCR-217); on a single day the bars already are the categories.
  const showCategories = tab === 'expenses' && !singleDay;
  const chart = singleDay ? singleDayChart(t, m, tab, chartTitle, snapshot) : {
    ...trendChart(t, m.periodTrend, chartTitle, [tab === 'sales' ? 'net' : tab === 'expenses' ? 'expenses' : 'netProfit']),
    allLabels: tab === 'sales' || m.periodTrend.length <= 7, valueLabels: tab === 'sales',
  };
  const comparisonTitle = t('widget.ledger.comparisonChart');
  const confirmCandidate = (expenseId: string) => {
    if (pending.current.has(expenseId)) return;
    pending.current.add(expenseId);
    const settle = () => { pending.current.delete(expenseId); setConfirming(current => { const next = new Set(current); next.delete(expenseId); return next; }); };
    const outcome = run({ type: 'ledger.confirmCandidate', expenseId });
    if (outcome instanceof Promise) { setConfirming(current => new Set(current).add(expenseId)); void outcome.finally(settle); } else settle();
  };
  const hasGrid = tab === 'sales' || (tab === 'expenses' && m.expenses.items.length > 0);
  return (
    <div className={`mm-detail${hasGrid ? ' mm-detail--grid' : ''}`} data-widget={ID}>
      <DetailTabs value={tab} onValueChange={setTab} label={t('widget.ledger.tabs')} tabs={[{ value: 'sales', label: t('widget.ledger.tabSales') }, { value: 'expenses', label: t('widget.ledger.tabExpenses') }, { value: 'profit', label: t('widget.ledger.profitTab') }]} />
      <section className="mm-detail__overview" tabIndex={hasGrid ? 0 : undefined} aria-label={t('widget.ledger.title')}>
        <div className="mm-detail__tools">{periodChips}</div>
        <div className="mm-kpis" data-slot="ledger.kpis">
          <Kpi
            slot="ledger.kpi.sales"
            label={labelOf(t, m)}
            value={sales.value}
            unit={sales.unit}
            semanticValue={recognizedSales}
            details={<>
              <ActionButton id="ledger.closing.status" data-focus-key="ledger.closing.status" variant="outline" aria-label={`${t(closed ? 'widget.ledger.closed' : 'widget.ledger.beforeClosing')}, ${t('widget.ledger.openClosing')}`} onClick={() => host.openClosing('ledger.closing.status')}>
                <Icon name={closed ? 'check' : 'clock'} aria-hidden />
                <ValueSlot slotId="ledger.detail.closing" featureId={ID} scope="detail" semanticValue={closed}>{t(closed ? 'widget.ledger.closed' : 'widget.ledger.beforeClosing')}</ValueSlot>
              </ActionButton>
              {compare ? <p className="mm-detail__note">{compare}</p> : null}
            </>}
          />
          <Kpi slot="ledger.kpi.expenses" label={t('widget.ledger.totalExpenses')} value={expenses.value} unit={expenses.unit} semanticValue={m.expenses.total} />
          <Kpi slot="ledger.kpi.remaining" label={t('widget.ledger.remaining')} value={remaining ? remaining.value : t('data.state.ledger.no-expenses')} unit={remaining?.unit} semanticValue={m.remaining} />
          <Kpi slot="ledger.kpi.missing" label={t('widget.ledger.missingEvidenceLabel')} value={String(m.missingEvidenceCount)} unit={t.locale === 'ko' ? '건' : undefined} semanticValue={m.missingEvidenceCount} tone={m.missingEvidenceCount > 0 ? 'warning' : undefined} />
        </div>
        <div className={`mm-detail__split${singleDay && tab === 'sales' ? ' mm-ledger-today-sales' : ''}${showCategories ? '' : ' mm-detail__split--single'}`}>
          <section className="mm-card" aria-label={chartTitle}>
            <h3 className="mm-card__title" lang="ko">{chartTitle}</h3>
            {chart.values.length ? <LedgerDetailChart data={chart} /> : <p className="mm-muted">{t(tab === 'expenses' ? 'widget.ledger.noExpenseRows' : 'data.state.ledger.no-sales')}</p>}
          </section>
          {showCategories ? <section className="mm-card" aria-label={t('widget.ledger.detailCategories')}>
            <h3 className="mm-card__title" lang="ko">{t('widget.ledger.detailCategories')}</h3>
            {m.expenses.byCategory.length === 0 ? null : (
              <ul className="mm-plain-list">{m.expenses.byCategory.map((c) => <li key={c.category} data-row-id={c.category}><span>{t(c.categoryKey)}</span><strong><ValueSlot slotId={`ledger.detail.category.${c.category}`} featureId={ID} scope="detail" semanticValue={c.amount}>{money(c.amount)}</ValueSlot></strong></li>)}</ul>
            )}
          </section> : null}
        </div>
        {tab === 'sales' ? (
          <>{accounting ? <SalesDepositSplitCard view={accounting} showSalesTotal={false} onRetry={presentation?.onRetry ?? onRetry} /> : <><p lang="ko">{posT('pos.salesCalculation', { gross: money(m.sales.gross), discount: money(m.sales.discount), refund: money(m.sales.refund) })}</p> <ActionButton id="ledger.closing" data-focus-key="ledger.closing" variant="outline" onClick={() => host.openClosing('ledger.closing')}>{t('widget.briefing.closingAction')}</ActionButton><Table className="mm-table" data-slot="ledger.sales-summary">
            <tbody>
              <tr><th scope="row">{t('widget.ledger.gross')}</th><td>{full(m.sales.gross)}</td></tr>
              <tr><th scope="row">{t('widget.ledger.discount')}</th><td>{full(-m.sales.discount)}</td></tr>
              <tr><th scope="row">{t('widget.ledger.refund')}</th><td>{full(-m.sales.refund)}</td></tr>
              <tr className="mm-table__total"><th scope="row">{t('widget.ledger.net')}</th><td>{full(m.sales.net)}</td></tr>
            </tbody>
          </Table><Table className="mm-table mm-sales-methods" data-slot="ledger.sales-table"><caption className="mm-table__caption" lang="ko">{t('widget.ledger.methodSales')}</caption>
            <tbody>
              {(['card', 'easyPay', 'cash'] as const).map((method) => <tr key={method} data-row-id={method}><th scope="row">{t(`widget.ledger.method.${method}`)}{closed ? <StatusBadge kind="confirmed" /> : null}</th><td><ValueSlot slotId={`ledger.detail.method.${method}`} featureId={ID} scope="detail" semanticValue={m.sales.byMethod[method]}>{full(m.sales.byMethod[method])}</ValueSlot></td></tr>)}
            </tbody>
          </Table><CustomSalesBreakdown period={m.period} /></>}</>
        ) : tab === 'profit' ? <section className="mm-card">
          <Kpi slot="ledger.profit" label={t('widget.ledger.totalProfit')} value={remaining?.value ?? t('data.state.ledger.no-expenses')} unit={remaining?.unit} semanticValue={m.remaining} />
          <Kpi slot="ledger.profitRate" label={t('widget.ledger.profitRate')} value={m.profitRate == null ? '–' : `${m.profitRate.toFixed(1)}%`} semanticValue={m.profitRate} />
          <section aria-label={comparisonTitle}>
            <h3 lang="ko">{comparisonTitle}</h3>
            <LedgerDetailChart data={{
              ...trendChart(t, m.periodTrend, comparisonTitle, ['net', 'expenses']),
              allLabels: m.periodTrend.length <= 7, valueLabels: singleDay,
            }} />
          </section>
        </section> : (
          <div className="mm-expenses">
            <div className="mm-expenses__bar">
              <ActionButton ref={openButton} variant="secondary" onClick={() => setFormOpen(true)} aria-expanded={formOpen}>{t('common.recordExpense')}</ActionButton>
            </div>
            {formOpen ? <ExpenseForm t={t} onClose={() => setFormOpen(false)} run={run} returnFocus={openButton} prefill={prefill} /> : null}
            {m.candidates.length > 0 ? (
              <section className="mm-card" aria-label={t('widget.ledger.candidates')}>
                <h3 className="mm-card__title" lang="ko">{t('widget.ledger.candidates')}</h3>
                <p className="mm-muted">{t('widget.ledger.candidateHint')}</p>
                <ul className="mm-plain-list">
                  {m.candidates.map((c) => (
                    <li key={c.expenseId} data-row-id={c.expenseId} data-slot="ledger.candidate">
                      <span className="mm-plain-list__text"><StatusBadge kind="suggested" label={t('widget.ledger.candidateTag')} /> {c.supplierNameKey ? t(c.supplierNameKey) : t(c.categoryKey)}{'\u00A0'}· {t.format.date(c.date, 'short')}</span>
                      <strong>{full(c.amount)}</strong>
                      <ActionButton variant="outline" autoFocus={c.expenseId === detailRef.itemId} disabled={confirming.has(c.expenseId)} onClick={() => confirmCandidate(c.expenseId)}>{t('widget.ledger.confirmCandidate')}</ActionButton>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {m.expenses.items.length === 0 ? <p className="mm-muted">{t('widget.ledger.noExpenseRows')}</p> : null}
          </div>
        )}
      </section>
      {tab === 'sales' ? <div className="mm-detail__grid">{accounting ? accounting.status === 'ready' ? <AccountingTransactions rows={accounting.transactions} showDate={!singleDay} onOpenReceipt={onOpenAccountingReceipt ?? presentation?.onOpenReceipt} /> : null : <PaymentGrid t={t} snapshot={store.getSnapshot()} />}</div> : tab === 'expenses' && m.expenses.items.length > 0 ? <div className="mm-detail__grid"><ExpenseGrid t={t} rows={m.expenses.items} itemId={detailRef.itemId} /></div> : null}
    </div>
  );
}

function ExpenseForm({ t, onClose, run, returnFocus, prefill }: {
  readonly t: T; readonly onClose: () => void; readonly run: ReturnType<typeof useMoneyRun>;
  readonly returnFocus: RefObject<HTMLElement | null>; readonly prefill?: NonNullable<ReturnType<typeof moneyDetailPrefill>>;
}) {
  const [date, setDate] = useState<string | null>(() => typeof prefill?.date === 'string' && prefill.date <= TODAY ? prefill.date : TODAY);
  const [category, setCategory] = useState<ExpenseCategory>(() => FORM_CATEGORIES.find(value => value === prefill?.category) ?? 'ingredients');
  const [amount, setAmount] = useState<number | null>(() => typeof prefill?.amount === 'number' ? prefill.amount : null);
  const [merchant, setMerchant] = useState('');
  const [memo, setMemo] = useState(() => typeof prefill?.memo === 'string' ? prefill.memo : '');
  const [evidence, setEvidence] = useState<Evidence>(() => EVIDENCES.find(value => value === prefill?.evidence) ?? 'receipt');
  const [error, setError] = useState<string | undefined>();
  const [dateError, setDateError] = useState<string | undefined>();
  const [existing, setExisting] = useState<{ readonly message: string; readonly date: string; readonly category: string; readonly amount: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const earliest = useMemo(() => addIsoDays(TODAY, -30), []);
  const [review, setReview] = useState<Record<ReceiptField, boolean> | null>(null);
  const receiptEdits = useRef(new Set<ReceiptField>());
  /** Any edit makes the earlier answer (a look-alike, a future date) stale. */
  const edited = (field?: ReceiptField) => {
    if (field) {
      receiptEdits.current.add(field);
      setReview(current => current?.[field] ? { ...current, [field]: false } : current);
    }
    setError(undefined);
    setDateError(undefined);
    setExisting(null);
  };
  const save = (confirmDuplicate = false) => {
    if (busy.current) return;
    if (!date) { setDateError(t('data.error.dateInvalid')); return; }
    if (amount === null || !Number.isInteger(amount) || amount <= 0) { setError(t('data.error.amountInvalid')); return; }
    busy.current = true;
    setSaving(true);
    // Receipt text has no supplier or inventory receipt ID. Store only the owner-confirmed memo.
    const confirmedMemo = [merchant.trim(), memo.trim()].filter(Boolean).join(' · ');
    const settle = (result: DataCommandResult) => {
      if (result.ok) { onClose(); return; }
      if (result.reason === 'EXPENSE_DATE_FUTURE') { edited(); setDateError(t(result.messageKey)); }
      else if (result.reason === 'LIKELY_DUPLICATE_EXPENSE' && result.details) {
        const found = result.details as { readonly date: string; readonly category: string; readonly amount: number };
        edited(); setExisting({ message: t(result.messageKey), date: found.date, category: found.category, amount: found.amount });
      } else setError(t(result.messageKey));
      busy.current = false;
      setSaving(false);
    };
    const outcome = run({ type: 'ledger.recordExpense', date, category, amount, evidence, ...(confirmedMemo ? { memo: confirmedMemo } : {}), ...(confirmDuplicate ? { confirmDuplicate: true } : {}) }, ['EXPENSE_DATE_FUTURE', 'LIKELY_DUPLICATE_EXPENSE']);
    // Over HTTP the form stays pending (and a second press is ignored) until the server's receipt arrives.
    if (outcome instanceof Promise) void outcome.then(settle); else settle(outcome);
  };
  const manualDate = date ?? TODAY;
  return (
    <InlineForm title={t('common.recordExpense')} onSave={() => save()} onClose={onClose} saving={saving} returnFocusRef={returnFocus}>
      <ReceiptScanEntry t={t} onScanStart={() => receiptEdits.current.clear()} onRecognized={values => {
        const preserved = receiptEdits.current;
        if (!preserved.has('date')) setDate(values.date);
        if (!preserved.has('amount')) setAmount(values.amount);
        if (!preserved.has('merchant')) setMerchant(values.merchant);
        if (!preserved.has('memo')) setMemo(values.memo);
        if (!preserved.has('evidence')) setEvidence('receipt');
        const nextReview: Record<ReceiptField, boolean> = { ...values.review };
        for (const field of preserved) nextReview[field] = true;
        setReview(nextReview);
        edited();
      }} />
      {review ? <ReceiptReviewField locale={t.locale} review={review.date}>
        {hint => <DateField name="expense-date" label={t('widget.ledger.field.date')} value={date} onValueChange={value => { setDate(value); edited('date'); }}
          today={TODAY} max={TODAY} required error={dateError} hint={hint} />}
      </ReceiptReviewField> : <div className="ui-field" data-invalid={dateError ? 'true' : undefined}>
        <DateStepper label={t('widget.ledger.field.date')} text={t.format.date(manualDate, 'long')} onPrevious={() => { setDate(addIsoDays(manualDate, -1)); edited('date'); }} onNext={() => { setDate(addIsoDays(manualDate, 1)); edited('date'); }} previousDisabled={manualDate <= earliest} nextDisabled={manualDate >= TODAY} />
        {dateError ? <p className="ui-field__error" role="alert" data-slot="ledger.dateError"><Icon name="error" />{dateError}</p> : null}
      </div>}
      <ChipChoice label={t('widget.ledger.field.category')} value={category} onChange={(v) => { setCategory(v); edited(); }} options={FORM_CATEGORIES.map((c) => ({ value: c, label: t(`data.expenseCategory.${c}`) }))} />
      <ReceiptReviewField locale={t.locale} review={review?.amount}>
        {hint => <NumberField name="expense-amount" label={t('widget.ledger.field.amount')} value={amount} onValueChange={value => { setAmount(value); edited('amount'); }}
          min={1} unit={t('widget.ledger.currency')} error={error} hint={hint} />}
      </ReceiptReviewField>
      <ReceiptReviewField locale={t.locale} review={review?.merchant}>
        {hint => <TextField name="expense-merchant" label={t('widget.ledger.field.supplier')} value={merchant} onValueChange={value => { setMerchant(value); edited('merchant'); }} hint={hint} />}
      </ReceiptReviewField>
      <ReceiptReviewField locale={t.locale} review={review?.memo}>
        {hint => <TextField name="expense-memo" label={t('widget.ledger.field.memo')} value={memo} onValueChange={value => { setMemo(value); edited('memo'); }} hint={hint} />}
      </ReceiptReviewField>
      <ReceiptReviewField locale={t.locale} review={review?.evidence} groupLabel={t('widget.ledger.field.evidence')}>
        {() => <ChipChoice label={t('widget.ledger.field.evidence')} value={evidence} onChange={value => { setEvidence(value); edited('evidence'); }} options={EVIDENCES.map((e) => ({ value: e, label: e === 'receipt' ? t('widget.ledger.evidenceReceipt') : t(`data.evidence.${e}`) }))} />}
      </ReceiptReviewField>
      {existing ? <div className="mm-field-answer" role="alert" data-slot="ledger.duplicate">
        <p className="mm-field-answer__text"><Icon name="warning" aria-hidden />{existing.message}</p>
        <p className="mm-muted" data-slot="ledger.existing">{t('widget.ledger.existingExpense', { date: t.format.date(existing.date, 'short'), category: t(`data.expenseCategory.${existing.category}`), amount: t.format.money(existing.amount, 'full') })}</p>
        <ActionButton variant="secondary" disabled={saving} onClick={() => save(true)}>{t('widget.ledger.recordAnyway')}</ActionButton>
      </div> : null}
      {t.locale !== 'ko' ? <p className="mm-muted">{t('widget.ledger.recordedNote')}</p> : null}
    </InlineForm>
  );
}

export const ledgerModule: WidgetModule = { id: ID, Panel: LedgerPanel, Detail: LedgerDetail, useSummary: useLedgerSummary };

function PaymentGrid({ t, snapshot }: { t: T; snapshot: ReturnType<ReturnType<typeof useWidgetDataStore>['getSnapshot']> }) {
  const [sort, setSort] = useState<GridSort>(null);
  const [focus, setFocus] = useState<GridFocus>(null);
  const sortField = sort?.columnId === 'amount' ? 'amount' : sort?.columnId === 'method' ? 'method' : sort?.columnId === 'status' ? 'status' : 'time';
  const rows = selectPayments(snapshot, { date: TODAY, scenario: 'normal', sort: { field: sortField, direction: sort?.direction ?? 'desc' } }).rows;
  type Row = typeof rows[number];
  const content = (p: Row) => {
    const lines = p.lines.map(line => {
      const menu = snapshot.tables.menuItem.find(item => item.menuId === line.menuId);
      return menu ? `${resolveDataText(t, menu.name ?? { key: menu.nameKey })} ${line.qty}` : null;
    });
    return lines.length && lines.every(line => line !== null) ? lines.join(', ') : resolveDataText(t, p.summary);
  };
  const columns: GridColumn<Row>[] = [
    { id: 'time', header: t('widget.ledger.paymentTime'), kind: 'text', sortable: true, minWidth: 120, value: p => p.time },
    { id: 'amount', header: t('widget.ledger.paymentAmount'), kind: 'number', sortable: true, minWidth: 140, value: p => t.format.money(p.net, 'full') },
    { id: 'method', header: t('widget.ledger.paymentMethod'), kind: 'text', sortable: true, minWidth: 120, value: p => t(`widget.ledger.method.${p.method === 'easy_pay' ? 'easyPay' : p.method}`) },
    { id: 'content', header: t('widget.ledger.paymentContent'), kind: 'text', minWidth: 180, value: content, render: p => { const text = content(p); return <span lang={copyLang(text)}>{text}</span>; } },
    { id: 'status', header: t('widget.ledger.paymentStatus'), kind: 'status', sortable: true, minWidth: 100, value: p => t(p.kind === 'refund' ? 'widget.ledger.paymentRefund' : 'widget.ledger.paymentDone') },
  ];
  return <DataGrid id="ledger-payments" label={t('widget.ledger.paymentList')} rows={rows} getRowId={p => p.paymentId} getRowLabel={p => p.time} columns={columns} sort={sort} onSortChange={setSort} focus={focus} onFocusChange={setFocus} selectedRowId={null} expandedRowIds={new Set()} emptyContent={t('data.state.ledger.no-sales')} />;
}

function ExpenseGrid({ t, rows, itemId }: { t: T; rows: readonly LedgerExpenseRow[]; itemId?: string }) {
  const [sort, setSort] = useState<GridSort>(null), [focus, setFocus] = useState<GridFocus>(() => itemId ? { rowId: itemId, columnId: 'category' } : null);
  const columns: GridColumn<LedgerExpenseRow>[] = [
    { id: 'date', header: t('widget.ledger.field.date'), kind: 'text', minWidth: 130, value: e => t.format.date(e.date, 'short') },
    { id: 'category', header: t('widget.ledger.expenseCategoryHeader'), kind: 'text', minWidth: 140, value: e => t(e.categoryKey) },
    { id: 'amount', header: t('widget.ledger.field.amount'), kind: 'number', minWidth: 140, value: e => t.format.money(e.amount, 'full'), render: e => <ValueSlot slotId={`ledger.detail.expense.${e.expenseId}.amount`} featureId={ID} scope="detail" semanticValue={e.amount}>{t.format.money(e.amount, 'full')}</ValueSlot> },
    { id: 'supplier', header: t('widget.ledger.field.supplier'), kind: 'text', minWidth: 140, value: e => e.supplierNameKey ? t(e.supplierNameKey) : '–' },
    { id: 'memo', header: t('widget.ledger.expenseMemoHeader'), kind: 'text', minWidth: 180, value: e => e.memo ? ('raw' in e.memo ? e.memo.raw : t(e.memo.key, e.memo.params)) : t('widget.ledger.noMemo') },
    { id: 'evidence', header: t('widget.ledger.field.evidence'), kind: 'text', minWidth: 120, value: e => t(e.evidenceKey) },
  ];
  return <DataGrid id="ledger-expenses" label={t('widget.ledger.expenseList')} rows={rows} getRowId={e => e.expenseId} getRowLabel={e => t(e.categoryKey)} columns={columns} sort={sort} onSortChange={setSort} selectedRowId={null} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} emptyContent={t('widget.ledger.noExpenseRows')} />;
}
