import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import navisSymbol from '../../../assets/brand/navis-symbol.svg';
import type { WidgetHost } from '../../../contracts';
import type { ImportRow } from '../../../data/models/types';
import { useWidgetDataStore } from '../../../data/react';
import type { CommandReceipt } from '../../../data/reality/00';
import { shownAverage, type AnsweredReviewImport, type InquiryDto, type RealInbox, type ReviewDraftSource, type ReviewKeywordDto, type ReviewStatsUnit } from '../../../data/reality/15/dto';
import { pressKey, useConsultation, useInboxCommand, useReviewDraftPreview, useReviewInsights } from '../../../data/reality/15/hooks';
import { exampleReplyCoupons, exampleTalkTalkDraft, talkTalkReplyCommand, useReplyCoupons, useTalkTalkDraft } from '../../../data/reality/15/talktalk';
import { ActionButton, ChipChoice, Icon, InlineError, InlineForm, PinnedColumn, SegmentedControl, StatusBadge, Textarea, TextField } from '../../../ui';
import { inboxFailureText } from './inbox-failure';
import { periodText } from './local-changes.http';
import { MetaLine, text, useT } from './shared';


const ID = 'ai-response';
const UNITS: readonly ReviewStatsUnit[] = ['day', 'week', 'month'];
const k = (name: string) => `data.real.inbox.${name}`;
export const inboxText = (name: string) => k(`ui.${name}`);
export const inboxDisplayText = (t: ReturnType<typeof useT>, value: string) => value.replace(/(?:\(\[연락처 삭제\]\)|\[연락처 삭제\])/gu, t.t('widget.ai-response.contactHidden'));
const LIMIT = { review: 1000, message: 2000 } as const;
/** The service refuses a public review reply with a phone number, email or resident number (B15 `publicReply`); say so before saving. */
const CONTACT = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?82[\s.-]?)?0?1[016789][\s().-]*\d{3,4}[\s().-]*\d{4}|\d{6}\s*-\s*[1-8]\d{6}/iu;
const hasContact = (value: string) => CONTACT.test(value.normalize('NFKC'));
const naverLink = (value: string | null): string | undefined => {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && (url.hostname === 'naver.com' || url.hostname.endsWith('.naver.com')) ? url.href : undefined; }
  catch { return undefined; }
};


/** `리뷰 AI 통계` (PN03 via Insight): the provider's period, themes and keywords; the two-day lag is said plainly; nothing is computed here. */
export function ReviewStats({ read, unit, onUnit }: { readonly read: ReturnType<typeof useReviewInsights>; readonly unit: ReviewStatsUnit; readonly onUnit: (unit: ReviewStatsUnit) => void }) {
  const t = useT();
  const s = (name: string) => k(`stats.${name}`);
  const statistics = read.data?.statistics;
  const average = shownAverage(read.data);
  const retry = <ActionButton variant="secondary" onClick={read.retry}>{t.t('common.retry')}</ActionButton>;
  let body;
  if (read.status === 'loading' && !read.data) body = <p className="mkt-meta" role="status">{t.t(s('loading'))}</p>;
  else if (read.status === 'error' && !read.data || statistics?.state === 'unavailable') body = <div role="alert"><p className="mkt-meta">{t.t(s('failed'))}</p>{retry}</div>;
  else if (statistics?.state !== 'ready') body = <p className="mkt-meta" role="status">{t.t(s('notConnected'))}</p>;
  else {
    const keywords = (rows: readonly ReviewKeywordDto[], label: string) => rows.length > 0 && <section aria-label={label}>
      <h5 className="mkt-meta">{label}</h5>
      <ul className="mkt-list">{rows.map(row => <li key={row.keyword} className="mkt-row">
        <span className="mkt-row__text"><span className="mkt-row__title">{t.t(s('keyword'), { keyword: row.keyword, n: row.count })}</span>
          {row.relatedReviews?.slice(0, 3).map((review, index) => <span key={index} className="mkt-row__sub">{t.t(s('related'))} · {review.text}</span>)}</span>
      </li>)}</ul>
    </section>;
    const themes = statistics.themes.filter(row => row.positiveCount > 0 || row.negativeCount > 0);
    const empty = themes.length === 0 && statistics.topKeywords.positive.length === 0 && statistics.topKeywords.negative.length === 0;
    body = <>
      <MetaLine>{t.t(s('source'), { period: periodText(t, statistics.period) })}</MetaLine>
      {statistics.coverage.dataThrough < statistics.coverage.requestedTo && <p className="mkt-meta" role="note">{t.t(s('lag'))}</p>}
      {empty ? <p className="mkt-meta" role="status">{t.t(s('empty'))}</p> : <>
        {themes.length > 0 && <section aria-label={t.t(s('themes'))}>
          <h5 className="mkt-meta">{t.t(s('themes'))}</h5>
          <ul className="mkt-list">{themes.map(row => <li key={row.theme} className="mkt-row">
            <span className="mkt-row__title">{row.theme}</span>
            <span className="mkt-row__value">{t.t(s('themeCounts'), { p: row.positiveCount, n: row.negativeCount })}</span>
          </li>)}</ul>
        </section>}
        {keywords(statistics.topKeywords.positive, t.t(s('positive')))}
        {keywords(statistics.topKeywords.negative, t.t(s('negative')))}
      </>}
      {read.status === 'error' && <div role="alert"><p className="mkt-meta">{t.t(s('failed'))}</p>{retry}</div>}
    </>;
  }
  return <section className="mkt-detail" data-slot={`${ID}.stats`} aria-busy={read.status === 'loading' || undefined}>
    <SegmentedControl value={unit} onChange={onUnit} label={t.t(s('unitLabel'))} options={UNITS.map(value => ({ value, label: t.t(s(`unit.${value}`)) }))} />
    {average !== undefined && <MetaLine>{t.t(inboxText('average'), { x: average.toFixed(1) })}</MetaLine>}
    {body}
  </section>;
}

