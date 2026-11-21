import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import { NOW, TODAY } from '../../../data/db/time';
import type { DataSnapshot, InquiryThread } from '../../../data/db/types';
import { dataBundles } from '../../../data/widget-data';
import type { DataCommand } from '../../../data/commands/types';
import { checkCommunityResponse, checkInquiryReply, inquiryDraftRevision, inquirySourceText, planInquiryDraft, storedInquiryReply } from '../../../data/commands/reply-guard';
import { selectWidget } from '../../../data/models/select';
import type { AiResponseModel, CommunityModel, OfferRow, ThreadRow } from '../../../data/models/types';
import { resolveDataText } from '../../../data/text';
import { baseBundles, createTranslator } from '../../../i18n';
import { mktLocalBundle } from '../../widgets/mkt-local/messages';
import { validateAgentDraft, validateAgentPrefill, type AgentFact, type AgentRecordMatch } from '../../../../shared/navis-agent-schema.mjs';
import { normalizeNavisInput, normalizeNavisName } from '../navis-input';
import type { DomainAdapter, DomainDetail, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter, RecordSearch, RecordTargets, RunCommandAdapter } from './registry';

const defaultCondition = { kind: 'default' } as const;
const replies = 'ai-response';
const community = 'community';
type Translation = ReturnType<typeof createTranslator<string>>;
const translations = new Map<Locale, Translation>();
function tr(locale: Locale): Translation {
  const cached = translations.get(locale);
  if (cached) return cached;
  const translator = createTranslator<string>(locale, ...baseBundles, ...dataBundles, mktLocalBundle);
  translations.set(locale, translator);
  return translator;
}
const local = (t: Translation, ko: string, en: string, hans: string, hant: string) =>
  ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[t.locale];
const dayOf = (snapshot: DataSnapshot) => snapshot.pos?.businessDate ?? TODAY;
const nowOf = (snapshot: DataSnapshot) => dayOf(snapshot) + NOW.slice(10);
const replyModel = (snapshot: DataSnapshot) => selectWidget(snapshot, replies, defaultCondition, 'normal');
const offerModel = (snapshot: DataSnapshot) => selectWidget(snapshot, community, defaultCondition, 'normal');
const threadRecord = (snapshot: DataSnapshot, id: string) => snapshot.tables.inquiryThread.find(row => row.threadId === id);
const original = (t: Translation, row: ThreadRow) => maskContact(resolveDataText(t.t, row.body));
const maskContact = (value: string) => value.replace(/(?:\+82[- .]?)?0?1[016789][-. ]?\d{3,4}[-. ]?\d{4}/gu, '010-****-****')
  .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '***@***');
const count = (t: Translation, value: number) => t.format.count(value, 'count');
const join = (...items: readonly (string | null | undefined)[]) => items.filter(Boolean).join(' · ');
const quote = (text: string) => text ? `“${text}”` : '';
const fact = (key: string, label: string, value: number | string, display = String(value)): AgentFact =>
  ({ key, label, value: typeof value === 'string' ? value.slice(0, 1000) : value, unit: typeof value === 'number' ? 'count' : 'text', display: display.slice(0, 1000) });

const replyKey = (name: string) => `inquiry.${name}`;
const offerKey = (name: string) => `community.${name}`;
const threadKey = (snapshot: DataSnapshot, row: ThreadRow) =>
  replyKey(`thread.${snapshot.tables.inquiryThread.findIndex(item => item.threadId === row.threadId)}`);
const communityKey = (snapshot: DataSnapshot, row: OfferRow) =>
  offerKey(`offer.${snapshot.tables.partnershipOffer.findIndex(item => item.offerId === row.offerId)}`);
const replyLabel = (t: Translation, row: ThreadRow) => t.t(row.type === 'review' ? 'widget.ai-response.reviewDraft' : 'widget.ai-response.draft');
const received = (t: Translation, row: ThreadRow, snapshot: DataSnapshot) => t.format.dateTime(row.receivedAt, { today: dayOf(snapshot) });
const threadName = (t: Translation, row: ThreadRow) => join(t.t(row.channelKey), row.authorMasked, row.rating === null ? null : t.t('widget.ai-response.rating', { n: row.rating }));
const threadDraft = (t: Translation, row: ThreadRow) => resolveDataText(t.t, row.draft);
const offerName = (t: Translation, row: OfferRow) => join(t.t(row.titleKey), t.t(row.fromStoreKey));
const offerStatus = (row: OfferRow, snapshot: DataSnapshot) =>
  row.status === 'pending' && row.respondBy < nowOf(snapshot) ? 'expired' : row.status;
const offerStatusText = (row: OfferRow, snapshot: DataSnapshot, t: Translation) => {
  const status = offerStatus(row, snapshot);
  if (status === 'withdrawn') return local(t, '철회됨', 'Withdrawn', '已撤回', '已撤回');
  return t.t(`widget.community.${status === 'pending' ? 'awaiting' : status}`);
};
const activeOffers = (rows: readonly OfferRow[], snapshot: DataSnapshot) => rows.filter(row => offerStatus(row, snapshot) === 'pending');

