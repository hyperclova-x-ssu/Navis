import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WidgetHost } from '../../../contracts';
import { dataBundle } from '../../../data/messages';
import { selectNotices, selectStoreClosures } from '../../../data/iteration7/notices/selectors';
import { noticeBusinessNow } from '../../../data/iteration7/notices/commands';
import type { NoticeChannel } from '../../../data/iteration7/notices/types';
import type { CustomerGroupId } from '../../../data/marketing/types';
import { useDomainState, useRealPort, useRealRetry, useWidgetDataStore } from '../../../data/react';
import type { CommandReceipt } from '../../../data/reality/00';
import type { AudiencesDto, NoticeDto, NoticeSmsPreviewDto, SmsReservationStatus } from '../../../data/reality/15/dto';
import { inboxRows } from '../../../data/reality/15/messages';
import { inboxClock, pressKey, useInbox, useInboxCommand, useNoticeDetail, useSmsReservation } from '../../../data/reality/15/hooks';
import { smsSenderConfigured } from '../../../data/reality/14/sms';
import { ActionButton, ChipChoice, DateField, Icon, PanelState, StatusBadge, TimeField } from '../../../ui';
import { useBundle } from '../../../i18n';
import { FixedSmsPreview, SmsSetupHelp } from '../mkt-coupon/shared';
import { noticeDraftInput, noticeView } from './source';
import type { NoticeDraftInput, NoticePort, NoticePreview, NoticeView, ScheduledRow } from './widget';