/** The owner records what they received elsewhere; the new record then opens in its tab so its reply can be drafted right away. */
export function AddInquiry({ host, close, onCreated }: { readonly host: WidgetHost; readonly close: () => void; readonly onCreated: (id: string, kind: 'message' | 'review') => void }) {
  const t = useT();
  const command = useInboxCommand(host);
  const [kind, setKind] = useState<'message' | 'review'>('message');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const link = url.trim() ? naverLink(url.trim()) : undefined;
  const invalidUrl = Boolean(url.trim()) && !link;
  const valid = title.trim().length > 0 && title.trim().length <= 100 && body.trim().length > 0 && [...body].length <= 4000 && !invalidUrl;
  return <InlineForm title={t.t(inboxText('addInquiry'))} saving={command.pending} saveDisabled={!valid} saveLabel={t.t(`widget.ai-response.record.${kind}`)} onClose={close} onSave={async () => {
    const result = await command.send({ type: 'inquiry.create', kind, title: title.trim(), body: body.trim(), ...(link ? { sourceUrl: link } : {}), idempotencyKey: pressKey('inbox') });
    const id = result?.ok ? (result.value as CommandReceipt | undefined)?.resourceId : undefined;
    if (result?.ok) { if (id) onCreated(id, kind); close(); }
  }}>
    <ChipChoice value={kind} onChange={setKind} label={t.t('widget.ai-response.recordKind')} options={[{ value: 'message', label: t.t(inboxText('kindMessage')) }, { value: 'review', label: t.t(inboxText('kindReview')) }]} />
    <TextField label={t.t(inboxText('title'))} name="title" value={title} onValueChange={setTitle} disabled={command.pending} required />
    <Textarea label={t.t(inboxText('received'))} name="text" value={body} onValueChange={setBody} disabled={command.pending} rows={4} />
    <TextField label={t.t('widget.ai-response.sourceLink')} name="sourceUrl" value={url} onValueChange={setUrl} disabled={command.pending}
      error={invalidUrl ? t.t(k('error.INVALID_SOURCE_URL')) : undefined} />
    {command.error && <p role="alert" className="ui-field__error"><Icon name="error" aria-hidden />{inboxFailureText(t.t, command.error)}</p>}
  </InlineForm>;
}