function threadFacts(snapshot: DataSnapshot, model: AiResponseModel, t: Translation) {
  const noItems = t.t('widget.ai-response.noItems');
  const waiting = t.t('widget.ai-response.waiting');
  const reviews = model.threads.filter(row => row.type === 'review' && row.rating !== null);
  const mean = reviews.length ? Math.round(reviews.reduce((sum, row) => sum + row.rating!, 0) * 10 / reviews.length) / 10 : null;
  const today = model.threads.filter(row => row.type !== 'review' && row.receivedAt.slice(0, 10) === dayOf(snapshot));
  const completed = model.threads.filter(row => !row.waiting && row.type !== 'review')
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const oldest = [...model.priority].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))[0];
  const channels = new Map(model.byChannel.map(row => [row.channelKey, row.count]));
  for (const channel of ['data.channel.kakao', 'data.channel.naverTalk', 'data.channel.naverReview']) {
    if (!channels.has(channel)) channels.set(channel, 0);
  }
  const speakers = [...channels].map(([channel, total]) => `${t.t(channel)} ${count(t, total)}`);
  const rules = new Map<string, string[]>();
  for (const rule of model.autoReply) {
    const label = join(t.t(rule.channelKey), t.t(rule.enabled ? 'widget.ai-response.autoOn' : 'widget.ai-response.autoOff'));
    rules.set(label, [...(rules.get(label) ?? []), t.t(rule.topicKey)]);
  }
  const auto = [...rules].map(([label, topics]) => join(label, topics.join(', '))).join('\n') || noItems;
  return [
    fact(replyKey('missing.waiting'), waiting, noItems),
    fact(replyKey('waiting.count'), waiting, model.waitingCount, count(t, model.waitingCount)),
    fact(replyKey('waiting.message'), t.t('data.fact.inquiry.waiting.message'), model.byType.message, count(t, model.byType.message)),
    fact(replyKey('waiting.review'), t.t('data.fact.inquiry.waiting.review'), model.byType.review, count(t, model.byType.review)),
    fact(replyKey('waiting.call'), t.t('data.fact.inquiry.waiting.call'), model.byType.call, count(t, model.byType.call)),
    fact(replyKey('waiting.channel'), waiting, speakers.join(' · ') || count(t, 0)),
    fact(replyKey('priority'), t.t('widget.ai-response.recent'), model.priority.slice(0, 4).map(row => join(threadName(t, row), quote(original(t, row)))).join('\n') || noItems),
    fact(replyKey('praise'), t.t('widget.ai-response.tabReviews'), model.praiseCount, t.t('widget.ai-response.praise', { n: model.praiseCount })),
    fact(replyKey('rating'), local(t, '평균 별점', 'Average rating', '平均评分', '平均評分'), mean ?? noItems,
      mean === null ? noItems : join(t.t('widget.ai-response.rating', { n: mean }), count(t, reviews.length))),
    fact(replyKey('completed'), t.t('widget.ai-response.statusDone'), completed.slice(0, 3).map(row => {
      const sent = maskContact(threadDraft(t, row));
      return join(threadName(t, row), join(t.t('widget.ai-response.original'), quote(original(t, row))),
        sent && join(t.t('widget.ai-response.sentHeading'), quote(sent)));
    }).join('\n') || noItems),
    fact(replyKey('autoReply'), t.t('widget.ai-response.autoTitle'), auto),
    fact(replyKey('today'), local(t, '오늘 받은 문의', 'Inquiries today', '今日收到的询问', '今日收到的詢問'), today.length,
      join(count(t, today.length), ...today.slice(0, 5).map(row => received(t, row, snapshot)))),
    fact(replyKey('oldest'), local(t, '가장 오래 기다린 문의', 'Longest-waiting inquiry', '等待最久的询问', '等待最久的詢問'),
      oldest ? join(threadName(t, oldest), received(t, oldest, snapshot), quote(original(t, oldest))) : noItems),
    ...model.threads.flatMap(row => {
      const stored = threadRecord(snapshot, row.threadId)?.replyDraft;
      const basis = stored?.grounding ?? row.groundKeys.map(key => t.t(key));
      const draft = threadDraft(t, row);
      const origin = stored?.origin === 'edited' ? local(t, '수정한 초안', 'Edited draft', '已编辑草稿', '已編輯草稿')
        : stored?.origin === 'generated' ? local(t, '생성한 초안', 'Generated draft', '已生成草稿', '已產生草稿') : undefined;
      return [
        fact(threadKey(snapshot, row), threadName(t, row), join(received(t, row, snapshot),
          t.t(row.isPublic ? 'widget.ai-response.public' : 'widget.ai-response.private'),
          t.t(row.waiting ? row.draft ? 'widget.ai-response.statusDraft' : 'widget.ai-response.waiting' : 'widget.ai-response.statusDone'),
          row.sentiment && t.t(`widget.ai-response.${row.sentiment}`), row.needsPersonKey && t.t(row.needsPersonKey), quote(original(t, row)))),
        fact(`${threadKey(snapshot, row)}.draft`, replyLabel(t, row), draft ? join(origin, quote(maskContact(draft)), ...basis.map(maskContact)) : noItems),
      ];
    }),
  ];
}

function offerFacts(snapshot: DataSnapshot, model: CommunityModel, t: Translation) {
  const open = activeOffers(model.pending, snapshot);
  const publicOffers = activeOffers(model.publicOffers, snapshot);
  const expired = [...model.received, ...model.publicOffers].filter(row => offerStatus(row, snapshot) === 'expired');
  return [
    fact(offerKey('pending.count'), t.t('widget.community.pendingOffers'), open.length, count(t, open.length)),
    fact(offerKey('public'), t.t('widget.community.tabBrowse'), publicOffers.slice(0, 4).map(row =>
      join(offerName(t, row), t.format.dateRange(row.period.start, row.period.end))).join('\n') || t.t('widget.community.noPublic')),
    fact(offerKey('accepted'), t.t('widget.community.accepted'), model.inProgress.length,
      join(count(t, model.inProgress.length), ...model.inProgress.slice(0, 4).map(row => offerName(t, row)))),
    fact(offerKey('expired'), t.t('widget.community.expired'), expired.slice(0, 4).map(row =>
      join(offerName(t, row), t.format.dateTime(row.respondBy))).join('\n') || t.t('widget.community.noReceived')),
    ...[...model.received, ...model.publicOffers].flatMap(row => [
      fact(communityKey(snapshot, row), offerName(t, row), join(t.t(row.categoryKey), offerStatusText(row, snapshot, t), t.format.dateTime(row.respondBy))),
      fact(`${communityKey(snapshot, row)}.terms`, offerName(t, row), join(t.t(row.termsKey), t.format.dateRange(row.period.start, row.period.end))),
      fact(`${communityKey(snapshot, row)}.interest`, offerName(t, row), row.interestSent ? t.t('data.notice.interestSent') :
        local(t, '아직 보내지 않았어요', 'Interest has not been sent yet.', '尚未发送意向', '尚未傳送意向')),
      ...(row.status === 'accepted' && row.sharedContactKey
        ? [fact(`${communityKey(snapshot, row)}.contact`, offerName(t, row), maskContact(t.t(row.sharedContactKey)))] : []),
    ]),
  ];
}