type Translate = ReturnType<typeof useBundle<readonly [typeof dataBundle]>>;
export const noticeKey = <T extends string>(name: T): `data.real.inbox.${T}` => `data.real.inbox.${name}`;
export const isInboxMessageKey = (key: string | undefined): key is keyof typeof inboxRows => !!key && Object.hasOwn(inboxRows, key);
const k = noticeKey;
const CHANNELS: readonly NoticeChannel[] = ['manual', 'sms', 'talktalk', 'place-news', 'place-hours'];
const SMS_GROUP_PATH = '/marketing/notice-recipient-groups';
const smsGroupNames: Record<CustomerGroupId, string> = { 'churn-risk': '떠날 수 있는 손님', 'first-visit': '첫 방문', regular: '단골' };
type NoticeSmsGroup = { readonly groupId: CustomerGroupId; readonly recipientGroupId: string | null };
const seoulMinute = (at: Date) => new Date(+at + 9 * 3600_000).toISOString().slice(0, 16);
const isNight = (minute: string) => minute.slice(11) < '08:00' || minute.slice(11) >= '21:00';
const tomorrowEight = (minute: string) => `${new Date(Date.parse(`${minute.slice(0, 10)}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10)}T08:00`;
const whenOf = (t: Translate['t'], minute: string) => t(k('notice.sms.when'), { month: Number(minute.slice(5, 7)), day: Number(minute.slice(8, 10)), time: minute.slice(11, 16) });

export function useHttpNoticeView(): NoticeView {
  const state = useDomainState('inbox');
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (state.mode !== 'http') return { status: 'empty' };
  if (state.status === 'error') return { status: 'error' };
  if (state.status === 'idle' || state.status === 'loading') return { status: 'loading' };
  const now = seoulMinute(inboxClock.now());
  return noticeView(selectNotices(snapshot, {}, now.slice(0, 10)), selectStoreClosures(snapshot), [], now);
}

/** Feed the shared editor with the command receipt and the same notice rows that power the panel and Navis. */
export function useHttpNotice(host: Pick<WidgetHost, 'notify'>) {
  const store = useWidgetDataStore();
  const real = useRealPort();
  const command = useInboxCommand(host);
  const inbox = useInbox();
  const retry = useRealRetry('inbox');
  const read = (id: string) => store.getSnapshot().tables.noticeDraft.find(row => row.noticeId === id);
  const key = () => pressKey('notice');
  const port: Omit<NoticePort, 'preview'> = {
    retry,
    async saveDraft(draft, forSend) {
      const current = draft.noticeId ? read(draft.noticeId) : undefined;
      if (current && current.revision !== draft.revision) return { ok: false, reason: 'PREVIEW_STALE' };
      const channel = draft.channel ?? 'manual';
      let recipientGroupId = channel === 'sms' ? draft.recipientGroupId : undefined;
      const title = draft.title.trim(), body = draft.body.trim();
      const day = seoulMinute(inboxClock.now()).slice(0, 10);
      const startDate = draft.startDate || day, endDate = draft.endDate || startDate;
      if (current && current.title === title && current.body === body && current.startDate === startDate && current.endDate === endDate
        && current.channel === channel && current.talkAudience === draft.talkAudience && current.recipientGroupId === recipientGroupId
        && (channel !== 'sms' || !!recipientGroupId) && (current.closureEventId ?? undefined) === draft.closureEventId) return { ok: true, noticeId: current.noticeId, revision: current.revision, unchanged: true };
      const groupId = draft.groupIds[0];
      if (channel === 'sms' && !recipientGroupId && real && groupId) {
        const group = await real.transport.request<NoticeSmsGroup>({ method: 'POST', path: SMS_GROUP_PATH, body: { groupId } });
        recipientGroupId = group.recipientGroupId ?? undefined;
      }
      const result = await command.send({ ...draft, type: 'notice.saveDraft', channel, title, body, startDate, endDate, recipientGroupId, idempotencyKey: key() },
        forSend ? { noticeKey: '' } : undefined);
      if (!result?.ok) return result ?? { ok: false };
      const receipt = result.value as CommandReceipt | undefined;
      return receipt ? { ok: true, noticeId: receipt.resourceId, revision: receipt.revision, recipientGroupId } : { ok: false };
    },
    async importClosure(eventId, noticeId) {
      const result = await command.send({ type: 'notice.importClosure', eventId, noticeId, idempotencyKey: key() });
      if (!result?.ok) return result ?? { ok: false };
      const receipt = result.value as CommandReceipt | undefined;
      const row = receipt && read(receipt.resourceId);
      return row ? { ok: true, draft: noticeDraftInput(row) } : { ok: false };
    },
    async send(noticeId, draftRevision, previewId, sendAt) {
      const result = await command.send({ type: 'notice.send', noticeId, draftRevision, previewId, idempotencyKey: key(), ...(sendAt ? { sendAt } : {}) },
        sendAt ? { noticeKey: k('notice.smsScheduled') } : undefined);
      if (!result?.ok) return result ?? { ok: false };
      const state = (result.value as { state?: string } | undefined)?.state;
      return { ok: true, deliveryState: sendAt ? 'scheduled' : state === 'accepted' || state === 'saved' ? state : 'recorded' };
    },
    async deleteDraft(noticeId) { return await command.send({ type: 'notice.deleteDraft', noticeId, idempotencyKey: key() }) ?? { ok: false }; },
    async cancelSchedule(sentId) { return await command.send({ type: 'notice.cancelSchedule', sentId, idempotencyKey: key() }) ?? { ok: false }; },
  };
  return { port, inbox, command };
}

function useNoticeSmsGroups(enabled: boolean) {
  const real = useRealPort();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ rows?: readonly NoticeSmsGroup[]; failed?: boolean }>({});
  useEffect(() => {
    if (!enabled || !real) return;
    const controller = new AbortController();
    real.transport.request<{ items: readonly NoticeSmsGroup[] }>({ method: 'GET', path: SMS_GROUP_PATH, signal: controller.signal }).then(
      response => { if (!controller.signal.aborted) setResult({ rows: response.items }); },
      () => { if (!controller.signal.aborted) setResult({ failed: true }); },
    );
    return () => controller.abort();
  }, [attempt, enabled, real]);
  return { ...result, retry: () => { setResult({}); setAttempt(value => value + 1); } };
}

export function useNoticeDelivery(draft: NoticeDraftInput, saved: NoticeDraftInput | undefined, enabled: boolean, http: boolean, examplePreview: NoticePreview | null) {
  const { t } = useBundle(dataBundle);
  const inbox = useInbox();
  const store = useWidgetDataStore();
  const channel = enabled ? draft.channel ?? 'manual' : undefined;
  const sms = channel === 'sms';
  const smsGroups = useNoticeSmsGroups(http && sms);
  const now = http ? seoulMinute(inboxClock.now()) : noticeBusinessNow(store.getSnapshot());
  const [timing, setTiming] = useState<{ id: string | undefined; date: string | null; time: string | null }>();
  const date = timing && timing.id === draft.noticeId ? timing.date : now.slice(0, 10);
  const time = timing && timing.id === draft.noticeId ? timing.time : null;
  const unchanged = saved && saved.channel === channel && saved.revision === draft.revision && saved.title === draft.title
    && saved.body === draft.body && saved.startDate === draft.startDate && saved.endDate === draft.endDate
    && saved.closureEventId === draft.closureEventId && saved.recipientGroupId === draft.recipientGroupId;
  const smsDetail = useNoticeDetail(sms && unchanged ? saved.noticeId ?? null : null, saved?.revision);
  const detail = smsDetail.data?.revision === saved?.revision ? smsDetail.data : undefined;
  const smsPreview: NoticeSmsPreviewDto | undefined = http ? unchanged && sms ? detail?.smsPreview : undefined
    : sms && examplePreview ? { content: examplePreview.renderedBody, contentType: 'AD', type: null, bytes: null, recipientCount: examplePreview.recipientCount,
      maxRecipients: examplePreview.recipientCount, sendAllowed: examplePreview.sendAllowed, reasons: examplePreview.reasons } : undefined;
  const smsNight = sms && isNight(now);
  const sendAt = !sms ? undefined : smsNight ? detail?.nextSendWindow?.localTime ?? tomorrowEight(now) : date && time ? `${date}T${time}` : undefined;
  const timeError = sendAt && !smsNight ? isNight(sendAt) ? t(k('notice.nightBlocked'))
    : Date.parse(`${sendAt}:00+09:00`) - (http ? +inboxClock.now() : Date.parse(`${now}:00+09:00`)) <= 600_000 ? t(k('notice.tooSoon')) : undefined : undefined;
  const audiences: AudiencesDto | undefined = http ? inbox?.audiences.status === 'available' ? inbox.audiences : undefined : {
    items: [{ audience: 'benefit-subscribers', count: 12 }, { audience: 'recent-visitor-reviewers', count: 4 }],
    quota: { month: now.slice(0, 7), assigned: 3 },
  };
  const talkNight = channel === 'talktalk' && isNight(now);
  const smsClosed = sms && detail?.smsEnabled === false;
  const smsGroup = draft.groupIds.length > 0 || (http && !!draft.recipientGroupId);
  const canSave = (!sms || smsGroup) && (channel !== 'talktalk' || !!draft.talkAudience && !!audiences);
  const canSend = canSave && !talkNight && (!sms || smsSenderConfigured && !smsClosed && !!sendAt && !timeError && smsPreview?.sendAllowed === true && (smsPreview.recipientCount ?? 0) > 0);
  const sendLabel = sms ? sendAt && !timeError ? t(k('notice.send.smsAt'), { when: whenOf(t, sendAt) }) : '예약하기' : channel ? t(k(`notice.send.${channel}`)) : '공지 보내기';
  return { channel, http, sms, unchanged, smsDetail, smsPreview, smsNight, talkNight, smsClosed, smsGroup, smsGroups, sendAt, sendLabel, timeError, today: now.slice(0, 10),
    date, time, audiences, canSave, canSend, setTiming: (date: string | null, time: string | null) => setTiming({ id: draft.noticeId, date, time }),
    keepTiming: (id: string) => setTiming(current => current && current.id === draft.noticeId ? { ...current, id } : current), t };
}

type Delivery = ReturnType<typeof useNoticeDelivery>;

type NoticeChannelControls = { delivery: Delivery; busy: boolean; change(patch: Partial<NoticeDraftInput>): void };

export function NoticeChannels({ delivery, busy, change }: NoticeChannelControls) {
  const { channel, t } = delivery;
  return <div className="i7-notice-choice">
    <p className="i7-notice-field-label">{t(k('notice.channel'))}</p>
    <ChipChoice<NoticeChannel> value={channel ?? 'manual'} onChange={channel => change({ channel })} label={t(k('notice.channel'))}
      options={CHANNELS.map(value => ({ value, label: t(k(`notice.channel.${value}`)), disabled: busy }))} />
  </div>;
}

export function NoticeRecipients({ delivery, draft, busy, change, promotional, groups, openSettings }: NoticeChannelControls & {
  draft: NoticeDraftInput; promotional: boolean; groups: Extract<NoticeView, { status: 'ready' }>['groups']; openSettings?: WidgetHost['openSettings'];
}) {
  const { channel, audiences, t } = delivery;
  const groupRows = delivery.http ? delivery.smsGroups.rows : groups.map(({ groupId }) => ({ groupId, recipientGroupId: null }));
  const group = draft.groupIds[0] ?? (draft.recipientGroupId ? groupRows?.find(row => row.recipientGroupId === draft.recipientGroupId)?.groupId : undefined);
  return <>
    {channel === 'manual' && <p className="i7-notice-rule">{t(k('notice.manualHint'))}</p>}
    {channel === 'talktalk' && (audiences ? <div className="i7-notice-choice">
      <p className="i7-notice-field-label">받는 사람</p>
      <ChipChoice value={draft.talkAudience ?? ''} onChange={value => change({ talkAudience: value || undefined })} label={t(k('notice.audience'))}
        options={audiences.items.map(item => ({ value: item.audience, disabled: busy || item.count === 0,
          label: t(k(`notice.audience.${item.audience}`)) }))} />
      {audiences.quota && <p className="i7-notice-rule">{t(k('notice.quota'), { n: audiences.quota.assigned, month: audiences.quota.month })}</p>}
    </div> : <p role="status">{t(k('notice.audienceUnavailable'))}</p>)}
    {delivery.talkNight && <p role="status" className="i7-notice-rule">{t(k('notice.night'))}</p>}
    {delivery.sms && <>
      <div className="i7-notice-choice">
        <p className="i7-notice-field-label">{t(k('notice.smsGroup'))}</p>
        {groupRows?.length ? <ChipChoice<CustomerGroupId | ''> label={t(k('notice.smsGroup'))} value={group ?? ''}
          options={groupRows.map(row => ({ value: row.groupId, label: groups.find(item => item.groupId === row.groupId)?.name ?? smsGroupNames[row.groupId], disabled: busy }))}
          onChange={groupId => { if (groupId) change({ audience: 'group', groupIds: [groupId], recipientGroupId: groupRows.find(row => row.groupId === groupId)?.recipientGroupId ?? undefined }); }} />
          : delivery.smsGroups.failed ? <PanelState tone="error" message="손님 그룹을 불러오지 못했어요" action={{ label: '다시 시도하기', widgetName: '공지 발송', onPress: delivery.smsGroups.retry }} />
            : delivery.http && !groupRows ? <p role="status" className="i7-notice-hint">손님 그룹을 불러오고 있어요</p> : null}
        <p className="i7-notice-hint">{delivery.smsGroup ? '고른 그룹에서 광고 문자에 동의한 손님에게 보내요' : '문자를 받는 손님 그룹을 골라 주세요'}</p>
      </div>
      <div className="i7-notice-rule i7-notice-sms-rule" role="status">
        {delivery.smsClosed && <p>{t(k('error.A6_DISABLED'))}</p>}
        {!delivery.smsNight && <p>{promotional ? '광고 문자는 밤 9시부터 아침 8시까지 보내지 않아요' : '문자는 밤 9시부터 아침 8시까지 보내지 않아요'}</p>}
        {!smsSenderConfigured && <SmsSetupHelp openSettings={openSettings} settingsPath />}
      </div>
    </>}
  </>;
}

export function SmsSchedule({ delivery, busy, onChange }: { delivery: Delivery; busy: boolean; onChange(): void }) {
  const { t, smsNight, date, time, today, timeError, setTiming } = delivery;
  return <section aria-label={t(k('notice.when'))} data-slot="notice-send.sms-schedule">
    <h4 className="i7-notice-field-label">{t(k('notice.when'))}</h4>
    {smsNight ? <>
      <p role="status" className="i7-notice-rule">{t(k('notice.nightOnly'))}</p>
      <ChipChoice value="tomorrow8" onChange={() => undefined} label={t(k('notice.time'))} options={[{ value: 'tomorrow8', label: t(k('notice.tomorrow8')) }]} />
    </> : <div className="i7-notice-dates">
      <DateField label={t(k('notice.date'))} value={date} today={today} min={today} onValueChange={value => { setTiming(value, time); onChange(); }} disabled={busy} />
      <TimeField label={t(k('notice.time'))} value={time} step={10} min="08:00" max="20:50" error={timeError}
        onValueChange={value => { setTiming(date, value); onChange(); }} disabled={busy} />
    </div>}
  </section>;
}

function SmsPreviewContent({ preview, t }: { preview: NoticeSmsPreviewDto; t: Translate['t'] }) {
  return <>
    <p className="mkt-quote" lang="ko">{preview.content}</p>
    {preview.type && preview.bytes !== null && <p className="i7-notice-rule">{t(k(`notice.smsBytes.${preview.type}`), { n: preview.bytes })}</p>}
    {preview.recipientCount !== null && <p className="i7-notice-rule">{t(k('notice.smsConsenting'), { n: preview.recipientCount })}</p>}
  </>;
}

export function SmsPreview({ delivery, body }: { delivery: Delivery; body: string }) {
  const { smsPreview, smsDetail, t } = delivery;
  if (!smsPreview) return smsDetail.status === 'error'
    ? <PanelState tone="error" message={t('data.real.error')} action={{ label: t('common.retry'), widgetName: t(k('notice.smsPreview')), onPress: smsDetail.retry }} />
    : <p role="status">{t('data.real.loading')}</p>;
  return <>
    {smsSenderConfigured ? <SmsPreviewContent preview={smsPreview} t={t} /> : <FixedSmsPreview body={body} recipientCount={smsPreview.recipientCount ?? 0} customerOnly />}
    {smsPreview.reasons.filter(reason => reason !== 'A6_DISABLED' && (smsSenderConfigured || reason !== 'SMS_SETTINGS_REQUIRED')).map(reason => {
      const key = k(`error.${reason}`);
      return <p key={reason} role="status" className="ui-field__error">{t(isInboxMessageKey(key) ? key : k('error.UNAVAILABLE'), { n: smsPreview.maxRecipients })}</p>;
    })}
  </>;
}

export function SmsConfirm({ delivery, busy, onConfirm, onClose }: { delivery: Delivery; busy: boolean; onConfirm(): void; onClose(): void }) {
  const { t, sendAt, smsPreview, sendLabel, canSend } = delivery;
  if (!smsPreview || !sendAt) return null;
  return <div role="group" aria-label={t(k('notice.reviewSms'))} className="mkt-alert" data-slot="notice-send.sms-confirm">
    <p className="mkt-alert__title"><Icon name="warning" aria-hidden />{t(k('notice.confirmSms'), { when: whenOf(t, sendAt) })}</p>
    <SmsPreviewContent preview={smsPreview} t={t} />
    <ActionButton disabled={busy || !canSend} loading={busy} onClick={onConfirm}>{sendLabel}</ActionButton>
    <ActionButton variant="secondary" disabled={busy} onClick={onClose}>{t(k('notice.keep'))}</ActionButton>
  </div>;
}

export function noticeResult(state: 'accepted' | 'recorded' | 'saved' | 'scheduled', t: Translate['t'], sendAt?: string) {
  return t(k(`notice.result.${state}`), sendAt ? { when: whenOf(t, sendAt) } : undefined);
}

/** SCR-273: 보내기 전·보내는 중·예약 취소 neutral, 접수 success, 보내지 못함 warning. */
const SMS_CHIP: Readonly<Record<SmsReservationStatus, 'none' | 'waiting' | 'done' | 'warning'>> = {
  READY: 'waiting', PROCESSING: 'none', DONE: 'done', CANCELED: 'none', FAIL: 'warning', STALE: 'warning', SKIP: 'warning',
};

/** Add provider status and cancellation controls to the rows in the existing reservation list. */
export function smsSchedules(inbox: ReturnType<typeof useInbox>, command: ReturnType<typeof useInboxCommand>, t: Translate['t']) {
  const reservations = new Map<string, NoticeDto>();
  const rows = (inbox?.notices ?? []).flatMap((row): ScheduledRow[] => {
    if (row.channel !== 'sms' || row.status !== 'done' || !row.result?.scheduledFor
      || (row.result.state !== 'scheduled' && row.result.state !== 'canceled')) return [];
    reservations.set(row.id, row);
    return [{ sentId: row.id, noticeId: row.id, title: row.title, sendAt: row.result.scheduledFor, cancellable: false }];
  }).sort((a, b) => b.sendAt.localeCompare(a.sendAt) || a.sentId.localeCompare(b.sentId));
  return { rows, label: t(k('notice.channel.sms')), actions: ({ sentId, sendAt }: ScheduledRow) => {
    const row = reservations.get(sentId);
    return row ? <SmsReservationControls key={`${row.id}:${row.revision}`} row={row} sendAt={sendAt} command={command} t={t} /> : null;
  } };
}

function SmsReservationControls({ row, sendAt, command, t }: { readonly row: NoticeDto; readonly sendAt: string; readonly command: ReturnType<typeof useInboxCommand>; readonly t: Translate['t'] }) {
  const [checking, setChecking] = useState(false);
  const [asking, setAsking] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (asking) keep.current?.focus(); }, [asking]);
  const live = useSmsReservation(checking ? row.id : null);
  const when = whenOf(t, sendAt);
  const canceled = row.result?.state === 'canceled';
  const status: SmsReservationStatus | undefined = canceled ? 'CANCELED' : live.data?.status;
  const future = Date.parse(`${sendAt}:00+09:00`) > +inboxClock.now();
  // Before a read, a future reservation is shown as not sent yet; the press reads the provider again.
  const shown: SmsReservationStatus | undefined = status ?? (!canceled && future ? 'READY' : undefined);
  const cancellable = !canceled && future && shown === 'READY' && (!checking || live.status === 'ready');
  const check = () => { if (checking) live.retry(); else setChecking(true); };
  const cancel = async () => {
    const result = await command.send({ type: 'notice.cancelSchedule', sentId: row.id, idempotencyKey: pressKey('notice') });
    if (result?.ok) setAsking(false);
  };
  return <>
    {shown && <div><StatusBadge semantic={SMS_CHIP[shown]} label={t(k(`notice.sms.status.${shown}`))} /></div>}
    <div className="i7-notice-actions">
      {!canceled && <ActionButton variant="secondary" disabled={command.pending} aria-busy={checking && live.status === 'loading' || undefined} onClick={check}>
        {t(k('notice.sms.check'))}<span className="ui-sr-only"> {row.title}</span></ActionButton>}
      {cancellable && !asking && <ActionButton variant="secondary" disabled={command.pending} onClick={() => setAsking(true)}>{t(k('notice.sms.cancel'))}<span className="ui-sr-only"> {row.title}</span></ActionButton>}
    </div>
    {checking && live.status === 'error' && <p role="alert" className="ui-field__error">{t(k('notice.sms.statusError'))}</p>}
    {status === 'PROCESSING' && <p className="i7-notice-rule">{t(k('notice.sms.cannotCancel'))}</p>}
    {cancellable && asking && <div role="group" aria-label={t(k('notice.sms.cancel'))} className="mkt-alert" data-slot="notice-send.sms-cancel">
      <StatusBadge semantic="warning" label={t(k('notice.sms.confirmBadge'))} />
      <p className="mkt-alert__title"><Icon name="warning" aria-hidden />{t(k('notice.sms.cancelAsk'), { when })}</p>
      <ActionButton ref={keep} variant="secondary" disabled={command.pending} onClick={() => setAsking(false)}>{t(k('notice.sms.keep'))}</ActionButton>
      <ActionButton variant="destructive" disabled={command.pending} aria-busy={command.pending || undefined} onClick={() => void cancel()}>{t(k('notice.sms.cancel'))}</ActionButton>
    </div>}
  </>;
}
