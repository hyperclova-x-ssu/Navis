import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ActionButton, Checkbox, ChipChoice, DataGrid, DateField, DetailFooterContent, DetailTabs, InlineEmpty, InlineForm, MetricFit, PanelAction, PanelState, RadioGroup, Textarea, TextField, useKitT, type DataGridHandle, type GridColumn, type GridFocus, type GridSort } from '../../../ui';
import type { DetailRef, WidgetHost } from '../../../contracts';
import { commandFailureText } from '../../../data/commands/failure-copy';
import type { DataCommandResult } from '../../../data/commands/types';
import { classifyNoticeContent } from '../../../data/iteration7/notices';
import { TODAY } from '../../../data/db/time';
import type { ClosureLinkStatus, NoticeAudience, NoticeChannel, NoticeKind, NoticePreviewView, NoticeTalkAudience } from '../../../data/iteration7/notices/types';
import type { CustomerGroupId } from '../../../data/marketing/types';
import { noticeFormPrefill } from '../../assistant/domains/notices';
import { FitProbe } from '../mgmt-money/fit';
import { Icon } from '../../../ui/icons';
import { dataBundle } from '../../../data/messages';
import { smsSenderConfigured } from '../../../data/reality/14/sms';
import { useBundle } from '../../../i18n';
import { FixedSmsPreview } from '../mkt-coupon/shared';
import { NoticeScheduleCancel } from './schedule-cancel';
import { isInboxMessageKey, NoticeChannels, NoticeRecipients, noticeKey, noticeResult, SmsConfirm, SmsPreview, SmsSchedule, useNoticeDelivery } from './real';
import './widget.css';
import { dateRangeWithWeekdays } from '../date-range';

/** `closureLink` is read live from the calendar by the view, never typed in: anything but current/none asks for a new import. */
export type NoticeDraftInput = { noticeId?: string; revision?: number; closureLink?: ClosureLinkStatus; kind: NoticeKind; title: string; body: string; startDate: string; endDate: string; closureEventId?: string; audience: NoticeAudience; groupIds: CustomerGroupId[];
  channel?: NoticeChannel; talkAudience?: NoticeTalkAudience; recipientGroupId?: string };
export type NoticePreview = NoticePreviewView;
/** `field` is the data layer's name of the refused input (startDate, endDate ...); the date refusal goes under that date. */
type Result<T = object> = ({ ok: true } & T) | { ok: false; reason?: string; messageKey?: string; field?: string; code?: string; outcomeUnknown?: boolean };
type SentRow = { sentId: string; title: string; kind: string; recipientCount: number; sentAt: string; channel?: NoticeChannel;
  result?: 'saved' | 'accepted' | 'recorded'; providerRef?: string };
