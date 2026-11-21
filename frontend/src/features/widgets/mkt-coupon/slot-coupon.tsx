/**
 * 빈 시간 단골 쿠폰 (slot-coupon, F-48, SCR-37/38): panel (3칸 + PanelAction) and the 4-step send flow
 * (quiet hour -> recipients -> benefit -> message, then send time, confirm, sending, ‘보냈어요(예시)’). Sending has no undo.
 */
import { useRef, useState } from 'react';
import { validateAgentPrefill } from '../../../../shared/navis-agent-schema.mjs';
import type { DetailRef, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import { TOMORROW } from '../../../data/widget-data';
import type { SlotCouponModel } from '../../../data/widget-data';
import {
  ActionButton, BenefitCards, ChipChoice, ConfirmStep, Icon, RecipientList, SendTimePicker, StatusBadge, useKitT,
} from '../../../ui';
import { MktPanel } from './panel';
import {
  DetailNotReady, EditableSmsPreview, Live, LiveText, NoteLine, PanelNotReady, recipientMeta, reportResult, SentStatus, slotLabel, useActionFocus, useFormKey, useKept, useMkt, useSendPhase,
} from './shared';

const ID = 'slot-coupon' as const;
const DEFAULT_TIME = '09:00';

function SentList({ rows }: { readonly rows: SlotCouponModel['sent'] }) {
  const { t, dt } = useMkt();
  if (rows.length === 0) return null;
  return <section className="mkt-sent" aria-labelledby="slot-sent-title" data-slot="slot-coupon.sent">
    <h3 id="slot-sent-title">{t('widget.slot-coupon.sentTitle')}</h3>
    <ul>{[...rows].reverse().map((row) => <li key={row.couponId}><LiveText value={`${row.used}/${row.issued}`}>
      {t('widget.slot-coupon.sentLine', { name: dt(row.name), used: row.used ?? 0, issued: row.issued, left: row.daysLeft === 0 ? t('widget.coupon-status.untilToday') : t('widget.coupon-status.daysLeft', { n: row.daysLeft }) })}
    </LiveText></li>)}</ul>
  </section>;
}

export function SlotCouponPanel({ width, height, shape, editing, host }: WidgetPanelProps) {
  const { t, f, money } = useMkt();
  const view = useWidgetView(ID);
  const name = t('widget.slot-coupon.title');
  if (view.status !== 'ready') return <PanelNotReady view={view} widgetName={name} host={host} shape={shape} width={width} />;
  const m = view.model;
  const note = view.notes?.[0];
  const descs = m.slotCount === 0 ? [t('widget.slot-coupon.allSent')] : shape === 'Q' ? [note ? t(note.messageKey) : t('widget.slot-coupon.panelQ')]
    : shape === 'T' ? [t('widget.slot-coupon.panelQ')] : [t('widget.slot-coupon.panelW', { n: m.regularsCount }), t('widget.slot-coupon.panelQ')];
  const recommended = m.benefits.options.find((o) => o.recommended);
  const rows = [
    ...m.openSlots.slice(0, 3).map((slot) => <li key={slot.slotId} data-row-id={slot.slotId}>{t('widget.slot-coupon.slotLine', { slot: slotLabel(f, slot), percent: slot.percent })}</li>),
    ...((shape === 'S' || shape === 'L') && recommended ? [<li key="kept">{t('widget.slot-coupon.keptLine', { amount: money(recommended.marginPerCoupon) })}</li>] : []),

  ];
  return <MktPanel id={ID} shape={shape} width={width} height={height} editing={editing}
    label={t('widget.slot-coupon.panelQ')} kpi={{ value: String(m.slotCount), unit: t('widget.slot-coupon.unitName', { n: m.slotCount }) }}
    descs={descs} aside={view.notes?.length ? <NoteLine notes={view.notes} compact={editing} /> : undefined} rows={rows}
    action={m.canSend ? { label: shape === 'Q' || shape === 'T' ? t('marketing.sendCoupon') : t('marketing.sendCouponsToRegulars'), widgetName: name, onPress: () => host.openDetail({ featureId: ID, view: 'send', focus: 'action' }) } : null} />;
}

export function useSlotCouponSummary(): string {
  const { t } = useMkt();
  const view = useWidgetView(ID);
  if (view.status !== 'ready') return t(view.messageKey);
  return t('widget.slot-coupon.summary', { n: view.model.slotCount, m: view.model.regularsCount });
}

export function SlotCouponDetail({ detailRef, host }: WidgetDetailProps) {
  const view = useWidgetView(ID);
  const root = useRef<HTMLDivElement>(null);
  useActionFocus(root, detailRef, ['send']);
  return <div ref={root} className="mkt-detail" data-widget={ID}>
    {view.status !== 'ready' ? <DetailNotReady view={view} host={host} /> : <SlotFlow model={view.model} notes={view.notes} host={host} detailRef={detailRef} />}
  </div>;
}

function SlotFlow({ model, notes, host, detailRef }: { readonly detailRef: DetailRef; readonly model: SlotCouponModel; readonly notes: Parameters<typeof NoteLine>[0]['notes']; readonly host: WidgetDetailProps['host'] }) {
  const { t, f, dt, money, locale } = useMkt();
  const kit = useKitT();
  const dispatch = useDataDispatch();
  const { phase, setPhase, startSending } = useSendPhase();
  const [key, renewKey] = useFormKey('slot');
  const open = model.openSlots;
  // The form opens on the first quiet slot that has a consenting regular; a slot nobody matches only shows ‘받는 사람이 없어요’ and a disabled button.
  const firstSlot = open.find((s) => model.recipients.some((r) => r.selectable && r.slotIds.includes(s.slotId))) ?? open[0];
  const fields = detailRef.prefill?.kind === 'widget-draft' && validateAgentPrefill(ID, detailRef.prefill.fields) ? detailRef.prefill.fields : undefined;
  const initialSlot = open.find(s => s.slotId === (fields?.slotId ?? detailRef.itemId)) ?? firstSlot;
  const initialBenefit = model.benefits.options.find(option => option.id === fields?.benefit)?.id ?? model.benefits.recommendedId;
  const [pickedSlot, setPickedSlot] = useState<string>(initialSlot?.slotId ?? '');
  const slot = open.find((s) => s.slotId === pickedSlot) ?? firstSlot;
  type Excluded = { readonly slot: string; readonly ids: readonly string[] };
  const [keptOff, setOff] = useKept<Excluded>('slot-coupon.off', { slot: '', ids: [] });
  const [draftOff, setDraftOff] = useState<Excluded | null>(() => initialSlot && Array.isArray(fields?.excludeRecipients)
    ? { slot: initialSlot.slotId, ids: fields.excludeRecipients.filter(id => typeof id === 'string') } : null);
  const off = draftOff ?? keptOff;
  const [benefit, setBenefit] = useState(initialBenefit);
  const [edited, setEdited] = useState<{ readonly benefit: string; readonly text: string } | null>(
    typeof fields?.messageText === 'string' ? { benefit: initialBenefit, text: fields.messageText } : null);
  const [mode, setMode] = useState<'now' | 'schedule'>(fields?.sendMode === 'schedule' ? 'schedule' : 'now');
  const [time, setTime] = useState(typeof fields?.sendTime === 'string' ? fields.sendTime : DEFAULT_TIME);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ readonly count: number; readonly benefit: string; readonly when: string; readonly slot: string } | null>(null);

  const recipients = slot ? model.recipients.filter((r) => r.slotIds.includes(slot.slotId)) : [];
  const selectableIds = recipients.filter((r) => r.selectable).map((r) => r.customerId);
  const offIds = slot && off.slot === slot.slotId ? off.ids : [];
  const selected = selectableIds.filter((id) => !offIds.includes(id));
  const defaultBody = dt(model.message.bodies[benefit]);
  const body = edited && edited.benefit === benefit ? edited.text : defaultBody;
  // Any time of day may be scheduled or sent now: no night restriction (owner decision 2026-11-20).
  const blocked = !slot || selected.length === 0 || !model.canSend || (mode === 'schedule' && !time);
  const reason = !slot ? null : selected.length === 0 ? t('marketing.noRecipients') : null;
  const benefitName = dt(model.benefits.options.find((o) => o.id === benefit)?.name);
  const whenText = mode === 'now' ? kit.t('ui.send.now') : t('widget.slot-coupon.scheduledAt', { date: f.date(TOMORROW, 'short'), time: time ? f.time(time) : '-' });

  const send = () => {
    if (!slot) return;
    const messageEdits = edited && edited.benefit === benefit && edited.text.trim() !== defaultBody.trim() ? edited.text : undefined;
    const result = dispatch({
      type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: selected, benefit, idempotencyKey: key,
      ...(messageEdits ? { messageEdits } : {}), ...(mode === 'schedule' ? { sendAt: `${TOMORROW}T${time}` } : {}),
    });
    const failure = reportResult(result, host, t, 'data.notice.sent');
    if (failure) { setError(failure); setPhase('form'); return; }
    setError(null);
    setSubmitted({ count: selected.length, benefit: benefitName, when: whenText, slot: slotLabel(f, slot) });
    startSending();
  };
  const reset = () => { setPhase('form'); renewKey(); setEdited(null); setSubmitted(null); setError(null); };

  return <div className="mkt-columns" data-slot="slot-coupon.detail">
    <div className="mkt-col-main">
      <NoteLine notes={notes} />
      {/* The window is tomorrow + 6 days, not a calendar week: say the dates (GD-3, S5-129). */}
      <p className="mkt-basis" data-slot="slot-coupon.window">{t('widget.slot-coupon.windowLine', { range: t('widget.slot-coupon.windowRange', { start: f.date(model.window.start, 'short'), end: f.date(model.window.end, 'short') }) })}</p>
      {open.length === 0 ? <p className="mkt-all-done" role="status"><Icon name="check" aria-hidden />{t('widget.slot-coupon.allSent')}</p> : <>
        <section aria-labelledby="slot-step1">
          <h2 id="slot-step1">{t('widget.slot-coupon.step1')}</h2>
          <div data-first-control>
            <ChipChoice label={t('widget.slot-coupon.slotsLabel')} value={slot?.slotId ?? ''} onChange={setPickedSlot}
              options={open.map((s) => ({ value: s.slotId, label: slotLabel(f, s) }))} />
          </div>
        </section>
        <section aria-labelledby="slot-step2">
          <h2 id="slot-step2">{t('widget.slot-coupon.step2')}</h2>
          <RecipientList label={t('marketing.recipients')} selected={selected} onChange={(ids) => {
            if (!slot) return;
            setDraftOff(null);
            setOff({ slot: slot.slotId, ids: selectableIds.filter((id) => !ids.includes(id)) });
          }}
            recipients={recipients.map((r) => {
              const display = dt(r.name);
              const meta = t('widget.slot-coupon.recipientMeta', { slot: r.slotIds.map((id) => { const s = model.slots.find((x) => x.slotId === id); return s ? slotLabel(f, s) : ''; }).join(', '), date: r.lastVisit ? f.date(r.lastVisit, 'short') : '-' });
              return { id: r.customerId, name: display, meta: recipientMeta(display, meta), consent: r.selectable };
            })} />
        </section>
        <section aria-labelledby="slot-step3">
          <h2 id="slot-step3">{t('widget.slot-coupon.step3')}</h2>
          <BenefitCards label={t('marketing.benefit')} value={benefit} onChange={(v) => setBenefit(v as typeof benefit)}
            options={model.benefits.options.map((o) => ({
              value: o.id, name: dt(o.name), recommended: o.recommended, detail: t('widget.slot-coupon.keptLine', { amount: money(o.marginPerCoupon) }),
              diff: o.recommended ? t('widget.slot-coupon.moreKept', { amount: money(model.benefits.differenceVsNext) }) : undefined,
            }))} />
          <p className="mkt-recommend"><StatusBadge kind="recommended" /> {t('widget.slot-coupon.recommendLine', { name: dt(model.benefits.options.find((o) => o.recommended)?.name) })}</p>
        </section>
      </>}
    </div>
    <div className="mkt-col-side" aria-live="off">
      {phase === 'form' ? <>
        {slot ? <>
          <section aria-labelledby="slot-step4">
            <h2 id="slot-step4">{t('widget.slot-coupon.step4')}</h2>
            <EditableSmsPreview body={body} onBodyChange={text => setEdited({ benefit, text })} recipientCount={selected.length} />
          </section>
          <div className="mkt-slot-send-options">
            <SendTimePicker mode={mode} onModeChange={setMode} time={time} onTimeChange={setTime} />
            <section className="mkt-summary" aria-labelledby="slot-summary">
              <h2 id="slot-summary">{t('widget.slot-coupon.summaryTitle')}</h2>
              <dl>
                <div><dt>{t('marketing.recipients')}</dt><dd><Live value={selected.length}>{f.count(selected.length, 'person')}</Live></dd></div>
                <div><dt>{t('marketing.benefit')}</dt><dd>{benefitName}</dd></div>
                <div><dt>{kit.t('ui.send.time')}</dt><dd>{whenText}</dd></div>
              </dl>
            </section>
          </div>
          <ActionButton disabled={blocked} aria-describedby={reason ? 'slot-reason' : undefined} onClick={() => { setError(null); setPhase('confirm'); }} data-slot="slot-coupon.send">
            {t('widget.slot-coupon.send', { n: selected.length })}
          </ActionButton>
          {reason ? <p id="slot-reason" className="mkt-reason" role="status">{reason}</p> : null}
          {error ? <p className="mkt-reason" role="alert"><Icon name="error" aria-hidden />{error}</p> : null}
        </> : null}
      </> : <>
        {phase === 'sent' ? (locale === 'ko' ? <div role="status"><h3>{t('widget.slot-coupon.sentResult', { slot: submitted?.slot ?? '', n: submitted?.count ?? 0 })}</h3></div> : <SentStatus />) : <ConfirmStep count={submitted?.count ?? selected.length} phase={phase === 'confirm' ? 'ask' : phase} onCancel={() => setPhase('form')} onSend={send}
          summary={[
            { label: t('marketing.recipients'), value: f.count(submitted?.count ?? selected.length, 'person') },
            { label: t('marketing.benefit'), value: submitted?.benefit ?? benefitName },
            { label: kit.t('ui.send.time'), value: submitted?.when ?? whenText },
          ]} />}
        {phase === 'sent' && open.length > 0 ? <ActionButton variant="secondary" onClick={reset}>{t('widget.slot-coupon.again')}</ActionButton> : null}
      </>}
      <SentList rows={model.sent} />
    </div>
  </div>;
}

export const slotCoupon: WidgetModule = { id: ID, Panel: SlotCouponPanel, Detail: SlotCouponDetail, useSummary: useSlotCouponSummary };