function projectWidget(snapshot: DataSnapshot, feature: FeatureId, condition: QueryCondition, locale: Locale) {
  if (feature !== replies && feature !== community) return;
  if (condition.kind !== 'default') return { status: 'unsupported_period' as const };
  const t = tr(locale);
  if (feature === replies) {
    const view = replyModel(snapshot);
    return view.status === 'ready' && view.model.connected
      ? { facts: threadFacts(snapshot, view.model, t) } : { status: 'unavailable' as const };
  }
  const view = offerModel(snapshot);
  return view.status === 'ready' ? { facts: offerFacts(snapshot, view.model, t) } : { status: 'unavailable' as const };
}

const replyWords = /문의|메시지|리뷰|후기|댓글|답변|답장|답글|자동\s*응답|질문|초안|카톡|카카오톡|톡톡|별점|평점|응대|\b(?:inquiries|message|review|reply|rating)\b/iu;
const offerWords = /커뮤니티|공동.?구매|공구|책마루|스탬프|교차\s*적립|제안|제휴|협업|둘러보기|\b(?:offer|partnership|community)\b/iu;
const openWords = /열어|띄워|보여\s*(?:줘|주세요)|\b(?:open|show)\b/iu;
const draftWords = /초안|답글|답변|답장|\bdraft\b/iu;
const generationWords = /만들|답글\s*초안$|초안\s*$|써\s*(?:줘|주세요)|새로|다시|초안\s*좀|초안\s*부탁|뭐라고\s*답하지|\b(?:draft|write|generate)\b/iu;
const changeWords = /바[꿔꾸]|고쳐|수정|\b(?:edit|revise)\b/iu;
const sendWords = /(?:보내(?!지\s*마)|전송|발송|게시|올려|등록해|달아\s*줘)|\b(?:send|post|publish)\b/iu;
const praiseWords = /칭찬|좋은\s*리뷰|\bpraise\b/iu;
const reviewWords = /리뷰|후기|댓글|답글|별점|평점|\breview\b/iu;
const publicWords = /공개\s*제안|둘러보기|다른\s*가게(?:들)?(?:이\s*올린)?\s*제안|\b(?:browse|public offers)\b/iu;
const declineWords = /거절(?:해|할|하자|하기)|안\s*하는\s*걸로\s*답해|\bdecline\b/iu;
const acceptWords = /수락(?:해|할|하자|하기|\s*처리|\s*한\s*번|$)|받을게|받아\s*줘|\baccept\b/iu;
const interestWords = /관심\s*(?:있다고\s*)?(?:보내(?![지셨])|표시(?:해|할))|\bshow interest\b/iu;
const separateSms = /테스트\s*(?:문자|발송|sms)|\btest (?:sms|message)\b/iu;
const noMutation = /하지\s*마|말아\s*줘|보내지\s*마|(?:발송|게시|전송|수락|거절|관심).{0,5}취소|(?:자동|예약)\s*(?:으로\s*)?(?:발송|전송|보내)|\b(?:do not|don't|automatically)\b/iu;
const withoutQuoted = (text: string) => text.replace(/"[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’/gu, ' ');
const quoteText = (text: string) => text.match(/"([^"]*)"|“([^”]*)”|'([^']*)'|‘([^’]*)’/u)?.slice(1).find(value => value !== undefined)
  ?? text.match(/[:：]\s*(.+)$/su)?.[1];

const threadTopics: readonly [string, RegExp][] = [
  ['parking', /주차|\bparking\b/iu],
  ['hours', /일요일|영업시간|\bsunday\b/iu],
  ['refund', /환불|원두.{0,7}시[다어]|시다는\s*원두|\brefund\b/iu],
  ['location', /위치|지하철역|길\s*안내|역에서|\bdirections\b/iu],
];
const offerTopics: readonly [string, RegExp][] = [
  ['cup', /포장\s*용기|컵\s*(?:공동|제안)/u],
  ['bean', /원두.{0,9}(?:공동|공구|건|제안|연락)|(?:빵집.{0,7})원두|원두\s*같이/u],
  ['stamp', /스탬프|(?:동네\s*)?책방|책마루/u],
  ['flowers', /꽃집|꽃작업실|공동\s*할인|꽃다발/u],
  ['bakery', /빵집/u],
];

function threadQuery(text: string, rows: readonly InquiryThread[]) {
  const authored = rows.find(row => row.author && !row.author.includes('*') && text.includes(row.author));
  if (authored) return `id:${authored.threadId}`;
  const topic = threadTopics.find(([, pattern]) => pattern.test(text))?.[0];
  if (topic) return topic;
  if (/직접\s*확인|사람이\s*봐/u.test(text)) return 'needs-person';
  if (/새\s*문의|방금\s*온|새로\s*온/u.test(text)) return /카톡|카카오톡/u.test(text) ? 'latest-kakao' : 'latest';
  if (reviewWords.test(text)) {
    const stars = text.match(/([1-5])\s*점/u)?.[1];
    if (stars) return `review:${stars}`;
    if (/별점\s*낮/u.test(text)) return 'review:negative';
    if (/자리\s*없/u.test(text)) return 'review:seat';
    if (/리뷰\s*대기/u.test(text)) return 'review:negative';
    return praiseWords.test(text) ? 'review:praise' : 'review:waiting';
  }
  if (/톡톡/u.test(text)) return 'talk';
  if (/카톡|카카오톡/u.test(text)) return 'kakao';
  if (/메시지|답장|문의/u.test(text) && /대기|남/u.test(text)) return 'message';
  if (/급한|먼저|우선순위/u.test(text)) return 'priority';
  return 'waiting';
}

function threadRows(snapshot: DataSnapshot, query: string, forCommand = false): readonly ThreadRow[] {
  const view = replyModel(snapshot);
  if (view.status !== 'ready' || !view.model.connected) return [];
  const { threads, priority } = view.model;
  const ko = tr('ko');
  const available = forCommand ? threads.filter(row => row.waiting && row.type !== 'call') : threads;
  if (query.startsWith('id:')) return available.filter(row => row.threadId === query.slice(3));
  if (query === 'priority') return priority.slice(0, 1);
  if (query === 'waiting') return available.filter(row => row.waiting);
  if (query === 'message') return available.filter(row => row.waiting && row.type === 'message');
  if (query === 'kakao' || query === 'talk') {
    return available.filter(row => row.waiting && row.channelKey === (query === 'kakao' ? 'data.channel.kakao' : 'data.channel.naverTalk'));
  }
  if (query === 'needs-person') return available.filter(row => row.waiting && row.needsPersonReason);
  if (query.startsWith('latest')) return [...available].filter(row => row.type !== 'review' && (query === 'latest' || row.channelKey === 'data.channel.kakao'))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 1);
  if (query.startsWith('review:')) {
    const filter = query.slice(7);
    return available.filter(row => row.type === 'review' && (
      filter === 'praise' ? row.sentiment === 'positive' : !row.waiting ? false
        : filter === 'waiting' ? true : filter === 'negative' ? row.sentiment === 'negative'
          : filter === 'seat' ? /자리|좌석/u.test(original(ko, row)) : row.rating === Number(filter)));
  }
  const pattern = threadTopics.find(([label]) => label === query)?.[1];
  return pattern ? available.filter(row => row.type === 'message' &&
    (pattern.test(original(ko, row)) || query === 'hours' && /(?:일요일|주말).{0,12}(?:문|영업|열)/u.test(original(ko, row)))) : [];
}

