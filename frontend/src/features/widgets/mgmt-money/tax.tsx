/** 세금계산 (F-29, SCR-30/31): panel, detail with connection status, review list, estimate and the sample export. */
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { DetailRef, QueryCondition, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetView } from '../../../data/react';
import { resolveDataText, TODAY, supportedConditions, type TaxItemRow, type TaxModel } from '../../../data/widget-data';
import { ActionButton, AnchoredPopover, ChipChoice, DataGrid, DateField, DetailTabs, Icon, InlineForm, MasterDetail, NumberField, StatusBadge, StatusChip, Table, TextField, type GridAction, type GridColumn, type GridFocus, type GridSort, type DataGridHandle } from '../../../ui';
import { compareTaxDue, selectNextTaxPayment } from '../../../data/commands/management-guards';
import { DetailViewState, Kpi, MoneyPanel, MONEY_FIT, NoteLine, ViewState, splitMoney, useMoneyT, useRunCommand, useSizeCtx, type PanelSpec, type RowData, type T } from './shared';

import { accountingForPeriod, SalesDepositSplitCard, useAccountingPresentation, type AccountingDetailProps } from './ledger';
import { accountingCopy } from './iteration7-accounting-messages';
import { moneyDetailPrefill } from '../../assistant/domains/money';

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
const itemRow = (t: T, item: TaxItemRow): RowData => ({ id: item.refId, name: itemTitle(t, item), sub: t.format.date(item.date, 'short'), badge: itemBadge(t, item) });

function buildSpec(t: T, model: TaxModel, notes: ReactNode, shape: string, height: number): PanelSpec {
  const periodLine = model.period ? `${t('widget.tax.period')} ${t.format.dateRange(model.period.start, model.period.end)}` : undefined;
  const unresolved = model.period === null;
  const none = !unresolved && model.reviewCount === 0;
  const open = model.items.filter((i) => i.status === 'needs-check');
  const connections: RowData[] = model.connections.map((c) => ({ id: `conn-${c.source}`, name: t(c.sourceKey), value: t(c.statusKey) }));
  const estimate: RowData[] = shape === 'L' ? [model.estimate
    ? { id: 'estimate', name: t('widget.tax.estimate'), sub: t('widget.tax.basis', { date: t.format.date(model.estimate.basisDate, 'short') }), value: t.format.money(model.estimate.amount, 'compact') }
    : { id: 'estimate', name: t('widget.tax.estimate'), sub: t('widget.tax.estimateHidden') }] : [];
  const items = (shape === 'S' || shape === 'W' || shape === 'T' ? open : model.items).map((i) => itemRow(t, i));
  // tall narrow shapes (1x3, 1x4) also show the data sources the model has (SCR-30 expanded form); the fit guard drops what does not fit
  const unpaid = model.payments.filter(p => p.status === 'unpaid').sort(compareTaxDue);
  const nextPayment = selectNextTaxPayment(model.payments);
  const paymentRows: RowData[] = unpaid.map(p => ({ id: p.taxPaymentId, name: resolveDataText(t, p.type), value: t.format.money(p.amount, 'compact'), sub: t('widget.tax.next', { date: t.format.date(p.dueOn, 'short') }) }));
  const recentRows: RowData[] = [...model.payments].sort((a, b) => b.dueOn.localeCompare(a.dueOn)).slice(0, 3).map(p => ({ id: `recent-${p.taxPaymentId}`, name: resolveDataText(t, p.type), value: t.format.money(p.amount, 'compact'), sub: t(p.status === 'paid' ? 'widget.tax.paid' : 'widget.tax.unpaid') }));
  const rows = shape === 'W' ? [...paymentRows, ...items] : shape === 'T' ? [...items, ...paymentRows, ...(height >= 3 ? connections : [])] : [...items, ...connections, ...recentRows, ...estimate];
  return {
    slot: ID, label: t('widget.tax.reviewItems'), semanticValue: model.reviewCount, subEssential: true,
    value: unresolved ? t('data.state.tax.missing-data') : none ? t('data.state.tax.all-checked') : String(model.reviewCount),
    unit: unresolved || none ? undefined : t('widget.tax.unit', { n: model.reviewCount }), inlineUnit: true,
    state: unresolved || none ? { message: t(unresolved ? 'data.state.tax.missing-data' : 'data.state.tax.all-checked'), tone: 'info', chip: unresolved ? <StatusChip compact tone="warning">{t('data.state.tax.needs-more')}</StatusChip> : undefined } : undefined,
    fitOrder: [...MONEY_FIT, { selector: '.mm-state-chip' }],
    sub: nextPayment ? t('widget.tax.next', { date: t.format.date(nextPayment.dueOn, 'short') }) : periodLine, rows, rowsTitle: shape === 'L' ? t('widget.tax.list') : undefined, status: unresolved || none ? undefined : notes,
  };
}

