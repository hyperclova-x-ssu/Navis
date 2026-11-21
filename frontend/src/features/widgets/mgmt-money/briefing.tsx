/** 출근·퇴근 화면은 공용 브리핑 selector가 만든 같은 snapshot을 사용한다. */
import { useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { QueryCondition, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetDataStore, useWidgetView } from '../../../data/react';
import { TODAY, posFacts, resolveDataText, type BriefingModel } from '../../../data/widget-data';
import { ActionButton, DetailTabs, Icon, StatusBadge } from '../../../ui';
import { DetailViewState, Kpi, MoneyPanel, NoteLine, ViewState, addIsoDays, splitMoney, useMoneyT, useSizeCtx, type RowData, type T } from './shared';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { posDataBundle } from '../../../data/messages/pos';
import { PosContext } from '../../../pos/react';
import { orderStatusRuntime } from '../../../pos/runtime';
import { ValueSlot } from './value-slot';
import { keepDots } from './fit';
import { briefingBundle } from '../../../screens/briefing/messages';
import { accountingForPeriod, SalesDepositSplitCard, useAccountingPresentation } from './ledger';

const ID = 'briefing' as const;
function useBriefingMoneyT(): T {
  const base = useMoneyT(), pos = useBundle(posDataBundle, posBundle, briefingBundle);
  return Object.assign((key: string, params?: Parameters<T>[1]) => pos.has(key) ? keepDots(pos.t(key as keyof typeof posDataBundle.ko | keyof typeof posBundle.ko | keyof typeof briefingBundle.ko, params)) : base(key, params), { format: base.format, locale: base.locale });
}
const groupName = (t: T, id: string) => t(`widget.briefing.${id}`);
type Alert = BriefingModel['importantAlerts']['groups'][number]['items'][number];
/** The value or status that sits at the right end of an alert row (SCR-226 G-13: no row without one). */
interface Trailing { readonly kind: 'value' | 'chip'; readonly text: string; readonly semantic?: 'waiting' | 'warning' }
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** The data layer hands the closure date over as `MM/DD`; the next such day is meant, so the year rolls over when it already passed. */
const closureDate = (monthDay: string) => {
  const [month = '1', day = '1'] = monthDay.split('/');
  const year = Number(TODAY.slice(0, 4)) + (`${month.padStart(2, '0')}-${day.padStart(2, '0')}` < TODAY.slice(5) ? 1 : 0);
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
};
function useAlertText(t: T) {
  const tax = useWidgetView('tax'), suppliers = useWidgetView('suppliers'), stock = useWidgetView('inventory-booking'), grants = useWidgetView('grants');
  const alertText = (item: Alert): string => {
    const ref = item.ref;
    if ('sourceId' in ref) return t(item.messageKey, item.params);
    if (item.id.startsWith('tax:') && tax.status === 'ready') { const payment = tax.model.payments.find(p => p.taxPaymentId === ref.itemId); if (payment) return t('widget.briefing.taxItem', { name: resolveDataText(t, payment.type), amount: t.format.money(payment.amount, 'compact'), date: t.format.date(payment.dueOn, 'short') }); }
    if (item.id.startsWith('order:') && suppliers.status === 'ready') { const order = suppliers.model.orders.find(o => o.poId === ref.itemId); const line = order?.lines[0]; if (order && line && !order.overdue) return t('widget.briefing.deliveryItem', { name: t(line.itemNameKey), quantity: t.format.quantity(line.remaining, line.unit) }); }
    if (item.id.startsWith('stock:') && stock.status === 'ready') { const out = stock.model.ingredients.find(i => i.outOfStock); if (out) return t('widget.briefing.stockItem', { count: stock.model.restockCount, name: out.name ? resolveDataText(t, out.name) : t(out.nameKey) }); }
    if (item.id.startsWith('grant:') && grants.status === 'ready') { const grant = grants.model.notices.find(n => n.noticeId === ref.itemId); if (grant) return t('widget.briefing.grantItem', { name: t(grant.titleKey), date: t.format.date(grant.applyEndDate, 'short') }); }
    if (item.id.startsWith('closure:') && typeof item.params?.date === 'string') return t(item.messageKey, { ...item.params, date: t.format.date(closureDate(item.params.date), 'short') });
    return t(item.messageKey, item.params);
  };
  const daysLeft = (iso: string): Trailing => { const n = dayDiff(TODAY, iso); return { kind: 'chip', semantic: 'waiting', text: n <= 0 ? t('widget.briefing.dueToday') : t('widget.briefing.daysLeft', { n }) }; };
  const needsCheck: Trailing = { kind: 'chip', semantic: 'warning', text: t('widget.briefing.needsCheck') };
  const trailing = (item: Alert): Trailing => {
    const ref = item.ref;
    if ('sourceId' in ref) return { kind: 'value', text: t('widget.briefing.minutes', { n: Number(item.params?.n ?? 0) }) };
    if (item.id.startsWith('tax:') && tax.status === 'ready') { const payment = tax.model.payments.find(p => p.taxPaymentId === ref.itemId); if (payment) return daysLeft(payment.dueOn); }
    if (item.id.startsWith('order:') && suppliers.status === 'ready') { const order = suppliers.model.orders.find(o => o.poId === ref.itemId); const line = order?.lines[0]; if (order && line && !order.overdue) return { kind: 'value', text: t.format.quantity(line.remaining, line.unit) }; }
    if (item.id.startsWith('stock:') && stock.status === 'ready') return { kind: 'value', text: t('widget.briefing.itemsCount', { n: stock.model.restockCount }) };
    if (item.id.startsWith('grant:') && grants.status === 'ready') { const grant = grants.model.notices.find(n => n.noticeId === ref.itemId); if (grant) return daysLeft(grant.applyEndDate); }
    if (item.id.startsWith('closure:')) return { kind: 'chip', semantic: 'waiting', text: t('widget.briefing.notSent') };
    if (item.id.startsWith('manual:') && item.params) return { kind: 'value', text: `${item.params.done}/${item.params.total}` };
    return needsCheck;
  };
  return Object.assign(alertText, { trailing, meaning: (item: Alert): string => {
    let source: unknown = item.params ?? item.messageKey;
    const ref = item.ref;
    if ('sourceId' in ref) return JSON.stringify([item.id, source]);
    if (item.id.startsWith('tax:') && tax.status === 'ready') { const payment = tax.model.payments.find(p => p.taxPaymentId === ref.itemId); if (payment) source = [payment.type, payment.amount, payment.dueOn, payment.status]; }
    if (item.id.startsWith('order:') && suppliers.status === 'ready') { const order = suppliers.model.orders.find(o => o.poId === ref.itemId); if (order) source = [order.overdue, order.dueDate, order.lines.map(line => [line.itemId, line.remaining, line.unit])]; }
    if (item.id.startsWith('stock:') && stock.status === 'ready') source = [stock.model.restockCount, stock.model.ingredients.filter(row => row.outOfStock).map(row => row.itemId)];
    if (item.id.startsWith('grant:') && grants.status === 'ready') { const grant = grants.model.notices.find(n => n.noticeId === ref.itemId); if (grant) source = [grant.titleKey, grant.applyEndDate]; }
    return JSON.stringify([item.id, source]);
  } });
}

export function BriefingPanel(props: WidgetPanelProps) {
  const t = useBriefingMoneyT();
  const ctx = useSizeCtx(props);
  const view = useWidgetView(ID, props.condition);
  const alertText = useAlertText(t);
  if (view.status !== 'ready') return <ViewState view={view} ctx={ctx} host={props.host} featureId={ID} t={t} />;
  const { importantAlerts } = view.model;
  const groupRows: RowData[] = importantAlerts.groups.map(group => ({ id: group.id, name: groupName(t, group.id), value: group.items.map(alertText).join('\u00a0·\u00a0'), semanticValue: JSON.stringify(group.items.map(alertText.meaning)) }));
  const rows: RowData[] = ctx.shape === 'S' || ctx.shape === 'L' ? [
    { id: 'schedules', name: t('widget.briefing.schedule'), value: `${t('widget.briefing.todaySchedule', { n: view.model.schedules.todayCount })} · ${t(view.model.staff.today.nextHandoffAt ? 'briefing.staffHandoff' : 'briefing.staffCount', { n: view.model.staff.today.workingCount, time: view.model.staff.today.nextHandoffAt ?? '' })}`, semanticValue: `${view.model.schedules.todayCount}/${view.model.staff.today.workingCount}/${view.model.staff.today.nextHandoffAt ?? ''}` },
    { id: 'reservations', name: t('widget.briefing.reservations'), value: t('widget.briefing.todayReservations', { count: view.model.reservations.count, people: view.model.reservations.partyTotal }), semanticValue: `${view.model.reservations.count}/${view.model.reservations.partyTotal}` },
    { id: 'pickups', name: t('widget.custom-order.title'), value: t('briefing.pickupToday', { n: view.model.custom.summary.todayPickup }), semanticValue: view.model.custom.summary.todayPickup },
    ...groupRows,
  ] : groupRows;
  return <MoneyPanel spec={{ slot: ID, label: t('widget.briefing.alerts'), value: importantAlerts.count ? String(importantAlerts.count) : t('data.state.briefing.none'), semanticValue: importantAlerts.count, unit: importantAlerts.count ? t('widget.briefing.unit', { n: importantAlerts.count }) : undefined, textValue: !importantAlerts.count, inlineUnit: true, rows, status: <NoteLine notes={view.notes} t={t} /> }} ctx={ctx} />;
}
export function useBriefingSummary({ condition }: { featureId: unknown; condition: QueryCondition }): string {
  const t = useBriefingMoneyT();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return t(view.messageKey);
  return view.model.importantAlerts.count ? t('widget.briefing.alertSummary', { n: view.model.importantAlerts.count }) : t('data.state.briefing.none');
}

function BriefingRow({ children, lang }: { children: ReactNode; lang?: string }) {
  return <li className="mm-briefing-row" lang={lang}>{children}</li>;
}

function SourceRow({ host, target, children, trailing }: { host: WidgetDetailProps['host']; target: Alert['ref']; children: ReactNode; trailing?: Trailing }) {
  const runtime = useContext(PosContext), pos = runtime ? orderStatusRuntime(runtime) : null;
  return <BriefingRow>
    <ActionButton variant="ghost" className="mm-briefing-link" onClick={() => 'sourceId' in target ? pos?.openPos({ tab: 'status', orderId: target.orderId, forceVisible: true }) : host.openLinked(target)}>
      <span className="mm-briefing-link__text">{children}</span>
      <span className="mm-briefing-link__end">
        {trailing ? trailing.kind === 'chip' ? <StatusBadge semantic={trailing.semantic} label={trailing.text} /> : <strong className="mm-briefing-link__value">{trailing.text}</strong> : null}
        <Icon name="chevron-right" aria-hidden />
      </span>
    </ActionButton>
  </BriefingRow>;
}

/** Entries of other days that belong in the schedule card: not shifts, pickups or reservations (they have their own cards). */
const PLANNED_SOURCES = new Set(['delivery', 'deadline', 'direct']);
function Arrival({ model, host, t }: { model: BriefingModel; host: WidgetDetailProps['host']; t: T }) {
  const alertText = useAlertText(t);
  const tax = useWidgetView('tax');
  const { schedules, reservations, importantAlerts } = model;
  const { workingCount, nextHandoffAt } = model.staff.today;
  const weekEnd = addIsoDays(TODAY, 7);
  const ahead = schedules.monthEntries.filter(entry => entry.date > TODAY && PLANNED_SOURCES.has(entry.source)).sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
  const planned = ahead.filter(entry => entry.date <= weekEnd).slice(0, 3);
  const nextTax = tax.status === 'ready' ? tax.model.payments.filter(p => p.status === 'unpaid' && p.dueOn > TODAY).sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0] : undefined;
  const later = ahead.filter(entry => entry.date > weekEnd).slice(0, nextTax ? 2 : 3);
  return <>
    <section className="mm-card mm-briefing-card">
      <h3 className="mm-card__title">{t('widget.briefing.schedule')}</h3>
      <h4 className="mm-card__subtitle">{t('widget.briefing.scheduleToday')}</h4>
      <ul className="mm-briefing-list" role="list">
        <SourceRow host={host} target={{ featureId: 'calendar' }}>
          <ValueSlot slotId="briefing.detail.schedules" featureId={ID} scope="detail" semanticValue={schedules.todayCount}>
            {t('widget.briefing.todaySchedule', { n: schedules.todayCount })}
          </ValueSlot>
        </SourceRow>
        <BriefingRow lang="ko">{t(nextHandoffAt ? 'briefing.staffHandoff' : 'briefing.staffCount', { n: workingCount, time: nextHandoffAt ?? '' })}</BriefingRow>
        {schedules.todayEntries.map(entry => (
          <BriefingRow key={entry.id}>{t.format.date(entry.date, 'short')} {resolveDataText(t, entry.title)}</BriefingRow>
        ))}
      </ul>
      {planned.length ? <>
        <h4 className="mm-card__subtitle">{t('widget.briefing.scheduleUpcoming')}</h4>
        <ul className="mm-briefing-list" role="list" data-slot="briefing.planned">
          {planned.map(entry => <BriefingRow key={entry.id}>{t.format.date(entry.date, 'short')} {resolveDataText(t, entry.title)}</BriefingRow>)}
        </ul>
      </> : null}
      {nextTax || later.length ? <>
        <h4 className="mm-card__subtitle">{t('widget.briefing.scheduleLater')}</h4>
        <ul className="mm-briefing-list" role="list" data-slot="briefing.later">
          {nextTax ? <SourceRow host={host} target={{ featureId: 'tax', itemId: nextTax.taxPaymentId }}>{t('widget.briefing.taxItem', { name: resolveDataText(t, nextTax.type), amount: t.format.money(nextTax.amount, 'compact'), date: t.format.date(nextTax.dueOn, 'short') })}</SourceRow> : null}
          {later.map(entry => <BriefingRow key={entry.id}>{t.format.date(entry.date, 'short')} {resolveDataText(t, entry.title)}</BriefingRow>)}
        </ul>
      </> : null}
    </section>
    <section className="mm-card mm-briefing-card">
      <h3 className="mm-card__title">{t('widget.briefing.reservations')}</h3>
      <ul className="mm-briefing-list" role="list">
        <SourceRow host={host} target={{ featureId: 'voice-booking' }}>
          <ValueSlot slotId="briefing.detail.reservations" featureId={ID} scope="detail" semanticValue={`${reservations.count}/${reservations.partyTotal}`}>
            {t('widget.briefing.todayReservations', { count: reservations.count, people: reservations.partyTotal })}
          </ValueSlot>
        </SourceRow>
        {reservations.completedCount > 0 ? <BriefingRow lang="ko">{t('data.pos.completedVisits', { n: reservations.completedCount })}</BriefingRow> : null}
        <BriefingRow>
          <ValueSlot slotId="briefing.detail.changes" featureId={ID} scope="detail" semanticValue={reservations.changes}>
            {t('widget.briefing.changes', { n: reservations.changes })}
          </ValueSlot>
        </BriefingRow>
        <SourceRow host={host} target={{ featureId: 'voice-booking' }}>{t('briefing.pickupToday', { n: model.custom.summary.todayPickup })}</SourceRow>
        <BriefingRow lang="ko">{t('briefing.customPending', { n: model.custom.summary.approvalPending, m: model.custom.summary.todayNotComplete })}</BriefingRow>
        {reservations.timeGroups.map(group => (
          <BriefingRow key={group.time}>
            <ValueSlot slotId={`briefing.detail.time.${group.time}`} featureId={ID} scope="detail" semanticValue={`${group.count}/${group.partyTotal}`}>
              {t('widget.briefing.timeGroup', { time: group.time, count: group.count, people: group.partyTotal })}
            </ValueSlot>
          </BriefingRow>
        ))}
      </ul>
    </section>
    <section className="mm-card mm-briefing-card">
      <h3 className="mm-card__title">
        <ValueSlot slotId="briefing.detail.alerts" featureId={ID} scope="detail" semanticValue={importantAlerts.count}>
          {t('widget.briefing.alertSummary', { n: importantAlerts.count })}
        </ValueSlot>
      </h3>
      {importantAlerts.count === 0 ? (
        <ul className="mm-briefing-list" role="list"><BriefingRow>{t('data.state.briefing.none')}</BriefingRow></ul>
      ) : importantAlerts.groups.map(group => (
        <div key={group.id} className="mm-briefing-group" data-row-id={group.id}>
          <h4 className="mm-card__subtitle">{groupName(t, group.id)}</h4>
          <ul className="mm-briefing-list" role="list">
            {group.items.map(item => (
              <SourceRow key={item.id} host={host} target={item.ref} trailing={alertText.trailing(item)}>
                <ValueSlot slotId={`briefing.detail.alert.${item.id}`} featureId={ID} scope="detail" semanticValue={alertText.meaning(item)}>{alertText(item)}</ValueSlot>
              </SourceRow>
            ))}
          </ul>
        </div>
      ))}
    </section>
  </>;
}
/** A host without a run (previews, tests): nothing to follow. */
const NOT_TRACKED = { subscribe: () => () => undefined, getSnapshot: () => false };
export function BriefingDetail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useBriefingMoneyT();
  const presentation = useAccountingPresentation();
  const store = useWidgetDataStore(), snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const orderCount = posFacts(snapshot).find(fact => fact.key === 'orders.today.count')?.value ?? 0;
  const view = useWidgetView(ID, condition);
  // N19 deep link: a chat hand-off opens the 퇴근 tab ('closing') or the 출근 tab ('alerts', the default).
  const [tab, setTab] = useState<'arrival' | 'closing'>(detailRef?.view === 'closing' ? 'closing' : 'arrival');
  const [pressed, setPressed] = useState(false);
  // The run's briefing flag wins over this component's own press: the chat can acknowledge while this detail is open (D-327).
  const tracked = host.briefingAcknowledged ?? NOT_TRACKED;
  const acknowledgedInRun = useSyncExternalStore(tracked.subscribe, tracked.getSnapshot, tracked.getSnapshot);
  const acknowledged = pressed || acknowledgedInRun;
  if (view.status !== 'ready') return <div className="mm-detail" data-widget={ID}><DetailViewState view={view} host={host} t={t} /></div>;
  const model = view.model, sales = splitMoney(t, model.closingSummary.salesSnapshot.net), profit = splitMoney(t, model.closingSummary.netProfit);
  const accounting = accountingForPeriod(presentation, { start: TODAY, end: TODAY });
  const tomorrow = model.tomorrowReservations;
  return <div className="mm-detail mm-briefing-detail" data-widget={ID}>
    <DetailTabs value={tab} onValueChange={setTab} label={t('widget.briefing.tabs')} tabs={[{ value: 'arrival', label: t('widget.briefing.tabArrival') }, { value: 'closing', label: t('widget.briefing.tabClosing') }]} />
    <NoteLine notes={view.notes} t={t} />
    <div className="mm-briefing-body" tabIndex={0} role="region" aria-label={t(tab === 'arrival' ? 'widget.briefing.tabArrival' : 'widget.briefing.tabClosing')}>
      <Arrival model={model} host={host} t={t} />
      {tab === 'closing' ? <section className="mm-card mm-briefing-card" data-slot="briefing.closing">
        <h3 className="mm-card__title">{t('widget.briefing.closingTitle')}</h3>
        {accounting && <SalesDepositSplitCard view={accounting} onRetry={presentation?.onRetry} />}
        <div className="mm-kpis">
          {!accounting && <Kpi slot="briefing.kpi.sales" label={t('widget.ledger.todaySales')} value={sales.value} unit={sales.unit} semanticValue={model.closingSummary.salesSnapshot.net} />}
          <Kpi slot="briefing.kpi.remaining" label={t('widget.briefing.profit')} value={profit.value} unit={profit.unit} semanticValue={model.closingSummary.netProfit} />
        </div>
        <ul className="mm-briefing-list" role="list">
          <BriefingRow>
            <ValueSlot slotId="briefing.detail.closing.status" featureId={ID} scope="detail" semanticValue={model.closingSummary.status}>{t(model.closingSummary.status === 'closed' ? 'widget.briefing.closed' : 'widget.briefing.notClosed')}</ValueSlot>
          </BriefingRow>
          <BriefingRow>
            <ValueSlot slotId="briefing.detail.closing.payments" featureId={ID} scope="detail" semanticValue={model.closingSummary.salesSnapshot.paymentCount}>{t('widget.briefing.paymentCount', { n: model.closingSummary.salesSnapshot.paymentCount })}</ValueSlot>
          </BriefingRow>
          <BriefingRow lang="ko">
            <ValueSlot slotId="briefing.detail.closing.orders" featureId={ID} scope="detail" semanticValue={orderCount}>{t('widget.briefing.orderCount', { n: orderCount })}</ValueSlot>
          </BriefingRow>
          {model.closingSummary.drawer ? <BriefingRow lang="ko"><ValueSlot slotId="briefing.detail.closing.cash" featureId={ID} scope="detail" semanticValue={model.closingSummary.drawer.difference === null ? `${model.closingSummary.status}:unchecked` : model.closingSummary.drawer.difference}>{t(model.closingSummary.drawer.difference === null ? model.closingSummary.status === 'closed' ? 'pos.cashUnchecked' : 'pos.cashBefore' : model.closingSummary.drawer.difference === 0 ? 'pos.cashMatch' : model.closingSummary.drawer.difference < 0 ? 'pos.cashShort' : 'pos.cashOver', { amount: t.format.money(Math.abs(model.closingSummary.drawer.difference ?? 0), 'full') })}</ValueSlot></BriefingRow> : null}
          {model.closingSummary.status === 'closed' && !accounting ? (['card', 'easy_pay', 'cash'] as const).map(method => (
            <BriefingRow key={method}>
              <span>{t(`widget.ledger.method.${method === 'easy_pay' ? 'easyPay' : method}`)} <ValueSlot slotId={`briefing.detail.closing.method.${method}`} featureId={ID} scope="detail" semanticValue={model.closingSummary.salesSnapshot.byMethod[method]}>{t.format.money(model.closingSummary.salesSnapshot.byMethod[method], 'compact')}</ValueSlot></span>
            </BriefingRow>
          )) : null}
          <SourceRow host={host} target={{ featureId: 'calendar' }}>{t('widget.briefing.tomorrowSchedule')}</SourceRow>
          {model.schedules.entries.filter(entry => entry.date === addIsoDays(TODAY, 1)).map(entry => <BriefingRow key={entry.id}>{resolveDataText(t, entry.title)}</BriefingRow>)}
          <SourceRow host={host} target={{ featureId: 'voice-booking', date: addIsoDays(TODAY, 1) }}>
            <ValueSlot slotId="briefing.detail.tomorrow.reservations" featureId={ID} scope="detail" semanticValue={`${tomorrow.count}/${tomorrow.partyTotal}`}>{t('widget.briefing.tomorrowReservations', { count: tomorrow.count, people: tomorrow.partyTotal })}</ValueSlot>
          </SourceRow>
          <BriefingRow lang="ko">{t('briefing.pickupTomorrow', { n: model.custom.summary.tomorrowPickup })}</BriefingRow>
        </ul>
        <ActionButton id="briefing.closing" data-focus-key="briefing.closing" variant="secondary" onClick={() => host.openClosing('briefing.closing')}>{t('widget.briefing.closingAction')}</ActionButton>
      </section> : null}
      <ActionButton disabled={acknowledged} onClick={() => { setPressed(true); host.acknowledgeBriefing(); }}>{t('widget.briefing.done')}</ActionButton>
      {acknowledged ? <p role="status">{t('widget.briefing.acknowledged')}</p> : null}
    </div>
  </div>;
}
export const briefingModule: WidgetModule = { id: ID, Panel: BriefingPanel, Detail: BriefingDetail, useSummary: useBriefingSummary };
