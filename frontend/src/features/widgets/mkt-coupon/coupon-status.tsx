/**
 * 진행 중인 쿠폰 (coupon-status, F-51, SCR-37/39): panel (3장 + PanelAction) and the coupon table with usage bars,
 * ending-soon reminder (sending has no undo), pause / resume / extend (with undo through the notice), ended coupons and
 * the 13 + 15 = 28 identity. Coupons come from the one store, so a coupon sent elsewhere shows up here in the same frame.
 */
import { useEffect, useRef, useState } from 'react';
import type { DetailRef, WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import type { CouponRow, CouponStatusModel } from '../../../data/widget-data';
import { ActionButton, ConfirmStep, Icon, StatusBadge, Table, UsageBar, useKitT } from '../../../ui';
import { koreanLang } from '../mkt-local/fit';
import { MktPanel } from './panel';
import {
  DetailNotReady, FixedSmsPreview, Live, LiveText, NoteLine, PanelNotReady, reportResult, useActionFocus, useFormKey, useMkt, useSendPhase,
} from './shared';

const ID = 'coupon-status' as const;

function useTodayTarget(): DetailRef {
  const { locale } = useMkt();
  const today = useWidgetView('marketing-today');
  return locale === 'ko' ? { featureId: 'slot-coupon', view: 'send' } : today.status === 'ready' ? { ...today.model.tapTarget, focus: 'action' } : { featureId: 'slot-coupon', view: 'send', focus: 'action' };
}

function left(t: ReturnType<typeof useMkt>['t'], row: CouponRow): string {
  return row.daysLeft <= 0 ? t('widget.coupon-status.untilToday') : t('widget.coupon-status.daysLeft', { n: row.daysLeft });
}

export function CouponStatusPanel({ width, height, shape, editing, host }: WidgetPanelProps) {
  const { t, dt, locale } = useMkt();
  const view = useWidgetView(ID);
  const target = useTodayTarget();
  const name = t('widget.coupon-status.title');
  if (view.status !== 'ready') return <PanelNotReady view={view} widgetName={name} host={host} shape={shape} width={width} shortMessage={view.status === 'empty' && view.messageKey === 'data.state.coupon-status.none' ? t('widget.coupon-status.state.none.short') : undefined} onEmptyAction={() => host.openDetail(target)} emptyActionLabel={view.status === 'empty' && view.actionKey === 'data.marketing.action.viewTodayPromotions' ? t('widget.coupon-status.emptyAction') : undefined} />;
  const m = view.model;
  const note = view.notes?.[0];
  const ending = m.rows.find((r) => r.endingSoon && r.canNotify);
  const endingLine = m.endingSoonCount > 0 ? t('widget.coupon-status.endingLine', { m: m.endingSoonCount }) : '';
  const monthLine = m.monthUsed !== null ? t('widget.coupon-status.monthLine', { n: m.monthUsed }) : '';
  // The big number is the running count; paused coupons are named on their own line (GD-3, U-03) instead of hiding inside it.
  const pausedLine = m.pausedCount > 0 ? t('widget.coupon-status.pausedLine', { p: m.pausedCount }) : '';
  const descs = shape === 'Q' ? [note ? t(note.messageKey) : endingLine || pausedLine]
    : m.endingSoonCount > 0 && shape === 'T' ? [endingLine]
    : m.endingSoonCount > 0 ? [locale === 'ko' ? endingLine : t('widget.coupon-status.panelW', { n: m.activeCount, m: m.endingSoonCount }), endingLine] : [pausedLine || monthLine];
  const rows = [
    ...m.rows.slice(0, 3).map((row) => <li key={row.couponId} lang={koreanLang(dt(row.name))} data-row-id={row.couponId} data-paused={row.status === 'paused' ? 'true' : undefined}>
      {dt(row.name)}{'\u00A0·\u00A0'}{row.used === null ? t('widget.coupon-status.noUsage') : t('widget.coupon-status.used', { used: row.used, issued: row.issued })}{'\u00A0·\u00A0'}{row.status === 'paused' ? t('widget.coupon-status.paused') : left(t, row)}
    </li>),
    ...((shape === 'S' || shape === 'L') && pausedLine && m.endingSoonCount > 0 ? [<li key="paused" data-slot="coupon-status.paused-line">{pausedLine}</li>] : []),
    ...((shape === 'S' || shape === 'L') && monthLine ? [<li key="month">{monthLine}</li>] : []),
  ];
  return <MktPanel id={ID} shape={shape} width={width} height={height} editing={editing}
    label={locale === 'ko' ? t('widget.coupon-status.label') : name} kpi={{ value: String(m.activeCount), unit: t('widget.coupon-status.unitName') }}
    descs={descs} aside={view.notes?.length ? <NoteLine notes={view.notes} compact={editing} /> : undefined} rows={rows}
    action={ending ? { label: shape === 'Q' || shape === 'T' ? t('marketing.sendReminder') : t('marketing.sendEndingReminder'), widgetName: name, onPress: () => host.openDetail({ featureId: ID, focus: 'action' }) } : null} />;
}

export function useCouponStatusSummary(): string {
  const { t } = useMkt();
  const view = useWidgetView(ID);
  if (view.status !== 'ready') return t(view.messageKey);
  return t('widget.coupon-status.summary', { n: view.model.activeCount, m: view.model.endingSoonCount });
}

export function CouponStatusDetail({ detailRef, host }: WidgetDetailProps) {
  const view = useWidgetView(ID);
  const target = useTodayTarget();
  const root = useRef<HTMLDivElement>(null);
  const isTargeted = detailRef.view === 'reminder' || detailRef.view === 'ended' || Boolean(detailRef.itemId);
  useActionFocus(root, isTargeted ? { ...detailRef, focus: undefined } : detailRef);
  useEffect(() => {
    if (!isTargeted) return;
    const target = root.current?.querySelector<HTMLElement>('[data-navis-coupon-target]');
    target?.focus();
  }, [isTargeted, detailRef.itemId, detailRef.view]);
  return <div ref={root} className="mkt-detail mkt-detail--single" data-widget={ID}>
    {view.status !== 'ready' ? <DetailNotReady view={view} host={host} onEmptyAction={() => host.openLinked(target)} />
      : <StatusBody model={view.model} notes={view.notes} host={host} detailRef={detailRef} />}
  </div>;
}

function StatusBody({ model, notes, host, detailRef }: { readonly model: CouponStatusModel; readonly notes: Parameters<typeof NoteLine>[0]['notes']; readonly host: WidgetHost; readonly detailRef: DetailRef }) {
  const { t, f, dt } = useMkt();
  const kit = useKitT();
  const dispatch = useDataDispatch();
  const reminderTarget = detailRef.view === 'reminder' ? detailRef.itemId : undefined;
  const ending = model.rows.find(r => r.endingSoon && r.canNotify && (!reminderTarget || reminderTarget === r.couponId));
  const [open, setOpen] = useState((detailRef.view === 'reminder' || detailRef.view === undefined && detailRef.focus === 'action') && ending !== undefined);
  const { phase, setPhase, startSending } = useSendPhase();
  const [key, renewKey] = useFormKey('remind');
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  // The count comes from the same selector the command uses (consenting text targets), never from the issued count of a public post.
  const recipients = ending ? ending.reminderRecipients : 0;

  const act = (type: 'coupon.pause' | 'coupon.resume' | 'coupon.extend', couponId: string) => {
    const failure = reportResult(dispatch({ type, couponId }), host, t, 'data.notice.sent');
    setError(failure);
  };
  const sendReminder = () => {
    if (!ending) return;
    const failure = reportResult(dispatch({ type: 'coupon.notifyEnding', couponId: ending.couponId, idempotencyKey: key }), host, t, 'data.notice.sent');
    if (failure) { setError(failure); setPhase('form'); return; }
    setError(null); setSentCount(recipients); startSending();
  };
  const close = () => { setOpen(false); setPhase('form'); renewKey(); };

  return <div data-slot="coupon-status.detail">
    <NoteLine notes={notes} />
    <div className="mkt-status-head">
      <Live value={`${model.activeCount}|${model.pausedCount}`}><strong className="mkt-status-count" data-slot="coupon-status.active">{model.pausedCount > 0 ? t('widget.coupon-status.activeHeaderPaused', { n: model.activeCount, p: model.pausedCount }) : t('widget.coupon-status.activeHeader', { n: model.activeCount })}</strong></Live>
      {model.endingSoonCount > 0 ? <span className="mkt-status-ending"><StatusBadge kind="endingSoon" /> {t('widget.coupon-status.endingLine', { m: model.endingSoonCount })}</span> : null}
      <span className="mkt-status-spacer" />
      <div data-first-control>
        <ActionButton disabled={!ending || open} aria-describedby={!ending ? 'cs-no-ending' : undefined} onClick={() => setOpen(true)} data-slot="coupon-status.notify">{t('marketing.sendEndingReminder')}</ActionButton>
      </div>
    </div>
    {!ending ? <p id="cs-no-ending" className="mkt-reason mkt-no-ending">{t('widget.coupon-status.noEnding')}</p> : null}
    {error && !open ? <p className="mkt-reason" role="alert"><Icon name="error" aria-hidden />{error}</p> : null}

    {open && ending ? <section className="mkt-notify" aria-labelledby="cs-notify-title">
      <h2 id="cs-notify-title" tabIndex={-1} data-navis-coupon-target={detailRef.view === 'reminder' || undefined}>{t('widget.coupon-status.notifyTitle')}</h2>
      <p className="mkt-notify__target">{t('widget.coupon-status.notifyFor')}: <strong>{dt(ending.name)}</strong>{'\u00A0·\u00A0'}{left(t, ending)}</p>
      {phase === 'form' ? <>
        <FixedSmsPreview body={t('data.marketing.sms.reminder')} recipientCount={recipients} />
        <div className="mkt-actions">
          <ActionButton disabled={recipients === 0} aria-describedby={recipients === 0 ? 'cs-no-recipients' : undefined} onClick={() => setPhase('confirm')} data-slot="coupon-status.notify-send">{t('widget.coupon-status.notifySend', { n: recipients })}</ActionButton>
          <ActionButton variant="secondary" onClick={close}>{t('widget.expiry-coupon.notNow')}</ActionButton>
        </div>
        {recipients === 0 ? <p id="cs-no-recipients" className="mkt-reason" role="alert" data-slot="coupon-status.no-recipients"><Icon name="error" aria-hidden />{t('data.marketing.error.noReminderRecipients')}</p> : null}
      </> : <ConfirmStep count={sentCount || recipients} phase={phase === 'confirm' ? 'ask' : phase} onCancel={() => setPhase('form')} onSend={sendReminder}
        summary={[
          { label: t('widget.coupon-status.notifyFor'), value: dt(ending.name) },
          { label: t('marketing.recipients'), value: f.count(sentCount || recipients, 'person') },
          { label: kit.t('ui.send.time'), value: kit.t('ui.send.now') },
        ]} />}
      {error ? <p className="mkt-reason" role="alert"><Icon name="error" aria-hidden />{error}</p> : null}
    </section> : null}

    <Table aria-label={t('widget.coupon-status.tableLabel')} className="mkt-table">
      <thead><tr>
        <th scope="col">{t('widget.coupon-status.colCoupon')}</th><th scope="col">{t('widget.coupon-status.colUsed')}</th>
        <th scope="col">{t('widget.coupon-status.colLeft')}</th><th scope="col">{t('widget.coupon-status.colActions')}</th>
      </tr></thead>
      <tbody>{model.rows.map((row) => {
        const name = dt(row.name);
        return <tr key={row.couponId} data-row-id={row.couponId} data-paused={row.status === 'paused' ? 'true' : undefined}>
          <th scope="row" tabIndex={row.couponId === detailRef.itemId && detailRef.view === 'active' ? -1 : undefined}
            data-navis-coupon-target={row.couponId === detailRef.itemId && detailRef.view === 'active' || undefined}><span className="mkt-coupon-name">{name}</span>
            {row.status === 'paused' ? <StatusBadge kind="paused" label={t('widget.coupon-status.pausedBadge')} /> : row.endingSoon ? <StatusBadge kind="endingSoon" /> : null}</th>
          <td><LiveText value={`${row.used}/${row.issued}`}>{row.used === null
            ? <><StatusBadge kind="needsReview" /> <span>{t('widget.coupon-status.noUsage')}</span></>
            : <UsageBar used={row.used} total={row.issued} />}</LiveText></td>
          <td>{left(t, row)}</td>
          <td><div className="mkt-actions">
            {row.status === 'paused'
              ? <ActionButton variant="secondary" disabled={!row.canResume} aria-label={t('widget.coupon-status.resumeName', { name })} onClick={() => act('coupon.resume', row.couponId)}>{t('widget.coupon-status.resume')}</ActionButton>
              : <ActionButton variant="secondary" disabled={!row.canPause} aria-label={t('widget.coupon-status.pauseName', { name })} onClick={() => act('coupon.pause', row.couponId)}>{t('marketing.pause')}</ActionButton>}
            <ActionButton variant="secondary" disabled={!row.canExtend} aria-label={t('widget.coupon-status.extendName', { name })} onClick={() => act('coupon.extend', row.couponId)}>{t('marketing.extend')}</ActionButton>
          </div></td>
        </tr>;
      })}</tbody>
    </Table>

    <details className="mkt-ended" open={detailRef.view === 'ended' || undefined}>
      <summary data-navis-coupon-target={detailRef.view === 'ended' && !detailRef.itemId || undefined}>{t('widget.coupon-status.endedTitle', { n: model.ended.length })}</summary>
      <ul>{model.ended.map((row) => <li key={row.couponId} tabIndex={row.couponId === detailRef.itemId ? -1 : undefined}
        data-navis-coupon-target={row.couponId === detailRef.itemId && detailRef.view === 'ended' || undefined}>{t('widget.coupon-status.endedLine', {
        name: dt(row.name), used: row.used === null ? '-' : row.used, issued: row.issued, date: f.date(row.endsOn, 'short'),
      })}</li>)}</ul>
    </details>
    <p className="mkt-identity" data-slot="coupon-status.total">
      {model.monthUsed !== null && model.endedUsed !== null && model.monthUsed === model.runningUsed + model.endedUsed
        ? <LiveText value={`${model.monthUsed}|${model.runningUsed}`}>{t(model.pausedCount > 0 ? 'widget.coupon-status.totalPaused' : 'widget.coupon-status.total', { n: model.monthUsed, a: model.runningUsed, b: model.endedUsed })}</LiveText>
        // the sum is written only while it is true; a total that does not add up is shown as the month's count alone
        : <LiveText value={model.monthUsed ?? model.runningUsed}>{t('widget.coupon-status.monthLine', { n: model.monthUsed ?? model.runningUsed })}</LiveText>}
    </p>
  </div>;
}

export const couponStatus: WidgetModule = { id: ID, Panel: CouponStatusPanel, Detail: CouponStatusDetail, useSummary: useCouponStatusSummary };