function offerRows(snapshot: DataSnapshot, query: string): readonly OfferRow[] {
  const view = offerModel(snapshot);
  if (view.status !== 'ready') return [];
  const available = [...view.model.received, ...view.model.publicOffers];
  if (query === 'priority') return activeOffers(view.model.pending, snapshot).slice(0, 1);
  if (query === 'accepted') return view.model.inProgress;
  if (query.startsWith('id:')) return available.filter(row => row.offerId === query.slice(3));
  const ko = tr('ko');
  const pattern = offerTopics.find(([label]) => label === query)?.[1];
  if (query === 'public') return activeOffers(view.model.publicOffers, snapshot);
  if (query === 'direct') return activeOffers(view.model.pending, snapshot);
  return pattern ? available.filter(row => pattern.test(offerName(ko, row))) : [];
}

function offerQuery(text: string, snapshot: DataSnapshot) {
  const view = offerModel(snapshot);
  if (view.status === 'ready') {
    const t = tr('ko');
    const name = normalizeNavisName(text);
    const all = [...view.model.received, ...view.model.publicOffers];
    const exactTitle = all.find(row => name.includes(normalizeNavisName(t.t(row.titleKey))));
    if (exactTitle) return `id:${exactTitle.offerId}`;
    const stores = all.filter(row => name.includes(normalizeNavisName(t.t(row.fromStoreKey))));
    if (stores.length === 1) return `id:${stores[0].offerId}`;
  }
  return offerTopics.find(([, pattern]) => pattern.test(text))?.[0]
    ?? (/연락|수락한/u.test(text) ? 'accepted' : /급한|기한\s*빠른/u.test(text) ? 'priority' : publicWords.test(text) || /관심/u.test(text) ? 'public' : 'direct');
}

function threadSearchRows({ snapshot, query, command }: RecordSearch) {
  return threadRows(snapshot, query, Boolean(command)).slice(0, 6);
}
const handle = (kind: 'thread' | 'offer', index: number) => `n17-${kind}-${index + 1}`;
const threadReader: RecordAdapter = {
  kind: 'thread',
  search(input) {
    const t = tr(input.locale);
    return threadSearchRows(input).map((row, index): AgentRecordMatch => {
      const stored = threadRecord(input.snapshot, row.threadId);
      return { handle: handle('thread', index), match: 'exact',
        ...(!input.privateLookup && { label: join(threadName(t, row), original(t, row)).slice(0, 180) }),
        fields: { type: row.type, isPublic: row.isPublic, connected: true, hasDraft: Boolean(row.draft),
          canDraft: row.waiting && row.type !== 'call', canSend: row.waiting && row.type !== 'call' && !row.needsPersonReason && Boolean(row.draft),
          status: row.status === 'draft-ready' || row.status === 'send-failed' ? 'draft_ready' : row.status,
          revision: stored?.replyDraft?.revision ?? 1 } };
    });
  },
  resolve(input, ref) {
    return threadSearchRows(input).find((_, index) => handle('thread', index) === ref)?.threadId;
  },
};
const offerSearchRows = (input: RecordSearch) => offerRows(input.snapshot, input.query).slice(0, 6);
const offerReader: RecordAdapter = {
  kind: 'offer',
  search(input) {
    const t = tr(input.locale);
    return offerSearchRows(input).map((row, index): AgentRecordMatch => {
      const status = offerStatus(row, input.snapshot);
      return { handle: handle('offer', index), match: 'exact', ...(!input.privateLookup && { label: offerName(t, row).slice(0, 180) }),
        fields: { visibility: row.visibility, status, eligible: status === 'pending', interestSent: row.interestSent } };
    });
  },
  resolve(input, ref) {
    return offerSearchRows(input).find((_, index) => handle('offer', index) === ref)?.offerId;
  },
};

