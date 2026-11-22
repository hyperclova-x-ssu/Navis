/** 세무관리 (SCR-219): POS payment records, review and accountant data. */
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { DetailRef, QueryCondition, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useDomainState, useRealRetry, useWidgetView } from '../../../data/react';
import { resolveDataText, TODAY, supportedConditions, type TaxItemRow, type TaxModel } from '../../../data/widget-data';
import { ActionButton, AnchoredPopover, ChipChoice, DataGrid, DateField, DetailDialog, DetailTabs, Icon, InlineForm, MasterDetail, NumberField, StatusBadge, StatusChip, Table, TextField, type GridAction, type GridColumn, type GridFocus, type GridSort, type DataGridHandle } from '../../../ui';
import { compareTaxDue, selectNextTaxPayment } from '../../../data/commands/management-guards';
import type { FitPart } from './fit';
import { DetailViewState, Kpi, MoneyPanel, MONEY_FIT, NoteLine, ViewState, splitMoney, useMoneyT, useRunCommand, useSizeCtx, type PanelSpec, type RowData, type T } from './shared';

import { accountingForPeriod, SalesDepositSplitCard, useAccountingPresentation, type AccountingDetailProps } from './ledger';
import { accountingCopy } from './iteration7-accounting-messages';
import { moneyDetailPrefill } from '../../assistant/domains/money';
import { useRunTaxCommand } from './tax.commands';
import { useTaxCopy } from './tax.copy';
import { TaxEvidence } from './tax.evidence';
import { TaxExportActions } from './tax.export';
import { downloadTaxFile } from './tax.file';
import { commandFailureText } from '../../../data/commands/failure-copy';
import { dateRangeWithWeekdays } from '../date-range';

const ID = 'tax' as const;

function memoText(t: T, item: TaxItemRow): string {
  return item.memo ? ('raw' in item.memo ? item.memo.raw : t(item.memo.key, item.memo.params)) : t(item.categoryKey);
}
/** `{category} · {memo}`; an item without its own memo (or one that repeats the category) shows the category once. */
function itemTitle(t: T, item: TaxItemRow): string {
  const category = t(item.categoryKey), memo = memoText(t, item);
  return memo === category ? category : `${category}\u00A0· ${memo}`;
}
const itemBadge = (t: T, item: TaxItemRow) => (item.status === 'checked' ? <StatusBadge kind="checked" /> : <StatusBadge kind="needsReview" label={t('common.badge.needsReview')} />);
const itemRow = (t: T, item: TaxItemRow, withAmount = false): RowData => ({ id: item.refId, name: itemTitle(t, item), sub: t.format.date(item.date, 'short'), badge: itemBadge(t, item), ...(withAmount ? { value: t.format.money(item.amount, 'compact'), semanticValue: item.amount } : {}) });
const TAX_FIT: readonly FitPart[] = [...MONEY_FIT, { selector: '.mm-state-chip' }];
/** D-333: on a large card the list shows what each row says (date, status, amount) and drops whole rows first, the reverse of the short cards' order. */
export const TAX_LARGE_FIT: readonly FitPart[] = [{ selector: '.mm-note' }, { selector: '.mm-row', last: true }, ...TAX_FIT.filter((part) => part.selector !== '.mm-note' && part.selector !== '.mm-row')];

