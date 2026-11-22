/** 커뮤니티 (`community`, F-46): received offers by reply deadline, browse public offers; accept / decline / show interest (mock). */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { isLargeCard, koreanLang } from './fit';
import type { WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import type { OfferRow } from '../../../data/models/types';
import { ActionButton, ChipChoice, DateField, DetailTabs, DialogFrame, Icon, InlineForm, MasterDetail, PanelBody, StatusBadge, Textarea, TextField, useUi } from '../../../ui';
import type { LocalRealCommand } from '../../../data/reality/13/commands';
import { calendarDay } from '../../../data/reality/13/adapter';
import { cafeArticleLink, type CafePostDto, type PeerDto, type RealLocal } from '../../../data/reality/13/dto';
import { useCafeBoards, useCafeCard } from '../../../data/reality/13/hooks';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, rowCapacity, useT, type Translator } from './shared';
import { localKey, periodText, seoulStamp, useLocalCommand, useLocalData, useReadHost } from './local-changes.http';
import { LocalReadNote } from './local-changes';
import { useKept } from '../mkt-coupon/shared';
import { dateRangeWithWeekdays } from '../date-range';

const ID = 'community';
type Tab = 'received' | 'browse' | 'sent' | 'cafe';
const cafeKey = (name: string) => localKey(`cafe.${name}`);

function StatusOf({ t, offer }: { readonly t: Translator; readonly offer: OfferRow }) {
  if (offer.status === 'pending') return <StatusBadge semantic="waiting" label={t.t('widget.community.awaiting')} />;
  if (offer.status === 'accepted') return <StatusBadge kind="active" label={t.t('widget.community.accepted')} />;
  if (offer.status === 'declined') return <StatusBadge kind="reviewed" label={t.t('widget.community.declined')} />;
  return <StatusBadge semantic="warning" label={t.t('widget.community.expired')} />;
}

function Panel({ condition, width, height, shape, host: shellHost }: WidgetPanelProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  const primary = <PrimaryMetric id={ID} shape={shape} label={t.t('widget.community.pendingOffers')} value={t.format.number(m.pendingCount)} unit={t.t('widget.community.unit', { n: m.pendingCount })} />;
  /**
   * D-333: the 4-high card keeps the offers awaiting a reply and adds the other real offers the data holds — the ones in progress and the public ones to browse —
   * each with the reply deadline. Nothing is added for a group the data has no offers in.
   */
  const large = isLargeCard(shape, height);
  const awaiting = m.pending.slice(0, shape === 'W' ? (textScale === 125 ? 1 : 2) : rowCapacity(shape, height, textScale));
  const rows = large ? [...awaiting, ...m.inProgress, ...m.publicOffers.filter((o) => !awaiting.includes(o))] : awaiting;
  const by = (o: OfferRow) => t.t('widget.community.respondBy', dateTime(t, o.respondBy));
  const sub = (o: OfferRow) => !large ? t.t(o.fromStoreKey)
    : o.visibility === 'public' ? `${t.t('widget.community.tabBrowse')} · ${t.t(o.fromStoreKey)} · ${by(o)}`
      : `${t.t(o.fromStoreKey)}${o.status === 'pending' ? ` · ${by(o)}` : ''}`;
  const list = rows.length === 0 ? null : (
    <FitList slot={`${ID}.list`} label={t.t('widget.community.pendingOffers')} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((o) => (
        <li key={o.offerId} className="mkt-row" data-slot={`${ID}.list.row`} data-mkt-extra={large && !awaiting.includes(o) ? '' : undefined}>
          <span className="mkt-row__text"><span className="mkt-row__title" lang={koreanLang(t.t(o.titleKey))}>{t.t(o.titleKey)}</span><span className="mkt-row__sub">{sub(o)}</span></span>
          {shape === 'W' ? <span className="mkt-row__value">{t.t('widget.community.awaiting')}</span> : large && o.visibility === 'public' ? null : <StatusOf t={t} offer={o} />}
        </li>
      ))} />
  );
  const extra = shape === 'S' || shape === 'L' ? (
    <p className="mkt-secondary" data-slot={`${ID}.metric.secondary`}>{t.t('widget.community.tabBrowse')} {m.publicOffers.length}{'\u00A0·\u00A0'}{t.t('widget.community.accepted')} {m.inProgress.length}</p>
  ) : null;
  return <PanelBody width={width} height={height} primary={primary} list={list} secondary={extra} />;
}

