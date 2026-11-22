/** 메시지·리뷰 응대 (F-45, SCR-31). */
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { inquiryDraftRevision, storedInquiryReply } from '../../../data/commands/reply-guard';
import { formatMaskedCustomer } from '../../../data/customer-display';
import { useWidgetDataStore, useWidgetView } from '../../../data/react';
import type { ImportRow, ThreadRow } from '../../../data/models/types';
import { ActionButton, DetailTabs, Icon, IntegrationBadge, MasterDetail, PanelBody, StatusBadge, useUi } from '../../../ui';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, rowCapacity, text, useT, type Translator } from './shared';
import { isLargeCard, koreanLang } from './fit';
import type { StoreClosure } from '../../../data/iteration7/notices';
import { isIsoDate } from '../../../data/db/time';
import { replyPrefill } from './reply-prefill';
import { AddInquiry, ImportPane, InboxReplyControls, InboxThreadSource, ReplyDone, ReviewStats, inboxDisplayText, inboxText } from './ai-response.actions';
import { answeredReviewImports, shownAverage, starsSentiment, type AnsweredReviewImport, type ReviewStatsUnit } from '../../../data/reality/15/dto';
import { useConsultation, useInbox, useInboxHttp, useReviewInsights } from '../../../data/reality/15/hooks';
import { useReadHost } from './local-changes.http';
import { exampleInsights } from './example-local';
import { useKept } from '../mkt-coupon/shared';

const ID = 'ai-response';
type Tab = 'message' | 'review' | 'stats';
/** Waiting items a wide card lists under the channel rows; the 4-high card lists up to six (D-333). */
const SMALL_PRIORITY_ROWS = 3;
const LARGE_PRIORITY_ROWS = 6;
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
const authorOf = (th: ThreadRow): string | null => th.authorMasked ? formatMaskedCustomer(th.authorMasked) : null;
const importExcerpt = (t: Translator, row: ImportRow) => row.text ? inboxDisplayText(t, row.text) : t.t('widget.ai-response.consultation');
const isTalkLookup = (value: string | null | undefined) => /^톡톡 상담\s+[\w-]+$/u.test(value ?? '');

function SentimentBadge({ t, sentiment }: { readonly t: Translator; readonly sentiment: ThreadRow['sentiment'] }) {
  if (sentiment === 'positive') return <StatusBadge semantic="positive" label={t.t('widget.ai-response.positive')} />;
  if (sentiment === 'negative') return <StatusBadge kind="needsReview" label={t.t('widget.ai-response.negative')} />;
  if (sentiment === 'neutral') return <StatusBadge kind="suggested" label={t.t('widget.ai-response.neutral')} />;
  return null;
}