/** A visible NAVER review or TalkTalk consultation before the owner takes it into the inquiry records. */
export function ImportPane({ row, host }: { readonly row: ImportRow | AnsweredReviewImport; readonly host: WidgetHost }) {
  const t = useT();
  const command = useInboxCommand(host);
  const consultation = useConsultation(row.source === 'talktalk' ? row.providerRef : null);
  const review = row.source === 'review';
  const answered = 'reply' in row;
  return <div className="mkt-detail" data-slot={`${ID}.card`}>
    <div className="mkt-card__badges">
      {review ? <StatusBadge semantic="none" label={t.t('widget.ai-response.public')} /> : null}
      {review ? row.stars === null ? <StatusBadge semantic="none" label={t.t(inboxText('noStars'))} /> : <StatusBadge semantic="rating" label={t.t('widget.ai-response.rating', { n: row.stars })} /> : null}
      {answered ? <StatusBadge kind="checked" label={t.t(inboxText('hasReply'))} /> : <StatusBadge semantic="waiting" label={t.t(review ? 'widget.ai-response.reviewWaiting' : 'widget.ai-response.waiting')} />}
    </div>
    <MetaLine>{t.t(row.channelKey)}</MetaLine>
    <h4 className="mkt-section">{t.t('widget.ai-response.original')}</h4>
    {review ? <p className="mkt-quote">{row.text}</p>
      : consultation.status === 'loading' ? <p className="mkt-meta" role="status">{t.t('data.real.loading')}</p>
        : consultation.status === 'error' ? <p className="mkt-meta" role="alert">{t.t(inboxText('threadError'))}</p>
          : <ul className="mkt-list">{consultation.thread?.messages.map((message, index) => message.text ? <li key={index} className="mkt-meta mkt-meta--lines">
            {message.from ? `${t.t(inboxText(message.from === 'user' ? 'fromUser' : 'fromPartner'))}: ` : ''}{inboxDisplayText(t, message.text)}</li> : null)}</ul>}
    {answered && row.reply && <><h4 className="mkt-section">{t.t('widget.ai-response.myReply')}</h4><p className="mkt-quote mkt-reply-text">{row.reply}</p></>}
    {(!answered || row.reply) && <div className="mkt-toolbar">
      <ActionButton variant="secondary" disabled={command.pending} aria-busy={command.pending || undefined}
        onClick={() => void command.send({ type: 'inquiry.import', source: row.source, providerRef: row.providerRef, idempotencyKey: pressKey('inbox') })}>
        {t.t(answered ? inboxText('manageReview') : `widget.ai-response.write.${review ? 'review' : 'message'}`)}</ActionButton>
    </div>}
    {command.error && <p role="alert" className="ui-field__error"><Icon name="error" aria-hidden />{inboxFailureText(t.t, command.error)}</p>}
  </div>;
}

/** Channel-specific evidence occupies the same source area as the original thread. */
export function InboxThreadSource({ row, data }: { readonly row: InquiryDto; readonly data: RealInbox }) {
  const t = useT();
  const consultation = useConsultation(row.source === 'talktalk' ? row.providerRef : null);
  const provider = row.source === 'review' && data.reviews.status === 'available' ? data.reviews.items.find(item => item.ref === row.providerRef) : undefined;
  const link = naverLink(row.sourceUrl);
  return <>
    {provider && provider.text !== row.text && <p className="mkt-quote">{provider.text}</p>}
    {row.source === 'talktalk' && <>
      <h4 className="mkt-section">{t.t(inboxText('threadHeading'))}</h4>
      {consultation.status === 'loading' ? <p className="mkt-meta" role="status">{t.t('data.real.loading')}</p>
        : consultation.status === 'error' ? <p className="mkt-meta" role="alert">{t.t(inboxText('threadError'))}</p>
          : <ul className="mkt-list">{consultation.thread?.messages.map((message, index) => message.text ? <li key={index} className="mkt-meta mkt-meta--lines">
            {message.from ? `${t.t(inboxText(message.from === 'user' ? 'fromUser' : 'fromPartner'))}: ` : ''}{message.text}</li> : null)}</ul>}
    </>}
    {link && <p><a className="mkt-touch-link" href={link} target="_blank" rel="noopener noreferrer">{t.t('data.real.local.original')}</a></p>}
  </>;
}

