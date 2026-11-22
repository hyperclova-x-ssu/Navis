/** 출근·퇴근 화면은 공용 브리핑 selector가 만든 같은 snapshot을 사용한다. */
import { useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { QueryCondition, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetDataStore, useWidgetView } from '../../../data/react';
import { selectReservations } from '../../../data/derive/reservations';
import { bookingPartyText, unknownPartyRows } from '../mgmt-customers/voice-booking';
import { TODAY, resolveDataText, type BriefingModel } from '../../../data/widget-data';
import { ActionButton, DetailTabs, Icon, StatusBadge } from '../../../ui';
import { DetailViewState, Kpi, MoneyPanel, NoteLine, ViewState, splitMoney, useMoneyT, useSizeCtx, type RowData, type T } from './shared';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { posDataBundle } from '../../../data/messages/pos';
import { PosContext } from '../../../pos/react';
import { orderStatusRuntime } from '../../../pos/runtime';
import { ValueSlot } from './value-slot';
import { keepDots } from './fit';
import { briefingBundle } from '../../../screens/briefing/messages';
import { selectAccountingPresentation } from '../../../data/pos/projection';
import { accountingForPeriod, useAccountingPresentation } from './ledger';
import { briefingIsReal, recordBriefingAcknowledgement } from '../../../data/reality/12/ack';
import { sectionWithheld, withheldNote, type SectionId } from '../../../data/reality/12/overlay';
import { kstLocal } from '../../../data/reality/02/clock';
import { sourceLabel, WithheldLines, type BriefingCopy } from '../../../screens/briefing/real';
import { exampleBriefingSources } from '../../../screens/briefing/example-sources';
import { useBriefingValues } from './briefing.values';

const ID = 'briefing' as const;
const exampleSources = exampleBriefingSources();

function BriefingSources({ model, t }: { model: BriefingModel; t: T }) {
  const copy = copyOf(t);
  const sources = model.real?.sources ?? exampleSources;
  const problems = sources.filter(source => source.state !== 'ready');
  const readyCount = sources.length - problems.length;
  const title = copy.t('briefing.sources.title');
  return <section className="mm-card mm-briefing-card" data-slot="briefing.sources" aria-label={title}>
    <h3 className="mm-card__title">{title}</h3>
    {readyCount > 0 && <p className="mm-muted">{t('widget.briefing.loadedSources', { n: readyCount })}</p>}
    {problems.length > 0 && <ul className="briefing-sources">{problems.map(source => <li key={source.key} className="briefing-sources__row" data-source={source.key} data-state={source.state}>
      <span>{sourceLabel(copy, source.key)}</span>
      <StatusBadge semantic={source.state === 'not-connected' ? 'waiting' : 'warning'} label={copy.t(`briefing.state.${source.state}`)} />
    </li>)}</ul>}
  </section>;
}
function useBriefingMoneyT(): T {
  const base = useMoneyT(), pos = useBundle(posDataBundle, posBundle, briefingBundle);
  return Object.assign((key: string, params?: Parameters<T>[1]) => pos.has(key) ? keepDots(pos.t(key as keyof typeof posDataBundle.ko | keyof typeof posBundle.ko | keyof typeof briefingBundle.ko, params)) : base(key, params), { format: base.format, locale: base.locale });
}
const groupName = (t: T, id: string) => t(`widget.briefing.${id}`);
/** The text a screen hands to the shared source components (the widget and the arrival card translate with different bundle sets). */
const copyOf = (t: T): BriefingCopy => ({ t: (key, params) => t(key, params), date: (iso, style) => t.format.date(iso, style), time: hhmm => t.format.time(hhmm) });
/** In place of a value whose section the service cannot vouch for (not connected, or could not be read). */
const withheldValue = (t: T, model: BriefingModel, section: SectionId): string | null => { const note = withheldNote(model, section); return note ? t(`briefing.state.${note.state}`) : null; };
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
    return item.id.startsWith('manual:') && typeof item.params?.done === 'number' ? t(item.messageKey, item.params).replace(` ${item.params.done}/${item.params.total}`, '') : t(item.messageKey, item.params);
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
  const store = useWidgetDataStore();
  if (view.status !== 'ready') return <ViewState view={view} ctx={ctx} host={props.host} featureId={ID} t={t} />;
  const { importantAlerts } = view.model;
  const missing = unavailableSources(t, view.model);
  const groupRows: RowData[] = importantAlerts.groups.map(group => ({ id: group.id, name: groupName(t, group.id), value: group.items.map(alertText).join('\u00a0·\u00a0'), semanticValue: JSON.stringify(group.items.map(alertText.meaning)) }));
  /** D-333: from 3x3 up each summary row also lists what it counts (today's entries, the reservation times, the order-pickup follow-ups), as the detail window does. */
  const large = ctx.shape === 'L' && ctx.width >= 3 && ctx.height >= 3;
  const { schedules, reservations, custom } = view.model;
  /** The items already hold dots (‘17:30 1건 · 3명’), so the lists are separated by commas. */
  const dot = ', ';
  const scheduleDetail = schedules.todayEntries.map(entry => `${entry.time ? `${t.format.time(entry.time)} ` : ''}${resolveDataText(t, entry.title)}`).join(dot);
  const parties = bookingPeople(store.getSnapshot(), view.model.real?.businessDay ?? TODAY, t.format);
  const reservationDetail = [...reservations.timeGroups.map(group => `${group.time} ${t.format.count(group.count, 'count')} · ${parties(group.count, group.partyTotal, group.time)}`), ...(reservations.completedCount > 0 ? [t('data.pos.completedVisits', { n: reservations.completedCount })] : []), ...(reservations.changes > 0 ? [t('widget.briefing.changes', { n: reservations.changes })] : [])].join(dot);
  const customDetail = custom.summary.approvalPending > 0 || custom.summary.todayNotComplete > 0 ? t('briefing.customPending', { n: custom.summary.approvalPending, m: custom.summary.todayNotComplete }) : '';
  const heldSchedule = withheldValue(t, view.model, 'schedule'), heldReservations = withheldValue(t, view.model, 'reservations'), heldPickups = withheldValue(t, view.model, 'pickups');
  const rows: RowData[] = ctx.shape === 'S' || ctx.shape === 'L' ? [
    { id: 'schedules', name: t('widget.briefing.schedule'), value: heldSchedule ?? `${t('widget.briefing.todaySchedule', { n: view.model.schedules.todayCount })} · ${t(view.model.staff.today.nextHandoffAt ? 'briefing.staffHandoff' : 'briefing.staffCount', { n: view.model.staff.today.workingCount, time: view.model.staff.today.nextHandoffAt ?? '' })}`, semanticValue: heldSchedule ?? `${view.model.schedules.todayCount}/${view.model.staff.today.workingCount}/${view.model.staff.today.nextHandoffAt ?? ''}`, detail: large && !heldSchedule && scheduleDetail ? scheduleDetail : undefined },
    { id: 'reservations', name: t('widget.briefing.reservations'), value: heldReservations ?? `오늘 ${t.format.count(reservations.count, 'count')} · ${parties(reservations.count, reservations.partyTotal)}`, semanticValue: heldReservations ?? `${view.model.reservations.count}/${view.model.reservations.partyTotal}`, detail: large && !heldReservations && reservationDetail ? reservationDetail : undefined },
    { id: 'pickups', name: t('widget.custom-order.title'), value: heldPickups ?? t('briefing.pickupToday', { n: view.model.custom.summary.todayPickup }), semanticValue: heldPickups ?? view.model.custom.summary.todayPickup, detail: large && !heldPickups && customDetail ? customDetail : undefined },
    ...groupRows,
  ] : groupRows;
  return <MoneyPanel spec={{ slot: ID, label: t('widget.briefing.alerts'), value: importantAlerts.count ? String(importantAlerts.count) : t('data.state.briefing.none'), semanticValue: importantAlerts.count, unit: importantAlerts.count ? t('widget.briefing.unit', { n: importantAlerts.count }) : undefined, textValue: !importantAlerts.count, inlineUnit: true, rows, status: missing.length ? <p className="mm-muted">{missing.join(' · ')} 자료를 모두 불러오지 못했어요</p> : <NoteLine notes={view.notes?.filter(note => note.messageKey !== 'data.real.partial')} t={t} /> }} ctx={ctx} />;
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
function bookingPeople(snapshot: ReturnType<ReturnType<typeof useWidgetDataStore>['getSnapshot']>, date: string, format: T['format']) {
  const unknown = unknownPartyRows(selectReservations(snapshot, { date }).rows, snapshot.tables.realBooking?.meta);
  return (count: number, total: number, time?: string) => bookingPartyText(format, count, total, time ? unknown.filter(row => row.time === time).length : unknown.length);
}
function unavailableSources(t: T, model: BriefingModel) {
  return model.real?.notes.map(note => sourceLabel(copyOf(t), note.key)) ?? [];
}
function Arrival({ model, host, t, snapshot }: { model: BriefingModel; host: WidgetDetailProps['host']; t: T; snapshot: ReturnType<ReturnType<typeof useWidgetDataStore>['getSnapshot']> }) {
  const alertText = useAlertText(t);
  const values = useBriefingValues(t, snapshot);
  const tax = useWidgetView('tax');
  const { schedules, reservations, importantAlerts } = model;
  const { workingCount } = model.staff.today;
  const today = model.real?.businessDay ?? TODAY;
  const parties = bookingPeople(snapshot, today, t.format);
  const alertSources = new Set(importantAlerts.groups.flatMap(group => group.items.flatMap(item => 'itemId' in item.ref && item.ref.itemId ? [item.ref.itemId] : [])));
  const ahead = schedules.monthEntries.filter(entry => entry.date > today && PLANNED_SOURCES.has(entry.source) && !alertSources.has(entry.sourceId));
  // Over HTTP the schedule never borrows a tax payment the service has no tax source for (the seed would still hold one).
  const nextTax = tax.status === 'ready' && !sectionWithheld(model, 'tax') ? tax.model.payments.filter(p => p.status === 'unpaid' && p.dueOn > today && !alertSources.has(p.taxPaymentId)).sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0] : undefined;
  const upcoming = ahead.map(entry => ({ id: entry.sourceId, date: entry.date, title: resolveDataText(t, entry.title), ref: entry.ref }));
  if (nextTax && !upcoming.some(entry => entry.id === nextTax.taxPaymentId)) upcoming.push({ id: nextTax.taxPaymentId, date: nextTax.dueOn,
    title: resolveDataText(t, nextTax.type), ref: { featureId: 'tax', itemId: nextTax.taxPaymentId } });
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  const copy = copyOf(t), heldSchedule = sectionWithheld(model, 'schedule'), heldReservations = sectionWithheld(model, 'reservations'), heldPickups = sectionWithheld(model, 'pickups');
  return <>
    <section className="mm-card mm-briefing-card">
      <h3 className="mm-card__title">{t('widget.briefing.schedule')}</h3>
      {heldSchedule ? <WithheldLines copy={copy} model={model} sections={['schedule']} /> : <>
      <h4 className="mm-card__subtitle">{t('widget.briefing.scheduleToday')}</h4>
      <ul className="mm-briefing-list" role="list">
        <SourceRow host={host} target={{ featureId: 'calendar' }}>
          <ValueSlot slotId="briefing.detail.schedules" featureId={ID} scope="detail" semanticValue={schedules.todayCount}>
            {t('widget.briefing.todaySchedule', { n: schedules.todayCount })}
          </ValueSlot>
        </SourceRow>
        <BriefingRow lang="ko">{t('briefing.staffCount', { n: workingCount })}</BriefingRow>
        {schedules.todayEntries.filter(entry => !alertSources.has(entry.sourceId)).map(entry => {
          const label = `${entry.time ? `${t.format.time(entry.time)} ` : ''}${resolveDataText(t, entry.title)}`;
          // A due date from another service (tax, grant) arrives with only a generic title: it gets its status chip and a link to its source (G-13).
          if (entry.source !== 'deadline' || !entry.ref) return <BriefingRow key={entry.id}>{label}</BriefingRow>;
          const payment = entry.sourceFeatureId === 'tax' && tax.status === 'ready' && !sectionWithheld(model, 'tax') ? tax.model.payments.find(p => p.taxPaymentId === entry.sourceId) : undefined;
          return <SourceRow key={entry.id} host={host} target={entry.ref} trailing={{ kind: 'chip', semantic: 'waiting', text: t('widget.briefing.dueToday') }}>
            {payment ? t('widget.briefing.taxItem', { name: resolveDataText(t, payment.type), amount: t.format.money(payment.amount, 'compact'), date: t.format.date(payment.dueOn, 'short') }) : label}
          </SourceRow>;
        })}
      </ul>
      {upcoming.length ? <>
        <h4 className="mm-card__subtitle">{t('widget.briefing.scheduleLater')}</h4>
        <ul className="mm-briefing-list" role="list" data-slot="briefing.planned">
          {upcoming.slice(0, 6).map(entry => {
            const label = `${t.format.date(entry.date, 'short')} ${entry.title}`;
            return entry.ref ? <SourceRow key={entry.id} host={host} target={entry.ref}>{label}</SourceRow> : <BriefingRow key={entry.id}>{label}</BriefingRow>;
          })}
        </ul>
      </> : null}
      </>}
    </section>
    <section className="mm-card mm-briefing-card">
      <h3 className="mm-card__title">{t('widget.briefing.reservations')}</h3>
      <ul className="mm-briefing-list" role="list">
        {heldReservations ? null : <>
        <SourceRow host={host} target={{ featureId: 'voice-booking' }}>
          <ValueSlot slotId="briefing.detail.reservations" featureId={ID} scope="detail" semanticValue={`${reservations.count}/${reservations.partyTotal}`}>
            {`오늘 ${t.format.count(reservations.count, 'count')} · ${parties(reservations.count, reservations.partyTotal)}`}
          </ValueSlot>
        </SourceRow>
        {reservations.completedCount > 0 ? <BriefingRow lang="ko">{t('data.pos.completedVisits', { n: reservations.completedCount })}</BriefingRow> : null}
        <BriefingRow>
          <ValueSlot slotId="briefing.detail.changes" featureId={ID} scope="detail" semanticValue={reservations.changes}>
            {t('widget.briefing.changes', { n: reservations.changes })}
          </ValueSlot>
        </BriefingRow></>}
        {heldPickups ? null : <>
        <SourceRow host={host} target={{ featureId: 'voice-booking' }}>{t('briefing.pickupToday', { n: model.custom.summary.todayPickup })}</SourceRow>
        <BriefingRow lang="ko">{t('briefing.customPending', { n: model.custom.summary.approvalPending, m: model.custom.summary.todayNotComplete })}</BriefingRow></>}
        {heldReservations ? null : reservations.timeGroups.map(group => (
          <BriefingRow key={group.time}>
            <ValueSlot slotId={`briefing.detail.time.${group.time}`} featureId={ID} scope="detail" semanticValue={`${group.count}/${group.partyTotal}`}>
              {`${group.time} ${t.format.count(group.count, 'count')} · ${parties(group.count, group.partyTotal, group.time)}`}
            </ValueSlot>
          </BriefingRow>
        ))}
      </ul>
      <WithheldLines copy={copy} model={model} sections={['reservations', 'pickups']} />
    </section>
    <section className="mm-card mm-briefing-card" data-slot="briefing.values">
      <h3 className="mm-card__title">{t('briefing.values.title')}</h3>
      <ul className="mm-briefing-list" role="list">
        {values.map(row => <SourceRow key={row.id} host={host} target={row.target} trailing={row.trailing}>{row.label}{row.id === 'reviews' && <small className="mm-muted"> · 이틀 전까지의 자료예요</small>}</SourceRow>)}
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
      <WithheldLines copy={copy} model={model} sections={['purchasing', 'stock', 'tax', 'tasks']} />
    </section>
    <BriefingSources model={model} t={t} />
  </>;
}
/**
 * The explicit press over HTTP: one request while pending, the host (run flag, arrival gate) follows only once the service holds the receipt,
 * and a failure leaves the press available with its reason. The same helper serves the Navis card path, so one key per business day reaches the service.
 */