export type ScheduledRow = { sentId: string; noticeId: string; title: string; recipientCount?: number; sendAt: string; cancellable: boolean };
type ScheduledNoticesBinding = { rows: readonly ScheduledRow[]; label: string; actions(row: ScheduledRow): ReactNode };
export type NoticeView = { status: 'empty' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; unsentCount: number; nextClosure: { eventId: string; title: string } | null; closures: readonly { eventId: string; title: string }[]; drafts: readonly NoticeDraftInput[]; sent: readonly SentRow[]; scheduled: readonly ScheduledRow[]; groups: readonly { groupId: CustomerGroupId; name: string }[] };
export type NoticePort = {
  importClosure(eventId: string, noticeId?: string): Promise<Result<{ draft: NoticeDraftInput }>>;
  /** `unchanged`: the draft already holds exactly these values, so nothing was written. */
  saveDraft(draft: NoticeDraftInput, forSend?: boolean): Promise<Result<{ noticeId: string; revision: number; unchanged?: boolean; recipientGroupId?: string }>>;
  cancelSchedule(sentId: string): Promise<Result>;
  deleteDraft(noticeId: string): Promise<Result>;
  preview(noticeId: string, revision: number, sendAt?: string): Promise<Result<{ preview: NoticePreview }>>;
  send(noticeId: string, revision: number, previewId: string, sendAt?: string): Promise<Result<{ deliveryState?: 'accepted' | 'recorded' | 'saved' | 'scheduled' }>>;
  retry(): void;
};
/** H5: what was typed survives closing and reopening the window. The module keeps it per data store (a new run starts clean). */
export type NoticeDraftMemory = { read(): NoticeDraftInput | null; write(draft: NoticeDraftInput | null): void };
const blank = (): NoticeDraftInput => ({ kind: 'temporary_closure', title: '', body: '', startDate: '', endDate: '', audience: 'all_contactable', groupIds: [] });
const untouched = (draft: NoticeDraftInput) => !draft.noticeId && !draft.title && !draft.body && !draft.startDate && !draft.endDate && !draft.channel && draft.kind === 'temporary_closure' && draft.audience === 'all_contactable' && draft.groupIds.length === 0;
const kinds = [{ value: 'regular_closure', label: '정기 휴무' }, { value: 'temporary_closure', label: '임시 휴무' }, { value: 'hours_change', label: '영업시간 변경' }, { value: 'other', label: '기타' }] as const;
const kindLabel = (kind: string) => kinds.find(item => item.value === kind)?.label ?? kind;
const audiences = [{ value: 'all_contactable', label: '연락처가 있는 회원 전체' }, { value: 'group', label: '손님 그룹 선택' }] as const;
const reason: Record<string, string> = { TITLE_REQUIRED: '공지 제목을 넣어 주세요', BODY_REQUIRED: '공지 내용을 넣어 주세요', NO_RECIPIENTS: '보낼 수 있는 손님이 없어요', AD_NIGHT_RESTRICTED: '밤 9시부터 아침 8시까지는 광고 문자를 보낼 수 없어요', PREVIEW_STALE: '내용이 바뀌었어요. 미리보기를 다시 눌러 주세요', INVALID_DATE_RANGE: '날짜와 기간을 확인해 주세요' };
const message = (code?: string) => reason[code ?? ''] ?? '처리하지 못했어요. 다시 시도해 주세요';
reason.PAST_DATE = '지난 날짜에는 공지를 만들 수 없어요. 오늘 이후로 골라 주세요';
/** The handler says why a linked draft is stale by messageKey; the calendar closure text is the same as in the banner. */
const staleText: Readonly<Record<string, string>> = { changed: '휴무 일정이 바뀌었어요. 휴무를 다시 불러와 주세요', removed: '연결된 휴무 일정이 없어요. 캘린더에서 다른 휴무를 불러와 주세요', dates: '공지 기간이 캘린더 휴무와 달라요. 휴무를 다시 불러와 주세요' };
const staleKey: Readonly<Record<string, string>> = { 'data.notices.error.CLOSURE_CHANGED': staleText.changed!, 'data.notices.error.CLOSURE_REMOVED': staleText.removed!, 'data.notices.error.CLOSURE_DATES_DIFFER': staleText.dates! };
const messageOf = (result: { reason?: string; messageKey?: string }) => staleKey[result.messageKey ?? ''] ?? message(result.reason);
const dateReason = (result: { reason?: string }) => result.reason === 'INVALID_DATE_RANGE' || result.reason === 'PAST_DATE';
const SAVED = '임시 저장했어요', SENT = '보냈어요', PREVIEW_FIRST = '미리보기를 먼저 눌러 내용을 확인해 주세요';
const NO_ROWS: ReadonlySet<string> = new Set();
type DateFieldName = 'startDate' | 'endDate';

/** A draft kept from an earlier visit may point at a saved draft that is gone now: then it is a new draft again. */
function restored(draft: NoticeDraftInput | null | undefined, view: NoticeView): NoticeDraftInput {
  if (!draft) return blank();
  if (draft.noticeId && view.status === 'ready' && !view.drafts.some(item => item.noticeId === draft.noticeId)) {
    const { noticeId: _id, revision: _revision, closureLink: _link, ...input } = draft;
    return input;
  }
  return draft;
}