function read(featureId: typeof replies | typeof community, ...factKeys: string[]): DomainTurnInput {
  return { intent: { kind: 'read', featureId, condition: defaultCondition }, factKeys };
}
function noRows(t: Translation, featureId: typeof replies | typeof community): DomainRoute {
  return { kind: 'answer', answer: t.t(featureId === replies ? 'widget.ai-response.noItems' : 'widget.community.noReceived') };
}
function chooseOffer(rows: readonly OfferRow[], snapshot: DataSnapshot, t: Translation): DomainRoute {
  const candidates = rows.slice(0, 6);
  return { kind: 'clarification', field: 'offerId', answer: t.t('common.navis.agent.chooseRecord'),
    choices: candidates.map((row, index) => ({ id: handle('offer', index), label: offerName(t, row) })),
    resume: id => {
      const row = candidates.find((_, index) => handle('offer', index) === id);
      return row && read(community, communityKey(snapshot, row), `${communityKey(snapshot, row)}.terms`);
    } };
}

type ThreadAction = 'reply.draft' | 'inquiry.saveDraft' | 'inquiry.send' | 'inquiry.post';
type OfferAction = 'community.accept' | 'community.decline' | 'community.sendInterest';
const bodySlot = (value: unknown): value is string => typeof value === 'string' && value.length <= 1000 && Boolean(value.trim());
const revisionSlot = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const slot = (name: string) => ({ slot: name });

function proposeThread(command: ThreadAction, query: string, t: Translation, body?: string, revision?: number): DomainTurnInput {
  return { intent: { kind: 'command', command, args: { ...(body !== undefined && { body: slot('body') }), ...(revision !== undefined && { revision: slot('revision') }) } },
    slots: { threadId: query, navisLocale: t.locale, ...(body !== undefined && { body }), ...(revision !== undefined && { revision }) },
    lookups: [{ kind: 'thread', querySlot: 'threadId', bind: ['threadId'] }] };
}
function proposeOffer(command: OfferAction, query: string, t: Translation): DomainTurnInput {
  return { intent: { kind: 'command', command, args: {} },
    slots: { offerId: query, navisLocale: t.locale }, lookups: [{ kind: 'offer', querySlot: 'offerId', bind: ['offerId'] }] };
}
const exact = (id: string) => `id:${id}`;

function replyWrite(text: string, raw: string, snapshot: DataSnapshot, t: Translation): DomainRoute | undefined {
  if (separateSms.test(text) || noMutation.test(text)) {
    return { kind: 'refusal', reason: 'widget_only', answer: t.t('widget.ai-response.confirmOnly'), alternative: { featureId: replies } };
  }
  const edit = changeWords.test(text) && draftWords.test(text);
  const generate = draftWords.test(text) && generationWords.test(text) && !/열어|필터|초안\s*[?？]|읽어|뭐라고\s*돼|써\s*둔/u.test(text);
  const send = sendWords.test(text) && (draftWords.test(text) || reviewWords.test(text)) && !/(?:어떻게|방법|보냈|보낸|보내기\s*전|쿠폰|공지)/u.test(text);
  if (!edit && !generate && !send) return;
  const baseQuery = threadQuery(text, snapshot.tables.inquiryThread);
  const query = send && baseQuery === 'waiting' ? 'message' : baseQuery;
  if (send && /전화|통화/u.test(text) && !/메시지|리뷰|카톡|톡톡/u.test(text)) {
    return { kind: 'refusal', reason: 'widget_only', alternative: { featureId: replies } };
  }
  const rows = threadRows(snapshot, query, true);
  if (!rows.length) return query === 'review:praise' ? read(replies, replyKey('praise'))
    : read(replies, replyKey('missing.waiting'));
  if (!edit && !send) return proposeThread('reply.draft', query, t);
  function continueWith(row: ThreadRow, customBody?: string): DomainRoute {
    const thread = threadRecord(snapshot, row.threadId);
    if (!thread) return noRows(t, replies);
    if (edit) {
      if (!bodySlot(customBody)) return { kind: 'clarification', field: 'body', answer: t.t('widget.ai-response.writeReply'),
        resume: value => continueWith(row, value) };
      return proposeThread('inquiry.saveDraft', exact(row.threadId), t, customBody, inquiryDraftRevision(thread));
    }
    const command = row.type === 'review' ? 'inquiry.post' : 'inquiry.send';
    const body = customBody ?? storedInquiryReply(thread);
    const check = bodySlot(body) ? checkInquiryReply(snapshot.tables, { type: command, threadId: row.threadId, body, idempotencyKey: 'preflight' }) : undefined;
    if (!bodySlot(body) || !check?.ok) {
      return { kind: 'refusal', reason: 'widget_only', answer: t.t('widget.ai-response.writeReply'),
        alternative: { featureId: replies, command, draft: { threadId: row.threadId, view: row.type === 'review' ? 'review' : 'message' } } };
    }
    return proposeThread(command, exact(row.threadId), t, body);
  }
  if (rows.length === 1) return continueWith(rows[0], quoteText(raw));
  if (send && quoteText(raw) === undefined && rows.every(row => !row.draft)) {
    return { kind: 'refusal', reason: 'widget_only', answer: t.t('widget.ai-response.writeReply'), alternative: { featureId: replies } };
  }
  const choices = rows.slice(0, 6);
  return { kind: 'clarification', field: 'threadId', answer: t.t('widget.ai-response.pickItem'),
    choices: choices.map((row, index) => ({ id: handle('thread', index), label: join(threadName(t, row), original(t, row)).slice(0, 180) })),
    resume: id => {
      const row = choices.find((_, index) => handle('thread', index) === id);
      return row && continueWith(row, quoteText(raw));
    } };
}