function ReplyLayout({ footer, children }: { readonly footer: ReactNode; readonly children: ReactNode }) {
  return <PinnedColumn footer={<div className="mkt-reply-footer">{footer}</div>}>
    <div className="mkt-detail mkt-reply-editor" data-slot={`${ID}.card`}>{children}</div>
  </PinnedColumn>;
}

export function ReplyDone({ original, body, status, children, lang, review }: {
  readonly original: ReactNode; readonly body: string; readonly status: string; readonly children?: ReactNode; readonly lang?: string; readonly review?: boolean;
}) {
  const t = useT();
  return <div className="mkt-detail" data-slot={`${ID}.card`}>
    {original}
    <h4 className="mkt-section">{t.t(review ? 'widget.ai-response.myReply' : 'widget.ai-response.sentHeading')}</h4>
    <p className="mkt-quote mkt-reply-text" lang={lang}>{body}</p>
    <p className="mkt-ok" role="status"><Icon name="check" aria-hidden />{status}</p>
    {children}
  </div>;
}

interface ReplyControlsProps {
  readonly row: Pick<InquiryDto, 'id' | 'type' | 'source' | 'providerRef' | 'draft' | 'reply' | 'revision'>;
  readonly host: WidgetHost;
  readonly prefill?: string;
  readonly example?: boolean;
  readonly exampleInquiry?: string;
  readonly authorNotification?: string | null;
  readonly groundKeys?: readonly string[];
  readonly recoverSend?: () => void;
  readonly keep: () => void;
  readonly children: ReactNode;
  readonly focusOnEntry: boolean;
}