function Panel({ condition, width, height, shape, editing, host: shellHost }: WidgetPanelProps) {
  const t = useT();
  const host = useReadHost(shellHost, 'inbox');
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  const capacity = rowCapacity(shape, height, textScale);
  const channels = shape === 'S' ? m.byChannel.filter(row => row.channelKey !== 'data.channel.naverReview' || row.count !== m.byType.review) : m.byChannel;
  const channelRows = channels.slice(0, capacity);
  const byType = t.t('widget.ai-response.byType', { m: m.byType.message, r: m.byType.review });
  const primary = (
    <PrimaryMetric id={ID} shape={shape} label={t.t('widget.ai-response.waiting')} value={t.format.number(m.waitingCount)} unit={t.t('widget.ai-response.unit', { n: m.waitingCount })}
      secondary={shape === 'W' ? undefined : byType} />
  );
  const priorityRows = m.priority.slice(0, capacity);
  const hiddenWaiting = channels.slice(channelRows.length).reduce((sum, channel) => sum + channel.count, 0);
  const channelItems = channelRows.map((c, index) => (
    <li key={c.channelKey} className="mkt-row" data-slot={`${ID}.list.row`}>
      <span className="mkt-row__title">{t.t(c.channelKey)}</span>
      <span className="mkt-row__value">{t.t('widget.ai-response.countText', { n: c.count })}{t.locale === 'ko' && index === channelRows.length - 1 && hiddenWaiting > 0 ? `\u00a0·\u00a0외 ${t.format.number(hiddenWaiting)}건` : ''}</span>
    </li>
  ));
  /** D-333: the large card keeps the small-size rows and adds the next waiting items; each row also says when it was received and why it needs a person (the data the thread holds). */
  const large = isLargeCard(shape, height);
  const priorityItems = (large ? m.priority.slice(0, LARGE_PRIORITY_ROWS) : priorityRows).map((th, index) => (
    <li key={th.threadId} className="mkt-row" data-slot={`${ID}.list.row`} data-mkt-extra={large && index >= SMALL_PRIORITY_ROWS ? '' : undefined}>
      <span className="mkt-row__text"><span className="mkt-row__title mkt-inbox-excerpt" lang={koreanLang(text(t, th.body))}>{inboxDisplayText(t, text(t, th.body))}</span><span className="mkt-row__sub">{large ? `${t.t(th.channelKey)}\u00a0·\u00a0${t.t('widget.ai-response.receivedAt', dateTime(t, th.receivedAt))}` : t.t(th.channelKey)}</span></span>
      {th.needsPersonReason ? <StatusBadge kind="needsReview" label={large && th.needsPersonKey ? `${t.t('common.badge.needsReview')}\u00a0·\u00a0${t.t(th.needsPersonKey)}` : undefined} /> : null}
    </li>
  ));
  // HTTP: the NAVER items that wait for a reply are counted above, so they list after the queue's own waiting items (same row shape).
  const room = Math.max(0, (large ? LARGE_PRIORITY_ROWS : capacity) - priorityItems.length);
  priorityItems.push(...(m.imports ?? []).slice(0, room).map((row, index) => {
    const excerpt = importExcerpt(t, row);
    return <li key={row.importId} className="mkt-row" data-slot={`${ID}.list.row`} data-mkt-extra={large && priorityItems.length + index >= SMALL_PRIORITY_ROWS ? '' : undefined}>
      <span className="mkt-row__text"><span className="mkt-row__title mkt-inbox-excerpt" lang={koreanLang(excerpt)}>{excerpt}</span><span className="mkt-row__sub">{t.t(row.channelKey)}</span></span>
    </li>;
  }));
  const fit = (items: readonly ReactNode[], label: string) => <FitList slot={`${ID}.list`} label={label} items={items} resetKey={`${t.locale}|${width}x${height}|${textScale}|${items.length}`} />;
  const byChannel = fit(channelItems, t.t('widget.ai-response.waiting'));
  const first = fit(priorityItems, t.t('widget.ai-response.recent'));
  const note = view.notes?.[0];
  const praiseLine = shape !== 'Q' && !(shape === 'T' && textScale === 125) ? (
    <>
      {m.praiseCount > 0 && <p className="mkt-secondary" data-slot={`${ID}.metric.secondary`}>{t.t('widget.ai-response.praise', { n: m.praiseCount })}</p>}
      {note ? <p className="mkt-panel-note">{editing ? <StatusBadge kind="needsReview" /> : <Icon name="warning" aria-hidden />}<span className={editing ? 'ui-sr-only' : undefined} lang={koreanLang(t.t(note.messageKey))}>{t.t(note.messageKey)}</span></p> : null}
    </>
  ) : null;
  const list = m.waitingCount === 0 ? null : shape === 'T' ? first : shape === 'S' ? byChannel : shape === 'L' ? fit([...channelItems, ...priorityItems.slice(0, large ? LARGE_PRIORITY_ROWS : SMALL_PRIORITY_ROWS)], t.t('widget.ai-response.waiting')) : byChannel;
  return <PanelBody width={width} height={height} primary={primary} list={shape === 'W' ? <p className="mkt-secondary">{byType}</p> : list} secondary={shape === 'W' ? undefined : praiseLine} />;
}

function TalkExcerpt({ row, selected }: { readonly row: ImportRow; readonly selected: boolean }) {
  const t = useT();
  const thread = useConsultation(selected ? row.providerRef : null);
  const first = thread.thread?.messages.find(message => message.from === 'user' && message.text)?.text;
  return first ? inboxDisplayText(t, first).split('\n')[0] : importExcerpt(t, row);
}