export function NoticeEditor({ view, port, memory, detailRef, deliveryChannels = false, schedules, deleteNews, openSettings }: {
  view: NoticeView; port: NoticePort | Omit<NoticePort, 'preview'>; memory?: NoticeDraftMemory; detailRef?: DetailRef;
  deliveryChannels?: boolean; schedules?: ScheduledNoticesBinding; deleteNews?(id: string): Promise<boolean>; openSettings?: WidgetHost['openSettings'];
}) {
  const { t } = useBundle(dataBundle);
  const http = !('preview' in port);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [smsConfirm, setSmsConfirm] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<'compose' | 'history' | 'scheduled'>(detailRef?.view === 'history' || detailRef?.view === 'scheduled' ? detailRef.view : 'compose');
  const [draft, setDraft] = useState<NoticeDraftInput>(() => {
    const picked = detailRef?.itemId && detailRef.view !== 'history' && view.status === 'ready' ? view.drafts.find(item => item.noticeId === detailRef.itemId) : undefined;
    const prefill = detailRef && noticeFormPrefill(detailRef);
    const base = picked ?? (detailRef?.itemId && detailRef.view !== 'history' || prefill ? blank() : restored(memory?.read(), view));
    return { ...base, ...prefill, groupIds: [...(prefill?.groupIds ?? base.groupIds)] };
  });
  const [preview, setPreview] = useState<NoticePreview | null>(null);
  const [picker, setPicker] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [sentFeedback, setSentFeedback] = useState<'sent' | 'scheduled'>();
  /** Title and content refusals sit under their own field and take focus. */
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({});
  /** Date refusals sit under the date field the data layer names (role=alert), not in the status line. */
  const [dateError, setDateError] = useState<{ field: DateFieldName; text: string } | null>(null);
  const statusId = useId();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (tab === 'compose') memory?.write(untouched(draft) ? null : draft); }, [draft, memory, tab]);
  const locked = useRef(false);
  const version = useRef(0);
  const titleInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const previewBox = useRef<HTMLElement>(null);
  const previewAction = useRef<HTMLButtonElement>(null);
  const reimportAction = useRef<HTMLButtonElement>(null);
  const ruleBand = useRef<HTMLDivElement>(null);
  const clearMessages = () => { setDeleteConfirm(false); setSmsConfirm(false); setFeedback(''); setSentFeedback(undefined); setErrors({}); setDateError(null); };
  const change = (patch: Partial<NoticeDraftInput>) => { version.current++; setDraft(current => ({ ...current, ...patch })); setPreview(null); clearMessages(); };
  const run = async (action: () => Promise<void>) => { if (locked.current) return; locked.current = true; setPending(true); try { await action(); } catch { setFeedback(message()); } finally { locked.current = false; setPending(false); } };
  // T-17 (PKG-F failure copy): a refusal the widget has no sentence for says what was refused and what to do instead of the bare "처리하지 못했어요".
  const refusalMessage = (result: { reason?: string; messageKey?: string; code?: string; outcomeUnknown?: boolean }) => deliveryChannels && isInboxMessageKey(result.messageKey)
    ? t(result.messageKey)
    : deliveryChannels && result.code && result.messageKey && !reason[result.reason ?? ''] && !staleKey[result.messageKey]
      ? commandFailureText(t, result as Extract<DataCommandResult, { ok: false }>) : messageOf(result);
  const refuse = (result: { reason?: string; messageKey?: string; field?: string }) => { if (dateReason(result)) setDateError({ field: result.field === 'endDate' ? 'endDate' : 'startDate', text: refusalMessage(result) }); else setFeedback(refusalMessage(result)); };
  const validate = () => {
    const found = { ...(draft.title.trim() ? {} : { title: message('TITLE_REQUIRED') }), ...(draft.body.trim() ? {} : { body: message('BODY_REQUIRED') }) };
    if (!found.title && !found.body) return true;
    setFeedback(''); setErrors(found); (found.title ? titleInput : bodyInput).current?.focus();
    return false;
  };
  const save = async (forSend?: boolean) => {
    if (!validate()) return null;
    const result = await port.saveDraft(draft, forSend);
    if (!result.ok) { refuse(result); return null; }
    return result;
  };
  const model = view.status === 'ready' ? view : { unsentCount: 0, nextClosure: null, closures: [], drafts: [], sent: [], scheduled: [], groups: [] };
  const savedDraft = model.drafts.find(item => item.noticeId === draft.noticeId);
  const delivery = useNoticeDelivery(draft, savedDraft, deliveryChannels, http, preview);
  /** The calendar closure behind this draft changed after the import: the old preview must not be sent. */
  const link = draft.noticeId ? savedDraft?.closureLink : undefined;
  const stale = link === 'changed' || link === 'removed' || link === 'dates' ? link : null;
  const withReceipt = (saved: { noticeId: string; revision: number; recipientGroupId?: string }) => {
    if (delivery.sms) delivery.keepTiming(saved.noticeId);
    setDraft(current => ({
      ...current, ...(http ? { channel: delivery.channel, title: current.title.trim(), body: current.body.trim(),
        startDate: current.startDate || delivery.today, endDate: current.endDate || current.startDate || delivery.today } : {}), ...saved,
    }));
  };
  /** T-11: a stale draft that was not edited is not written, so "saved" would be untrue: the re-import offer takes the press instead. */
  const onSave = () => void run(async () => {
    const v = version.current; const result = await save();
    if (!result || v !== version.current) return;
    withReceipt(result); setSentFeedback(undefined);
    if (result.unchanged && stale) { setFeedback(''); reimportAction.current?.focus(); return; }
    setFeedback(SAVED);
  });
  const onPreview = () => {
    if (!('preview' in port)) {
      if (!validate()) return;
      const start = draft.startDate || delivery.today;
      if (draft.endDate && draft.endDate < start) { refuse({ reason: 'INVALID_DATE_RANGE' }); return; }
      setPreview({ previewId: 'service', draftRevision: draft.revision ?? 0, renderedBody: draft.body.trim(),
        contentClass: classifyNoticeContent(draft.title, draft.body), recipientCount: 0, excludedCount: 0,
        adMarker: false, optOutText: '', sendAllowed: true, reasons: [] });
      clearMessages();
      return;
    }
    void run(async () => {
      const v = version.current;
      const saved = await save();
      if (!saved || v !== version.current) return;
      withReceipt(saved);
      const result = await port.preview(saved.noticeId, saved.revision, delivery.sendAt);
      if (v !== version.current) return;
      if (!result.ok) { setPreview(null); refuse(result); return; }
      setPreview(result.preview);
      setSentFeedback(undefined);
      setFeedback(result.preview.recipientCount === 0 ? message('NO_RECIPIENTS') : result.preview.reasons
        .map(code => code === 'NIGHT_RESTRICTED' ? t('data.notices.error.NIGHT_RESTRICTED') : message(code)).join(' '));
    });
  };
  const [focusOnEntry] = useState(() => tab === 'compose' && (detailRef?.view === 'drafts' || detailRef?.focus === 'action'));
  useEffect(() => {
    if (!focusOnEntry) return;
    const fields = detailRef?.prefill?.kind === 'widget-draft' ? detailRef.prefill.fields : undefined;
    const focusTarget = () => reimportAction.current ?? (fields ? fields.body && !fields.title ? bodyInput.current : titleInput.current : previewAction.current);
    const frame = requestAnimationFrame(() => focusTarget()?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusOnEntry, detailRef?.prefill]);
  const fresh = stale || (http && draft.noticeId && savedDraft?.revision !== draft.revision) ? null : preview;
  const alreadyScheduled = model.scheduled.some(row => row.noticeId === draft.noticeId);
  const senderMissing = !http && (!deliveryChannels || delivery.sms) && fresh?.contentClass === 'promotional' && !smsSenderConfigured;
  const canSend = !alreadyScheduled && !senderMissing && !stale && (delivery.sms ? delivery.canSend
    : !!fresh?.sendAllowed && delivery.canSend && (http || !!fresh.recipientCount));
  const onSend = (confirmed = false) => {
    if (!canSend || locked.current) return;
    if (delivery.sms && !confirmed) { setSmsConfirm(true); return; }
    void run(async () => {
      const v = version.current;
      let target = draft.noticeId && draft.revision ? { noticeId: draft.noticeId, revision: draft.revision } : null;
      if (http && !delivery.sms) {
        target = await save(true);
        if (!target || !mounted.current || v !== version.current) return;
        withReceipt(target);
      }
      if (!http) await new Promise<void>(resolve => setTimeout(resolve, 1000));
      if (!target || !mounted.current || v !== version.current) return;
      const revision = http ? target.revision : fresh?.draftRevision ?? target.revision;
      const result = await port.send(target.noticeId, revision, fresh?.previewId ?? 'service', delivery.sendAt);
      if (v !== version.current) return;
      setSmsConfirm(false);
      if (!result.ok) { setPreview(null); setFeedback(result.reason === 'ALREADY_SCHEDULED' ? t('data.notices.error.ALREADY_SCHEDULED') : refusalMessage(result)); return; }
      version.current++; setDraft(blank()); setPreview(null); setErrors({}); setDateError(null);
      setSentFeedback(result.deliveryState === 'scheduled' ? 'scheduled' : 'sent');
      setFeedback(result.deliveryState ? noticeResult(result.deliveryState, t, delivery.sendAt) : SENT);
    });
  };
  const deleteId = deleteConfirm ? draft.noticeId : undefined;
  const onDelete = () => void run(async () => { if (!deleteId) return; setDeleteConfirm(false); const result = await port.deleteDraft(deleteId); if (!result.ok) { setFeedback(messageOf(result)); return; } version.current++; setDraft(blank()); setPreview(null); clearMessages(); });
  const importFrom = (eventId: string) => void run(async () => { const v = version.current; const result = await port.importClosure(eventId, draft.noticeId); if (v !== version.current) return; if (!result.ok) { setFeedback(messageOf(result)); return; } version.current++; setDraft(result.draft); setPreview(null); setPicker(false); clearMessages(); });
  const promotional = classifyNoticeContent(draft.title, draft.body) === 'promotional';
  const previewId = fresh?.previewId;
  useEffect(() => { if (previewId) previewBox.current?.scrollIntoView?.({ block: 'nearest' }); }, [previewId]);
  // The warning band is taller than the info band: when ad wording shows up it moves into view instead of hiding below the fold (large text).
  useEffect(() => { if (promotional) ruleBand.current?.scrollIntoView?.({ block: 'nearest' }); }, [promotional]);
  if (view.status === 'error') return <PanelState tone="error" message="공지 내역을 불러오지 못했어요" action={{ label: '다시 시도하기', widgetName: '공지 발송', onPress: port.retry }} />;
  const shown = alreadyScheduled ? t('data.notices.error.ALREADY_SCHEDULED') : feedback && !(stale && feedback === staleText[stale]) ? feedback : '';
  const statusText = shown || (delivery.sms && !delivery.sendAt && !pending ? '보낼 시각을 골라 주세요'
    : senderMissing || delivery.sms ? '' : !canSend && !pending ? PREVIEW_FIRST : '');
  const good = shown === SAVED || !!sentFeedback;
  return <div className="i7-notice-detail" data-tab={tab} lang="ko">
    <DetailTabs value={tab} onValueChange={value => { setDeleteConfirm(false); setSmsConfirm(false); setTab(value); }} label="공지 발송 보기" tabs={[{ value: 'compose', label: '공지 작성' }, { value: 'scheduled', label: t('data.notices.schedule.list') }, { value: 'history', label: '보낸 기록' }]} />
    {tab === 'history' ? <SentHistory rows={model.sent} initialItemId={detailRef?.view === 'history' ? detailRef.itemId : undefined} onCompose={() => setTab('compose')} deleteNews={deleteNews} /> : tab === 'scheduled' ? <ScheduledNotices rows={model.scheduled} port={port} binding={schedules} onCompose={() => setTab('compose')} /> : <div className="i7-notice-form">
      <p className="i7-notice-field-label">공지 종류</p>
      <ChipChoice label="공지 종류" value={draft.kind} onChange={kind => change({ kind })} options={kinds} />
      <div className="i7-notice-toolbar">
      {model.drafts.length > 0 && <select className="ui-text-input i7-notice-draft-pick" aria-label="임시 저장한 공지" value={draft.noticeId ?? ''} onChange={event => { const selected = model.drafts.find(item => item.noticeId === event.currentTarget.value); if (selected) { version.current++; setDraft(selected); setPreview(null); clearMessages(); } }}><option value="">임시 저장한 공지 고르기</option>{model.drafts.map(item => <option key={item.noticeId} value={item.noticeId}>{item.title}</option>)}</select>}
        <ActionButton variant="secondary" className="i7-notice-calendar-load" onClick={() => setPicker(!picker)}>
          캘린더에서 불러오기
        </ActionButton>
      </div>
      {picker && <><p className="i7-notice-field-label">{model.closures.length ? '불러올 휴무를 골라 주세요' : '불러올 휴무가 없어요'}</p><div className="i7-notice-picker">{model.closures.map(closure => <ActionButton key={closure.eventId} variant="secondary" disabled={pending} onClick={() => importFrom(closure.eventId)}>{closure.title}</ActionButton>)}</div></>}
      {deliveryChannels && <>
        <NoticeChannels delivery={delivery} busy={pending} change={change} />
        <NoticeRecipients delivery={delivery} draft={draft} groups={model.groups} busy={pending} change={change} promotional={promotional} openSettings={openSettings} />
      </>}
      <TextField label="공지 제목" value={draft.title} onValueChange={title => change({ title })} error={errors.title} inputRef={titleInput} />
      <div className="i7-notice-dates">
        <DateField label="시작 날짜" value={draft.startDate || null} onValueChange={startDate => change({ startDate: startDate ?? '' })} error={dateError?.field === 'startDate' ? dateError.text : undefined} />
        <DateField label="종료 날짜" value={draft.endDate || null} min={draft.startDate || undefined} onValueChange={endDate => change({ endDate: endDate ?? '' })} error={dateError?.field === 'endDate' ? dateError.text : undefined} />
      </div>
      {stale && <div role="alert" className="i7-notice-stale"><p>{staleText[stale]}</p>{stale !== 'removed' && draft.closureEventId && <ActionButton ref={reimportAction} variant="secondary" disabled={pending} onClick={() => importFrom(draft.closureEventId!)}>캘린더에서 다시 가져오기</ActionButton>}</div>}
      <Textarea label="공지 내용" value={draft.body} onValueChange={body => change({ body })} error={errors.body} inputRef={bodyInput} />
      {!deliveryChannels && <>
      <RadioGroup label="받는 사람" orientation="horizontal" value={draft.audience} onValueChange={audience => change(audience === 'all_contactable' ? { audience, groupIds: [] } : { audience })} options={audiences} />
      {draft.audience === 'group' && <div className="i7-notice-groups">{model.groups.map(group => <Checkbox key={group.groupId} label={group.name} checked={draft.groupIds.includes(group.groupId)} onCheckedChange={checked => change({ groupIds: checked ? [...draft.groupIds, group.groupId] : draft.groupIds.filter(id => id !== group.groupId) })} />)}</div>}
      <div ref={ruleBand} role="status" className="i7-notice-rule" data-tone={promotional ? 'warning' : 'info'}>
        <Icon name={promotional ? 'warning' : 'info'} aria-hidden />
        {promotional
          ? <div><p>홍보 문구가 들어가면 문자 동의한 손님에게만 보낼 수 있어요</p><p>(광고) 표시와 수신 거부 안내가 자동으로 들어가요</p><p>밤 9시부터 아침 8시까지는 광고 문자를 보낼 수 없어요</p></div>
          : <p>정보성 공지는 연락처가 있는 회원 모두에게 보낼 수 있어요</p>}
      </div>
      </>}
      {delivery.sms && <SmsSchedule delivery={delivery} busy={pending} onChange={() => {
        setSmsConfirm(false);
        if (!http) { version.current++; setPreview(null); }
      }} />}
      {(fresh || delivery.sms && delivery.unchanged) && <section ref={previewBox} className="i7-notice-preview" aria-label={delivery.sms ? t(noticeKey('notice.smsPreview')) : '미리보기'}>
        <h3>{delivery.sms ? t(noticeKey('notice.smsPreview')) : '미리보기'}</h3>
        {delivery.sms && (delivery.unchanged || !http) ? <SmsPreview delivery={delivery} body={draft.body} /> : fresh && <>
          {senderMissing ? <FixedSmsPreview body={draft.body} recipientCount={fresh.recipientCount} customerOnly /> : <p className="i7-notice-preview-body">{fresh.renderedBody}</p>}
          {!http && <p>받는 사람 {fresh.recipientCount}명</p>}
        </>}
      </section>}
      {smsConfirm && <SmsConfirm delivery={delivery} busy={pending} onConfirm={() => onSend(true)} onClose={() => setSmsConfirm(false)} />}
    </div>}
    {tab === 'compose' && <DetailFooterContent>
      {deleteId && <InlineForm title="공지 초안을 지울까요?" saveLabel="초안 지우기" closeLabel="그대로 두기" returnFocusRef={deleteButton}
        onSave={onDelete} onClose={() => setDeleteConfirm(false)}>{null}</InlineForm>}
      <div className="i7-notice-footbar">
        {draft.noticeId && <ActionButton ref={deleteButton} variant="secondary" disabled={pending || deleteConfirm || smsConfirm} onClick={() => setDeleteConfirm(true)}>임시 저장 지우기</ActionButton>}
        <p role="status" id={statusId} className="i7-notice-status" data-tone={good ? 'ok' : shown ? 'error' : 'hint'}>
          {statusText && <Icon name={good ? 'status-ok' : shown ? 'warning' : 'info'} aria-hidden />}
          <span>{statusText}</span>
          {sentFeedback === 'sent' && <ActionButton variant="secondary" onClick={() => setTab('history')}>보낸 기록 보기</ActionButton>}
          {sentFeedback === 'scheduled' && <ActionButton variant="secondary" onClick={() => setTab('scheduled')}>{t('data.notices.schedule.list')}</ActionButton>}
        </p>
        <div className="i7-notice-actions">
          <ActionButton variant="secondary" disabled={pending || !delivery.canSave} onClick={onSave}>임시 저장하기</ActionButton>
          <ActionButton ref={previewAction} variant="secondary" disabled={pending || !delivery.canSave} onClick={onPreview}>미리보기</ActionButton>
          {!smsConfirm && <ActionButton loading={pending && !!fresh} disabled={!canSend || pending} aria-describedby={statusText ? statusId : undefined} onClick={() => onSend()}>{pending && fresh ? '공지를 보내고 있어요' : delivery.sendLabel}</ActionButton>}
        </div>
      </div>
    </DetailFooterContent>}
  </div>;
}

