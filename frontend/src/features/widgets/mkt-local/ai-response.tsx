/** 메시지·리뷰 응대 (F-45) and the confirmed test SMS flow (SCR-31). */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import { managementBundle } from '../../../data/messages/management';
import type { ThreadRow } from '../../../data/models/types';
import { ActionButton, ChipChoice, DetailTabs, Icon, InlineEmpty, InlineError, IntegrationBadge, MasterDetail, PanelBody, PinnedColumn, StatusBadge, Textarea, useUi } from '../../../ui';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, rowCapacity, text, useT, type Translator } from './shared';
import { koreanLang } from './fit';
import { useBundle } from '../../../i18n';
import { registerGridLayer } from '../../../ui/grid-interactions';
import { naverDraftErrorText, naverDrafts, setDraftInputLanguage, useNaverDraft, useNaverDraftCopy, type DraftError, type SendResult, type TargetResult, type TestTarget } from '../naver-drafts';
import type { StoreClosure } from '../../../data/iteration7/notices';
import { isIsoDate } from '../../../data/db/time';
import { replyPrefill } from '../../assistant/domains/replies';

const ID = 'ai-response';
type Tab = 'message' | 'review';
const EMPTY_REPLY = 'th-empty';
type ReplyCompletion = { readonly status: 'simulated' | 'accepted'; readonly body: string };
const guidanceBundle = { id: 'widget.reply-guidance', ko: {
  'replyGuidance.title': '매장 안내', 'replyGuidance.regular': '정기 휴무', 'replyGuidance.temporary': '임시 휴무',
  'replyGuidance.answer': '{date}은 {kind}로 쉬어요',
}, en: {}, 'zh-Hans': {}, 'zh-Hant': {} };