function useAcknowledge(host: WidgetDetailProps['host'], store: ReturnType<typeof useWidgetDataStore>) {
  const [state, setState] = useState<{ readonly pending: boolean; readonly error: string | null }>({ pending: false, error: null });
  const locked = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const press = () => {
    if (locked.current) return;
    locked.current = true;
    setState({ pending: true, error: null });
    void recordBriefingAcknowledgement(store).then(result => {
      if (!result || result.ok) host.acknowledgeBriefing();
      if (active.current) setState({ pending: false, error: result && !result.ok ? result.messageKey : null });
    }, () => {
      if (active.current) setState({ pending: false, error: 'briefing.error.notRecorded' });
    }).finally(() => { locked.current = false; });
  };
  return { ...state, press };
}
/** A host without a run (previews, tests): nothing to follow. */
const NOT_TRACKED = { subscribe: () => () => undefined, getSnapshot: () => false };
export function BriefingDetail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useBriefingMoneyT();
  const presentation = useAccountingPresentation();
  const store = useWidgetDataStore(), snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const view = useWidgetView(ID, condition);
  // N19 deep link: a chat hand-off opens the 퇴근 tab ('closing') or the 출근 tab ('alerts', the default).
  const [tab, setTab] = useState<'arrival' | 'closing'>(detailRef?.view === 'closing' ? 'closing' : 'arrival');
  const [pressed, setPressed] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  // The run's briefing flag wins over this component's own press: the chat can acknowledge while this detail is open (D-327).
  const tracked = host.briefingAcknowledged ?? NOT_TRACKED;
  const acknowledgedInRun = useSyncExternalStore(tracked.subscribe, tracked.getSnapshot, tracked.getSnapshot);
  // REAL-PLAN F12: over HTTP only the service's record counts (a closed arrival card is not a confirmation) and the press waits for its receipt.
  const real = briefingIsReal(store), ack = useAcknowledge(host, store);
  const serverAck = snapshot.tables.realBriefing?.acknowledgement ?? null;
  const acknowledged = real ? serverAck !== null : pressed || acknowledgedInRun;
  if (view.status !== 'ready') return <div className="mm-detail" data-widget={ID}><DetailViewState view={view} host={host} t={t} /></div>;
  const model = view.model;
  const { closingSummary } = model;
  const businessDay = model.real?.businessDay ?? TODAY;
  const accounting = tab === 'closing'
    ? accountingForPeriod(presentation ?? selectAccountingPresentation(snapshot), { start: businessDay, end: businessDay })
    : undefined;
  const deposits = accounting?.status === 'ready' && accounting.depositCoverage?.complete !== false ? accounting.summary.deposits.total : null;
  const closingAmounts = [
    { id: 'sales', label: t('widget.ledger.todaySales'), amount: closingSummary.salesSnapshot.net },
    { id: 'deposits', label: t('widget.briefing.actualDeposits'), amount: deposits },
    { id: 'remaining', label: t('widget.briefing.profit'), amount: closingSummary.netProfit },
  ];
  const heldClosing = sectionWithheld(model, 'closing');
  const missing = unavailableSources(t, model);
  return <div className="mm-detail mm-briefing-detail" data-widget={ID}>
    <DetailTabs value={tab} onValueChange={next => { setTab(next); if (scroll.current) scroll.current.scrollTop = 0; }} label={t('widget.briefing.tabs')} tabs={[{ value: 'arrival', label: t('widget.briefing.tabArrival') }, { value: 'closing', label: t('widget.briefing.tabClosing') }]} />
    <NoteLine notes={view.notes?.filter(note => note.messageKey !== 'data.real.partial')} t={t} />
    {tab === 'arrival' && missing.length > 0 && <p className="mm-muted" role="status">{missing.join(' · ')} 자료를 모두 불러오지 못했어요</p>}
    <div ref={scroll} className="mm-briefing-body" tabIndex={0} role="region" aria-label={t(tab === 'arrival' ? 'widget.briefing.tabArrival' : 'widget.briefing.tabClosing')}>
      {tab === 'arrival' ? <>
        <Arrival model={model} host={host} t={t} snapshot={snapshot} />
        <ActionButton disabled={acknowledged || ack.pending} onClick={() => { if (real) ack.press(); else { setPressed(true); host.acknowledgeBriefing(); } }}>{t('widget.briefing.done')}</ActionButton>
        {acknowledged ? <p role="status">{t('widget.briefing.acknowledged')}</p> : null}
        {serverAck ? <p className="briefing-ack-status">{t('briefing.ack.at', { time: t.format.time(kstLocal(serverAck.acknowledgedAt).slice(11, 16)) })}</p> : null}
        {ack.pending ? <p role="status">{t('briefing.ack.pending')}</p> : null}
        {ack.error ? <p role="alert">{t(ack.error)}</p> : null}
      </> : <section className="mm-card mm-briefing-card" data-slot="briefing.closing">
        <h3 className="mm-card__title">{t('widget.briefing.closingTitle')}</h3>
        {heldClosing ? <WithheldLines copy={copyOf(t)} model={model} sections={['closing']} /> : <>
          <div className="mm-kpis">{closingAmounts.map(item => {
            const formatted = item.amount === null ? { value: t('briefing.state.unavailable'), unit: '' } : splitMoney(t, item.amount);
            return <Kpi key={item.id} slot={`briefing.kpi.${item.id}`} label={item.label} value={formatted.value} unit={formatted.unit} semanticValue={item.amount} />;
          })}</div>
          <ul className="mm-briefing-list" role="list"><BriefingRow>
            <ValueSlot slotId="briefing.detail.closing.status" featureId={ID} scope="detail" semanticValue={closingSummary.status}>{t(closingSummary.status === 'closed' ? 'widget.briefing.closed' : 'widget.briefing.notClosed')}</ValueSlot>
          </BriefingRow></ul>
        </>}
        <ActionButton id="briefing.closing" data-focus-key="briefing.closing" onClick={() => host.openClosing('briefing.closing')}>{t('widget.briefing.closingAction')}</ActionButton>
      </section>}
    </div>
  </div>;
}
export const briefingModule: WidgetModule = { id: ID, Panel: BriefingPanel, Detail: BriefingDetail, useSummary: useBriefingSummary };