function Detail({ condition, detailRef, host: shellHost }: WidgetDetailProps) {
  const t = useT();
  const host = useReadHost(shellHost, 'inbox');
  const view = useWidgetView(ID, condition);
  const http = useInboxHttp();
  const data = useInbox();
  // T-18 (H5): without a requested view the tab and the stats unit the owner left come back (kept per data store); a Navis card's view still wins.
  const requested = detailRef.view !== undefined || detailRef.itemId !== undefined;
  const [keptTab, keepTab] = useKept<Tab>('ai-response.tab', 'message');
  const [keptUnit, keepUnit] = useKept<ReviewStatsUnit>('ai-response.unit', 'week');
  const [tab, setTabState] = useState<Tab>(detailRef.view === 'review' || detailRef.view === 'stats' ? detailRef.view : !requested ? keptTab : 'message');
  const setTab = (next: Tab) => { setTabState(next); keepTab(next); };
  const [adding, setAdding] = useState(false);
  const [unit, setUnitState] = useState<ReviewStatsUnit>(requested ? 'week' : keptUnit);
  const setUnit = (next: ReviewStatsUnit) => { setUnitState(next); keepUnit(next); };
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const serviceInsights = useReviewInsights(!http || tab === 'message' ? null : tab === 'review' ? 'week' : unit);
  // PAR-3 (D-384): the example data answers the statistics tab and the average like the insight service does.
  const insights: typeof serviceInsights = http ? serviceInsights : { status: 'ready', data: tab === 'message' ? undefined : exampleInsights(snapshot, tab === 'review' ? 'week' : unit), retry: () => {} };
  const [praiseOnly, setPraiseOnly] = useState(detailRef.filter === 'praise');
  const [pickedId, setPickedId] = useState<string | null>(detailRef.itemId ?? null);
  if (view.status !== 'ready') {
    const disconnected = view.variant === 'channel-disconnected';
    return <DetailState id={ID} view={view} host={host} extra={disconnected && t.locale !== 'ko' ? <IntegrationBadge state="needed" label={t.t('common.connectNeeded')} /> : null} />;
  }
  const m = view.model;
  const done = m.threads.filter((th) => !th.waiting).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.threadId.localeCompare(b.threadId));
  const matchesTab = (row: Pick<ThreadRow, 'type' | 'sentiment'>) => (tab === 'review') === (row.type === 'review')
    && (tab !== 'review' || !praiseOnly || row.sentiment === 'positive');
  const matchesImport = (row: ImportRow) => matchesTab({ type: row.type, sentiment: starsSentiment(row.stars) });
  const waitingImports = (m.imports ?? []).filter(matchesImport);
  const answeredImports = data && tab === 'review' ? answeredReviewImports(data).filter(matchesImport) : [];
  const rows = [...m.priority.filter(matchesTab), ...waitingImports, ...done.filter(matchesTab), ...answeredImports];
  const importedId = pickedId?.startsWith('import:') ? data?.inquiries.find(row => `import:${row.source}:${row.providerRef}` === pickedId)?.id : undefined;
  const active = rows.find(row => ('importId' in row ? row.importId : row.threadId) === (importedId ?? pickedId)) ?? rows[0];
  const selectedImport = active && 'importId' in active ? active : undefined;
  const selected = active && 'threadId' in active ? active : undefined;
  const raw = new Map(data?.inquiries.map(row => [row.id, row]));
  const average = tab === 'review' ? shownAverage(insights.data) : undefined;

  const threadRow = (th: ThreadRow) => {
    const at = dateTime(t, th.receivedAt);
    const sourceTitle = raw.get(th.threadId)?.title ?? th.title;
    const title = isTalkLookup(sourceTitle) ? null : sourceTitle;
    const body = inboxDisplayText(t, text(t, th.body));
    return (
      <li key={th.threadId} data-slot={`${ID}.list.row`}>
        <button type="button" className="mkt-pick" aria-current={selected?.threadId === th.threadId} onClick={() => setPickedId(th.threadId)}>
          <span className="mkt-pick__top">
            <span className="mkt-pick__title">{t.t(th.channelKey)}{authorOf(th) ? `\u00A0·\u00A0${authorOf(th)}` : ''}</span>
            <span className="mkt-pick__sub">{t.t('widget.ai-response.receivedAt', at)}</span>
          </span>
          <span className="mkt-pick__excerpt">{title && title !== body ? `${title} · ${body}` : body}</span>
          <span className="mkt-pick__badges">
            {th.type === 'review' ? <SentimentBadge t={t} sentiment={th.sentiment} /> : null}
            {th.needsPersonReason ? <StatusBadge kind="needsReview" label={`${t.t('common.badge.needsReview')}\u00A0·\u00A0${t.t(th.needsPersonKey ?? '')}`} />
              : th.waiting ? <StatusBadge semantic="waiting" label={th.draft ? t.t('widget.ai-response.statusDraft') : t.t(th.type === 'review' ? 'widget.ai-response.reviewWaiting' : 'widget.ai-response.waiting')} />
                : <StatusBadge kind="checked" label={t.t('widget.ai-response.statusDone')} />}
          </span>
        </button>
      </li>
    );
  };

  const importRow = (row: ImportRow | AnsweredReviewImport) => (
    <li key={row.importId} data-slot={`${ID}.list.row`}>
      <button type="button" className="mkt-pick" aria-current={selectedImport?.importId === row.importId} onClick={() => setPickedId(row.importId)}>
        <span className="mkt-pick__top"><span className="mkt-pick__title">{t.t(row.channelKey)}</span></span>
        <span className="mkt-pick__excerpt">{row.source === 'talktalk' ? <TalkExcerpt row={row} selected={selectedImport?.importId === row.importId} /> : importExcerpt(t, row)}</span>
        <span className="mkt-pick__badges">
          {row.type === 'review' ? row.stars === null ? <StatusBadge semantic="none" label={t.t(inboxText('noStars'))} /> : <StatusBadge semantic="rating" label={t.t('widget.ai-response.rating', { n: row.stars })} /> : null}
          {'reply' in row ? <StatusBadge kind="checked" label={t.t(inboxText('hasReply'))} /> : <StatusBadge semantic="waiting" label={t.t(row.type === 'review' ? 'widget.ai-response.reviewWaiting' : 'widget.ai-response.waiting')} />}
        </span>
      </button>
    </li>
  );

  const pane = () => {
    if (selectedImport) return <ImportPane key={selectedImport.importId} row={selectedImport} host={host} />;
    if (!selected) return <p className="mkt-meta">{t.t('widget.ai-response.pickItem')}</p>;
    const th = selected;
    const review = th.type === 'review';
    const prefill = th.threadId === detailRef.itemId ? replyPrefill(detailRef) : undefined;
    const inquiry = raw.get(th.threadId);
    const original = (
      <>
        <div className="mkt-card__badges">
          {th.isPublic || t.locale !== 'ko' ? <StatusBadge semantic="none" label={th.isPublic ? t.t('widget.ai-response.public') : t.t('widget.ai-response.private')} /> : null}
          {review ? <SentimentBadge t={t} sentiment={th.sentiment} /> : null}
          {th.rating !== null ? <StatusBadge semantic="rating" label={t.t('widget.ai-response.rating', { n: th.rating })} />
            : inquiry?.source === 'review' ? <StatusBadge semantic="none" label={t.t(inboxText('noStars'))} /> : null}
        </div>
        <MetaLine>{t.t(th.channelKey)}{authorOf(th) ? `\u00A0·\u00A0${authorOf(th)}` : ''}{'\u00A0·\u00A0'}{t.t('widget.ai-response.receivedAt', dateTime(t, th.receivedAt))}</MetaLine>
        <h4 className="mkt-section">{t.t('widget.ai-response.original')}</h4>
        {inquiry?.title && !isTalkLookup(inquiry.title) && inquiry.title !== text(t, th.body) && <p className="mkt-card__title">{inboxDisplayText(t, inquiry.title)}</p>}
        <p className="mkt-quote">{inboxDisplayText(t, text(t, th.body))}</p>
        {inquiry && data && <InboxThreadSource row={inquiry} data={data} />}
        {th.needsPersonReason && <div className="mkt-alert" role="note"><p className="mkt-alert__title"><Icon name="warning" aria-hidden />{t.t('common.badge.needsReview')}</p><p>{t.t('widget.ai-response.needsPerson', { reason: t.t(th.needsPersonKey ?? '') })}</p></div>}
      </>
    );
    const controls = {
      host, prefill, focusOnEntry: detailRef.focus === 'action' && (detailRef.itemId === undefined || th.threadId === detailRef.itemId),
      keep: () => setPickedId(th.threadId),
    };
    const key = JSON.stringify([data?.storeId, th.threadId, prefill]);
    if (data && inquiry) return <InboxReplyControls key={key} {...controls} row={inquiry} authorNotification={data.authorNotification}>{original}</InboxReplyControls>;
    if (http || th.type === 'call') return original;
    if (!th.waiting) return <ReplyDone original={original} body={text(t, th.draft)} status={t.t('widget.ai-response.statusDone')} review={review} />;

    const example = snapshot.tables.inquiryThread.find(row => row.threadId === th.threadId);
    if (!example) return original;
    const saved = storedInquiryReply(example);
    const manual = th.channelKey === 'data.real.inbox.channel.manualMessage' || th.channelKey === 'data.real.inbox.channel.manualReview';
    const row = {
      id: th.threadId, type: th.type, source: manual ? 'manual' : review ? 'review' : 'talktalk', providerRef: null,
      draft: saved !== undefined ? { text: saved, source: 'owner' as const } : null, reply: null, revision: inquiryDraftRevision(example),
    } as const;
    return <InboxReplyControls key={key} {...controls} row={row} example exampleInquiry={text(t, th.body)} groundKeys={th.groundKeys}
      recoverSend={view.variant === 'send-failure' ? host.resetPreview : undefined}>{original}</InboxReplyControls>;
  };

  const tabs = [{ value: 'message' as const, label: t.t('widget.ai-response.tabMessages') }, { value: 'review' as const, label: t.t('widget.ai-response.tabReviews') },
    { value: 'stats' as const, label: t.t(inboxText('tabStats')) }];
  return (
    <div className="mkt-detail mkt-reply-detail">
      <div className="mkt-toolbar mkt-add-toolbar">
        <MetaLine>{t.t('widget.ai-response.summary', { n: m.waitingCount })}{'\u00A0·\u00A0'}{t.t('widget.ai-response.byType', { m: m.byType.message, r: m.byType.review })}</MetaLine>
        {average !== undefined && <MetaLine>{t.t(inboxText('average'), { x: average.toFixed(1) })}</MetaLine>}
        <ActionButton variant="secondary" disabled={adding} onClick={() => setAdding(true)}>{t.t(inboxText('addInquiry'))}</ActionButton>
      </div>
      {adding && <AddInquiry host={host} close={() => setAdding(false)} onCreated={(id, kind) => { setTab(kind); setPickedId(id); }} />}
      {view.notes?.[0] ? <p className="mkt-panel-note"><Icon name="warning" aria-hidden />{t.t(view.notes[0].messageKey)}</p> : null}
      <DetailTabs value={tab} onValueChange={(v) => { setTab(v); setPickedId(null); }} tabs={tabs} label={t.t('widget.ai-response.tabLabel')} />
      {tab === 'review' ? (
        <div className="ui-chip-choice">
          <button type="button" role="checkbox" aria-checked={praiseOnly} className="ui-choice-chip" data-slot={`${ID}.praise`} onClick={() => setPraiseOnly(!praiseOnly)}>{t.t('widget.ai-response.onlyPraise')}</button>
        </div>
      ) : null}
      {tab === 'stats' ? <ReviewStats read={insights} unit={unit} onUnit={setUnit} /> : <MasterDetail
        list={rows.length === 0 ? <p className="mkt-meta">{t.t('widget.ai-response.noItems')}</p> : (
          <ul className="mkt-list" data-slot={`${ID}.list`}>
            {rows.map(row => 'importId' in row ? importRow(row) : threadRow(row))}
          </ul>
        )}
        detail={pane()}
      />}
    </div>
  );
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  if (view.status === 'ready') return t.t('widget.ai-response.summary', { n: view.model.waitingCount });
  return t.t(view.variant === 'channel-disconnected' ? 'widget.ai-response.state.disconnected.short' : view.messageKey);
}

/** HTTP builds (F15) read and write the service's inquiry records; example builds run the same controls on local records. */
export const aiResponseModule: WidgetModule = { id: ID, Panel, Detail, useSummary };