function ScheduledNotices({ rows, port, binding, onCompose }: { rows: readonly ScheduledRow[]; port: Pick<NoticePort, 'cancelSchedule'>; binding?: ScheduledNoticesBinding; onCompose(): void }) {
  const { t, format } = useBundle(dataBundle);
  const items = binding?.rows ?? rows;
  if (!items.length) return <div className="i7-notice-history-state"><InlineEmpty title={t('data.notices.schedule.empty')} />
    <ActionButton variant="secondary" onClick={onCompose}>공지 작성하기</ActionButton></div>;
  return <ul className="i7-notice-schedules" role="list" aria-label={binding?.label ?? t('data.notices.schedule.list')}>
    {items.map(row => <li key={row.sentId}>
      <div>
        <strong>{row.title}</strong>
        <p>{format.dateTime(row.sendAt, { today: TODAY })}{row.recipientCount !== undefined && <> · {format.count(row.recipientCount, 'person')}</>}</p>
      </div>
      {binding ? binding.actions(row) : <NoticeScheduleCancel available={row.cancellable} cancel={async () => (await port.cancelSchedule(row.sentId)).ok} />}
    </li>)}
  </ul>;
}

/** 보낸 기록: the kit DataGrid, read only (SCR-273). Dates read `오늘 15:45` / `11/16(월) 15:45`, never ISO. */
function SentHistory({ rows, initialItemId, onCompose, deleteNews }: { rows: readonly SentRow[]; initialItemId?: string; onCompose(): void; deleteNews?(id: string): Promise<boolean> }) {
  const { format } = useKitT();
  const { t } = useBundle(dataBundle);
  const [sort, setSort] = useState<GridSort>(null);
  const [focus, setFocus] = useState<GridFocus>(null);
  const [news, setNews] = useState<SentRow>();
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  const deletingRef = useRef(false);
  const grid = useRef<DataGridHandle>(null);
  useEffect(() => { if (initialItemId) grid.current?.focusCell(initialItemId, 'title'); }, [initialItemId]);
  const when = (row: SentRow) => format.dateTime(row.sentAt, { today: TODAY });
  const people = (row: SentRow) => row.channel ? '—' : `${row.recipientCount}명`;
  const columns: GridColumn<SentRow>[] = [
    { id: 'title', header: '공지 제목', kind: 'text', minWidth: 240, value: row => row.title },
    { id: 'kind', header: '공지 종류', kind: 'text', minWidth: 200, fixedWidth: true, value: row => kindLabel(row.kind),
      render: row => row.channel && row.result ? <>{t(noticeKey(`notice.channel.${row.channel}`))}<small className="i7-notice-draft__sub">{noticeResult(row.result, t)}</small></> : kindLabel(row.kind) },
    { id: 'recipients', header: '받는 사람', kind: 'number', minWidth: 160, fixedWidth: true, value: row => row.channel ? null : row.recipientCount, render: people, accessibleValue: people },
    { id: 'sentAt', header: '보낸 일시', kind: 'text', minWidth: 220, fixedWidth: true, value: row => row.sentAt, render: when, accessibleValue: when },
  ];
  const published = deleteNews ? rows.filter(row => row.channel === 'place-news' && row.providerRef) : [];
  return <div className="i7-notice-sent-grid">
    <DataGrid ref={grid} id="notice-history" label="보낸 기록" rows={rows} getRowId={row => row.sentId} getRowLabel={row => row.title} columns={columns}
      sort={sort} onSortChange={setSort} selectedRowId={null} expandedRowIds={NO_ROWS} focus={focus} onFocusChange={setFocus}
      emptyContent={<div className="i7-notice-history-state">
        <Icon name="clock" aria-hidden />
        <InlineEmpty title="아직 보낸 공지가 없어요" description="공지를 보내면 여기에 남아요" action={<ActionButton variant="secondary" onClick={onCompose}>공지 작성하기</ActionButton>} />
      </div>} />
    {published.length > 0 && <div className="i7-notice-toolbar">{published.map(row =>
      <ActionButton key={row.sentId} variant="secondary" disabled={deleting} onClick={() => { setFailed(false); setNews(row); }}>
        {t(noticeKey('notice.deleteNews'))}<span className="ui-sr-only"> {row.title}</span>
      </ActionButton>)}</div>}
    {news && <InlineForm title={t(noticeKey('notice.deleteNewsAsk'))} saveLabel={t(noticeKey('notice.deleteYes'))} closeLabel={t(noticeKey('notice.keep'))}
      saving={deleting} onClose={() => { if (!deletingRef.current) setNews(undefined); }} onSave={async () => {
        if (!deleteNews || deletingRef.current) return;
        deletingRef.current = true; setDeleting(true);
        try { if (await deleteNews(news.sentId)) setNews(undefined); else setFailed(true); }
        finally { deletingRef.current = false; setDeleting(false); }
      }}><p>{news.title}</p>{failed && <p role="alert">{message()}</p>}</InlineForm>}
  </div>;
}

