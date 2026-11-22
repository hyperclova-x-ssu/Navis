import { openUnpaidOrders } from '../screens/settings/start-view';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ClosingViewTab, RunStore } from '../contracts';
import type { PosDrawerCommand } from '../contracts/pos';
import { useBundle } from '../i18n';
import { useDataExecute, useDomainState, useRealPort, useRealRetry, useWidgetDataStore } from '../data/react';
import { dataBundles, resolveClosingVariant, resolveDataText, selectClosing, selectPayments, selectPosClosing, TODAY, type DataCommand, type DataCommandResult, type PaymentMethod } from '../data/widget-data';
import { usePosSession } from '../pos/react';
import { selectReceipt } from '../pos/reversals';
import { ActionButton, CashDrawerCalc, ClosedDayState, ClosingColumns, ClosingDialog, ConfirmedMark, DataGrid, DetailSidePanel, DetailTabs, Icon, InlineEmpty, InlineError, InlineForm, layoutTokens, NumberField, OverlayExitSurface, PosMoney, StatusChip, TextField, VisibleValue, type CashDrawerRow, type GridColumn, type GridFocus, type GridSort } from '../ui';
import { closingBundle } from './closing-messages';
import { posBundle } from '../i18n/messages/pos';
import type { OpenReversalReceipt } from './pos-host';
import '../features/widgets/mgmt-money/widget.css';
import { CustomSalesBreakdown } from '../features/widgets/i7-custom/accounting';
import { AccountingTransactions, SalesDepositSplitCard, accountingForPeriod, useAccountingPresentation, type AccountingView, type OpenAccountingReceipt } from '../features/widgets/mgmt-money/ledger';
import { accountingCopy } from '../features/widgets/mgmt-money/iteration7-accounting-messages';

export function CustomClosingSales({ date }: { readonly date: string }) {
  return <CustomSalesBreakdown period={{ start: date, end: date }} />;
}