function buildSpec(t: T, model: TaxModel, notes: ReactNode, shape: string, height: number): PanelSpec {
  const large = shape === 'L' && height >= 3;
  const periodLine = model.period ? `${t('widget.tax.period')} ${dateRangeWithWeekdays(t, model.period.start, model.period.end)}` : undefined;
  const unresolved = model.period === null;
  const none = !unresolved && model.reviewCount === 0;
  const open = model.items.filter((i) => i.status === 'needs-check');
  const estimate: RowData[] = shape === 'L' ? [model.estimate
    ? { id: 'estimate', name: t('widget.tax.estimate'), sub: t('widget.tax.basis', { date: t.format.date(model.estimate.basisDate, 'short') }), value: t.format.money(model.estimate.amount, 'compact') }
    : { id: 'estimate', name: t('widget.tax.estimate'), sub: t('widget.tax.estimateHidden') }] : [];
  const items = (shape === 'S' || shape === 'W' || shape === 'T' ? open : model.items).map((i) => itemRow(t, i, large));
  const unpaid = model.payments.filter(p => p.status === 'unpaid').sort(compareTaxDue);
  const nextPayment = selectNextTaxPayment(model.payments);
  const paymentRows: RowData[] = unpaid.map(p => ({ id: p.taxPaymentId, name: resolveDataText(t, p.type), value: t.format.money(p.amount, 'compact'), sub: t('widget.tax.next', { date: t.format.date(p.dueOn, 'short') }) }));
  const recentRows: RowData[] = [...model.payments].sort((a, b) => b.dueOn.localeCompare(a.dueOn)).slice(0, 3).map(p => ({ id: `recent-${p.taxPaymentId}`, name: resolveDataText(t, p.type), value: t.format.money(p.amount, 'compact'), sub: t(p.status === 'paid' ? 'widget.tax.paid' : 'widget.tax.unpaid') }));
  const rows = shape === 'W' ? [...paymentRows, ...items] : shape === 'T' ? [...items, ...paymentRows] : [...items, ...recentRows, ...estimate];
  return {
    slot: ID, label: t('widget.tax.reviewItems'), semanticValue: model.reviewCount, subEssential: true,
    value: unresolved ? t('data.state.tax.missing-data') : none ? t('data.state.tax.all-checked') : String(model.reviewCount),
    unit: unresolved || none ? undefined : t('widget.tax.unit', { n: model.reviewCount }), inlineUnit: true,
    state: unresolved || none ? { message: t(unresolved ? 'data.state.tax.missing-data' : 'data.state.tax.all-checked'), tone: 'info', chip: unresolved ? <StatusChip compact tone="warning">{t('data.state.tax.needs-more')}</StatusChip> : undefined } : undefined,
    fitOrder: large ? TAX_LARGE_FIT : TAX_FIT,
    sub: nextPayment ? t('widget.tax.next', { date: t.format.date(nextPayment.dueOn, 'short') }) : periodLine, rows, rowsTitle: shape === 'L' ? t('widget.tax.list') : undefined, status: unresolved || none ? undefined : notes,
  };
}

export function TaxPanel(props: WidgetPanelProps) {
  const t = useMoneyT();
  const ctx = useSizeCtx(props);
  const view = useWidgetView(ID, props.condition);
  const state = useDomainState(ID);
  const retry = useRealRetry(ID);
  if (view.status !== 'ready') return <ViewState view={view} ctx={ctx} host={state.mode === 'http' ? { ...props.host, resetPreview: retry } : props.host} featureId={ID} t={t} />;
  return <MoneyPanel spec={buildSpec(t, view.model, <NoteLine notes={view.notes} t={t} />, ctx.shape, ctx.height)} ctx={ctx} />;
}

export function useTaxSummary({ condition }: { featureId: unknown; condition: QueryCondition }): string {
  const t = useMoneyT();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return t(view.messageKey);
  if (view.model.period === null) return t('data.state.tax.missing-data');
  return view.model.reviewCount === 0 ? t('data.state.tax.all-checked') : t('widget.tax.summary', { n: view.model.reviewCount });
}

/* ---------- detail ---------- */
type PeriodKey = 'month' | 'last';
const LIST_PREVIEW = 5;
const conditions = supportedConditions(ID);
const conditionFor = (p: PeriodKey): QueryCondition => (p === 'month' ? conditions[0] : conditions[1]) ?? conditions[0]!;