export function TaxPanel(props: WidgetPanelProps) {
  const t = useMoneyT();
  const ctx = useSizeCtx(props);
  const view = useWidgetView(ID, props.condition);
  if (view.status !== 'ready') return <ViewState view={view} ctx={ctx} host={props.host} featureId={ID} t={t} />;
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
  const [period, setPeriod] = useState<PeriodKey>(() => (condition.kind === 'dateRange' ? 'last' : 'month'));
  const [selectedId, setSelectedId] = useState<string | null>(() => detailRef.itemId ?? null);
  const [exported, setExported] = useState(false);
  const [tab, setTab] = useState<'data' | 'payments'>(() => detailRef.view === 'payments' ? 'payments' : 'data');
  const [listOpen, setListOpen] = useState(false);
  const view = useWidgetView(ID, conditionFor(period));
  const presentation = useAccountingPresentation();
  const run = useRunCommand(host);
  const busy = useRef(false);
  const chips = <ChipChoice label={t('widget.tax.period')} value={period} onChange={(p) => { setPeriod(p); setExported(false); }} options={[{ value: 'month', label: t('widget.tax.thisMonth') }, { value: 'last', label: t('widget.tax.lastMonth') }]} />;
  if (view.status !== 'ready') return <div className="mm-detail" data-widget={ID}>{chips}<DetailViewState view={view} host={host} t={t} /></div>;
  const m = view.model;
  const accounting = m.period ? accountingForPeriod(presentation, m.period, explicitAccounting) : undefined;
  const selected = m.items.find((i) => i.refId === selectedId) ?? m.items.find((i) => i.status === 'needs-check') ?? m.items[0] ?? null;
  const full = (n: number) => t.format.money(n, 'full');
  const check = (refId: string) => {
    if (busy.current) return;
    busy.current = true;
    run({ type: 'tax.markChecked', refId });
    busy.current = false;
  };
  const doExport = () => {
    if (!m.period || busy.current || accounting && accounting.status !== 'ready') return;
    busy.current = true;
    const result = run({ type: 'tax.export', period: m.period });
    if (result.ok) setExported(true);
    busy.current = false;
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
      {selected.status === 'checked' ? <p className="mm-done"><Icon name="check" /> {t('common.badge.checked')}</p> : <ActionButton onClick={() => check(selected.refId)}>{t('common.gotIt')}</ActionButton>}
    </div>
  ) : <p className="mm-muted">{t('widget.tax.selectItem')}</p>;
  return (
    <div className={`mm-detail${tab === 'payments' ? ' mm-detail--grid' : ''}`} data-widget={ID}>
      <DetailTabs value={tab} onValueChange={setTab} label={t('widget.tax.tabs')} tabs={[{ value: 'data', label: t('widget.tax.dataTab') }, { value: 'payments', label: t('widget.tax.paymentsTab') }]} />
      {tab === 'payments' ? <TaxPayments payments={view.variant === 'all-checked' ? [] : m.payments} host={host} detailRef={detailRef} emptyPreview={view.variant === 'all-checked'} /> : <>
      <div className="mm-detail__tools">{chips}</div>
      {m.period ? <p className="mm-detail__note">{t('widget.tax.period')} {t.format.dateRange(m.period.start, m.period.end)}</p> : <p className="mm-detail__note" role="status"><StatusBadge kind="needsReview" label={t('data.state.tax.missing-data')} /></p>}
      <MasterDetail list={list} detail={detail} listLabel={t('widget.tax.list')} detailLabel={t('widget.tax.check')} />
      <section className="mm-card" aria-label={t('widget.tax.connections')}>
        <h3 className="mm-card__title">{t('widget.tax.connections')}</h3>
        <ul className="mm-plain-list" data-slot="tax.connections">
          {m.connections.map((c) => <li key={c.source} data-row-id={c.source}><span>{t(c.sourceKey)}</span><StatusBadge kind={c.status === 'connected' ? 'confirmed' : 'needsReview'} label={t(c.statusKey)} /></li>)}
        </ul>
      </section>
      {accounting ? <SalesDepositSplitCard view={accounting} example featureId="tax" onRetry={presentation?.onRetry ?? host.resetPreview} /> : null}
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
          <StatusBadge kind="suggested" label={accountingCopy.example} />
        </header>
        <Table className="mm-table">
          <thead><tr><th scope="col">{t('widget.tax.exportItem')}</th><th scope="col">{t('widget.tax.exportValue')}</th></tr></thead>
          <tbody>
            <tr><th scope="row">{t('widget.tax.salesTotal')}</th><td>{accounting ? accounting.status === 'ready' ? full(accounting.summary.sales.total) : '—' : full(m.exportPreview.salesTotal)}</td></tr>
            {accounting?.status === 'ready' && accounting.legacySales !== undefined ? <tr><th scope="row">{accountingCopy.legacySales}</th><td>{full(accounting.legacySales)}</td></tr> : null}
            {accounting ? <tr><th scope="row">{accountingCopy.deposits}</th><td>{accounting.status === 'ready' ? full(accounting.summary.deposits.total) : '—'}</td></tr> : null}
            <tr><th scope="row">{t('widget.tax.cashReceipts')}</th><td>{t('widget.tax.cashReceiptTotal', { n: m.exportPreview.cashReceipts.count, amount: full(m.exportPreview.cashReceipts.amount) })}</td></tr>
            <tr><th scope="row">{t('widget.tax.expenseTotal')}</th><td>{full(m.exportPreview.expenseTotal)}</td></tr>
            <tr><th scope="row">{t('widget.tax.withEvidence')}</th><td>{t.format.count(m.exportPreview.withEvidence, 'count')}</td></tr>
            <tr><th scope="row">{t('widget.tax.missingEvidence')}</th><td>{t.format.count(m.exportPreview.missingEvidence, 'count')}</td></tr>
          </tbody>
        </Table>
        <div className="mm-actions">
          <ActionButton variant="outline" disabled={m.period === null || !!accounting && accounting.status !== 'ready'} onClick={doExport}>{t('widget.tax.exportAction')}</ActionButton>
          {exported ? <p className="mm-done" role="status"><Icon name="check" /> {t('widget.tax.exportDone')} <span className="mm-muted">{t('widget.tax.exportNote')}</span></p> : null}
        </div>
      </section>
      </>}
    </div>
  );
}