const methods = ['card', 'easy_pay', 'cash'] as const;
type Filter = PaymentMethod | 'mixed' | undefined;
let keySequence = 0;
export function ClosingOverlay({ run, onOpenReceipt, accounting: explicitAccounting, accountingHistory, onOpenAccountingReceipt }: { run: RunStore; onOpenReceipt: OpenReversalReceipt; accounting?: AccountingView; accountingHistory?: readonly AccountingView[]; onOpenAccountingReceipt?: OpenAccountingReceipt }) {
  const state = useSyncExternalStore(run.subscribe, run.getState), store = useWidgetDataStore(), runtime = usePosSession();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const presentation = useAccountingPresentation();
  // REAL-PLAN F09: with the HTTP money domain the day's figures, drawer and close come from the finance service and every write waits for its receipt.
  const http = useRealPort()?.mode('money') === 'http';
  const money$ = useDomainState('money'), retryMoney = useRealRetry('money'), execute = useDataExecute();
  const fin = snapshot.tables.realFinance;
  const loading = http && !fin;
  const [busy, setBusy] = useState(false), [confirmReopen, setConfirmReopen] = useState(false), [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ actual?: number | null; memo?: string }>({});
  const accounting = accountingForPeriod(presentation, { start: TODAY, end: TODAY }, explicitAccounting);
  const { t, format } = useBundle(closingBundle, posBundle, ...dataBundles);
  const active = state.overlay.type === 'closing';
  const descriptor = active ? state.overlay : state.exitingOverlay?.type === 'closing' ? state.exitingOverlay : null;
  const initialTab = descriptor?.type === 'closing' ? descriptor.tab : undefined;
  const readOnly = descriptor?.type === 'closing' && descriptor.readOnly === true;
  const [tab, setTab] = useState<ClosingViewTab>('sales'), [method, setMethod] = useState<Filter>();
  const [sort, setSort] = useState<GridSort>({ columnId: 'time', direction: 'desc' }), [focus, setFocus] = useState<GridFocus>(null);
  const [selected, setSelected] = useState<string | null>(null), [historyId, setHistoryId] = useState<string | null>(null);
  const [historyFocus, setHistoryFocus] = useState<GridFocus>(null), [movementFocus, setMovementFocus] = useState<GridFocus>(null);
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const [editOpening, setEditOpening] = useState(false), [opening, setOpening] = useState<number | null>(null);
  const [movement, setMovement] = useState<'in' | 'out' | null>(null), [amount, setAmount] = useState<number | null>(null), [memo, setMemo] = useState(''), [inputError, setInputError] = useState('');
  const processButton = useRef<HTMLButtonElement | null>(null), returnFocus = useRef<HTMLElement | null>(null), wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (active && !wasOpen.current) { setConfirmReopen(false); setConfirmRemove(null); setTab(initialTab ?? 'sales'); setMethod(undefined); setSort({ columnId: 'time', direction: 'desc' }); setFocus(null); setSelected(null); setHistoryId(null); setEditOpening(false); setMovement(null); setInputError(''); }
    wasOpen.current = active;
    if (descriptor?.type === 'closing') returnFocus.current = document.getElementById(descriptor.returnFocusKey) ?? document.querySelector<HTMLElement>('[data-focus-key="closing"]');
    if (active) { const title = popup?.querySelector<HTMLElement>('h2'); if (title) { title.tabIndex = -1; title.focus(); } }
  }, [active, descriptor?.type === 'closing' ? descriptor.returnFocusKey : null, popup, initialTab]);
  const variant = http ? 'normal' : resolveClosingVariant(state.preview), scenario = variant === 'no-payments' ? 'empty' : 'normal';
  const closing = selectPosClosing(snapshot, { date: TODAY, scenario });
  // Sort a copy; keep adapter row identities and the grid's focus/selection across receipt entry.
  const payments = useMemo(() => selectPayments(snapshot, { date: TODAY, scenario, method: method === 'mixed' ? undefined : method, onlyMixed: method === 'mixed' }), [snapshot, scenario, method]);
  const rows = useMemo(() => {
    if (!sort || !['time', 'amount', 'method', 'status'].includes(sort.columnId)) return payments.rows;
    const field = sort.columnId === 'amount' ? 'net' : sort.columnId === 'status' ? 'kind' : sort.columnId as 'time' | 'method';
    return [...payments.rows].sort((a, b) => {
      const av = a[field], bv = b[field];
      const delta = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return delta * (sort.direction === 'asc' ? 1 : -1) || (field === 'time' ? ((a.seq ?? 0) - (b.seq ?? 0)) * (sort.direction === 'asc' ? 1 : -1) : 0) || a.paymentId.localeCompare(b.paymentId);
    });
  }, [payments, sort]);
  const totals = closing.totals, drawer = accounting?.status === 'ready' && accounting.drawer ? accounting.drawer : closing.drawer, closed = closing.status === 'closed';
  const blockedCount = (http && fin ? fin.closing.pendingBills.length : closing.pendingBills.length) + (state.posUi.approval?.status === 'pending' ? 1 : 0), cannotClose = blockedCount > 0;
  const money = (value: number) => format.money(value, 'compact'), full = (value: number) => format.money(value, 'full');
  const signed = (value: number) => `${value < 0 ? '−' : value > 0 ? '+' : ''}${full(Math.abs(value))}`;
  const notify = (result: ReturnType<typeof store.dispatch>) => {
    if (!result.ok) { run.actions.showNotice({ kind: 'error', messageKey: result.messageKey }); return; }
    if (!result.duplicate) run.actions.showNotice({ kind: 'complete', messageKey: result.noticeKey ?? 'data.management.notice.reopened', ...(result.undoToken ? { undo: { target: 'data' as const, token: result.undoToken } } : {}) });
  };
  /** One write at a time: each request carries the revision the previous receipt produced. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const sendHttp = (command: DataCommand): Promise<boolean> => {
    const run = queue.current.then(async () => { setBusy(true); try { const result: DataCommandResult = await execute(command); notify(result); return result.ok; } finally { setBusy(false); } });
    queue.current = run.catch(() => undefined);
    return run;
  };
  type DrawerInput = PosDrawerCommand extends infer C ? C extends PosDrawerCommand ? Omit<C, 'meta'> : never : never;
  const httpDrawer = (command: DrawerInput): Promise<boolean> => sendHttp(command.type === 'drawer.set'
    ? { type: 'closing.setDrawer', date: TODAY, ...(command.opening !== undefined ? { opening: command.opening } : {}), ...(command.actual !== undefined ? { actual: command.actual } : {}), ...(command.memo !== undefined ? { memo: command.memo } : {}) }
    : command.type === 'drawer.addMovement' ? { type: 'closing.addMovement', date: TODAY, kind: command.kind, amount: command.amount, ...(command.memo ? { memo: command.memo } : {}) }
      : { type: 'closing.removeMovement', date: TODAY, movementId: command.movementId, confirmed: true });
  // The count and memo are typed: send them once the owner pauses (or leaves), not on every keystroke.
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined), draftRef = useRef(draft);
  draftRef.current = draft;
  const flushDraft = () => {
    clearTimeout(draftTimer.current);
    const pending = draftRef.current;
    if (pending.actual === undefined && pending.memo === undefined) return;
    void httpDrawer({ type: 'drawer.set', ...(pending.actual !== undefined ? { actual: pending.actual } : {}), ...(pending.memo !== undefined ? { memo: pending.memo } : {}) }).then(ok => { if (ok) setDraft(current => ({ ...(current.actual === pending.actual ? {} : { actual: current.actual }), ...(current.memo === pending.memo ? {} : { memo: current.memo }) })); });
  };
  const editDraft = (patch: { actual?: number | null; memo?: string }) => { setDraft(current => ({ ...current, ...patch })); clearTimeout(draftTimer.current); draftTimer.current = setTimeout(flushDraft, 700); };
  // Leaving the overlay sends a count that is still waiting for its pause; the effect must run its cleanup on unmount only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (http) flushDraft(); }, []);
  const drawerCommand = (command: DrawerInput, message?: string): boolean | Promise<boolean> => {
    if (readOnly) return false;
    if (http) return httpDrawer(command);
    const read = runtime.read(), result = runtime.execute({ ...command, meta: { runId: read.runId, idempotencyKey: `drawer-ui:${++keySequence}` } } as PosDrawerCommand);
    if (!result.ok) { run.actions.showNotice({ kind: 'error', messageKey: result.messageKey }); return false; }
    if (message && result.status === 'applied') run.actions.showNotice({ kind: 'complete', messageKey: 'pos.notice', params: { message }, ...(result.undoToken ? { undo: { target: 'pos', token: result.undoToken } } : {}) });
    return true;
  };
  const afterDrawer = (outcome: boolean | Promise<boolean>, done: () => void) => { if (outcome instanceof Promise) void outcome.then(ok => { if (ok) done(); }); else if (outcome) done(); };
  const process = () => {
    const current = run.getState(); if (current.overlay.type !== 'closing' || current.overlay.readOnly || (!http && resolveClosingVariant(current.preview) === 'error') || accounting && accounting.status !== 'ready') return;
    if (http) {
      if (!fin || busy) return;
      const key = `${fin.closing.closingId ?? TODAY}:${fin.closing.revision}`;
      if (closed) {
        if (!fin.closing.closingId) return;
        // Reopening the day is confirmed by a second press (the service requires `confirmed`).
        if (!confirmReopen) { setConfirmReopen(true); return; }
        setConfirmReopen(false);
        void sendHttp({ type: 'closing.undoDay', date: TODAY, scenario: 'normal', closingId: fin.closing.closingId, idempotencyKey: `reopen:${key}` });
      } else if (!cannotClose) void sendHttp({ type: 'closing.closeDay', date: TODAY, scenario: 'normal', expectedGeneration: fin.closing.revision, idempotencyKey: `close:${key}` });
      return;
    }
    const latest = selectClosing(store.getSnapshot(), { date: TODAY, scenario });
    if (closed) { if (latest.status !== 'closed' || !latest.closingId) return; notify(store.dispatch({ type: 'closing.undoDay', date: TODAY, scenario, closingId: latest.closingId, idempotencyKey: `${latest.closingId}:undo` })); }
    else { if (cannotClose || latest.status === 'closed' || latest.generation !== closing.generation) return; notify(store.dispatch({ type: 'closing.closeDay', date: TODAY, scenario, expectedGeneration: latest.generation, idempotencyKey: `${state.runId}:closing:${scenario}:${++keySequence}` })); }
  };
  type Row = typeof payments.rows[number];
  const columns = useMemo<readonly GridColumn<Row>[]>(() => {
    const content = (r: Row) => {
      const lines = r.lines.map(line => { const menu = snapshot.tables.menuItem.find(item => item.menuId === line.menuId); return menu ? `${resolveDataText(t, menu.name ?? { key: menu.nameKey })} ${line.qty}` : null; });
      return lines.length && lines.every(line => line !== null) ? lines.join(', ') : resolveDataText(t, r.summary);
    };
    return [
      { id: 'time', header: t('closing.time'), kind: 'text', value: r => r.time, minWidth: layoutTokens.targetDefault * 2, sortable: true },
      { id: 'transaction', header: t('closing.transaction'), kind: 'text', value: r => r.transactionNo ?? '', minWidth: layoutTokens.targetDefault * 4 },
      { id: 'order', header: t('closing.orderNo'), kind: 'text', value: r => r.orderNos?.map(n => `#${n}`).join(' · ') ?? '', minWidth: layoutTokens.targetDefault * 2 },
      { id: 'amount', header: t('closing.amount'), kind: 'number', value: r => r.visibleAmount, render: r => <><PosMoney amount={r.visibleAmount}/>{method && method !== 'mixed' && (r.methodSplits?.length ?? 0) > 1 ? <small>{t('closing.mixedPart')}</small> : null}{r.status === 'canceled' && r.originalAmount !== undefined ? <small>{full(r.originalAmount)}</small> : null}</>, accessibleValue: r => state.locale === 'ko' ? full(r.visibleAmount) : String(r.visibleAmount), minWidth: layoutTokens.targetDefault * 3, sortable: true },
      { id: 'method', header: t('closing.method'), kind: 'text', value: r => r.method, render: r => (r.methodSplits?.length ?? 0) > 1 ? r.methodSplits!.map(s => t(`closing.${s.method}`)).join(' · ') : t(`closing.${r.method}`), accessibleValue: r => state.locale === 'ko' ? ((r.methodSplits?.length ?? 0) > 1 ? r.methodSplits!.map(s => t(`closing.${s.method}`)).join(' · ') : t(`closing.${r.method}`)) : r.method, minWidth: layoutTokens.targetDefault * 3, sortable: true },
      { id: 'content', header: t('closing.content'), kind: 'text', value: content, render: r => { const text = content(r); return <span lang={/[가-힣]/u.test(text) ? 'ko' : undefined}>{text}</span>; }, minWidth: layoutTokens.targetDefault * 4 },
      { id: 'status', header: t('closing.status'), kind: 'status', value: r => r.kind, render: r => <>{r.kind !== 'payment' ? <StatusChip>{t(r.kind === 'cancel' ? 'closing.cancel' : 'closing.refund')}</StatusChip> : r.status && r.status !== 'paid' ? <StatusChip>{t(`pos.${r.status}`)}</StatusChip> : null}{r.restockRetail ? <small>{t('closing.restocked')}</small> : null}</>, accessibleValue: r => state.locale === 'ko' ? (r.kind !== 'payment' ? t(r.kind === 'cancel' ? 'closing.cancel' : 'closing.refund') : r.status && r.status !== 'paid' ? t(`pos.${r.status}`) : t('closing.payment')) : r.kind, minWidth: layoutTokens.targetDefault * 2, sortable: true },
    ];
  }, [t, format, snapshot.tables.menuItem, method, state.locale]);
  const receipt = (id: string | null) => {
    const targetId = id ?? selected;
    if (!targetId) return;
    const row = payments.rows.find(r => r.paymentId === targetId);
    if (!row) { setSelected(null); return; }
    const paymentId = row.kind === 'payment' ? row.paymentId : row?.refundOf;
    if (!paymentId || !selectReceipt(runtime.read(), { paymentId })) return;
    setSelected(targetId); onOpenReceipt({ paymentId, view: 'receipt' });
  };
  if (!descriptor) return null;
  const error = <InlineError message={t('closing.error')} onRetry={run.actions.resetClosingPreview}/>;
  const value = (slotId: string, semanticValue: number, children: React.ReactNode) => <VisibleValue slot={{ slotId: `closing:${slotId}`, featureId: 'ledger', scope: 'detail', semanticValue, visible: active && tab === 'sales' }}>{children}</VisibleValue>;
  const summary = accounting ? <SalesDepositSplitCard stacked view={variant === 'error' ? { status: 'error', period: accounting.period } : scenario === 'empty' ? { status: 'empty', period: accounting.period } : accounting} onRetry={presentation?.onRetry ?? run.actions.resetClosingPreview} /> : <div className="app-closing-summary"><section aria-label={t('closing.sales')}><h3>{t('closing.sales')}</h3>{variant === 'error' || scenario === 'empty' ? <p>—</p> : <>
    <div className="app-closing-total">{value('net', totals.revenue, money(totals.revenue))}</div><p>{full(totals.revenue)}</p>
    <p>{t('pos.salesCalculation', { gross: money(totals.gross), discount: money(totals.discount), refund: money(totals.refund) })}</p>
    <p>{t('pos.discountComposition', { membership: full(totals.discountBySource.membership), coupon: full(totals.discountBySource.coupon), direct: full(totals.discountBySource.direct) })}</p>
    <p>{t('closing.counts', { payments: totals.paymentCount, charged: money(totals.charged), refunds: totals.refundCount, refund: money(totals.refund), cancels: totals.cancelCount, canceled: money(totals.canceled) })}</p>
    {closing.received > 0 ? <p>{t('pos.pendingReceived', { n: closing.pendingBills.length, amount: full(closing.received) })}</p> : null}
    <CustomClosingSales date={TODAY} />
    <h3>{t('closing.byMethod')}</h3><dl>{methods.map(m => <div key={m}><dt>{t(`closing.${m}`)}</dt><dd>{value(m, totals.byMethod[m], money(totals.byMethod[m]))} <span>{t('closing.count', { n: totals.methodCounts[m] })}</span>{closed ? <ConfirmedMark/> : null}</dd></div>)}</dl>
  </>}</section></div>;
  const filters: readonly Filter[] = [undefined, ...methods, 'mixed'];
  const details = accounting ? accounting.status === 'ready' && variant !== 'error' && scenario !== 'empty' ? <AccountingTransactions rows={accounting.transactions} onOpenReceipt={onOpenAccountingReceipt ?? presentation?.onOpenReceipt} /> : null : <div className="app-closing-payments"><h3>{t('closing.payments')}</h3>{variant === 'error' ? error : <DataGrid id="closing-payments" label={t('closing.payments')} rows={rows} getRowId={r => r.paymentId} getRowLabel={r => r.time} columns={columns} sort={sort} onSortChange={setSort} filters={method ? { method } : {}} selectedRowId={selected} onSelectionChange={receipt} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} renderFilters={() => <div className="app-closing-filters" role="radiogroup" aria-label={t('closing.method')}>{filters.map((m, index) => <ActionButton key={m ?? 'all'} variant="outline" role="radio" aria-checked={method === m} tabIndex={method === m ? 0 : -1} onKeyDown={e => { if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); const next = (index + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + filters.length) % filters.length; setMethod(filters[next]); (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus(); } }} onClick={() => setMethod(m)}>{method === m ? <Icon name="check" width={16} height={16}/> : null}{t(m ? `closing.${m}` : 'closing.all')}</ActionButton>)}</div>} emptyContent={<InlineEmpty title={t(scenario === 'empty' ? 'closing.empty' : method === 'mixed' ? 'closing.mixedEmpty' : 'closing.filteredEmpty')}/>}/>}</div>;
  // A typed count shows at once; its difference is the owner's arithmetic until the service answers with its own.
  const shownActual = http && draft.actual !== undefined ? draft.actual : drawer.actual;
  const cashRows: CashDrawerRow[] = [
    { id: 'opening', label: t('closing.opening'), amount: drawer.opening, action: readOnly ? undefined : { label: t('closing.edit'), onPress: () => { setOpening(drawer.opening); setInputError(''); setEditOpening(true); } } },
    { id: 'payments', label: accounting ? accountingCopy.actualCash : t('closing.cashPayments'), amount: accounting ? drawer.approvedCash : drawer.cashPayments, sign: 'plus' },
    ...(!accounting && drawer.pendingCash ? [{ id: 'pending', label: t('closing.pendingCash'), amount: drawer.pendingCash, sign: 'plus' as const, note: t('closing.notRevenue') }] : []),
    { id: 'returned', label: t('closing.cashReturned'), amount: drawer.cashReturned, sign: 'minus' },
    { id: 'in', label: t('closing.in'), amount: drawer.in, sign: 'plus' },
    { id: 'out', label: t('closing.out'), amount: drawer.out, sign: 'minus' },
  ];
  const movements = <div className="app-closing-payments"><h3>{t('closing.movements')}</h3><div className="app-closing-filters">{(['in', 'out'] as const).map(kind => <ActionButton key={kind} variant="secondary" disabled={readOnly || closed || scenario === 'empty'} onClick={() => { setMovement(kind); setAmount(null); setMemo(''); setInputError(''); }}>{t(kind === 'in' ? 'closing.addIn' : 'closing.addOut')}</ActionButton>)}</div>
    {movement && !closed ? <InlineForm title={t(movement === 'in' ? 'closing.addIn' : 'closing.addOut')} onSave={() => { if (amount === null || !Number.isSafeInteger(amount) || amount < 1) { setInputError(t('closing.invalidMovement')); return; } afterDrawer(drawerCommand({ type: 'drawer.addMovement', kind: movement, amount, memo }, t('pos.changed')), () => setMovement(null)); }} onClose={() => setMovement(null)}><NumberField label={t('closing.amount')} unit={t('closing.won')} min={1} value={amount} onValueChange={setAmount} error={inputError || undefined}/><TextField label={t('closing.memo')} value={memo} onValueChange={v => setMemo(v.slice(0, 100))}/></InlineForm> : null}
    <DataGrid id="closing-movements" label={t('closing.movements')} rows={drawer.movements} getRowId={r => r.movementId} getRowLabel={r => r.at.slice(11, 16)} columns={[
      { id: 'time', header: t('closing.time'), kind: 'text', value: r => r.at.slice(11, 16), minWidth: layoutTokens.targetDefault * 2 },
      { id: 'kind', header: t('closing.status'), kind: 'text', value: r => t(`closing.${r.kind}`), minWidth: layoutTokens.targetDefault * 2 },
      { id: 'amount', header: t('closing.amount'), kind: 'number', value: r => `${r.kind === 'out' ? '−' : '+'}${full(r.amount)}`, minWidth: layoutTokens.targetDefault * 3 },
      { id: 'memo', header: t('closing.memo'), kind: 'text', value: r => r.memo, minWidth: layoutTokens.targetDefault * 4 },
    ]} sort={null} onSortChange={() => {}} selectedRowId={null} expandedRowIds={new Set()} focus={movementFocus} onFocusChange={setMovementFocus} getRowActions={r => [{ id: 'delete', label: http && confirmRemove === r.movementId ? t('closing.removeConfirm') : t('closing.remove'), disabled: readOnly || closed || busy, onPress: () => {
      if (http) { if (confirmRemove !== r.movementId) { setConfirmRemove(r.movementId); return; } setConfirmRemove(null); }
      drawerCommand({ type: 'drawer.removeMovement', movementId: r.movementId }, t('closing.removed', { kind: t(`closing.${r.kind}`) }));
    } }]} emptyContent={<InlineEmpty title={t('closing.noMovements')}/>}/>
  </div>;
  const cash = accounting && (accounting.status !== 'ready' || !accounting.drawer) ? <InlineEmpty title={accountingCopy.unavailable} /> : <><ClosingColumns summary={<div className="app-closing-cash">{closed ? <p>{t('closing.cashClosed')}</p> : null}{editOpening && !closed ? <InlineForm title={t('closing.opening')} onSave={() => { if (opening === null || !Number.isSafeInteger(opening) || opening < 0) { setInputError(t('closing.invalidCash')); return; } afterDrawer(drawerCommand({ type: 'drawer.set', opening }, t('pos.changed')), () => setEditOpening(false)); }} onClose={() => setEditOpening(false)}><NumberField label={t('closing.opening')} value={opening} min={0} onValueChange={setOpening} error={inputError || undefined}/></InlineForm> : null}<CashDrawerCalc rows={cashRows} expected={drawer.expected} actual={shownActual} difference={shownActual === null ? null : http && draft.actual !== undefined ? shownActual - drawer.expected : drawer.difference} closed={readOnly || closed || scenario === 'empty'} onActualChange={actual => { if (http) editDraft({ actual }); else drawerCommand({ type: 'drawer.set', actual }); }} memo={http && draft.memo !== undefined ? draft.memo : drawer.memo} onMemoChange={memo => { if (http) editDraft({ memo: memo.slice(0, 100) }); else drawerCommand({ type: 'drawer.set', memo: memo.slice(0, 100) }); }}/></div>} payments={movements}/></>;
  type HistoryRow = typeof closing.history[number];
  const historyRow = closing.history.find(r => r.businessDate === historyId);
  const frozenAccounting = (date: string) => (accountingHistory ?? presentation?.history)?.find(view => view.period.start === date && view.period.end === date);
  const historyAccounting = historyRow ? frozenAccounting(historyRow.businessDate) : undefined;
  const history = <div className="app-closing-history"><DataGrid id="closing-history" label={t('closing.history')} rows={closing.history} getRowId={r => r.businessDate} getRowLabel={r => format.date(r.businessDate, 'short')} columns={[
    { id: 'date', header: t('closing.date'), kind: 'text', value: (r: HistoryRow) => format.date(r.businessDate, 'short'), minWidth: layoutTokens.targetDefault * 3 },
    { id: 'sales', header: t('closing.sales'), kind: 'number', value: r => { const frozen = frozenAccounting(r.businessDate); return money(frozen?.status === 'ready' ? frozen.summary.sales.total : r.revenue); }, minWidth: layoutTokens.targetDefault * 3 },
    ...(accounting ? [{ id: 'deposits', header: accountingCopy.deposits, kind: 'number' as const, value: (r: HistoryRow) => { const frozen = frozenAccounting(r.businessDate); return frozen?.status === 'ready' ? full(frozen.summary.deposits.total) : '—'; }, minWidth: layoutTokens.targetDefault * 3 }] : []),
    { id: 'count', header: t('closing.paymentCount'), kind: 'number', value: r => r.paymentCount, minWidth: layoutTokens.targetDefault * 2 },
    { id: 'difference', header: t('closing.difference'), kind: 'number', value: r => r.cashDrawer.difference === null ? t('pos.cashUnchecked') : signed(r.cashDrawer.difference), render: r => <span data-tone={r.cashDrawer.difference !== null && r.cashDrawer.difference < 0 ? 'short' : 'neutral'}>{r.cashDrawer.difference ? <Icon name={r.cashDrawer.difference < 0 ? 'warning' : 'info'}/> : null}{r.cashDrawer.difference === null ? t('pos.cashUnchecked') : signed(r.cashDrawer.difference)}</span>, minWidth: layoutTokens.targetDefault * 3 },
    { id: 'time', header: t('closing.closedAt'), kind: 'text', value: r => r.closedAt.slice(11, 16), minWidth: layoutTokens.targetDefault * 2 },
  ]} sort={null} onSortChange={() => {}} selectedRowId={historyId} onSelectionChange={setHistoryId} expandedRowIds={new Set()} focus={historyFocus} onFocusChange={setHistoryFocus} emptyContent={<InlineEmpty title={t('closing.historyEmpty')}/>}/>
    <DetailSidePanel open={!!historyRow} selectedRowId={historyId} title={historyRow ? format.date(historyRow.businessDate, 'long') : t('closing.history')} onClose={() => setHistoryId(null)} returnFocusKey={historyId ?? ''} onRestoreFocus={id => popup?.querySelector<HTMLElement>(`[data-grid-row-id="${id}"][data-grid-column-id="date"]`)?.focus()}>{historyRow ? <div className="app-closing-history-detail">{accounting ? historyAccounting ? <SalesDepositSplitCard stacked view={historyAccounting} /> : <p lang="ko">{accountingCopy.unavailable}</p> : null}{historyAccounting?.status !== 'ready' ? <><h4>{t('closing.byMethod')}</h4>{methods.map(m => <p key={m}>{t(`closing.${m}`)} {full(historyRow.byMethod[m])}</p>)}<p>{t('pos.salesCalculation', { gross: full(historyRow.gross), discount: full(historyRow.discount), refund: full(historyRow.refund) })}</p></> : null}{(['opening', 'expected', 'actual', 'difference'] as const).map(key => <p key={key}>{t(`closing.${key}`)} {historyRow.cashDrawer[key] === null ? t('pos.cashUnchecked') : signed(historyRow.cashDrawer[key]!)}</p>)}<p>{t('closing.cashMemo')} {historyRow.cashDrawer.memo}</p>{!historyRow.today ? <p>{t('closing.historyNote')}</p> : null}</div> : null}</DetailSidePanel>
  </div>;
  const waiting = loading ? (money$.status === 'error' ? <InlineError message={t('closing.error')} onRetry={retryMoney} /> : <p role="status" aria-live="polite">{t('closing.loading')}</p>) : null;
  const body = waiting ?? <div className="app-closing-i6"><DetailTabs value={tab} onValueChange={setTab} label={t('closing.tabs')} tabs={(['sales', 'drawer', 'history'] as const).map(value => ({ value, label: t(`closing.${value}`) }))}/><div className="app-closing-i6__panel" role="tabpanel" aria-label={t(`closing.${tab}`)}>{tab === 'sales' ? <ClosingColumns summary={summary} payments={details}/> : variant === 'error' ? error : tab === 'drawer' ? cash : history}</div></div>;
  const footer = <><div className="app-closing-i6__process"><div><ClosedDayState closed={closed}/>{variant === 'error' ? <p>{t('closing.blocked')}</p> : null}{!closed && cannotClose ? <div lang="ko"><p><Icon name="warning"/>{t('pos.unpaidBlock', { n: blockedCount })}</p><ActionButton variant="secondary" onClick={() => openUnpaidOrders(run)}>{t('pos.showOrders')}</ActionButton></div> : null}</div><ActionButton key={closed ? 'undo' : 'close'} ref={processButton} size="primary" variant={closed ? 'secondary' : 'default'} disabled={readOnly || busy || loading || variant === 'error' || !!accounting && accounting.status !== 'ready' || !closed && cannotClose} aria-busy={busy || undefined} onKeyDown={event => { if (event.repeat) event.preventDefault(); }} onClick={event => { if (event.detail > 1) return; const focused = document.activeElement === event.currentTarget; process(); if (focused) queueMicrotask(() => processButton.current?.focus({ preventScroll: true })); }}>{t(closed ? (confirmReopen ? 'closing.undoConfirm' : 'closing.undo') : 'closing.close')}</ActionButton></div></>;
  if (!active && state.exitPendingToken) return <OverlayExitSurface token={state.exitPendingToken} kind="closing" onComplete={run.actions.finishOverlayExit}><div className="ui-overlay-body">{body}</div><footer className="ui-overlay-note">{footer}</footer></OverlayExitSurface>;
  const parent = descriptor.type === 'closing' && descriptor.returnTo;
  return <ClosingDialog open popupRef={setPopup} returnFocusRef={returnFocus} onClose={(reason, event) => run.actions.closeOverlay(reason, event instanceof KeyboardEvent ? { kind: 'keyboard', id: event.code || event.key } : undefined)} headerAction={parent ? <ActionButton variant="ghost" onClick={() => run.actions.closeOverlay('button')}>{t('common.back')}</ActionButton> : null} footer={footer}>{body}</ClosingDialog>;
}