function OfferForm({ peers, host, close, created }: { readonly peers: readonly PeerDto[]; readonly host: WidgetHost;
  readonly close: () => void; readonly created: () => void }) {
  const t = useT();
  const peerField = useId();
  const { send, pending, error } = useLocalCommand(host);
  const [recipientStoreId, setRecipient] = useState('');
  const [title, setTitle] = useState('');
  const [terms, setTerms] = useState('');
  const [startsOn, setStartsOn] = useState(calendarDay);
  const [endsOn, setEndsOn] = useState(calendarDay);
  const [respondBy, setDeadline] = useState(calendarDay);
  const [review, setReview] = useState<Extract<LocalRealCommand, { type: 'community.create' }>>();
  const peer = peers.find(row => row.storeId === recipientStoreId);
  const valid = !!peer && title.trim().length > 0 && title.trim().length <= 160 && terms.trim().length > 0 && terms.trim().length <= 1000
    && !!startsOn && endsOn >= startsOn && respondBy >= calendarDay && respondBy <= endsOn;

  return <>
    <InlineForm title={t.t(localKey('createOffer'))} saveLabel={t.t(localKey('reviewOffer'))} saveDisabled={!valid} onClose={close}
      onSave={() => setReview({ type: 'community.create', recipientStoreId, title: title.trim(), terms: terms.trim(), startsOn, endsOn, respondBy })}>
      <label htmlFor={peerField} className="ui-field">{t.t(localKey('peer'))}
        <select className="ui-text-input" id={peerField} name="recipientStoreId" value={recipientStoreId} onChange={event => setRecipient(event.currentTarget.value)} required>
          <option value="" disabled>{t.t(localKey('participatingStore'))}</option>
          {peers.map(row => <option key={row.storeId} value={row.storeId}>{row.displayName}</option>)}
        </select>
      </label>
      <TextField label={t.t(localKey('title'))} name="title" value={title} onValueChange={setTitle} required />
      <Textarea label={t.t('widget.community.termsLabel')} name="terms" value={terms} onValueChange={setTerms} />
      <DateField label={t.t(localKey('start'))} value={startsOn} onValueChange={value => setStartsOn(value ?? '')} required />
      <DateField label={t.t(localKey('end'))} value={endsOn} min={startsOn} onValueChange={value => setEndsOn(value ?? '')} required />
      <DateField label={t.t(localKey('deadline'))} value={respondBy} min={calendarDay} max={endsOn} onValueChange={value => setDeadline(value ?? '')} required />
    </InlineForm>
    {review && <DialogFrame open title={t.t(localKey('offer'))} onClose={() => setReview(undefined)} closeLocked={pending} footer={
      <ActionButton loading={pending} disabled={!peer} onClick={async () => { if (await send(review)) created(); }}>{t.t(localKey('sendOffer'))}</ActionButton>
    }>
      <div className="mkt-detail">
        <h4 className="mkt-card__title">{review.title}</h4>
        <MetaLine>{t.t(localKey('peer'))} · {peer?.displayName}</MetaLine>
        <p className="mkt-quote">{review.terms}</p>
        <MetaLine>{periodText(t, { from: review.startsOn, to: review.endsOn })} · {t.t(localKey('deadline'))} {t.format.date(review.respondBy, 'short')}</MetaLine>
        {error && <p role="alert">{t.t(error)}</p>}
      </div>
    </DialogFrame>}
  </>;
}