export const taxModule: WidgetModule = { id: ID, Panel: TaxPanel, Detail: TaxDetail, useSummary: useTaxSummary };

function TaxRowActions({ actions, label, longestLabel }: { actions: readonly GridAction[]; label: string; longestLabel: string }) {
  const [open,setOpen]=useState(false);
  const anchor=useRef<HTMLButtonElement>(null);
  // one named action on the row (mark paid, else add evidence); a paid row with its evidence only has ⋯ (edit / delete)
  const primary=actions.find(action=>action.id==='paid')??actions.find(action=>action.id==='evidence');
  const rest=actions.filter(action=>action!==primary);
  return (
    <span className="mm-tax-actions">
      <span aria-hidden="true" className="mm-tax-actions__sizer">{longestLabel}</span>
      {primary ? <ActionButton className="mm-tax-actions__primary" variant="secondary" onClick={primary.onPress}>{primary.label}</ActionButton> : null}
      <ActionButton ref={anchor} variant="secondary" size="icon" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>⋯</ActionButton>
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
function TaxPayments({ payments, host, detailRef, emptyPreview }: { payments: TaxModel['payments']; host: WidgetDetailProps['host']; detailRef: DetailRef; emptyPreview: boolean }) {
  const t = useMoneyT();
  const markPaidLabel = t('widget.tax.markPaid');
  const run = useRunCommand(host);
  const prefill = detailRef.focus === 'action' ? moneyDetailPrefill(detailRef) : undefined;
  const [adding, setAdding] = useState(() => detailRef.view === 'payments' && detailRef.focus === 'action');
  const [taxType, setType] = useState(() => typeof prefill?.taxType === 'string' ? prefill.taxType : '');
  const [amount, setAmount] = useState<number | null>(() => typeof prefill?.amount === 'number' ? prefill.amount : null);
  const [due, setDue] = useState(() => typeof prefill?.dueOn === 'string' ? prefill.dueOn : TODAY);
  const [error, setError] = useState<string>();
  const [existing, setExisting] = useState<{ type: string; amount: number; dueOn: string } | null>(null);
  const nextDue = selectNextTaxPayment(payments);
  const [sort, setSort] = useState<GridSort>({ columnId: 'dueOn', direction: 'desc' });
  const [focus, setFocus] = useState<GridFocus>(null);
  const grid = useRef<DataGridHandle>(null);
  useLayoutEffect(() => {
    if (detailRef.itemId) grid.current?.focusCell(detailRef.itemId, 'type');
  }, [detailRef.itemId]);
  type Row = TaxModel['payments'][number];
  const columns: GridColumn<Row>[] = [
    { id: 'type', header: t('widget.tax.type'), kind: 'text', sortable: true, minWidth: 180, value: p => resolveDataText(t, p.type), render: p => <TaxTypeName name={resolveDataText(t, p.type)} />, editable: () => true },
    { id: 'amount', header: t('widget.tax.amount'), kind: 'number', sortable: true, minWidth: 160, fixedWidth: true, value: p => p.amount, render: p => t.format.money(p.amount, 'full'), accessibleValue: p => t.format.money(p.amount, 'full'), editable: () => true },
    { id: 'dueOn', header: t('widget.tax.due'), kind: 'text', sortable: true, minWidth: 160, fixedWidth: true, value: p => p.dueOn, render: p => t.format.date(p.dueOn, 'short'), accessibleValue: p => t.format.date(p.dueOn, 'short'), editable: () => true, editor: 'date' },
    { id: 'paidOn', header: t('widget.tax.paidOn'), kind: 'text', minWidth: 130, fixedWidth: true, value: p => p.paidOn ? t.format.date(p.paidOn, 'short') : '–' },
    { id: 'status', header: t('widget.tax.status'), kind: 'status', minWidth: 140, fixedWidth: true, value: p => t(statusKey(p)), render: p => <StatusChip semantic={p.overdue ? 'warning' : p.status === 'paid' ? 'done' : 'waiting'}>{t(statusKey(p))}</StatusChip> },
    { id: 'evidence', header: t('widget.tax.evidence'), kind: 'text', minWidth: 120, fixedWidth: true, value: p => t(p.evidence === 'example' ? 'widget.tax.hasEvidence' : 'widget.tax.noEvidence') },
  ];
  const save = (confirmDuplicate: boolean) => {
    if (!amount || amount <= 0) { setError(t('widget.tax.amountRequired')); return; }
    const result = run({ type: 'tax.createPayment', taxType, amount, dueOn: due, idempotencyKey: `tax-${++taxSequence}`, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) });
    if (!result.ok) { setError(t(result.messageKey)); setExisting(result.reason === 'TAX_PAYMENT_EXISTS' && result.details ? result.details as unknown as { type: string; amount: number; dueOn: string } : null); return; }
    setAdding(false); setType(''); setAmount(null); setDue(TODAY); setError(undefined); setExisting(null);
  };
  return <section className="mm-card mm-detail__grid mm-tax-payments">{nextDue ? <p className="mm-note" data-slot="tax.nextDue">{t('widget.tax.nextDue', { date: t.format.date(nextDue.dueOn, 'short') })}</p> : null}<DataGrid ref={grid} id="tax-payments" label={t('widget.tax.paymentsTab')} rows={[...payments].sort((a, b) => { const field = sort?.columnId; const av = field === 'amount' ? a.amount : field === 'type' ? resolveDataText(t, a.type) : a.dueOn; const bv = field === 'amount' ? b.amount : field === 'type' ? resolveDataText(t, b.type) : b.dueOn; return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * (sort?.direction === 'asc' ? 1 : -1) || a.taxPaymentId.localeCompare(b.taxPaymentId); })} getRowId={p => p.taxPaymentId} getRowLabel={p => resolveDataText(t, p.type)} columns={columns} sort={sort} onSortChange={setSort} selectedRowId={null} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} emptyContent={t('widget.tax.emptyPayments')} addAction={{ id: 'add', label: t('widget.tax.addPayment'), onPress: () => { if (emptyPreview) host.resetPreview(); setAdding(true); } }} getRowActions={p => [
    ...(p.status === 'unpaid' ? [{ id: 'paid', label: markPaidLabel, onPress: () => { run({ type: 'tax.markPaid', taxPaymentId: p.taxPaymentId }, t.locale === 'ko' ? {messageKey:'data.management.notice.taxPaid',params:{name:resolveDataText(t,p.type)}} : undefined); } }] : []),
    ...(p.evidence === 'example' ? [] : [{ id: 'evidence', label: t('widget.tax.addEvidence'), onPress: () => { run({ type: 'tax.setEvidence', taxPaymentId: p.taxPaymentId, evidence: 'example' }); } }]),
    { id: 'edit', label: t.locale === 'ko' ? '납부 기록 고치기' : 'Edit payment', onPress: () => { grid.current?.focusCell(p.taxPaymentId, 'type'); document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); } },
    { id: 'delete', label: t('widget.tax.delete'), onPress: () => { run({ type: 'tax.deletePayment', taxPaymentId: p.taxPaymentId }, t.locale === 'ko' ? { messageKey: 'data.management.notice.deleted' } : undefined); } },
  ]} renderRowActions={(p, actions) => <TaxRowActions actions={actions} label={t.locale === 'ko' ? `${resolveDataText(t, p.type)} 더 보기` : 'More'} longestLabel={markPaidLabel} />} renderAddRow={() => adding ? <InlineForm title={t('widget.tax.addPayment')} onClose={() => { setAdding(false); setExisting(null); }} onSave={() => save(false)}><TextField label={t('widget.tax.type')} value={taxType} onValueChange={setType} /><NumberField label={t('widget.tax.amount')} value={amount} onValueChange={setAmount} min={1} error={error} /><DateField label={t('widget.tax.due')} value={due} onValueChange={value => setDue(value ?? TODAY)} />{existing ? <><p className="mm-note" data-slot="tax.existing">{t('widget.tax.existing', { type: existing.type, amount: t.format.money(existing.amount, 'full'), date: t.format.date(existing.dueOn, 'short') })}</p><ActionButton variant="secondary" onClick={() => save(true)}>{t('widget.tax.addAnyway')}</ActionButton></> : null}</InlineForm> : null} onCommit={({ rowId, columnId, raw }) => {
    const patch = columnId === 'amount' ? { amount: Number(raw) } : columnId === 'type' ? { type: raw } : { dueOn: raw };
    const result = run({ type: 'tax.updatePayment', taxPaymentId: rowId, patch });
    return result.ok ? { ok: true } : { ok: false, error: { id: result.code, message: t(result.messageKey) } };
  }} />
</section>;
}