export function TaxDetail({ condition, detailRef, host, accounting: explicitAccounting }: AccountingDetailProps) {
  const t = useMoneyT();
  const copy = useTaxCopy();
  const state = useDomainState(ID);
  const retry = useRealRetry(ID);
  const real = state.mode === 'http';
  const [period, setPeriod] = useState<PeriodKey>(() => (condition.kind === 'dateRange' ? 'last' : 'month'));
  const [selectedId, setSelectedId] = useState<string | null>(() => detailRef.itemId ?? null);
  const [exportStatus, setExportStatus] = useState<'done' | 'error'>();
  const [chosenTab, setTab] = useState<'data' | 'payments'>();
  const [listOpen, setListOpen] = useState(false);
  const view = useWidgetView(ID, conditionFor(period));
  const presentation = useAccountingPresentation();
  const dispatch = useDataDispatch();
  const runTax = useRunTaxCommand(host, real);
  const busy = useRef(false);
  const [checking, setChecking] = useState(false);
  const chips = <ChipChoice label={t('widget.tax.period')} value={period} onChange={(p) => { setPeriod(p); setExportStatus(undefined); }} options={[{ value: 'month', label: t('widget.tax.thisMonth') }, { value: 'last', label: t('widget.tax.lastMonth') }]} />;
  if (view.status !== 'ready') return <div className="mm-detail" data-widget={ID}>{chips}<DetailViewState view={view} host={real ? { ...host, resetPreview: retry } : host} t={t} /></div>;
  const m = view.model;
  const linkedPayment = real && (detailRef.view === 'evidence' || !detailRef.view && m.payments.some(row => row.taxPaymentId === detailRef.itemId));
  const tab = chosenTab ?? (detailRef.view === 'payments' || linkedPayment ? 'payments' : 'data');
  const accounting = !real && m.period ? accountingForPeriod(presentation, m.period, explicitAccounting) : undefined;
  const cashReceipts = m.exportPreview.cashReceipts;
  const selected = m.items.find((i) => i.refId === selectedId) ?? m.items.find((i) => i.status === 'needs-check') ?? m.items[0] ?? null;
  const full = (n: number) => t.format.money(n, 'full');
  const check = async (refId: string) => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try { await runTax({ type: 'tax.markChecked', refId }); }
    finally { busy.current = false; setChecking(false); }
  };
  const doExport = () => {
    if (!m.period || busy.current || accounting && accounting.status !== 'ready') return;
    busy.current = true;
    try {
      const result = dispatch({ type: 'tax.export', period: m.period });
      if (!result.ok) { setExportStatus('error'); return; }
      const preview = m.exportPreview;
      const rows: [string, string | number][] = [
        [t('widget.tax.exportItem'), t('widget.tax.exportValue')],
        [t('widget.tax.period'), `${m.period.start} – ${m.period.end}`],
        [t('widget.tax.salesTotal'), accounting?.summary.sales.total ?? preview.salesTotal],
        [t('widget.tax.expenseTotal'), preview.expenseTotal],
        [t('widget.tax.withEvidence'), preview.withEvidence],
        [t('widget.tax.missingEvidence'), preview.missingEvidence],
      ];
      if (accounting) rows.push([accountingCopy.deposits, accounting.summary.deposits.total]);
      if (cashReceipts) rows.push([t('widget.tax.cashReceipts'), cashReceipts.amount]);
      const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
      const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
      downloadTaxFile(URL.createObjectURL(blob), `tax-${m.period.start}-${m.period.end}.csv`);
      setExportStatus('done');
    } catch {
      setExportStatus('error');
    } finally {
      busy.current = false;
    }
  };
  // 39 items would push everything else of this tab thousands of pixels down: show the first few (and the selected one), the rest on request.
  const selectedIndex = m.items.findIndex((i) => i.refId === selected?.refId);
  const shownItems = listOpen ? m.items : m.items.slice(0, Math.max(LIST_PREVIEW, selectedIndex + 1));
  const hiddenCount = m.items.length - shownItems.length;
  const list = (
    <>
      <h3 className="mm-card__title">{t('widget.tax.list')}</h3>
      {m.items.length === 0 ? <p className="mm-muted">{m.period === null ? t('data.state.tax.missing-data') : t('data.state.tax.all-checked')}</p> : (
        <ul className="mm-select-list" data-slot="tax.list">
          {shownItems.map((item) => (
            <li key={item.refId} data-row-id={item.refId}>
              <button type="button" className="mm-select-row" autoFocus={item.refId === detailRef.itemId} aria-pressed={item.refId === selected?.refId} onClick={() => setSelectedId(item.refId)}>
                <span className="mm-select-row__text"><strong>{itemTitle(t, item)}</strong><span>{t.format.date(item.date, 'short')}{'\u00A0'}· {full(item.amount)}</span></span>
                {itemBadge(t, item)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {hiddenCount > 0 ? <ActionButton variant="secondary" onClick={() => setListOpen(true)}>{t('widget.tax.moreItems', { n: hiddenCount })}</ActionButton> : null}
    </>
  );
  const detail = selected ? (
    <div className="mm-item" data-slot="tax.item" data-row-id={selected.refId}>
      <h3 className="mm-card__title">{itemTitle(t, selected)}</h3>
      <dl className="mm-dl">
        <div><dt>{t('widget.ledger.field.date')}</dt><dd>{t.format.date(selected.date, 'long')}</dd></div>
        <div><dt>{t('widget.ledger.field.amount')}</dt><dd>{full(selected.amount)}</dd></div>
        <div><dt>{t('widget.tax.check')}</dt><dd>{t(selected.reasonKey)}</dd></div>
      </dl>
      {selected.status === 'checked' ? <p className="mm-done"><Icon name="check" /> {t('common.badge.checked')}</p> : <ActionButton loading={checking} onClick={() => void check(selected.refId)}>{real ? copy('review') : t('common.gotIt')}</ActionButton>}
    </div>
  ) : <p className="mm-muted">{t('widget.tax.selectItem')}</p>;
  return (
    <div className={`mm-detail${tab === 'payments' ? ' mm-detail--grid' : ''}`} data-widget={ID}>
      <DetailTabs value={tab} onValueChange={setTab} label={t('widget.tax.tabs')} tabs={[{ value: 'data', label: t('widget.tax.dataTab') }, { value: 'payments', label: real ? copy('payments') : t('widget.tax.paymentsTab') }]} />
      {real ? <p className="mm-detail__note">{t('common.linked.tax.paymentNote')}</p> : null}
      {real && view.notes?.length ? <div className="mm-actions"><NoteLine notes={view.notes} t={t} /><ActionButton variant="secondary" onClick={retry}>{t('data.action.retry')}</ActionButton></div> : null}
      {tab === 'payments' ? <TaxPayments payments={view.variant === 'all-checked' ? [] : m.payments} host={host} detailRef={detailRef} emptyPreview={view.variant === 'all-checked'} real={real} today={m.today ?? TODAY} /> : <>
      <div className="mm-detail__tools">{chips}</div>
      {m.period ? <p className="mm-detail__note">{t('widget.tax.period')} {dateRangeWithWeekdays(t, m.period.start, m.period.end)}</p> : <p className="mm-detail__note" role="status"><StatusBadge kind="needsReview" label={t('data.state.tax.missing-data')} /></p>}
      <MasterDetail list={list} detail={detail} listLabel={t('widget.tax.list')} detailLabel={t('widget.tax.check')} />
      {accounting ? <SalesDepositSplitCard view={accounting} featureId="tax" onRetry={presentation?.onRetry ?? host.resetPreview} /> : null}
      <section className="mm-card" aria-label={t('widget.tax.estimate')} data-slot="tax.estimate">
        <h3 className="mm-card__title">{t('widget.tax.estimate')}</h3>
        {m.estimate ? (
          <>
            <Kpi slot="tax.kpi.estimate" label={t('widget.tax.basis', { date: t.format.date(m.estimate.basisDate, 'long') })} value={splitMoney(t, m.estimate.amount).value} unit={splitMoney(t, m.estimate.amount).unit} />
            <p className="mm-muted">{t(m.estimate.assumptionKey)}</p>
          </>
        ) : <p className="mm-muted">{t('widget.tax.estimateHidden')}</p>}
      </section>
      <section className="mm-card" aria-label={t('widget.tax.exportTitle')} data-slot="tax.export">
        <header className="mm-card__header">
          <h3 className="mm-card__title">{t('widget.tax.exportTitle')}</h3>
        </header>
        <Table className="mm-table">
          <thead><tr><th scope="col">{t('widget.tax.exportItem')}</th><th scope="col">{t('widget.tax.exportValue')}</th></tr></thead>
          <tbody>
            <tr><th scope="row">{t('widget.tax.salesTotal')}</th><td>{accounting ? accounting.status === 'ready' ? full(accounting.summary.sales.total) : '—' : full(m.exportPreview.salesTotal)}</td></tr>
            {accounting?.status === 'ready' && accounting.legacySales !== undefined ? <tr><th scope="row">{accountingCopy.legacySales}</th><td>{full(accounting.legacySales)}</td></tr> : null}
            {m.real ? <tr><th scope="row">{accountingCopy.deposits}</th><td>{full(m.real.preview.deposits.total)}</td></tr> : accounting ? <tr><th scope="row">{accountingCopy.deposits}</th><td>{accounting.status === 'ready' ? full(accounting.summary.deposits.total) : '—'}</td></tr> : null}
            <tr><th scope="row">{t('widget.tax.cashReceipts')}</th><td>{cashReceipts ? t('widget.tax.cashReceiptTotal', { n: cashReceipts.count, amount: full(cashReceipts.amount) }) : copy(m.real ? 'cashReceiptsUnavailable' : 'noData')}</td></tr>
            <tr><th scope="row">{t('widget.tax.expenseTotal')}</th><td>{full(m.exportPreview.expenseTotal)}</td></tr>
            <tr><th scope="row">{m.real ? copy('classifiedExpenses') : t('widget.tax.withEvidence')}</th><td>{t.format.count(m.exportPreview.withEvidence, 'count')}</td></tr>
            <tr><th scope="row">{m.real ? copy('unclassifiedExpenses') : t('widget.tax.missingEvidence')}</th><td>{t.format.count(m.exportPreview.missingEvidence, 'count')}</td></tr>
            {m.real ? <>
              <tr><th scope="row">{copy('paidTotal')}</th><td>{full(m.real.preview.taxPayments.paidTotal)}</td></tr>
              <tr><th scope="row">{copy('unpaidTotal')}</th><td>{full(m.real.preview.taxPayments.unpaidTotal)}</td></tr>
              <tr><th scope="row">{copy('paymentsWithFiles')}</th><td>{t.format.count(m.real.preview.taxPayments.withEvidenceFile, 'count')}</td></tr>
            </> : null}
          </tbody>
        </Table>
        {m.real ? <>
          {m.real.officialLinks.hometax === 'https://www.hometax.go.kr/' ?
            <div className="mm-actions"><a className="ui-button ui-button--secondary ui-button--default" href={m.real.officialLinks.hometax} target="_blank" rel="noopener noreferrer"><span className="ui-press-surface">{t('common.linked.tax.openHometax')}</span></a></div> : null}
          <TaxExportActions key={period} read={m.real} disabled={state.refreshing || state.status === 'stale'} />
        </> : <div className="mm-actions">
          <ActionButton variant="outline" disabled={m.period === null || !!accounting && accounting.status !== 'ready'} onClick={doExport}>{t('common.linked.tax.accountantFile')}</ActionButton>
          {exportStatus === 'done' ? <p className="mm-done" role="status"><Icon name="check" /> {copy('downloaded')}</p> : null}
          {exportStatus === 'error' ? <p className="mm-muted" role="alert">{copy('exportError')}</p> : null}
        </div>}
      </section>
      </>}
    </div>
  );
}

export const taxModule: WidgetModule = { id: ID, Panel: TaxPanel, Detail: TaxDetail, useSummary: useTaxSummary };

function TaxRowActions({ actions, label, longestLabel, busy }: { actions: readonly GridAction[]; label: string; longestLabel: string; busy: boolean }) {
  const [open,setOpen]=useState(false);
  const anchor=useRef<HTMLButtonElement>(null);
  // one named action on the row (mark paid, else add evidence); a paid row with its evidence only has ⋯ (edit / delete)
  const primary=actions.find(action=>action.id==='paid')??actions.find(action=>action.id==='evidence');
  const rest=actions.filter(action=>action!==primary);
  return (
    <span className="mm-tax-actions">
      <span aria-hidden="true" className="mm-tax-actions__sizer">{longestLabel}</span>
      {primary ? <ActionButton className="mm-tax-actions__primary" variant="secondary" disabled={busy} onClick={primary.onPress}>{primary.label}</ActionButton> : null}
      <ActionButton ref={anchor} variant="secondary" size="icon" aria-label={label} aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>⋯</ActionButton>
      <AnchoredPopover open={open} anchorRef={anchor} label={label} onClose={() => setOpen(false)} focusOnOpen>
        <div className="mm-tax-actions__menu">{rest.map(action => <ActionButton key={action.id} variant="ghost" onClick={() => { setOpen(false); action.onPress(); }}>{action.label}</ActionButton>)}</div>
      </AnchoredPopover>
    </span>
  );
}

function TaxTypeName({ name }: { name: string }) {
  return <span title={name}>{name.split(/(\([^()]*\))/).map((part, index) => index % 2
    ? <Fragment key={index}><wbr /><span className="mm-tax-type__qualifier">{part}</span></Fragment>
    : part)}</span>;
}

let taxSequence = 0;
type PaymentRow = TaxModel['payments'][number];
const statusKey = (p: PaymentRow) => (p.overdue ? 'widget.tax.overdue' : p.status === 'paid' ? 'widget.tax.paid' : 'widget.tax.unpaid');
function TaxPayments({ payments, host, detailRef, emptyPreview, real, today }: { payments: TaxModel['payments']; host: WidgetDetailProps['host']; detailRef: DetailRef; emptyPreview: boolean; real: boolean; today: string }) {
  const t = useMoneyT();
  const copy = useTaxCopy();
  const markPaidLabel = t(real ? 'common.linked.tax.markPaid' : 'widget.tax.markPaid');
  const run = useRunCommand(host);
  const runTax = useRunTaxCommand(host, real);
  const prefill = detailRef.focus === 'action' ? moneyDetailPrefill(detailRef) : undefined;
  const [adding, setAdding] = useState(() => detailRef.view === 'payments' && detailRef.focus === 'action');
  const [taxType, setType] = useState(() => typeof prefill?.taxType === 'string' ? prefill.taxType : '');
  const [amount, setAmount] = useState<number | null>(() => typeof prefill?.amount === 'number' ? prefill.amount : null);
  const [due, setDue] = useState(() => typeof prefill?.dueOn === 'string' ? prefill.dueOn : today);
  const [error, setError] = useState<string>();
  const [existing, setExisting] = useState<{ type: string; amount: number; dueOn: string } | null>(null);
  const [evidenceId, setEvidenceId] = useState<string>();
  const linkedEvidence = real && detailRef.view === 'evidence' ? detailRef.itemId : undefined;
  useLayoutEffect(() => {
    if (!linkedEvidence) return;
    // The evidence portal must be appended after the containing detail portal.
    const frame = requestAnimationFrame(() => setEvidenceId(linkedEvidence));
    return () => cancelAnimationFrame(frame);
  }, [linkedEvidence]);
  const [deleteId, setDeleteId] = useState<string>();
  const [working, setWorking] = useState(false);
  const pending = useRef(false);
  const attemptedCreates = useRef(new Map<string, string>());
  const perform = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setWorking(true);
    try { await action(); }
    finally { pending.current = false; setWorking(false); }
  };
  const nextDue = selectNextTaxPayment(payments);
  const [sort, setSort] = useState<GridSort>({ columnId: 'dueOn', direction: 'desc' });
  const [focus, setFocus] = useState<GridFocus>(null);
  const grid = useRef<DataGridHandle>(null);
  useLayoutEffect(() => {
    if (detailRef.itemId && detailRef.view !== 'evidence') grid.current?.focusCell(detailRef.itemId, 'type');
  }, [detailRef.itemId, detailRef.view]);
  type Row = TaxModel['payments'][number];
  const editable = () => !working;
  const columns: GridColumn<Row>[] = [
    { id: 'type', header: t('widget.tax.type'), kind: 'text', sortable: true, minWidth: 180, value: p => resolveDataText(t, p.type), render: p => <TaxTypeName name={resolveDataText(t, p.type)} />, editable },
    { id: 'amount', header: t('widget.tax.amount'), kind: 'number', sortable: true, minWidth: 160, fixedWidth: true, value: p => p.amount, render: p => t.format.money(p.amount, 'full'), accessibleValue: p => t.format.money(p.amount, 'full'), editable },
    { id: 'dueOn', header: t('widget.tax.due'), kind: 'text', sortable: true, minWidth: 160, fixedWidth: true, value: p => p.dueOn, render: p => t.format.date(p.dueOn, 'short'), accessibleValue: p => t.format.date(p.dueOn, 'short'), editable, editor: 'date' },
    { id: 'paidOn', header: t('widget.tax.paidOn'), kind: 'text', minWidth: 130, fixedWidth: true, value: p => p.paidOn ? t.format.date(p.paidOn, 'short') : '–' },
    { id: 'status', header: t('widget.tax.status'), kind: 'status', minWidth: 140, fixedWidth: true, value: p => t(statusKey(p)), render: p => <StatusChip semantic={p.overdue ? 'warning' : p.status === 'paid' ? 'done' : 'waiting'}>{t(statusKey(p))}</StatusChip> },
    { id: 'evidence', header: t('widget.tax.evidence'), kind: 'text', minWidth: 120, fixedWidth: true,
      value: p => real ? copy(p.real?.evidenceFiles.length ? 'attached' : 'missing') : t(p.evidence === 'example' ? 'widget.tax.hasEvidence' : 'widget.tax.noEvidence') },
  ];
  const save = (confirmDuplicate: boolean) => void perform(async () => {
    if (!amount || amount <= 0) { setError(t('widget.tax.amountRequired')); return; }
    const fingerprint = JSON.stringify([taxType, amount, due, confirmDuplicate]);
    const idempotencyKey = real ? attemptedCreates.current.get(fingerprint) ?? crypto.randomUUID() : `tax-${++taxSequence}`;
    const result = await runTax({ type: 'tax.createPayment', taxType, amount, dueOn: due, idempotencyKey, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) });
    if (!result.ok && result.outcomeUnknown) attemptedCreates.current.set(fingerprint, idempotencyKey);
    else attemptedCreates.current.delete(fingerprint);
    if (!result.ok) { setError(commandFailureText(t, result, { next: '' })); setExisting(result.reason === 'TAX_PAYMENT_EXISTS' && result.details ? result.details as unknown as { type: string; amount: number; dueOn: string } : null); return; }
    setAdding(false); setType(''); setAmount(null); setDue(today); setError(undefined); setExisting(null);
  });
  const deleteRow = payments.find(row => row.taxPaymentId === deleteId);
  const evidenceRow = payments.find(row => row.taxPaymentId === evidenceId);
  return <section className="mm-card mm-detail__grid mm-tax-payments">
    {real && working ? <p className="mm-note" role="status">{copy('loading')}</p> : null}
    {nextDue ? <p className="mm-note" data-slot="tax.nextDue">{t('widget.tax.nextDue', { date: t.format.date(nextDue.dueOn, 'short') })}</p> : null}<DataGrid ref={grid} id="tax-payments" label={real ? copy('payments') : t('widget.tax.paymentsTab')} rows={[...payments].sort((a, b) => { const field = sort?.columnId; const av = field === 'amount' ? a.amount : field === 'type' ? resolveDataText(t, a.type) : a.dueOn; const bv = field === 'amount' ? b.amount : field === 'type' ? resolveDataText(t, b.type) : b.dueOn; return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * (sort?.direction === 'asc' ? 1 : -1) || a.taxPaymentId.localeCompare(b.taxPaymentId); })} getRowId={p => p.taxPaymentId} getRowLabel={p => resolveDataText(t, p.type)} columns={columns} sort={sort} onSortChange={setSort} selectedRowId={null} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} emptyContent={t('widget.tax.emptyPayments')} addAction={{ id: 'add', label: t('widget.tax.addPayment'), disabled: working, onPress: () => { if (emptyPreview) host.resetPreview(); setAdding(true); } }} getRowActions={p => [
    ...(p.status === 'unpaid' ? [{ id: 'paid', label: markPaidLabel, onPress: () => void perform(async () => {
      await runTax({ type: 'tax.markPaid', taxPaymentId: p.taxPaymentId }, t.locale === 'ko' ? { messageKey: 'data.management.notice.taxPaid', params: { name: resolveDataText(t, p.type) } } : undefined);
    }) }] : []),
    ...(real ? [{ id: p.real?.evidenceFiles.length ? 'files' : 'evidence', label: p.real?.evidenceFiles.length ? copy('files') : t('widget.tax.addEvidence'), onPress: () => setEvidenceId(p.taxPaymentId) }]
      : p.evidence === 'example' ? [] : [{ id: 'evidence', label: t('widget.tax.addEvidence'), onPress: () => { run({ type: 'tax.setEvidence', taxPaymentId: p.taxPaymentId, evidence: 'example' }); } }]),
    { id: 'edit', label: t.locale === 'ko' ? '납부 기록 고치기' : 'Edit payment', onPress: () => { grid.current?.focusCell(p.taxPaymentId, 'type'); document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); } },
    { id: 'delete', label: t('widget.tax.delete'), onPress: () => setDeleteId(p.taxPaymentId) },
  ]} renderRowActions={(p, actions) => <TaxRowActions actions={actions} label={t.locale === 'ko' ? `${resolveDataText(t, p.type)} 더 보기` : 'More'} longestLabel={markPaidLabel} busy={working} />} renderAddRow={() => adding ? <InlineForm title={t('widget.tax.addPayment')} onClose={() => { setAdding(false); setExisting(null); }} onSave={() => save(false)} saving={working}><TextField label={t('widget.tax.type')} value={taxType} onValueChange={setType} /><NumberField label={t('widget.tax.amount')} value={amount} onValueChange={setAmount} min={1} error={error} /><DateField label={t('widget.tax.due')} value={due} onValueChange={value => setDue(value ?? today)} />{existing ? <><p className="mm-note" data-slot="tax.existing">{t('widget.tax.existing', { type: existing.type, amount: t.format.money(existing.amount, 'full'), date: t.format.date(existing.dueOn, 'short') })}</p><ActionButton variant="secondary" disabled={working} onClick={() => save(true)}>{t('widget.tax.addAnyway')}</ActionButton></> : null}</InlineForm> : null} onCommit={({ rowId, columnId, raw }) => {
    const patch = columnId === 'amount' ? { amount: Number(raw) } : columnId === 'type' ? { type: raw } : { dueOn: raw };
    const command = { type: 'tax.updatePayment', taxPaymentId: rowId, patch } as const;
    if (real) {
      void perform(async () => { await runTax(command); });
      return { ok: true };
    }
    const result = run(command);
    return result.ok ? { ok: true } : { ok: false, error: { id: result.code, message: commandFailureText(t, result) } };
  }} />
  {deleteRow ? <DetailDialog open dialogRole="alertdialog" title={copy('deletePayment')} description={resolveDataText(t, deleteRow.type)}
    onClose={() => setDeleteId(undefined)} footer={<ActionButton variant="destructive" loading={working} onClick={() => void perform(async () => {
      const result = await runTax({ type: 'tax.deletePayment', taxPaymentId: deleteRow.taxPaymentId }, t.locale === 'ko' ? { messageKey: 'data.management.notice.deleted' } : undefined);
      if (result.ok) setDeleteId(undefined);
    })}>{t('widget.tax.delete')}</ActionButton>}>{null}</DetailDialog> : null}
  {real && evidenceRow ? <TaxEvidence key={evidenceRow.taxPaymentId} payment={evidenceRow} host={host} onClose={() => setEvidenceId(undefined)} /> : null}
</section>;
}
