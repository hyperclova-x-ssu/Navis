import { useEffect, useId, useRef, useState } from 'react';
import { ActionButton, Checkbox, ChipChoice, DataGrid, DateField, DetailFooterContent, DetailTabs, InlineEmpty, MetricFit, PanelAction, PanelState, RadioGroup, Textarea, TextField, useKitT, type DataGridHandle, type GridColumn, type GridFocus, type GridSort } from '../../../ui';
import type { DetailRef } from '../../../contracts';
import { classifyNoticeContent } from '../../../data/iteration7/notices';
import { TODAY } from '../../../data/db/time';
import type { ClosureLinkStatus, NoticeAudience, NoticeKind, NoticePreviewView } from '../../../data/iteration7/notices/types';
import type { CustomerGroupId } from '../../../data/marketing/types';
import { noticeFormPrefill } from '../../assistant/domains/notices';
import { FitProbe } from '../mgmt-money/fit';
import { Icon } from '../../../ui/icons';
import './widget.css';

/** `closureLink` is read live from the calendar by the view, never typed in: anything but current/none asks for a new import. */
export type NoticeDraftInput = { noticeId?: string; revision?: number; closureLink?: ClosureLinkStatus; kind: NoticeKind; title: string; body: string; startDate: string; endDate: string; closureEventId?: string; audience: NoticeAudience; groupIds: CustomerGroupId[] };
export type NoticePreview = NoticePreviewView;
/** `field` is the data layer's name of the refused input (startDate, endDate ...); the date refusal goes under that date. */
type Result<T = object> = ({ ok: true } & T) | { ok: false; reason?: string; messageKey?: string; field?: string };
type SentRow = { sentId: string; title: string; kind: string; recipientCount: number; sentAt: string };
export type NoticeView = { status: 'empty' } | { status: 'error' } | { status: 'ready'; unsentCount: number; nextClosure: { eventId: string; title: string } | null; closures: readonly { eventId: string; title: string }[]; drafts: readonly NoticeDraftInput[]; sent: readonly SentRow[]; groups: readonly { groupId: CustomerGroupId; name: string }[] };
export type NoticePort = {
  importClosure(eventId: string, noticeId?: string): Promise<Result<{ draft: NoticeDraftInput }>>;
  saveDraft(draft: NoticeDraftInput): Promise<Result<{ noticeId: string; revision: number }>>;
  deleteDraft(noticeId: string): Promise<Result>;
  preview(noticeId: string, revision: number): Promise<Result<{ preview: NoticePreview }>>;
  send(noticeId: string, revision: number, previewId: string): Promise<Result>;
  retry(): void;
};
/** H5: what was typed survives closing and reopening the window. The module keeps it per data store (a new run starts clean). */
export type NoticeDraftMemory = { read(): NoticeDraftInput | null; write(draft: NoticeDraftInput | null): void };
const blank = (): NoticeDraftInput => ({ kind: 'temporary_closure', title: '', body: '', startDate: '', endDate: '', audience: 'all_contactable', groupIds: [] });
const untouched = (draft: NoticeDraftInput) => !draft.noticeId && !draft.title && !draft.body && !draft.startDate && !draft.endDate && draft.kind === 'temporary_closure' && draft.audience === 'all_contactable' && draft.groupIds.length === 0;
const kinds = [{ value: 'regular_closure', label: '정기 휴무' }, { value: 'temporary_closure', label: '임시 휴무' }, { value: 'hours_change', label: '영업시간 변경' }, { value: 'other', label: '기타' }] as const;
const kindLabel = (kind: string) => kinds.find(item => item.value === kind)?.label ?? kind;
const audiences = [{ value: 'all_contactable', label: '연락처가 있는 회원 전체' }, { value: 'group', label: '손님 그룹 선택' }] as const;
const reason: Record<string, string> = { TITLE_REQUIRED: '공지 제목을 넣어 주세요', BODY_REQUIRED: '공지 내용을 넣어 주세요', NO_RECIPIENTS: '보낼 수 있는 손님이 없어요', AD_NIGHT_RESTRICTED: '밤 9시부터 아침 8시까지는 광고 문자를 보낼 수 없어요', PREVIEW_STALE: '내용이 바뀌었어요. 다시 미리보기해 주세요', INVALID_DATE_RANGE: '해당 일자·기간을 확인해 주세요' };
const message = (code?: string) => reason[code ?? ''] ?? '처리하지 못했어요. 다시 시도해 주세요';
reason.PAST_DATE = '지난 날짜에는 공지를 만들 수 없어요. 오늘 이후로 골라 주세요';
/** The handler says why a linked draft is stale by messageKey; the calendar closure text is the same as in the banner. */
const staleText: Readonly<Record<string, string>> = { changed: '휴무 일정이 바뀌었어요. 공지 초안에 다시 가져와 주세요', removed: '연결된 휴무 일정이 없어요. 캘린더에서 다른 휴무를 불러와 주세요', dates: '공지 기간이 캘린더 휴무와 달라요. 공지 초안에 다시 가져와 주세요' };
const staleKey: Readonly<Record<string, string>> = { 'data.notices.error.CLOSURE_CHANGED': staleText.changed!, 'data.notices.error.CLOSURE_REMOVED': staleText.removed!, 'data.notices.error.CLOSURE_DATES_DIFFER': staleText.dates! };
const messageOf = (result: { reason?: string; messageKey?: string }) => staleKey[result.messageKey ?? ''] ?? message(result.reason);
const dateReason = (result: { reason?: string }) => result.reason === 'INVALID_DATE_RANGE' || result.reason === 'PAST_DATE';
const SAVED = '임시 저장했어요', SENT = '보냈어요(예시)', PREVIEW_FIRST = '미리보기를 먼저 눌러 내용을 확인해 주세요';
const NO_ROWS: ReadonlySet<string> = new Set();
type DateFieldName = 'startDate' | 'endDate';