function replyRead(text: string, snapshot: DataSnapshot, t: Translation): DomainRoute {
  const facts = (...keys: string[]) => read(replies, ...keys.map(replyKey));
  if (/채널별|카톡이랑|카카오톡\s*쪽|\bby channel\b/iu.test(text)) return facts('waiting.channel');
  if (/뭐부터|급한\s*문의|먼저\s*볼/u.test(text)) return facts('priority');
  if (/오래\s*(?:기다린|묵은)|오래된\s*대기/u.test(text)) return facts('oldest');
  if (/별점\s*평균|평점\s*평균|\baverage rating\b/iu.test(text)) return facts('rating');
  if (praiseWords.test(text) && !draftWords.test(text)) return facts('praise');
  if (/답변해\s*준|답\s*끝낸|이미\s*답한|보낸\s*답변/u.test(text)) return facts('completed', 'praise');
  if (/자동\s*(?:응답|답변|답장)/u.test(text)) return facts('autoReply');
  if (/오늘/u.test(text) && /들어온|받은|오늘\s*온/u.test(text)) return facts('today');
  const query = threadQuery(text, snapshot.tables.inquiryThread);
  if (/몇\s*(?:건|개)|갯수|건수|대기\s*수/u.test(text)) {
    if (reviewWords.test(text)) return facts('waiting.review');
    if (/전화|통화/u.test(text)) return facts('waiting.call');
    if (/메시지/u.test(text)) return facts('waiting.message');
    return facts('waiting.count');
  }
  if (query !== 'waiting') {
    const rows = threadRows(snapshot, query);
    if (rows.length) {
      const key = draftWords.test(text) && !/리뷰\s*대기|내용도/u.test(text) && !query.startsWith('review:') ? '.draft' : '';
      return read(replies, ...rows.slice(0, 4).map(row => threadKey(snapshot, row) + key));
    }
    return noRows(t, replies);
  }
  return facts('waiting.count', 'waiting.message', 'waiting.review');
}

function communityRoute(text: string, snapshot: DataSnapshot, t: Translation): DomainRoute {
  const query = offerQuery(text, snapshot);
  const rows = offerRows(snapshot, query);
  const type = interestWords.test(text) && !/보냈|보낸|했었|했나/u.test(text) ? 'community.sendInterest'
    : declineWords.test(text) ? 'community.decline' : acceptWords.test(text) ? 'community.accept' : undefined;
  const facts = (...keys: string[]) => read(community, ...keys.map(offerKey));
  if (type) {
    if (noMutation.test(text)) return noRows(t, community);
    if (!rows.length) return noRows(t, community);
    if (rows.length > 1) return proposeOffer(type, query, t);
    const row = rows[0];
    const check = checkCommunityResponse(snapshot, { type, offerId: row.offerId });
    if (!check.ok) return { kind: 'answer', answer: t.has(check.messageKey) ? t.t(check.messageKey) : offerStatusText(row, snapshot, t) };
    return proposeOffer(type, query, t);
  }
  if (/기한\s*지난|놓친|지난\s*제안/u.test(text)) return facts('expired');
  if (/연락/u.test(text)) {
    const accepted = rows.filter(row => row.status === 'accepted' && row.sharedContactKey);
    return accepted.length ? read(community, ...accepted.map(row => `${communityKey(snapshot, row)}.contact`)) : facts('accepted');
  }
  if (/수락한|진행\s*중|하고\s*있는/u.test(text)) return facts('accepted');
  if (/관심/u.test(text)) return rows.length ? read(community, ...rows.slice(0, 4).map(row => `${communityKey(snapshot, row)}.interest`)) : noRows(t, community);
  if (query === 'public') return facts('public');
  if (query === 'direct' && /몇|건수|남았|전체/u.test(text)) return facts('pending.count');
  if (rows.length > 1 && openWords.test(text) && !/조건|내용/u.test(text)) return chooseOffer(rows, snapshot, t);
  if (!rows.length) return noRows(t, community);
  const terms = /조건|내용|기간|언제까지|깎|뭐야/u.test(text);
  return read(community, ...rows.slice(0, 4).map(row => communityKey(snapshot, row) + (terms ? '.terms' : '')));
}

function route(raw: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const text = withoutQuoted(normalizeNavisInput(raw));
  // Calendar owns attempts to add an automatic response deadline.
  if (/기한/u.test(text) && /캘린더|달력|일정/u.test(text) && /넣어|추가|등록|적어/u.test(text)) return;
  const t = tr(locale);
  const commonOfferWords = /빵집|책방|꽃집|책마루|수락한\s*가게/u.test(text) && /관심|연락|수락|거절|보낸|받을게|답해/u.test(text);
  if ((offerWords.test(text) || /빵집\s*거/u.test(text) || commonOfferWords || /관심\s*(?:표시|보낸|보내)|원두\s*같이/u.test(text)) && !/청구|채용|공급사|지원금|거래처|예약|쿠폰|위젯|패널|^제안카드/u.test(text)) {
    return communityRoute(text, snapshot, t);
  }
  if (!replyWords.test(text) && !/뭐부터\s*답|먼저\s*볼\s*거|사람이\s*봐|답\s*끝낸|이미\s*답한|우선순위|채널별|오래된\s*대기/u.test(text)) return;
  if (/쿠폰|공지|메뉴|위젯|패널|급여|공급사|영상|예약.{0,5}문자|회의록/u.test(text) && !reviewWords.test(text) && !/문의/u.test(text)) return;
  if (noMutation.test(text) && !separateSms.test(text) && !/[?？]|있어|돼\s*있/u.test(text)) return { kind: 'answer', answer: t.t('common.navis.agent.cancelled'), cancelPending: true };
  if (/인스타|당근/u.test(text) && generationWords.test(text)) {
    return { kind: 'answer', answer: local(t, '이 채널에서 저장할 응대 초안이 없어요', 'Drafts are unavailable for this channel.',
      '此渠道没有可保存的回复草稿', '此管道沒有可儲存的回覆草稿') };
  }
  if (praiseWords.test(text) && draftWords.test(text)) return read(replies, replyKey('praise'));
  const view = replyModel(snapshot);
  if (view.status !== 'ready' || !view.model.connected) return read(replies, replyKey('waiting.count'));
  return replyWrite(text, raw, snapshot, t) ?? replyRead(text, snapshot, t);
}