function Detail({ condition, detailRef, host: shellHost }: WidgetDetailProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const view = useWidgetView(ID, condition);
  const data = useLocalData();
  const dispatch = useDataDispatch();
  const { pending, error, send } = useLocalCommand(host);
  // T-18 (H5): without a requested view the tab the owner left comes back (kept per data store); a Navis card's view still wins.
  const [keptTab, keepTab] = useKept<Tab | undefined>('community.tab', undefined);
  const [chosenTab, setChosenTab] = useState<Tab | undefined>(() => detailRef.view !== undefined || detailRef.itemId !== undefined ? undefined : keptTab);
  const setTab = (next: Tab) => { setChosenTab(next); keepTab(next); };
  const [declineId, setDecline] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(detailRef.itemId ?? null);
  const entryRow = useRef<HTMLButtonElement>(null);
  const entryAction = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (detailRef.focus === 'action' || detailRef.itemId) (entryAction.current ?? entryRow.current)?.focus({ preventScroll: true });
  }, [detailRef.focus, detailRef.itemId, view.status]);
  if (view.status !== 'ready') return <DetailState id={ID} view={view} host={host} />;
  const m = view.model;
  const sentLink = m.sent?.some(row => row.offerId === detailRef.itemId);
  const tab = chosenTab ?? (data && detailRef.view === 'cafe' ? 'cafe'
    : data && (detailRef.view === 'sent' || sentLink) ? 'sent'
    : detailRef.view === 'browse' ? 'browse' : 'received');
  // Received offers: waiting first by reply deadline, then in progress, then closed ones.
  const rank = (o: OfferRow) => (o.status === 'pending' ? 0 : o.status === 'accepted' ? 1 : 2);
  const received = [...m.received].sort((a, b) => rank(a) - rank(b) || a.respondBy.localeCompare(b.respondBy) || a.offerId.localeCompare(b.offerId));
  const list = tab === 'received' ? received : tab === 'sent' ? m.sent ?? [] : m.publicOffers;
  const selected = list.find((o) => o.offerId === pickedId) ?? list[0] ?? null;
  const decline = m.pending.find(row => row.offerId === declineId);
  const switchTab = (next: Tab) => { setTab(next); setPickedId(null); };

  const act = (type: 'community.accept' | 'community.decline' | 'community.sendInterest', offerId: string) => {
    if (data) {
      if (type === 'community.decline') setDecline(offerId);
      else void send({ type, offerId }).then(ok => { if (ok) entryRow.current?.focus({ preventScroll: true }); });
      return;
    }
    const result = dispatch({ type, offerId });
    if (result.ok && result.noticeKey) host.notify({ kind: 'success', messageKey: result.noticeKey, ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
  };

  const row = (o: OfferRow) => {
    const by = dateTime(t, o.respondBy);
    return (
      <li key={o.offerId} data-slot={`${ID}.list.row`}>
        <button type="button" className="mkt-pick" ref={selected?.offerId === o.offerId ? entryRow : undefined} aria-current={selected?.offerId === o.offerId} onClick={() => setPickedId(o.offerId)}>
          <span className="mkt-pick__top"><span className="mkt-pick__title">{t.t(o.titleKey)}</span></span>
          <span className="mkt-pick__sub">{t.t(o.fromStoreKey)}{'\u00A0·\u00A0'}{t.t(o.categoryKey)}</span>
          {o.visibility === 'direct' ? <span className="mkt-pick__badges"><StatusOf t={t} offer={o} /></span> : null}
          {o.visibility === 'direct' && o.status === 'pending' ? <span className="mkt-pick__sub">{t.t('widget.community.respondBy', by)}</span> : null}
        </button>
      </li>
    );
  };

  const pane = () => {
    if (!selected) return <p className="mkt-meta">{t.t('widget.community.pickItem')}</p>;
    const o = selected;
    const by = dateTime(t, o.respondBy);
    return (
      <div className="mkt-detail" data-slot={`${ID}.card`}>
        <div className="mkt-card__badges">{o.visibility === 'direct' ? <StatusOf t={t} offer={o} /> : null}<StatusBadge semantic="none" label={t.t(o.categoryKey)} /></div>
        <h4 className="mkt-card__title">{t.t(o.titleKey)}</h4>
        <MetaLine>{t.t(tab === 'sent' ? localKey('to') : 'widget.community.from', { store: t.t(o.fromStoreKey) })}</MetaLine>
        <h4 className="mkt-section">{t.t('widget.community.termsLabel')}</h4>
        <p className="mkt-quote">{t.t(o.termsKey)}</p>
        <p className="mkt-card__line">{t.t('widget.community.period', { period: dateRangeWithWeekdays(t, o.period.start, o.period.end) })}</p>
        {o.visibility === 'direct' && o.status === 'pending' ? <p className="mkt-card__line">{t.t('widget.community.respondBy', by)}</p> : null}
        {o.status === 'accepted' && o.sharedContactKey ? <p className="mkt-ok" role="status"><Icon name="check" aria-hidden />{t.t('widget.community.contact', { contact: t.t(o.sharedContactKey) })}</p> : null}
        {tab === 'received' && m.pending.some(row => row.offerId === o.offerId) ? (
          <>
            {t.locale !== 'ko' ? <p className="mkt-meta">{t.t('widget.community.directHint')}</p> : null}
            <div className="mkt-reply-actions">
              <ActionButton ref={entryAction} disabled={pending || creating} loading={pending} onClick={() => act('community.accept', o.offerId)}>{t.locale === 'ko' ? t.t('widget.community.accept') : t.t('common.accept')}</ActionButton>
              <ActionButton variant="secondary" disabled={pending || creating} onClick={() => act('community.decline', o.offerId)}>{t.locale === 'ko' ? t.t('widget.community.decline') : t.t('common.decline')}</ActionButton>
              {data && (o.interestSent ? <span role="status">{t.t(localKey('interestSent'))}</span> :
                <ActionButton variant="secondary" disabled={pending || creating} onClick={() => act('community.sendInterest', o.offerId)}>{t.t('common.showInterest')}</ActionButton>)}
            </div>
          </>
        ) : null}
        {o.visibility === 'public' ? (
          <>
            <p className="mkt-meta">{t.t('widget.community.publicHint')}</p>
            {o.interestSent ? <p className="mkt-ok" role="status"><Icon name="check" aria-hidden />{t.t('data.notice.interestSent')}</p>
              : <div className="mkt-reply-actions"><ActionButton ref={entryAction} onClick={() => act('community.sendInterest', o.offerId)}>{t.t('common.showInterest')}</ActionButton></div>}
          </>
        ) : null}
      </div>
    );
  };

  // The original tabs stay in HTTP mode (the browse tab has no public offers to show); the approved sent-offers and Café tabs follow them.
  const tabs = [{ value: 'received' as const, label: t.t('widget.community.tabReceived') }, { value: 'browse' as const, label: t.t('widget.community.tabBrowse') },
    ...(data ? [{ value: 'sent' as const, label: t.t(localKey('sent')) }, { value: 'cafe' as const, label: t.t(cafeKey('tab')) }] : [])];
  const empty = tab === 'sent' ? localKey('noSent') : tab === 'browse' ? 'widget.community.noPublic' : 'widget.community.noReceived';
  return (
    <div className="mkt-detail">
      <LocalReadNote notes={view.notes} host={host} />
      <MetaLine>{t.t('widget.community.summary', { n: m.pendingCount })}</MetaLine>
      {data && <>
        {!data.peersAvailable ? <div role="status"><MetaLine>{t.t(localKey('peersUnavailable'))}</MetaLine>
          <ActionButton variant="secondary" onClick={host.resetPreview}>{t.t('common.retry')}</ActionButton></div>
          : data.peers.length ? <div><ActionButton variant="secondary" disabled={creating || pending} onClick={() => setCreating(true)}>{t.t(localKey('createOffer'))}</ActionButton></div>
            : <MetaLine>{t.t(localKey('noPeers'))}</MetaLine>}
        {creating && <OfferForm peers={data.peers} host={host} close={() => setCreating(false)} created={() => { switchTab('sent'); setCreating(false); }} />}
      </>}
      <DetailTabs value={tab} onValueChange={switchTab} tabs={tabs} label={t.t('widget.community.tabLabel')} />
      {tab === 'cafe' && data ? <CafeTab key={data.storeId} data={data} /> : <MasterDetail
        list={list.length === 0 ? <p className="mkt-meta">{t.t(empty)}</p> : <ul className="mkt-list" data-slot={`${ID}.list`}>{list.map(row)}</ul>}
        detail={pane()}
      />}
      {!decline && error && <p role="alert">{t.t(error)}</p>}
      {decline && <DialogFrame open dialogRole="alertdialog" title={t.t(localKey('confirmDecline'))} onClose={() => setDecline(undefined)} closeLocked={pending} footer={
        <ActionButton variant="destructive" loading={pending} onClick={async () => {
          if (await send({ type: 'community.decline', offerId: decline.offerId })) setDecline(undefined);
        }}>{t.t(localKey('confirmDeclineAction'))}</ActionButton>
      }>
        <p>{t.t(decline.titleKey)}</p>
        {error && <p role="alert">{t.t(error)}</p>}
      </DialogFrame>}
    </div>
  );
}

/**
 * `카페 글쓰기` (PN17 · SCR-31 community): a text-only post on a board the owner's approved account allows. [올릴 내용 확인하기] is the card
 * press, [카페에 글 올리기] the second press that sends it once. The receipt links the published article; editing or deleting is done in the
 * Café. Offers and Café posts keep separate records.
 */
function CafeTab({ data }: { readonly data: RealLocal }) {
  const t = useT();
  const boards = useCafeBoards(true);
  const card = useCafeCard();
  const [boardIndex, setBoard] = useState('0');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const items = boards.items ?? [];
  const board = items[Number(boardIndex)] ?? items[0];
  const posts = data.cafePosts;
  const revision = posts?.status === 'available' ? posts.sourceRevision : undefined;
  const locked = card.phase !== 'edit';
  const subjectError = tried && !subject.trim() ? t.t(cafeKey('subjectRequired')) : undefined;
  const textError = tried && !text.trim() ? t.t(cafeKey('textRequired')) : undefined;
  const receiptLink = cafeArticleLink(card.receipt?.articleUrl ?? null);

  async function review() {
    setTried(true);
    if (!board || !subject.trim() || !text.trim() || revision === undefined) return;
    await card.press({ clubid: board.clubid, menuid: board.menuid, subject: subject.trim(), text }, revision);
  }
  async function post() {
    const result = await card.post();
    if (result?.state === 'published') { setSubject(''); setText(''); setTried(false); }
  }

  let writer;
  if (boards.status === 'loading') writer = <p role="status" className="mkt-meta">{t.t(cafeKey('loading'))}</p>;
  else if (boards.status === 'error') writer = <div role="alert"><MetaLine>{t.t(cafeKey('boardsError'))}</MetaLine>
    <ActionButton variant="secondary" onClick={boards.retry}>{t.t('common.retry')}</ActionButton></div>;
  else if (!items.length) writer = <p role="status" className="mkt-meta">{t.t(cafeKey('noBoards'))}</p>;
  else if (card.phase === 'confirm' || card.phase === 'posting') {
    const shown = card.card!.post;
    writer = <div role="group" aria-label={t.t(cafeKey('confirmTitle'))} className="mkt-card">
      <h4 className="mkt-card__title">{t.t(cafeKey('confirmTitle'))}</h4>
      {items.length > 1 && <MetaLine>{t.t(cafeKey('board'))} · {t.t(cafeKey('boardN'), { n: items.findIndex(row => row.clubid === shown.clubid && row.menuid === shown.menuid) + 1 })}</MetaLine>}
      <MetaLine>{t.t(cafeKey('subject'))} · {shown.subject}</MetaLine>
      <p className="mkt-quote mkt-reply-text" lang="ko">{shown.text}</p>
      <div className="mkt-toolbar">
        <ActionButton size="primary" loading={card.phase === 'posting'} disabled={card.phase === 'posting'} onClick={() => void post()}>{t.t(cafeKey('post'))}</ActionButton>
        <ActionButton variant="secondary" disabled={card.phase === 'posting'} onClick={card.back}>{t.t(cafeKey('edit'))}</ActionButton>
      </div>
      {card.phase === 'posting' && <p role="status" className="mkt-meta">{t.t(cafeKey('posting'))}</p>}
    </div>;
  } else writer = <div className="mkt-detail">
    {items.length === 1 ? <MetaLine>{t.t(cafeKey('oneBoard'))}</MetaLine>
      : <ChipChoice value={boardIndex} onChange={setBoard} label={t.t(cafeKey('board'))}
        options={items.map((_, index) => ({ value: String(index), label: t.t(cafeKey('boardN'), { n: index + 1 }), disabled: locked }))} />}
    <TextField label={t.t(cafeKey('subject'))} name="cafe-subject" value={subject} onValueChange={setSubject} disabled={locked} required error={subjectError} />
    <Textarea label={t.t(cafeKey('text'))} name="cafe-text" value={text} onValueChange={setText} disabled={locked} rows={6} error={textError} />
    <MetaLine>{t.t(cafeKey('textOnly'))}</MetaLine>
    <div><ActionButton size="primary" loading={card.phase === 'pressing'} disabled={locked || revision === undefined} onClick={() => void review()}>{t.t(cafeKey('review'))}</ActionButton></div>
  </div>;

  return <section className="mkt-detail" data-slot={`${ID}.cafe`} aria-label={t.t(cafeKey('tab'))}>
    <MetaLine>{t.t(cafeKey('separate'))}</MetaLine>
    {card.phase === 'unknown' ? <div role="alert" className="mkt-alert">
      <p className="mkt-alert__title"><Icon name="warning" aria-hidden />{t.t(cafeKey('unknown'))}</p>
      <ActionButton variant="secondary" onClick={card.recheck}>{t.t('common.retry')}</ActionButton>
    </div> : writer}
    {card.receipt?.state === 'published' && <p role="status" className="mkt-ok"><Icon name="check" aria-hidden />{t.t(cafeKey('posted'))}
      {receiptLink && <> · <a className="mkt-touch-link" href={receiptLink} target="_blank" rel="noopener noreferrer">{t.t(cafeKey('view'))}</a></>}</p>}
    {card.receipt?.state === 'published' && <MetaLine>{t.t(cafeKey('editHint'))}</MetaLine>}
    {card.receipt?.state === 'rejected' && <p role="alert" className="ui-field__error"><Icon name="error" aria-hidden />{t.t(cafeKey('rejected'))}</p>}
    {card.error && <p role="alert" className="ui-field__error"><Icon name="error" aria-hidden />{t.t(card.error)}</p>}
    <CafePosts posts={posts} />
  </section>;
}

function CafePosts({ posts }: { readonly posts: RealLocal['cafePosts'] }) {
  const t = useT();
  const heading = <h4 className="mkt-section">{t.t(cafeKey('posts'))}</h4>;
  if (!posts || posts.status === 'unavailable') return <>{heading}<p role="status" className="mkt-meta">{t.t(cafeKey('postsUnavailable'))}</p></>;
  if (!posts.items.length) return <>{heading}<p role="status" className="mkt-meta">{t.t(cafeKey('noPosts'))}</p></>;
  const rows = [...posts.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const badge = (row: CafePostDto) => row.state === 'published' ? <StatusBadge kind="checked" label={t.t(cafeKey(`state.${row.state}`))} />
    : <StatusBadge semantic="none" label={t.t(cafeKey(`state.${row.state}`))} />;
  return <>{heading}<ul className="mkt-list" aria-label={t.t(cafeKey('posts'))} data-slot={`${ID}.cafe.posts`}>{rows.map(row => {
    const link = row.state === 'published' ? cafeArticleLink(row.articleUrl) : undefined;
    return <li key={row.id} className="mkt-row">
      <span className="mkt-row__text"><span className="mkt-row__title">{row.subject}</span>
        <span className="mkt-row__sub">{t.t(cafeKey('column.time'))} · {dateTime(t, seoulStamp(row.updatedAt)).at}</span></span>
      <span className="mkt-row__value">{badge(row)}</span>
      {link && <a className="mkt-touch-link" href={link} target="_blank" rel="noopener noreferrer">{t.t(cafeKey('view'))}<span className="ui-sr-only"> {row.subject}</span></a>}
    </li>;
  })}</ul></>;
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  return view.status === 'ready' ? t.t('widget.community.summary', { n: view.model.pendingCount }) : t.locale === 'ko' && view.variant === 'none' ? t.t('widget.community.state.none') : t.t(view.messageKey);
}

export const communityModule: WidgetModule = {
  id: ID,
  Panel,
  Detail,
  useSummary,
};