export function InboxReplyControls({ row, host, prefill, example, exampleInquiry, authorNotification, groundKeys, recoverSend, keep, children, focusOnEntry }: ReplyControlsProps) {
  const t = useT();
  const store = useWidgetDataStore();
  const base = useInboxCommand(host);
  // A reply moves the thread from waiting to done in the list: pin the shown thread before the first write.
  const command = { ...base, send: (...args: Parameters<typeof base.send>) => { keep(); return base.send(...args); } };
  const review = row.type === 'review';
  const talk = row.type === 'message' && row.source === 'talktalk';
  const navisDraft = useTalkTalkDraft(!row.reply ? row.id : null, Boolean(example));
  const [draftFacts, setDraftFacts] = useState<readonly string[]>([]);
  const [pickingCoupon, setPickingCoupon] = useState(false);
  const [attachment, setAttachment] = useState<{ block: string; fact: string }>();
  const coupons = useReplyCoupons(talk && pickingCoupon, Boolean(example));
  const couponOptions = example && pickingCoupon ? exampleReplyCoupons(store.getSnapshot()) : coupons.rows;
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const saved = row.draft?.text ?? '';
  const [localDraft, setLocalDraft] = useState<{ body: string; origin: ReviewDraftSource | null } | undefined>(
    () => prefill === undefined ? undefined : { body: prefill, origin: null },
  );
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(row.reply?.text ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null), keepButton = useRef<HTMLButtonElement>(null);
  const askedDelete = useRef(false);
  // T-19: the confirm is one Esc step (data-esc-layer + data-esc-close) and hands focus back to the button that opened it.
  useLayoutEffect(() => {
    if (confirmDelete) { askedDelete.current = true; keepButton.current?.focus({ preventScroll: true }); }
    else if (askedDelete.current) { askedDelete.current = false; deleteButton.current?.focus({ preventScroll: true }); }
  }, [confirmDelete]);
  const draftField = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!focusOnEntry) return;
    const frame = requestAnimationFrame(() => draftField.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focusOnEntry]);
  // A queued NAVER review also offers its existing provider draft.
  const reviewRef = row.source === 'review' && !row.reply ? row.providerRef : null;
  const preview = useReviewDraftPreview(reviewRef);
  const savedOrigin = row.draft && row.draft.source !== 'owner' ? row.draft.source : null;
  const body = localDraft?.body ?? saved;
  const origin = localDraft ? localDraft.origin : savedOrigin;
  const bodyLines = new Set(body.split('\n').map(line => line.trim()));
  const attached = attachment && body.includes(attachment.block) ? attachment : undefined;
  const facts = draftFacts.filter(fact => bodyLines.has(fact));
  if (attached) facts.push(attached.fact);
  const exampleFacts = (groundKeys ?? []).map(key => t.t(key)).filter(fact => bodyLines.has(fact));
  const emptyGrounding = navisDraft.status === 'ungrounded' ? inboxText('draftNoFacts')
    : draftFacts.length ? inboxText('draftFactsEdited')
      : origin === 'navis' || navisDraft.status === 'unavailable' ? inboxText('draftFactsUnavailable') : 'widget.ai-response.noGround';
  const limit = LIMIT[row.type];
  const trimmed = body.trim();
  const tooLong = [...body].length > limit;
  const contact = review && hasContact(body);
  const unsaved = trimmed !== saved.trim();
  const drafting = preview.status === 'loading' || navisDraft.status === 'loading';
  const busy = command.pending || drafting || sending;
  const sendLabel = row.source === 'manual' ? inboxText('attest') : review ? inboxText('sendReview') : inboxText('sendTalk');
  const reply = row.reply;
  const canChangeReply = reply && row.source === 'review' && reply.state !== 'recorded';

  async function makeNaverDraft() {
    const draft = await preview.request('naver-ai');
    if (!draft) return;
    setDraftFacts([]);
    setLocalDraft({ body: draft.text, origin: draft.source });
    command.clearError();
  }
  async function makeNavisDraft() {
    const draft = await navisDraft.request(() => exampleTalkTalkDraft(exampleInquiry ?? '', store.getSnapshot(), value => text(t, value)));
    if (!draft) return;
    setDraftFacts(draft.facts);
    setLocalDraft({ body: attached ? `${draft.text}\n\n${attached.block}` : draft.text, origin: 'navis' });
    command.clearError();
  }
  async function saveDraft() {
    const base = { type: 'inquiry.saveDraft' as const, threadId: row.id, body: trimmed, revision: row.revision, idempotencyKey: pressKey('inbox') };
    const result = await command.send(origin ? { ...base, draftSource: origin } : base);
    if (result?.ok) setLocalDraft(undefined);
    return result;
  }

  async function send() {
    if (sendingRef.current || busy || !trimmed || tooLong || contact || (!talk && (!row.draft || unsaved))) return;
    sendingRef.current = true;
    setSending(true);
    try {
      // An explicit TalkTalk send press saves the exact edited body before requesting its approved send.
      if (talk) {
        let revision = row.revision;
        if (!row.draft || unsaved) {
          const saved = await saveDraft();
          if (!saved?.ok) return;
          revision = (saved.value as CommandReceipt | undefined)?.revision
            ?? store.getSnapshot().tables.inquiryThread.find(thread => thread.threadId === row.id)?.replyDraft?.revision ?? revision;
        }
        await command.send(talkTalkReplyCommand(row.id, revision, example ? undefined : trimmed, recoverSend ? 'send-failure' : undefined));
        return;
      }
      await command.send({ type: review ? 'inquiry.post' : 'inquiry.send', threadId: row.id, idempotencyKey: pressKey('inbox'),
        ...(example ? {} : { body: row.draft!.text }),
        ...(recoverSend ? { previewVariant: 'send-failure' } : {}) });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  if (reply) {
    return <ReplyDone original={children} body={reply.text} status={t.t(inboxText(`state.${reply.state}`))} review={review}>
      {review && authorNotification && <p className="mkt-meta">{authorNotification}</p>}
      {canChangeReply && !editing && !confirmDelete && <div className="mkt-toolbar">
        <ActionButton variant="secondary" disabled={busy} onClick={() => { setEditBody(reply.text); setEditing(true); }}>{t.t(inboxText('edit'))}</ActionButton>
        <ActionButton ref={deleteButton} variant="secondary" disabled={busy} onClick={() => setConfirmDelete(true)}>{t.t(inboxText('delete'))}</ActionButton>
      </div>}
      {editing && <div>
        <Textarea label={t.t('widget.ai-response.reviewDraft')} value={editBody} disabled={busy} onValueChange={setEditBody} rows={4}
          error={hasContact(editBody) ? t.t(k('error.REPLY_CONTAINS_CONTACT')) : [...editBody].length > LIMIT.review ? t.t(k('error.INVALID_TEXT')) : undefined} />
        <div className="mkt-toolbar">
          <ActionButton size="primary" disabled={busy || !editBody.trim() || editBody.trim() === reply.text.trim() || [...editBody].length > LIMIT.review || hasContact(editBody)}
            aria-busy={busy || undefined} onClick={async () => { const result = await command.send({ type: 'inquiry.editReply', threadId: row.id, body: editBody.trim(), idempotencyKey: pressKey('inbox') }); if (result?.ok) setEditing(false); }}>
            {t.t(inboxText('editPost'))}</ActionButton>
          <ActionButton variant="secondary" disabled={busy} onClick={() => setEditing(false)}>{t.t('common.close')}</ActionButton>
        </div>
      </div>}
      {confirmDelete && <div role="group" aria-label={t.t(inboxText('delete'))} className="mkt-alert" data-esc-layer>
        <p className="mkt-alert__title"><Icon name="warning" aria-hidden />{t.t(inboxText('deleteAsk'))}</p>
        <div className="mkt-toolbar">
          <ActionButton size="primary" disabled={busy} aria-busy={busy || undefined} onClick={async () => { await command.send({ type: 'inquiry.deleteReply', threadId: row.id, idempotencyKey: pressKey('inbox') }); setConfirmDelete(false); }}>{t.t(inboxText('deleteYes'))}</ActionButton>
          <ActionButton ref={keepButton} variant="secondary" disabled={busy} data-esc-close onClick={() => setConfirmDelete(false)}>{t.t(inboxText('keep'))}</ActionButton>
        </div>
      </div>}
      {busy && <p className="mkt-meta" role="status">{t.t(inboxText('working'))}</p>}
      {command.error && <p role="alert" className="ui-field__error"><Icon name="error" aria-hidden />{inboxFailureText(t.t, command.error)}</p>}
    </ReplyDone>;
  }

  return <ReplyLayout footer={<>
    <div className="mkt-reply-footer__editor">
      <Textarea inputRef={draftField} label={t.t(review ? 'widget.ai-response.reviewDraft' : 'widget.ai-response.draft')} value={body} disabled={busy}
        labelAction={<ActionButton variant="secondary" size="icon" className="mkt-reply-draft-button"
          aria-label={t.t(inboxText('talkDraft'))} title={t.t(inboxText('talkDraft'))}
          disabled={busy} loading={navisDraft.status === 'loading'} onClick={() => void makeNavisDraft()}>
          <img src={navisSymbol} alt="" />
        </ActionButton>}
        onValueChange={value => { setLocalDraft({ body: value, origin: value.trim() ? origin : null }); command.clearError(); }}
        rows={4} error={contact ? t.t(k('error.REPLY_CONTAINS_CONTACT')) : tooLong ? t.t(k('error.INVALID_TEXT')) : undefined} />
    </div>
    <div className="mkt-reply-footer__tips">
      <p className="mkt-meta">{t.t(inboxText('pressOnly'))}</p>
      {!talk && unsaved && trimmed && <p className="mkt-meta">{t.t(inboxText('saveFirst'))}</p>}
      {navisDraft.status === 'loading' && <p className="mkt-meta" role="status">{t.t(inboxText('drafting'))}</p>}
      {(navisDraft.status === 'ungrounded' || navisDraft.status === 'unavailable') && <div className="mkt-toolbar" role="alert">
        <p className="ui-field__error"><Icon name="error" aria-hidden />{t.t(inboxText('draftFailed'))}</p>
        {navisDraft.status === 'ungrounded' && !trimmed && <p className="mkt-meta">{t.t(inboxText('draftNoFacts'))}</p>}
        {navisDraft.status === 'unavailable' && <ActionButton variant="secondary" disabled={busy} onClick={() => void makeNavisDraft()}>{t.t('common.retry')}</ActionButton>}
      </div>}
    </div>
    <div className="mkt-reply-footer__actions">
      <ActionButton variant="secondary" disabled={busy || !trimmed || !unsaved || tooLong || contact} aria-busy={command.pending || undefined}
        onClick={() => void saveDraft()}>{t.t('widget.ai-response.saveDraft')}</ActionButton>
      <ActionButton size="primary" disabled={busy || !trimmed || (!talk && (!row.draft || unsaved)) || tooLong || contact} aria-busy={command.pending || sending || undefined}
        onClick={() => void send()}>{t.t(sendLabel)}</ActionButton>
    </div>
  </>}>
    {children}
    {trimmed && <section aria-label={t.t('widget.ai-response.groundTitle')}>
      <h4 className="mkt-section">{t.t('widget.ai-response.groundTitle')}</h4>
      {facts.length || exampleFacts.length ? <ul className="mkt-list">
        {[...new Set([...facts, ...exampleFacts])].map(fact => <li key={fact} className="mkt-meta">{fact}</li>)}
      </ul> : <p className="mkt-meta">{t.t(emptyGrounding)}</p>}
    </section>}
    {review && authorNotification && <p className="mkt-meta"><span>{authorNotification}</span>{' '}<span>{t.t('widget.ai-response.noPersonalInfo')}</span></p>}
    {talk && <div data-slot={`${ID}.draft-buttons`}>
      <div className="mkt-toolbar">
        <ActionButton variant="secondary" disabled={busy} aria-expanded={pickingCoupon} onClick={() => { coupons.reset(); setPickingCoupon(!pickingCoupon); }}>{t.t(inboxText('attachCoupon'))}</ActionButton>
      </div>
      {pickingCoupon && <div role="group" aria-label={t.t(inboxText('attachCoupon'))} className="mkt-toolbar">
        {!example && coupons.status === 'loading' ? <p className="mkt-meta" role="status">{t.t('data.real.loading')}</p>
          : !example && coupons.status === 'error' ? <p className="ui-field__error" role="alert">{t.t(inboxText('couponLoadFailed'))}</p>
            : !couponOptions.length ? <p className="mkt-meta">{t.t(inboxText('noAttachableCoupons'))}</p>
              : couponOptions.map(coupon => <ActionButton key={coupon.id} variant="secondary" disabled={busy} onClick={() => {
                const fields = { name: text(t, coupon.name), benefit: text(t, coupon.benefit), date: coupon.endsOn, code: coupon.code };
                const block = t.t(inboxText('couponBlock'), fields);
                const rest = (attached ? body.replace(attached.block, '') : body).trimEnd();
                setAttachment({ block, fact: t.t(inboxText('couponFact'), fields) });
                setLocalDraft({ body: [rest, block].filter(Boolean).join('\n\n'), origin });
                setPickingCoupon(false);
                command.clearError();
                draftField.current?.focus({ preventScroll: true });
              }}>{text(t, coupon.name)}</ActionButton>)}
      </div>}
    </div>}
    {reviewRef && <div data-slot={`${ID}.draft-buttons`}>
      <div className="mkt-toolbar">
        <ActionButton variant="secondary" disabled={busy} aria-busy={preview.status === 'loading' || undefined} onClick={() => void makeNaverDraft()}>{t.t(inboxText('naverDraft'))}</ActionButton>
      </div>
      {preview.status === 'loading' && <p className="mkt-meta" role="status">{t.t(inboxText('drafting'))}</p>}
      {preview.status === 'error' && <div role="alert" className="mkt-toolbar">
        <p className="ui-field__error"><Icon name="error" aria-hidden />{t.t(inboxText('draftFailed'))}</p>
        <ActionButton variant="secondary" disabled={busy} onClick={() => void makeNaverDraft()}>{t.t('common.retry')}</ActionButton>
      </div>}
      <p className="mkt-meta">{t.t(inboxText('previewOnly'))}</p>
    </div>}
    {origin && body.trim() && <div className="mkt-card__badges"><StatusBadge semantic="none" label={t.t(inboxText(`draftFrom.${origin}`))} /></div>}
    {command.pending && <p className="mkt-meta" role="status">{t.t(inboxText('working'))}</p>}
    {command.error && (recoverSend && command.error === 'data.error.sendFailed'
      ? <InlineError message={t.t(command.error)} onRetry={() => { recoverSend(); command.clearError(); }} />
      : <p role="alert" className="ui-field__error"><Icon name="error" aria-hidden />{inboxFailureText(t.t, command.error)}</p>)}
  </ReplyLayout>;
}