function navigation(raw: string, snapshot: DataSnapshot): DomainDetail | null | undefined {
  const text = withoutQuoted(normalizeNavisInput(raw));
  if (noMutation.test(text) || /위젯|패널/u.test(text) && !/탭/u.test(text)) return;
  if (/^(?:메시지[·ㆍ\s]*리뷰|리뷰)\s*응대\s*(?:열어|보여|띄워)/u.test(text) && !/탭/u.test(text)) return { args: { featureId: replies } };
  if (/^커뮤니티\s*(?:열어|보여|띄워)/u.test(text)) return { args: { featureId: community } };
  if (/^(?:받은\s*제안|제안)\s*(?:목록|화면)/u.test(text) && openWords.test(text)) return { args: { featureId: community, view: 'received' } };
  if (offerWords.test(text) || /빵집\s*원두|빵집\s*거/u.test(text)) {
    if (publicWords.test(text) && (openWords.test(text) || /탭|구경/u.test(text))) return { args: { featureId: community, view: 'browse' } };
    if (!openWords.test(text) || /조건|내용|기간|관심|수락|거절/u.test(text)) return null;
    const query = offerQuery(text, snapshot);
    const rows = offerRows(snapshot, query);
    if (rows.length !== 1) return null;
    const row = rows[0];
    return { args: { featureId: community, view: row.visibility === 'public' ? 'browse' : 'received', itemId: row.offerId }, target: { kind: 'offer', id: row.offerId }, querySlot: 'offerId' };
  }
  if (!replyWords.test(text) && !/주차\s*물어본/u.test(text)) return;
  if (/쿠폰|공지|메뉴|공급사|영상/u.test(text) && !/답장|답글|문의|응대/u.test(text)) return;
  if (/답변\s*확인(?:하러|하기|\s*화면)/u.test(text)) return { args: { featureId: replies, focus: 'action' } };
  if (praiseWords.test(text) && /필터|만\s*(?:보여|모아서)/u.test(text) || /좋은\s*리뷰만/u.test(text)) {
    return { args: { featureId: replies, view: 'review', filter: 'praise' } };
  }
  if (reviewWords.test(text) && /탭|응대\s*화면|답글\s*(?:쓰는\s*데|창)|응대에서\s*리뷰/u.test(text) && !sendWords.test(text)) {
    return { args: { featureId: replies, view: 'review' } };
  }
  if (/뭐라고|읽어|내용|갯수|몇\s*(?:건|개)|평균|조건/u.test(text)) return null;
  const show = openWords.test(text) || /(?:후기|리뷰)\s*보여/u.test(text);
  if (!show || sendWords.test(text) || generationWords.test(text) || /직접\s*확인|답\s*끝낸/u.test(text)) return null;
  const query = threadQuery(text, snapshot.tables.inquiryThread);
  if (query === 'waiting' && !/주차|환불|급한/u.test(text)) return;
  const rows = threadRows(snapshot, query);
  if (rows.length !== 1) return null;
  const row = rows[0];
  const prefill = /(?:폼|양식|편집\s*화면)/u.test(text) ? quoteText(raw) : undefined;
  return { args: { featureId: replies, view: row.type === 'review' ? 'review' : 'message', itemId: row.threadId, focus: 'action',
    ...(bodySlot(prefill) && { prefill: { body: prefill } }) }, target: { kind: 'thread', id: row.threadId }, querySlot: 'threadId' };
}

function readArgs(wire: unknown, slots: LocalSlots, targets: RecordTargets) {
  const args = wire as Record<string, { handle?: string; slot?: string }>;
  const target = (value: { handle?: string } | undefined, kind: 'thread' | 'offer') => {
    const row = value?.handle && targets.get(value.handle);
    return row && row.kind === kind ? row.id : undefined;
  };
  return { threadId: target(args.threadId, 'thread'), offerId: target(args.offerId, 'offer'),
    body: args.body?.slot ? slots[args.body.slot] : undefined, revision: args.revision?.slot ? slots[args.revision.slot] : undefined };
}

type ReplyCommand = Extract<DataCommand, { type: ThreadAction | OfferAction }>;
type PreviewField = { readonly label: string; readonly before: string; readonly after: string };
const field = (label: string, after: string, before = after): PreviewField =>
  ({ label, before: before.trim() ? before.slice(0, 1000) : '—', after: after.trim() ? after.slice(0, 1000) : '—' });