/** Only explicit dates covered by the current calendar are grounds for a closure reply. */
export function closureForQuestion(question: string, closures: readonly StoreClosure[]): { date: string; closure: StoreClosure } | null {
  const full = question.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/u);
  const short = full ? null : question.match(/(?:(\d{4})년\s*)?(\d{1,2})(?:월\s*|\/)(\d{1,2})(?:일|\b)/u);
  const match = full ?? short;
  if (!match) return null;
  for (const closure of closures) {
    const date = `${match[1] ?? closure.startDate.slice(0, 4)}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    if (isIsoDate(date) && date >= closure.startDate && date <= closure.endDate) return { date, closure };
  }
  return null;
}

/** Reviewer name as masked by the data layer (AC-318); the full name never reaches the screen. */
const authorOf = (th: ThreadRow): string | null => th.authorMasked ?? null;

function SentimentBadge({ t, sentiment }: { readonly t: Translator; readonly sentiment: ThreadRow['sentiment'] }) {
  if (sentiment === 'positive') return <StatusBadge semantic="positive" label={t.t('widget.ai-response.positive')} />;
  if (sentiment === 'negative') return <StatusBadge kind="needsReview" label={t.t('widget.ai-response.negative')} />;
  if (sentiment === 'neutral') return <StatusBadge kind="suggested" label={t.t('widget.ai-response.neutral')} />;
  return null;
}

function Panel({ condition, width, height, shape, editing, host }: WidgetPanelProps) {
  const t = useT();
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  const primary = (
    <PrimaryMetric id={ID} shape={shape} label={t.t('widget.ai-response.waiting')} value={t.format.number(m.waitingCount)} unit={t.t('widget.ai-response.unit', { n: m.waitingCount })}
      secondary={shape==='W'?undefined:t.t('widget.ai-response.byType', { m: m.byType.message, r: m.byType.review })} />
  );
  const capacity = shape === 'W' ? (textScale === 125 ? 1 : 2) : rowCapacity(shape, height, textScale);
  const channelRows = m.byChannel.slice(0, capacity);
  const priorityRows = m.priority.slice(0, capacity);
  const hiddenWaiting = m.byChannel.slice(channelRows.length).reduce((sum, channel) => sum + channel.count, 0);
  const channelItems = channelRows.map((c, index) => (
    <li key={c.channelKey} className="mkt-row" data-slot={`${ID}.list.row`}>
      <span className="mkt-row__title">{t.t(c.channelKey)}</span>
      <span className="mkt-row__value">{t.t('widget.ai-response.countText', { n: c.count })}{t.locale === 'ko' && index === channelRows.length - 1 && hiddenWaiting > 0 ? `\u00a0·\u00a0외 ${t.format.number(hiddenWaiting)}건` : ''}</span>
    </li>
  ));
  const priorityItems = priorityRows.map((th) => (
    <li key={th.threadId} className="mkt-row" data-slot={`${ID}.list.row`}>
      <span className="mkt-row__text"><span className="mkt-row__title" lang={koreanLang(text(t, th.body))}>{text(t, th.body)}</span><span className="mkt-row__sub">{t.t(th.channelKey)}</span></span>
      {th.needsPersonReason ? <StatusBadge kind="needsReview" /> : null}
    </li>
  ));
  const fit = (items: readonly ReactNode[], label: string) => <FitList slot={`${ID}.list`} label={label} items={items} resetKey={`${t.locale}|${width}x${height}|${textScale}|${items.length}`} />;
  const byChannel = fit(channelItems, t.t('widget.ai-response.waiting'));
  const first = fit(priorityItems, t.t('widget.ai-response.recent'));
  const note = view.notes?.[0];
  const praiseLine = shape !== 'Q' && !(shape === 'T' && textScale === 125) ? (
    <>
      <p className="mkt-secondary" data-slot={`${ID}.metric.secondary`}>{t.t('widget.ai-response.praise', { n: m.praiseCount })}</p>
      {note ? <p className="mkt-panel-note">{editing ? <StatusBadge kind="needsReview" /> : <Icon name="warning" aria-hidden />}<span className={editing ? 'ui-sr-only' : undefined} lang={koreanLang(t.t(note.messageKey))}>{t.t(note.messageKey)}</span></p> : null}
    </>
  ) : null;
  const list = m.waitingCount === 0 ? null : shape === 'T' ? first : shape === 'S' ? byChannel : shape === 'L' ? fit([...channelItems, ...priorityItems.slice(0, 3)], t.t('widget.ai-response.waiting')) : byChannel;
  return <PanelBody width={width} height={height} primary={primary} list={shape==='W'?<>{list}{praiseLine}</>:list} secondary={shape==='W'?undefined:praiseLine} />;
}

function Detail({ condition, detailRef, host }: WidgetDetailProps) {
  const t = useT();
  const guidance = useBundle(guidanceBundle, managementBundle) as unknown as Translator;
  const view = useWidgetView(ID, condition);
  const dispatch = useDataDispatch();
  const [tab, setTab] = useState<Tab>(detailRef.view === 'review' ? 'review' : 'message');
  const [praiseOnly, setPraiseOnly] = useState(detailRef.filter === 'praise');
  const [pickedId, setPickedId] = useState<string | null>(detailRef.itemId ?? null);
  const [sent, setSent] = useState<Readonly<Record<string, ReplyCompletion>>>({});
  const draftCopy = useNaverDraftCopy();
  if (view.status !== 'ready') {
    const disconnected = view.variant === 'channel-disconnected';
    return <DetailState id={ID} view={view} host={host} extra={disconnected && t.locale !== 'ko' ? <IntegrationBadge state="needed" label={t.t('common.connectNeeded')} /> : null} />;
  }
  const m = view.model;
  const done = m.threads.filter((th) => !th.waiting).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.threadId.localeCompare(b.threadId));
  const ordered = [...m.priority, ...done];
  const inTab = ordered.filter((th) => (tab === 'review' ? th.type === 'review' : th.type !== 'review'));
  const list = tab === 'review' && praiseOnly ? inTab.filter((th) => th.sentiment === 'positive') : inTab;
  const emptySample = tab === 'message' && pickedId === EMPTY_REPLY;
  const selected = emptySample ? null : list.find(th => th.threadId === pickedId) ?? list[0] ?? null;

  const markSent = (thread: ThreadRow, completion: ReplyCompletion) => {
    setSent(previous => ({ ...previous, [thread.threadId]: completion }));
    // These commands update only the local queue. API-312 is the only test transport.
    dispatch({ type: thread.type === 'review' ? 'inquiry.post' : 'inquiry.send', threadId: thread.threadId, idempotencyKey: `${ID}:${thread.threadId}` });
  };

  const row = (th: ThreadRow) => {
    const at = dateTime(t, th.receivedAt);
    return (
      <li key={th.threadId} data-slot={`${ID}.list.row`}>
        <button type="button" className="mkt-pick" aria-current={selected?.threadId === th.threadId} onClick={() => setPickedId(th.threadId)}>
          <span className="mkt-pick__top">
            <span className="mkt-pick__title">{t.t(th.channelKey)}{authorOf(th) ? `\u00A0·\u00A0${authorOf(th)}` : ''}</span>
            <span className="mkt-pick__sub">{t.t('widget.ai-response.receivedAt', at)}</span>
          </span>
          <span className="mkt-pick__excerpt">{text(t, th.body)}</span>
          <span className="mkt-pick__badges">
            {th.isPublic || t.locale !== 'ko' ? <StatusBadge semantic="none" label={th.isPublic ? t.t('widget.ai-response.public') : t.t('widget.ai-response.private')} /> : null}
            {th.type === 'review' ? <SentimentBadge t={t} sentiment={th.sentiment} /> : null}
            {th.needsPersonReason ? <StatusBadge kind="needsReview" label={`${t.t('common.badge.needsReview')}\u00A0·\u00A0${t.t(th.needsPersonKey ?? '')}`} />
              : th.waiting ? <StatusBadge semantic="waiting" label={th.draft ? t.t('widget.ai-response.statusDraft') : t.t('widget.ai-response.waiting')} />
                : <StatusBadge kind="checked" label={t.t('widget.ai-response.statusDone')} />}
          </span>
        </button>
      </li>
    );
  };

  const pane = () => {
    if (emptySample) return (
      <ReplyEditor key={EMPTY_REPLY} sampleId={EMPTY_REPLY} review={false} onSent={() => {}}>
        <h3 className="mkt-section">{draftCopy.t('widget.grants.draft.emptySample')}</h3>
      </ReplyEditor>
    );
    if (!selected) return <p className="mkt-meta">{t.t('widget.ai-response.pickItem')}</p>;
    const th = selected;
    const review = th.type === 'review';
    const completion = sent[th.threadId];
    const prefill = th.threadId === detailRef.itemId ? replyPrefill(detailRef) : undefined;
    const saved = th.draft && 'raw' in th.draft ? th.draft.raw : undefined;
    const entryBody = prefill ?? saved;
    const original = (
      <>
        <div className="mkt-card__badges">
          {th.isPublic || t.locale !== 'ko' ? <StatusBadge semantic="none" label={th.isPublic ? t.t('widget.ai-response.public') : t.t('widget.ai-response.private')} /> : null}
          {review ? <SentimentBadge t={t} sentiment={th.sentiment} /> : null}
          {th.rating ? <StatusBadge semantic="rating" label={t.t('widget.ai-response.rating', { n: th.rating })} /> : null}
        </div>
        <MetaLine>{t.t(th.channelKey)}{authorOf(th) ? `\u00A0·\u00A0${authorOf(th)}` : ''}{'\u00A0·\u00A0'}{t.t('widget.ai-response.receivedAt', dateTime(t, th.receivedAt))}</MetaLine>
        <h4 className="mkt-section">{t.t('widget.ai-response.original')}</h4>
        <p className="mkt-quote">{text(t, th.body)}</p>
        {th.needsPersonReason && <div className="mkt-alert" role="note"><p className="mkt-alert__title"><Icon name="warning" aria-hidden />{t.t('common.badge.needsReview')}</p><p>{t.t('widget.ai-response.needsPerson', { reason: t.t(th.needsPersonKey ?? '') })}</p></div>}
      </>
    );
    if (completion || !th.waiting) return (
      <div className="mkt-detail" data-slot={`${ID}.card`}>
        {original}
        <h4 className="mkt-section">{t.t('widget.ai-response.sentHeading')}</h4>
        <p className="mkt-quote mkt-reply-text" lang={completion ? 'ko' : undefined}>{completion?.body ?? text(t, th.draft)}</p>
        <p className="mkt-ok" role="status"><Icon name="check" aria-hidden />{
          completion?.status === 'accepted' ? t.t('widget.ai-response.accepted')
            : completion ? t.t('common.sentSample') : t.t('widget.ai-response.statusDone')
        }</p>
      </div>
    );
    return (
      <ReplyEditor key={JSON.stringify([th.threadId, saved, prefill])} sampleId={th.threadId} review={review}
        initialBody={entryBody} focusOnEntry={detailRef.focus === 'action' && pickedId === (detailRef.itemId ?? null)}
        recoverPreview={view.variant === 'send-failure' ? host.resetPreview : undefined}
        onSent={result => markSent(th, result)}>
        {original}
        <div>
          <h4 className="mkt-section">{t.t('widget.ai-response.groundTitle')}</h4>
          {th.groundKeys.length === 0 ? <p className="mkt-meta">{t.t('widget.ai-response.noGround')}</p>
            : <ul className="mkt-list">{th.groundKeys.map(key => <li key={key} className="mkt-meta">{t.t(key)}</li>)}</ul>}
        </div>
      </ReplyEditor>
    );
  };

  const tabs = [{ value: 'message' as const, label: t.t('widget.ai-response.tabMessages') }, { value: 'review' as const, label: t.t('widget.ai-response.tabReviews') }];
  return (
    <div className="mkt-detail mkt-reply-detail">
      <div className="mkt-toolbar">
        <IntegrationBadge label={t.t('widget.ai-response.channelConnected')} />
        <MetaLine>{t.t('widget.ai-response.summary', { n: m.waitingCount })}{'\u00A0·\u00A0'}{t.t('widget.ai-response.byType', { m: m.byType.message, r: m.byType.review })}</MetaLine>
      </div>
      {view.notes?.[0] ? <p className="mkt-panel-note"><Icon name="warning" aria-hidden />{t.t(view.notes[0].messageKey)}</p> : null}
      <DetailTabs value={tab} onValueChange={(v) => { setTab(v); setPickedId(null); }} tabs={tabs} label={t.t('widget.ai-response.tabLabel')} />
      {tab === 'review' ? (
        <div className="ui-chip-choice">
          <button type="button" role="checkbox" aria-checked={praiseOnly} className="ui-choice-chip" data-slot={`${ID}.praise`} onClick={() => setPraiseOnly(!praiseOnly)}>{t.t('widget.ai-response.praise', { n: m.praiseCount })}</button>
        </div>
      ) : null}
      <MasterDetail
        list={list.length === 0 ? <p className="mkt-meta">{t.t('widget.ai-response.noItems')}</p> : (
          <ul className="mkt-list" data-slot={`${ID}.list`}>
            {list.map(row)}
            {tab === 'message' && <li><button type="button" className="mkt-pick" aria-current={emptySample} onClick={() => setPickedId(EMPTY_REPLY)}>
              {draftCopy.t('widget.grants.draft.emptySample')}
            </button></li>}
          </ul>
        )}
        detail={pane()}
      />
      <section aria-label={guidance.t('replyGuidance.title')} lang="ko"><h4 className="mkt-section">{guidance.t('replyGuidance.title')}</h4>
        {m.shopGuidance.closures.map(closure => <p className="mkt-meta mkt-meta--lines" key={closure.eventId}>{[closure.endDate !== closure.startDate ? t.format.dateRange(closure.startDate, closure.endDate) : t.format.date(closure.startDate, 'short'), closure.title, closure.body].filter(Boolean).join(' · ')}</p>)}
        {m.shopGuidance.manuals.map((manual, index) => {
          const parts = [text(guidance, manual.title), text(guidance, manual.body)].filter(Boolean);
          return parts.length === 0 ? null : <p className="mkt-meta mkt-meta--lines" key={index}>{parts.join(' · ')}</p>;
        })}
      </section>
    </div>
  );
}

interface ReplyPreview {
  readonly draftId: string;
  readonly body: string;
  readonly target: TestTarget | null;
}

function ReplyEditor({ sampleId, review, initialBody, focusOnEntry, recoverPreview, children, onSent }: {
  readonly sampleId: string;
  readonly review: boolean;
  readonly initialBody?: string;
  readonly focusOnEntry?: boolean;
  readonly recoverPreview?: () => void;
  readonly children: ReactNode;
  readonly onSent: (result: ReplyCompletion) => void;
}) {
  const t = useT();
  const draftCopy = useNaverDraftCopy();
  const { generation, generate } = useNaverDraft('ai-response');
  const [draftId, setDraftId] = useState<string>();
  const [body, setBody] = useState(initialBody ?? '');
  const [targets, setTargets] = useState<TargetResult>();
  const [targetRevision, setTargetRevision] = useState(0);
  const [targetId, setTargetId] = useState('');
  const [preview, setPreview] = useState<ReplyPreview | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<DraftError>();
  const sendLock = useRef(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const restorePreviewFocus = useRef(false);
  const draftField = useRef<HTMLTextAreaElement | null>(null);
  const generateButton = useRef<HTMLButtonElement>(null);
  const loaded = Boolean(draftId);
  const showEditor = loaded || initialBody !== undefined;
  const pending = generation.status === 'loading';

  useEffect(() => {
    if (!loaded) return;
    const controller = new AbortController();
    void naverDrafts.getTargets(controller.signal).then(result => {
      if (!controller.signal.aborted) setTargets(result);
    });
    return () => controller.abort();
  }, [loaded, targetRevision]);

  useLayoutEffect(() => {
    if (focusOnEntry) (draftField.current ?? generateButton.current)?.focus({ preventScroll: true });
  }, [focusOnEntry]);

  useLayoutEffect(() => {
    if (!preview && restorePreviewFocus.current) {
      restorePreviewFocus.current = false;
      previewButton.current?.focus({ preventScroll: true });
    }
  }, [preview]);

  const allTargets = targets?.status === 'targets' ? targets.targets : [];
  const disabledSend = sendError?.code === 'SEND_DISABLED'
    || (targets?.status === 'targets' && (targets.mode === 'off' || !allTargets.length));
  const target = disabledSend ? null : allTargets.find(item => item.id === targetId) ?? allTargets[0] ?? null;
  const uncertainSend = sendError !== undefined && (
    sendError.code === 'SEND_UNKNOWN' || sendError.code === 'TIMEOUT'
    || sendError.code === 'TRANSPORT' || sendError.code === 'INVALID_RESPONSE'
  );
  const lockedSample = uncertainSend || sendError?.code === 'CONFLICT' || sendError?.code === 'SEND_FAILED';
  const invalidReply = (loaded && (!body.trim() || !fitsTestSms(body))) || sendError?.code === 'INVALID_REPLY';
  const canPreview = loaded && Boolean(body.trim()) && targets?.status === 'targets'
    && !pending && !sending && !invalidReply && !lockedSample && sendError?.code !== 'NOT_FOUND';

  function start() {
    setPreview(null);
    if (!disabledSend) setSendError(undefined);
    void generate(sampleId, draft => {
      setDraftId(draft?.draftId);
      setBody(previous => !loaded && initialBody !== undefined && draft ? previous : draft?.content.body ?? initialBody ?? '');
      if (!draft) setTargets(undefined);
    });
  }
  function closePreview() {
    restorePreviewFocus.current = true;
    setPreview(null);
  }
  function openPreview() {
    if (!canPreview || !draftId) return;
    if (!disabledSend) setSendError(undefined);
    setPreview({ draftId, target, body });
  }

  async function sendConfirmed() {
    if (!preview?.target || disabledSend || sendLock.current) return;
    const snapshot = preview;
    sendLock.current = true;
    setSending(true);
    const result: SendResult = recoverPreview
      ? { status: 'error', code: 'UNAVAILABLE', httpStatus: 503 }
      : await naverDrafts.send({ draftId: snapshot.draftId, targetId: preview.target.id, body: snapshot.body });
    sendLock.current = false;
    setSending(false);
    if (result.status === 'error') {
      setSendError(result);
      closePreview();
    } else {
      onSent({ status: result.status, body: snapshot.body });
    }
  }

  const offLabel = t.t('widget.ai-response.testOff');
  const previewLabel = t.t('widget.ai-response.preview');
  const sendLabel = t.t('widget.ai-response.sendTest');
  if (preview) {
    return (
      <ReplyConfirmation preview={preview} heading={previewLabel} bodyLabel={t.t('widget.ai-response.previewBody')}
        targetLabel={t.t('widget.ai-response.testTarget')} offLabel={offLabel} closeLabel={t.t('common.close')}
        sendLabel={sendLabel} sendingLabel={t.t('widget.ai-response.sendingTest')} sending={sending} onClose={closePreview} onSend={sendConfirmed} />
    );
  }

  const replyError = invalidReply ? t.t('widget.ai-response.invalidReply') : undefined;
  const retryableSend = sendError?.code === 'RATE_LIMITED' || sendError?.code === 'UNAVAILABLE';
  const showSendError = sendError && !uncertainSend && sendError.code !== 'INVALID_REPLY' && sendError.code !== 'SEND_DISABLED';
  const sendErrorText = showSendError ? (
    sendError.code === 'CONFLICT' ? t.t('widget.ai-response.sendConflict')
      : sendError.code === 'NOT_FOUND' ? t.t('widget.ai-response.draftExpired')
        : sendError.code === 'RATE_LIMITED' ? naverDraftErrorText(sendError, draftCopy.t)
          : t.t(recoverPreview ? 'data.error.sendFailed' : 'widget.ai-response.sendFailed')
  ) : '';
  return (
    <PinnedColumn footer={
      <div className="mkt-reply-footer">
        <ActionButton ref={previewButton} size="primary" disabled={!canPreview} onClick={openPreview}>{previewLabel}</ActionButton>
      </div>
    }>
      <div className="mkt-detail mkt-reply-editor" data-slot={`${ID}.card`}>
        {children}
        <div className="mkt-toolbar">
          {generation.status === 'error'
            ? <InlineError message={naverDraftErrorText(generation, draftCopy.t)} onRetry={start} />
            : <ActionButton ref={generateButton} variant="secondary" disabled={pending || sending || lockedSample} aria-busy={pending || undefined} onClick={start}>
              {t.t(review ? 'widget.ai-response.generateReview' : 'widget.ai-response.generateMessage')}
            </ActionButton>}
          {pending && <p className="mkt-meta" role="status">{draftCopy.t('widget.grants.draft.loading')}</p>}
        </div>
        {generation.status === 'empty' && <InlineEmpty title={draftCopy.t('widget.grants.draft.empty')} />}
        {showEditor && (
          <>
            <div>
              <Textarea label={t.t(review ? 'widget.ai-response.reviewDraft' : 'widget.ai-response.draft')} value={body} disabled={pending || sending || lockedSample} inputRef={node => { draftField.current = node; setDraftInputLanguage(node); }}
                onValueChange={value => {
                  setBody(value);
                  setPreview(null);
                  if (sendError?.code === 'INVALID_REPLY') setSendError(undefined);
                }}
                hint={t.t('widget.ai-response.replyLimit')} error={replyError} rows={4} />
            </div>
            {targets?.status === 'error' && <InlineError message={t.t('widget.ai-response.targetError')} onRetry={() => setTargetRevision(value => value + 1)} />}
            {disabledSend ? <p className="mkt-meta" role="status">{offLabel}</p>
              : allTargets.length > 0 && <ChipChoice value={target?.id ?? ''} onChange={value => { setTargetId(value); setPreview(null); }}
                label={t.t('widget.ai-response.testTarget')} options={allTargets.map(item => ({ value: item.id, label: item.label, disabled: sending || lockedSample }))} />}
            {uncertainSend && <p className="mkt-meta" role="status">{t.t('widget.ai-response.sendUnknown')}</p>}
            {retryableSend ? <InlineError message={sendErrorText} onRetry={() => { if (recoverPreview) { recoverPreview(); setSendError(undefined); } else openPreview(); }}/>
              : showSendError && <p className="ui-field__error" role="alert"><Icon name="error" />{sendErrorText}</p>}
          </>
        )}
        <p className="mkt-meta">{t.t('widget.ai-response.confirmOnly')}</p>
      </div>
    </PinnedColumn>
  );
}

function ReplyConfirmation({ preview, heading, bodyLabel, targetLabel, offLabel, closeLabel, sendLabel, sendingLabel, sending, onClose, onSend }: {
  readonly preview: ReplyPreview;
  readonly heading: string;
  readonly bodyLabel: string;
  readonly targetLabel: string;
  readonly offLabel: string;
  readonly closeLabel: string;
  readonly sendLabel: string;
  readonly sendingLabel: string;
  readonly sending: boolean;
  readonly onClose: () => void;
  readonly onSend: () => void;
}) {
  const titleId = useId();
  const section = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const dismiss = useRef(onClose);
  useLayoutEffect(() => { dismiss.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    title.current?.focus();
    if (section.current) return registerGridLayer({ root: section.current, priority: () => 15, dismiss: () => dismiss.current() });
  }, []);

  return (
    <PinnedColumn footer={
      <div className="ui-confirm-step__actions mkt-reply-footer">
        <ActionButton variant="secondary" disabled={sending} onClick={onClose}>{closeLabel}</ActionButton>
        <ActionButton size="primary" disabled={sending || !preview.target} aria-busy={sending || undefined} onClick={onSend}>{sendLabel}</ActionButton>
      </div>
    }>
      <section ref={section} className="ui-confirm-step" aria-labelledby={titleId}>
        <h3 ref={title} id={titleId} tabIndex={-1} className="ui-confirm-step__title">{heading}</h3>
        <dl className="ui-confirm-step__summary mkt-reply-confirmation">
          <div><dt>{bodyLabel}</dt><dd className="mkt-reply-text" lang="ko">{preview.body}</dd></div>
          <div><dt>{targetLabel}</dt><dd lang={preview.target ? 'ko' : undefined} role={preview.target ? undefined : 'status'}>{preview.target?.label ?? offLabel}</dd></div>
        </dl>
        {sending && <p className="ui-confirm-step__status" role="status">{sendingLabel}</p>}
      </section>
    </PinnedColumn>
  );
}

// KS X 1001 uses two bytes per Korean character. The server also checks the sample's permitted sentences.
let smsCharacters: Set<string> | undefined;
function fitsTestSms(body: string): boolean {
  let length = 0;
  for (const character of body) {
    if (character.charCodeAt(0) <= 0x7f) length += 1;
    else {
      if (!smsCharacters) {
        const decoder = new TextDecoder('euc-kr', { fatal: true });
        smsCharacters = new Set();
        for (let lead = 0xa1; lead < 0xfe; lead += 1) {
          if (lead === 0xc9) continue;
          for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
            try { smsCharacters.add(decoder.decode(Uint8Array.of(lead, trail))); }
            catch { /* Unassigned KS X 1001 cell. */ }
          }
        }
      }
      if (!smsCharacters.has(character)) return false;
      length += 2;
    }
    if (length > 80) return false;
  }
  return true;
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  if (view.status === 'ready') return t.t('widget.ai-response.summary', { n: view.model.waitingCount });
  return t.t(view.variant === 'channel-disconnected' ? 'widget.ai-response.state.disconnected.short' : view.messageKey);
}

export const aiResponseModule: WidgetModule = { id: ID, Panel, Detail, useSummary };