export function NoticePanel({ view, width, height, onOpen, onRetry, onScheduled }: { view: NoticeView; width: number; height: number; onOpen(): void; onRetry(): void; onScheduled?(): void }) {
  const kit = useKitT(), { format } = kit;
  if (view.status === 'loading') return <p role="status">공지 내역을 불러오고 있어요</p>;
  if (view.status === 'error') return <PanelState tone="error" message="공지 내역을 불러오지 못했어요" shortMessage={height === 1 && width <= 2 ? '불러오지 못했어요' : undefined} action={{ label: '다시 시도하기', widgetName: '공지 발송', onPress: onRetry }} />;
  const count = view.status === 'ready' ? view.unsentCount : 0, nextClosure = view.status === 'ready' ? view.nextClosure : null, sent = view.status === 'ready' ? view.sent : [];
  const compact = width === 1 && height === 1;
  const wide = width >= 3 && height >= 2;
  /** D-333: the 4-high wide card also shows each draft's kind, dates (closure and hours drafts only) and first words, the scheduled notices, and up to 8 sent rows — only what the data holds. */
  const large = wide && height >= 4;
  const when = (sentAt: string) => format.dateTime(sentAt, { today: TODAY });
  const draftSub = (draft: NoticeDraftInput) => [kindLabel(draft.kind), draft.kind !== 'other' && draft.startDate ? (draft.endDate && draft.endDate !== draft.startDate ? dateRangeWithWeekdays(kit, draft.startDate, draft.endDate) : format.date(draft.startDate, 'short')) : null].filter(Boolean).join('\u00A0·\u00A0');
  const scheduledRows = large && view.status === 'ready' ? view.scheduled : [];
  const scheduled = view.status === 'ready' && view.scheduled.length > 0 && onScheduled;
  const action = <PanelAction label={scheduled ? '예약한 공지 보기' : '공지 보내기'} widgetName="공지 발송" onPress={scheduled || onOpen} />;
  const metric = <div className="i7-notice-metric"><div className="i7-notice-metric-line"><div className="i7-notice-number"><MetricFit value={String(count)} unit="건" stacked={false} /></div>{(compact || (width >= 2 && height >= 2)) && action}</div><p className="i7-notice-subtitle">안 보낸 공지</p></div>;
  const closure = nextClosure && <p className="i7-notice-closure"><Icon name="calendar-check" />{nextClosure.title}</p>;
  const drafts = view.status === 'ready' ? view.drafts : [];
  const history = sent.length ? <div className="i7-notice-history" aria-label="보낸 기록">{sent.slice(0, height >= 3 ? 4 : 2).map(row => <div className="i7-notice-value-row i7-notice-history-row" key={row.sentId}><span>{row.title}</span><strong>{when(row.sentAt)}</strong></div>)}</div> : <p className="i7-notice-history-empty">아직 보낸 공지가 없어요</p>;
  return <div className="i7-notice-panel" data-width={width} data-height={height} lang="ko">
    {metric}
    {!compact && (height === 1 ? <>
      <div className="i7-notice-wide-rows"><div className="i7-notice-value-row"><span>다가오는 매장 휴무</span><strong>{nextClosure?.title.match(/\d{2}\/\d{2}(?:\([^)]+\))?/)?.[0] ?? nextClosure?.title ?? '없어요'}</strong></div>{width >= 3 && <div className="i7-notice-value-row"><span>보낸 공지</span><strong>{sent.length}건</strong></div>}</div>
      <div className="i7-notice-wide-action">{action}</div>
    </> : wide ? <div className="i7-notice-workspace"><div>
      <h3>다가오는 매장 휴무</h3>{closure ?? <p className="i7-notice-history-empty">없어요</p>}
      <div className="i7-notice-drafts"><h3>임시 저장한 공지</h3>{drafts.length === 0 && <p className="i7-notice-history-empty">없어요</p>}{drafts.slice(0, height + 1).map((draft, i) => <div className="i7-notice-value-row i7-notice-draft" key={draft.noticeId ?? i}><span>{draft.title}{large && <><span className="i7-notice-draft__sub">{draftSub(draft)}</span>{draft.body && <span className="i7-notice-draft__body">{draft.body}</span>}</>}</span></div>)}</div>
      {scheduledRows.length > 0 && <div className="i7-notice-scheduled"><p>예약한 공지</p>{scheduledRows.map(row => <div className="i7-notice-value-row" key={row.sentId}><span>{row.title}</span><strong>{when(row.sendAt)}{row.recipientCount !== undefined && <> · {row.recipientCount}명</>}</strong></div>)}</div>}</div>
      <div className="i7-notice-history-table"><h3>보낸 기록</h3>{sent.length ? <table aria-label="보낸 기록"><thead><tr><th>공지 제목</th><th className="i7-notice-kind">공지 종류</th><th>받는 사람</th><th>보낸 일시</th></tr></thead><tbody>{sent.slice(0, height >= 4 ? 8 : height >= 3 ? 6 : 3).map(row => <tr key={row.sentId}><td>{row.title}</td><td className="i7-notice-kind">{kindLabel(row.kind)}</td><td>{row.channel ? '—' : `${row.recipientCount}명`}</td><td>{when(row.sentAt)}</td></tr>)}</tbody></table> : history}</div>
    </div> : <div className="i7-notice-panel-list">{width === 1 && action}{closure}{width >= 2 && height === 2 && <div className="i7-notice-value-row i7-notice-sent-count"><span>보낸 공지</span><strong>{sent.length}건</strong></div>}{(width === 1 || height >= 3) && history}</div>)}
    <FitProbe order={[{ selector: '.i7-notice-draft__body' }, { selector: '.i7-notice-draft__sub' }, { selector: '.i7-notice-scheduled' }, { selector: '.i7-notice-kind' }, { selector: '.i7-notice-history-row', last: true }, { selector: '.i7-notice-history-table tbody tr', last: true }, { selector: '.i7-notice-draft', last: true }, { selector: '.i7-notice-sent-count' }, ...(width === 1 ? [{ selector: '.i7-notice-closure' }] : [])]} deps={[width, height, count, sent.length, drafts.length]} />
  </div>;
}