const reject = (result: { code: string; messageKey: string; field?: string; reason?: string }) => ({
  kind: result.reason === 'TRANSACTION_BUSY' ? 'busy' as const : result.code === 'NOT_FOUND' ? 'conflict' as const : 'invalid' as const,
  messageKey: result.messageKey, field: result.field,
});
function planAdapter(command: ThreadAction | OfferAction): RunCommandAdapter<{ command: ReplyCommand; locale: Locale }> {
  return {
    command, slots: { body: bodySlot, revision: revisionSlot },
    resolve(wire, slots, _snapshot, targets) {
      if (!validateAgentDraft(command, wire)) return;
      const { threadId, offerId, body, revision } = readArgs(wire, slots, targets);
      const locale = slots.navisLocale === 'en' || slots.navisLocale === 'zh-Hans' || slots.navisLocale === 'zh-Hant' ? slots.navisLocale : 'ko';
      if (command === 'community.accept' || command === 'community.decline' || command === 'community.sendInterest') {
        return offerId ? { command: { type: command, offerId }, locale } : undefined;
      }
      if (!threadId) return;
      if (command === 'reply.draft') return { command: { type: command, threadId, idempotencyKey: '' }, locale };
      if (!bodySlot(body)) return;
      if (command === 'inquiry.saveDraft') {
        return revisionSlot(revision) ? { command: { type: command, threadId, body, revision, idempotencyKey: '' }, locale } : undefined;
      }
      return { command: { type: command, threadId, body, idempotencyKey: '' }, locale };
    },
    preflight({ command: input, locale }, { snapshot, idempotencyKey }) {
      const command = { ...input, idempotencyKey, baseRevision: snapshot.revision };
      const t = tr(locale);
      const featureId = 'threadId' in command ? replies : community;
      let title: string;
      let target: string;
      let fields: PreviewField[];
      if (command.type === 'reply.draft' || command.type === 'inquiry.saveDraft') {
        const checked = planInquiryDraft(snapshot.tables, command);
        if (!checked.ok) return reject(checked);
        const review = checked.thread.type === 'review';
        title = command.type === 'reply.draft' ? t.t(review ? 'widget.ai-response.generateReview' : 'widget.ai-response.generateMessage')
          : local(t, '응대 초안 저장', 'Save reply draft', '保存回复草稿', '儲存回覆草稿');
        target = join(t.t(checked.thread.channelKey), quote(maskContact(checked.draft.sourceText))).slice(0, 1000);
        const prev = storedInquiryReply(checked.thread);
        fields = [
          field(t.t('widget.ai-response.tabLabel'), t.t(checked.thread.channelKey)),
          field(t.t('widget.ai-response.original'), quote(maskContact(checked.draft.sourceText))),
          field(t.t(review ? 'widget.ai-response.reviewDraft' : 'widget.ai-response.draft'), checked.draft.body, prev ?? '—'),
          ...checked.draft.grounding.map(source => field(t.t('widget.ai-response.groundTitle'), source)),
        ];
      } else if (command.type === 'inquiry.send' || command.type === 'inquiry.post') {
        const checked = checkInquiryReply(snapshot.tables, command);
        if (!checked.ok) return reject(checked);
        target = join(t.t(checked.thread.channelKey), quote(maskContact(inquirySourceText(checked.thread)))).slice(0, 1000);
        title = command.type === 'inquiry.post'
          ? local(t, '리뷰 답글 게시', 'Post review reply', '发布评论回复', '發佈評論回覆')
          : local(t, '메시지 답변 보내기', 'Send message reply', '发送消息回复', '傳送訊息回覆');
        fields = [
          field(t.t('widget.ai-response.tabLabel'), join(t.t(checked.thread.channelKey), t.t(checked.thread.isPublic ? 'widget.ai-response.public' : 'widget.ai-response.private'))),
          field(t.t('widget.ai-response.original'), quote(maskContact(inquirySourceText(checked.thread)))),
          field(t.t('widget.ai-response.previewBody'), command.body ?? ''),
        ];
      } else {
        const checked = checkCommunityResponse(snapshot, command);
        if (!checked.ok) return reject(checked);
        const row = checked.offer;
        target = join(t.t(row.titleKey), t.t(row.fromStoreKey));
        title = t.t(command.type === 'community.accept' ? 'widget.community.accept'
          : command.type === 'community.decline' ? 'widget.community.decline' : 'common.showInterest');
        fields = [
          field(t.t('widget.community.title'), join(t.t(row.titleKey), t.t(row.fromStoreKey))),
          field(t.t('data.fact.community.offer'), t.format.dateTime(row.respondBy)),
          ...(command.type === 'community.accept' ? [field(t.t('widget.community.termsLabel'),
            local(t, '가게 연락 수단을 공유해요', 'Your shop contact method will be shared.', '将共享店铺联系方式', '將分享店鋪聯絡方式'))] : []),
        ];
      }
      return { kind: 'ready', preview: { title, target, fields }, execute(_run, store) {
        if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
        const result = store.dispatch(command);
        if (!result.ok) return reject(result);
        if (result.duplicate || !result.noticeKey || result.revision === snapshot.revision) return { kind: 'unchanged', messageKey: result.noticeKey };
        const { noticeKey, undoToken } = result;
        const undoable = command.type !== 'inquiry.send' && command.type !== 'inquiry.post';
        return { kind: 'applied', notice: { kind: 'success', featureId, messageKey: noticeKey },
          ...(undoable && undoToken && { undo: () => store.undo(undoToken).ok }) };
      } };
    },
  };
}

export function replyPrefill(ref: DetailRef) {
  if (ref.featureId !== replies || ref.prefill?.kind !== 'widget-draft') return;
  const { fields } = ref.prefill;
  if (validateAgentPrefill(replies, fields) && bodySlot(fields.body) && (!fields.threadId || fields.threadId === ref.itemId)) return fields.body;
}

export const repliesDomain: DomainAdapter = {
  featureIds: [replies, community],
  commands: [],
  runCommands: (['reply.draft', 'inquiry.saveDraft', 'inquiry.send', 'inquiry.post', 'community.accept', 'community.decline', 'community.sendInterest'] as const).map(planAdapter),
  reads: [threadReader, offerReader],
  projectWidget, route, navigation,
  routePresentation(text, snapshot, locale) {
    const wording = withoutQuoted(normalizeNavisInput(text));
    const explicitThread = /톡톡|카톡|카카오톡|주차.*초안|답변\s*초안|답장\s*초안|리뷰\s*답글|후기\s*댓글|문의\s*(?:답변|답장)|손님한테\s*뭐라고\s*답하지/u;
    const explicitOffer = /공동.?구매|공구|스탬프|교차\s*적립|수락한\s*가게|(?:빵집|책방|꽃집|연락\s*수단).*(?:제안|수락|안\s*하는|관심|답해)|할인\s*주간.*관심/u;
    if (explicitThread.test(wording) || explicitOffer.test(wording)) return route(text, snapshot, locale);
  },
  handoff(command, draft) {
    if (command === 'inquiry.send' || command === 'inquiry.post' || command === 'inquiry.saveDraft' || command === 'reply.draft') {
      return { featureId: replies, view: command === 'inquiry.post' || draft.view === 'review' ? 'review' : 'message', focus: 'action',
        ...(typeof draft.threadId === 'string' && { itemId: draft.threadId }),
        ...(bodySlot(draft.body) && { prefill: { kind: 'widget-draft', command, fields: { body: draft.body } } }) };
    }
    if (command === 'community.accept' || command === 'community.decline' || command === 'community.sendInterest') {
      return { featureId: community, view: command === 'community.sendInterest' ? 'browse' : 'received', focus: 'action',
        ...(typeof draft.offerId === 'string' && { itemId: draft.offerId }) };
    }
  },
};