/** A draft kept from an earlier visit may point at a saved draft that is gone now: then it is a new draft again. */
function restored(draft: NoticeDraftInput | null | undefined, view: NoticeView): NoticeDraftInput {
  if (!draft) return blank();
  if (draft.noticeId && view.status === 'ready' && !view.drafts.some(item => item.noticeId === draft.noticeId)) {
    return { kind: draft.kind, title: draft.title, body: draft.body, startDate: draft.startDate, endDate: draft.endDate, ...(draft.closureEventId ? { closureEventId: draft.closureEventId } : {}), audience: draft.audience, groupIds: draft.groupIds };
  }
  return draft;
}

export function NoticeEditor({ view, port, memory, detailRef }: { view: NoticeView; port: NoticePort; memory?: NoticeDraftMemory; detailRef?: DetailRef }) {
  const [tab, setTab] = useState<'compose' | 'history'>(detailRef?.view === 'history' ? 'history' : 'compose');
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
  const clearMessages = () => { setFeedback(''); setErrors({}); setDateError(null); };
  const change = (patch: Partial<NoticeDraftInput>) => { version.current++; setDraft(current => ({ ...current, ...patch })); setPreview(null); clearMessages(); };
  const run = async (action: () => Promise<void>) => { if (locked.current) return; locked.current = true; setPending(true); try { await action(); } catch { setFeedback(message()); } finally { locked.current = false; setPending(false); } };
  const refuse = (result: { reason?: string; messageKey?: string; field?: string }) => { if (dateReason(result)) setDateError({ field: result.field === 'endDate' ? 'endDate' : 'startDate', text: messageOf(result) }); else setFeedback(messageOf(result)); };
  const validate = () => {
    const found = { ...(draft.title.trim() ? {} : { title: message('TITLE_REQUIRED') }), ...(draft.body.trim() ? {} : { body: message('BODY_REQUIRED') }) };
    if (!found.title && !found.body) return true;
    setFeedback(''); setErrors(found); (found.title ? titleInput : bodyInput).current?.focus();
    return false;
  };
  const save = async () => { if (!validate()) return null; const result = await port.saveDraft(draft); if (!result.ok) { refuse(result); return null; } return result; };
  const onSave = () => void run(async () => { const v = version.current; const result = await save(); if (result && v === version.current) { setDraft(current => ({ ...current, noticeId: result.noticeId, revision: result.revision })); setFeedback(SAVED); } });
  const onPreview = () => void run(async () => { const v = version.current; const saved = await save(); if (!saved || v !== version.current) return; setDraft(current => ({ ...current, noticeId: saved.noticeId, revision: saved.revision })); const result = await port.preview(saved.noticeId, saved.revision); if (v !== version.current) return; if (!result.ok) { setPreview(null); refuse(result); return; } setPreview(result.preview); setFeedback(result.preview.recipientCount === 0 ? message('NO_RECIPIENTS') : result.preview.reasons.map(message).join(' ')); });
  const model = view.status === 'ready' ? view : { unsentCount: 0, nextClosure: null, closures: [], drafts: [], sent: [], groups: [] };
  /** The calendar closure behind this draft changed after the import: the old preview must not be sent. */
  const link = draft.noticeId ? model.drafts.find(item => item.noticeId === draft.noticeId)?.closureLink : undefined;
  const stale = link === 'changed' || link === 'removed' || link === 'dates' ? link : null;
  const [focusOnEntry] = useState(() => tab === 'compose' && (detailRef?.view === 'drafts' || detailRef?.focus === 'action'));
  useEffect(() => {
    if (!focusOnEntry) return;
    const fields = detailRef?.prefill?.kind === 'widget-draft' ? detailRef.prefill.fields : undefined;
    const focusTarget = () => reimportAction.current ?? (fields ? fields.body && !fields.title ? bodyInput.current : titleInput.current : previewAction.current);
    const frame = requestAnimationFrame(() => focusTarget()?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusOnEntry, detailRef?.prefill]);
  const fresh = stale ? null : preview;
  const canSend = !!fresh?.sendAllowed && !!fresh.recipientCount;
  const onSend = () => void run(async () => {
    if (!fresh || !draft.noticeId || !fresh.sendAllowed || !fresh.recipientCount) return;
    const v = version.current;
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
    if (!mounted.current || v !== version.current) return;
    const result = await port.send(draft.noticeId, fresh.draftRevision, fresh.previewId);
    if (v !== version.current) return;
    if (!result.ok) { setPreview(null); setFeedback(messageOf(result)); return; }
    // The notice is out: the form starts empty again (nothing left to send twice) and the status points at the history.
    version.current++; setDraft(blank()); setPreview(null); setErrors({}); setDateError(null); setFeedback(SENT);
  });
  const onDelete = () => void run(async () => { if (!draft.noticeId) return; const result = await port.deleteDraft(draft.noticeId); if (!result.ok) { setFeedback(messageOf(result)); return; } version.current++; setDraft(blank()); setPreview(null); clearMessages(); });
  const importFrom = (eventId: string) => void run(async () => { const v = version.current; const result = await port.importClosure(eventId, draft.noticeId); if (v !== version.current) return; if (!result.ok) { setFeedback(messageOf(result)); return; } version.current++; setDraft(result.draft); setPreview(null); setPicker(false); clearMessages(); });
  const promotional = classifyNoticeContent(draft.title, draft.body) === 'promotional';
  const previewId = fresh?.previewId;
  useEffect(() => { if (previewId) previewBox.current?.scrollIntoView?.({ block: 'nearest' }); }, [previewId]);
  // The warning band is taller than the info band: when ad wording shows up it moves into view instead of hiding below the fold (large text).
  useEffect(() => { if (promotional) ruleBand.current?.scrollIntoView?.({ block: 'nearest' }); }, [promotional]);
  if (view.status === 'error') return <PanelState tone="error" message="공지 내역을 불러오지 못했어요" action={{ label: '다시 시도하기', widgetName: '공지 발송', onPress: port.retry }} />;
  const shown = feedback && !(stale && feedback === staleText[stale]) ? feedback : '';
  const statusText = shown || (!canSend && !pending ? PREVIEW_FIRST : '');
  const good = shown === SAVED || shown === SENT;
  return <div className="i7-notice-detail" data-tab={tab} lang="ko">
    <DetailTabs value={tab} onValueChange={setTab} label="공지 발송 보기" tabs={[{ value: 'compose', label: '공지 작성' }, { value: 'history', label: '보낸 기록' }]} />
    {tab === 'history' ? <SentHistory rows={model.sent} initialItemId={detailRef?.view === 'history' ? detailRef.itemId : undefined} onCompose={() => setTab('compose')} /> : <div className="i7-notice-form">
      <div className="i7-notice-toolbar">
        <ChipChoice label="공지 종류" value={draft.kind} onChange={kind => change({ kind })} options={kinds} />
      {model.drafts.length > 0 && <select className="ui-text-input i7-notice-draft-pick" aria-label="임시 저장한 공지" value={draft.noticeId ?? ''} onChange={event => { const selected = model.drafts.find(item => item.noticeId === event.currentTarget.value); if (selected) { version.current++; setDraft(selected); setPreview(null); clearMessages(); } }}><option value="">임시 저장한 공지 고르기</option>{model.drafts.map(item => <option key={item.noticeId} value={item.noticeId}>{item.title}</option>)}</select>}
        <ActionButton variant="secondary" className="i7-notice-calendar-load" onClick={() => setPicker(!picker)}>
          캘린더에서 불러오기
        </ActionButton>
      </div>
      {picker && <div className="i7-notice-picker">{model.closures.map(closure => <ActionButton key={closure.eventId} variant="secondary" disabled={pending} onClick={() => importFrom(closure.eventId)}>{closure.title}</ActionButton>)}</div>}
      <TextField label="공지 제목" value={draft.title} onValueChange={title => change({ title })} error={errors.title} inputRef={titleInput} />
      <div className="i7-notice-dates">
        <DateField label="시작 날짜" value={draft.startDate || null} onValueChange={startDate => change({ startDate: startDate ?? '' })} error={dateError?.field === 'startDate' ? dateError.text : undefined} />
        <DateField label="종료 날짜" value={draft.endDate || null} min={draft.startDate || undefined} onValueChange={endDate => change({ endDate: endDate ?? '' })} error={dateError?.field === 'endDate' ? dateError.text : undefined} />
      </div>
      {stale && <div role="alert" className="i7-notice-stale"><p>{staleText[stale]}</p>{stale !== 'removed' && draft.closureEventId && <ActionButton ref={reimportAction} variant="secondary" disabled={pending} onClick={() => importFrom(draft.closureEventId!)}>캘린더에서 다시 가져오기</ActionButton>}</div>}
      <Textarea label="공지 내용" value={draft.body} onValueChange={body => change({ body })} error={errors.body} inputRef={bodyInput} />
      <RadioGroup label="받는 사람" orientation="horizontal" value={draft.audience} onValueChange={audience => change(audience === 'all_contactable' ? { audience, groupIds: [] } : { audience })} options={audiences} />
      {draft.audience === 'group' && <div className="i7-notice-groups">{model.groups.map(group => <Checkbox key={group.groupId} label={group.name} checked={draft.groupIds.includes(group.groupId)} onCheckedChange={checked => change({ groupIds: checked ? [...draft.groupIds, group.groupId] : draft.groupIds.filter(id => id !== group.groupId) })} />)}</div>}
      <div ref={ruleBand} role="status" className="i7-notice-rule" data-tone={promotional ? 'warning' : 'info'}>
        <Icon name={promotional ? 'warning' : 'info'} aria-hidden />
        {promotional
          ? <div><p>홍보 문구가 들어가면 문자 동의한 손님에게만 보낼 수 있어요</p><p>(광고) 표시와 수신 거부 안내가 자동으로 들어가요</p><p>밤 9시부터 아침 8시까지는 광고 문자를 보낼 수 없어요</p></div>
          : <p>정보성 공지는 연락처가 있는 회원 모두에게 보낼 수 있어요</p>}
      </div>
      {fresh && <section ref={previewBox} className="i7-notice-preview" aria-label="미리보기"><h3>미리보기</h3><p className="i7-notice-preview-body">{fresh.renderedBody}</p><p>받는 사람 {fresh.recipientCount}명</p></section>}
    </div>}
    {tab === 'compose' && <DetailFooterContent>
      <div className="i7-notice-footbar">
        <p role="status" id={statusId} className="i7-notice-status" data-tone={good ? 'ok' : shown ? 'error' : 'hint'}>
          {statusText && <Icon name={good ? 'status-ok' : shown ? 'warning' : 'info'} aria-hidden />}
          <span>{statusText}</span>
          {shown === SENT && <ActionButton variant="secondary" onClick={() => setTab('history')}>보낸 기록 보기</ActionButton>}
        </p>
        <div className="i7-notice-actions">
          <ActionButton variant="secondary" disabled={pending} onClick={onSave}>임시 저장하기</ActionButton>
          <ActionButton variant="secondary" disabled={pending || !draft.noticeId} onClick={onDelete}>임시 저장 지우기</ActionButton>
          <ActionButton ref={previewAction} variant="secondary" disabled={pending} onClick={onPreview}>미리보기</ActionButton>
          <ActionButton loading={pending && !!fresh} disabled={!canSend} aria-describedby={canSend ? undefined : statusId} onClick={onSend}>{pending && fresh ? '공지를 보내고 있어요' : '공지 보내기'}</ActionButton>
        </div>
      </div>
    </DetailFooterContent>}
  </div>;
}

/** 보낸 기록: the kit DataGrid, read only (SCR-273). Dates read `오늘 15:45` / `11/16(월) 15:45`, never ISO. */
function SentHistory({ rows, initialItemId, onCompose }: { rows: readonly SentRow[]; initialItemId?: string; onCompose(): void }) {
  const { format } = useKitT();
  const [sort, setSort] = useState<GridSort>(null);
  const [focus, setFocus] = useState<GridFocus>(null);
  const grid = useRef<DataGridHandle>(null);
  useEffect(() => { if (initialItemId) grid.current?.focusCell(initialItemId, 'title'); }, [initialItemId]);
  const when = (row: SentRow) => format.dateTime(row.sentAt, { today: TODAY });
  const people = (row: SentRow) => `${row.recipientCount}명`;
  const columns: GridColumn<SentRow>[] = [
    { id: 'title', header: '공지 제목', kind: 'text', minWidth: 240, value: row => row.title },
    { id: 'kind', header: '공지 종류', kind: 'text', minWidth: 200, fixedWidth: true, value: row => kindLabel(row.kind) },
    { id: 'recipients', header: '받는 사람', kind: 'number', minWidth: 160, fixedWidth: true, value: row => row.recipientCount, render: people, accessibleValue: people },
    { id: 'sentAt', header: '보낸 일시', kind: 'text', minWidth: 220, fixedWidth: true, value: row => row.sentAt, render: when, accessibleValue: when },
  ];
  return <div className="i7-notice-sent-grid">
    <DataGrid ref={grid} id="notice-history" label="보낸 기록" rows={rows} getRowId={row => row.sentId} getRowLabel={row => row.title} columns={columns}
      sort={sort} onSortChange={setSort} selectedRowId={null} expandedRowIds={NO_ROWS} focus={focus} onFocusChange={setFocus}
      emptyContent={<div className="i7-notice-history-state">
        <Icon name="clock" aria-hidden />
        <InlineEmpty title="아직 보낸 공지가 없어요" description="공지를 보내면 여기에 남아요" action={<ActionButton variant="secondary" onClick={onCompose}>공지 작성하기</ActionButton>} />
      </div>} />
  </div>;
}

export function NoticePanel({ view, width, height, onOpen, onRetry }: { view: NoticeView; width: number; height: number; onOpen(): void; onRetry(): void }) {
  const { format } = useKitT();
  if (view.status === 'error') return <PanelState tone="error" message="공지 내역을 불러오지 못했어요" shortMessage={height === 1 && width <= 2 ? '불러오지 못했어요' : undefined} action={{ label: '다시 시도하기', widgetName: '공지 발송', onPress: onRetry }} />;
  const count = view.status === 'ready' ? view.unsentCount : 0, nextClosure = view.status === 'ready' ? view.nextClosure : null, sent = view.status === 'ready' ? view.sent : [];
  const compact = width === 1 && height === 1;
  const wide = width >= 3 && height >= 2;
  const when = (sentAt: string) => format.dateTime(sentAt, { today: TODAY });
  const action = <PanelAction label="공지 보내기" widgetName="공지 발송" onPress={onOpen} />;
  const metric = <div className="i7-notice-metric"><div className="i7-notice-metric-line"><div className="i7-notice-number"><MetricFit value={String(count)} unit="건" stacked={false} /></div>{(compact || (width >= 2 && height >= 2)) && action}</div><p className="i7-notice-subtitle">공지 미발송</p></div>;
  const closure = nextClosure && <p className="i7-notice-closure"><Icon name="calendar-check" />{nextClosure.title}</p>;
  const history = sent.length ? <div className="i7-notice-history" aria-label="보낸 기록">{sent.slice(0, height >= 3 ? 4 : 2).map(row => <div className="i7-notice-value-row i7-notice-history-row" key={row.sentId}><span>{row.title}</span><strong>{when(row.sentAt)}</strong></div>)}</div> : <p className="i7-notice-history-empty">아직 보낸 공지가 없어요</p>;
  return <div className="i7-notice-panel" data-width={width} data-height={height} lang="ko">
    {metric}
    {!compact && (height === 1 ? <>
      <div className="i7-notice-wide-rows"><div className="i7-notice-value-row"><span>다가오는 매장 휴무</span><strong>{nextClosure?.title.match(/\d{2}\/\d{2}(?:\([^)]+\))?/)?.[0] ?? '—'}</strong></div>{width >= 3 && <div className="i7-notice-value-row"><span>보낸 공지</span><strong>{sent.length}건</strong></div>}</div>
      <div className="i7-notice-wide-action">{action}</div>
    </> : wide ? <div className="i7-notice-workspace"><div>{closure}{view.status === 'ready' && view.drafts.length > 0 && <div className="i7-notice-drafts"><p>임시 저장한 공지</p>{view.drafts.map((draft, i) => <div className="i7-notice-value-row" key={draft.noticeId ?? i}><span>{draft.title}</span></div>)}</div>}</div>
      <div className="i7-notice-history-table">{sent.length ? <table><thead><tr><th>공지 제목</th><th className="i7-notice-kind">공지 종류</th><th>받는 사람</th><th>보낸 일시</th></tr></thead><tbody>{sent.slice(0, height >= 3 ? 6 : 3).map(row => <tr key={row.sentId}><td>{row.title}</td><td className="i7-notice-kind">{kindLabel(row.kind)}</td><td>{row.recipientCount}명</td><td>{when(row.sentAt)}</td></tr>)}</tbody></table> : history}</div>
    </div> : <div className="i7-notice-panel-list">{width === 1 && action}{closure}{width >= 2 && <div className="i7-notice-value-row i7-notice-sent-count"><span>보낸 공지</span><strong>{sent.length}건</strong></div>}{(width === 1 || height >= 3) && history}</div>)}
    <FitProbe order={[{ selector: '.i7-notice-kind' }, { selector: '.i7-notice-history-row', last: true }, { selector: '.i7-notice-history-table tbody tr', last: true }, { selector: '.i7-notice-history-empty' }, { selector: '.i7-notice-sent-count' }, ...(width === 1 ? [{ selector: '.i7-notice-closure' }] : [])]} deps={[width, height, count, sent.length]} />
  </div>;
}
