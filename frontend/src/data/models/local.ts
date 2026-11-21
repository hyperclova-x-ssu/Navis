import { selectShopGuidance } from '../iteration7/notices';
import { addDays, dateOf, inRange, NOW, TODAY, WEEK_END, WEEK_START } from '../db/time';
import type { AiResponseModel, CommunityModel, KeywordRow, LocalChangeRow, LocalChangesModel, LocalTrendsModel, OfferRow, ThreadRow, TradeAreaModel } from './types';
import { note, ready, round1, type Projector } from './util';

/* 동네 변화 알림 */
export const projectLocalChanges: Projector<'local-changes'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const changes: LocalChangeRow[] = t.localChange
    .filter((c) => inRange(c.startDate, WEEK_START, WEEK_END) || inRange(dateOf(c.updatedAt), WEEK_START, WEEK_END))
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.changeId.localeCompare(b.changeId))
    .map((c) => ({
      changeId: c.changeId, kind: c.kind, kindKey: `data.localChangeKind.${c.kind}`, titleKey: c.titleKey, whenKey: c.whenKey, startDate: c.startDate, endDate: c.endDate, distanceM: c.distanceM,
      sameCategory: c.sameCategory, sourceKey: c.sourceKey, updatedAt: c.updatedAt, acked: c.ackedAt !== null, ackedAt: c.ackedAt,
      inDemandForecast: (c.kind === 'event' || c.kind === 'construction') && t.demandDay.some((d) => d.eventKey === c.titleKey),
    }));
  const model: LocalChangesModel = { week: { start: WEEK_START, end: WEEK_END }, count: changes.length, changes, openChanges: changes.filter((c) => !c.acked), foldedCount: changes.filter((c) => c.acked).length, radiusM: 500 };
  return ready('local-changes', condition, variant, model);
};

/* 상권분석 */
export const projectTradeArea: Projector<'trade-area'> = (ctx, condition, variant) => {
  const hours = [...ctx.snapshot.tables.footTraffic].sort((a, b) => a.hour - b.hour).map((f) => ({ hour: f.hour, people: f.estPeople }));
  const ranked = [...hours].sort((a, b) => b.people - a.people || a.hour - b.hour);
  const model: TradeAreaModel = { regionKey: 'seed:서울 동작구 상도동', periodKey: 'data.period.last4Weeks', sourceKey: 'data.source.sample', updatedAt: NOW, peak: ranked[0], top: ranked.slice(0, 2), hours };
  return ready('trade-area', condition, variant, model);
};

/* 로컬 트렌드 */
export const projectLocalTrends: Projector<'local-trends'> = (ctx, condition, variant) => {
  const keywords: KeywordRow[] = ctx.snapshot.tables.trendKeyword.map((k) => {
    const changePercent = k.prevMentions ? round1(((k.mentions - k.prevMentions) / k.prevMentions) * 100) : null;
    return { keywordId: k.keywordId, keywordKey: k.keywordKey, categoryKey: k.categoryKey, mentions: k.mentions, previous: k.prevMentions, changePercent, notable: k.prevMentions !== null && k.mentions > k.prevMentions * 1.1, noComparison: k.prevMentions === null };
  });
  const notable = keywords.filter((k) => k.notable).sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0) || a.keywordId.localeCompare(b.keywordId));
  const model: LocalTrendsModel = {
    period: { start: addDays(TODAY, -6), end: TODAY }, previousPeriod: { start: addDays(TODAY, -13), end: addDays(TODAY, -7) }, regionKey: 'seed:서울 동작구 상도동', sourceKey: 'data.source.sample', updatedAt: NOW,
    notableCount: notable.length, notable, keywords,
  };
  return ready('local-trends', condition, variant, model);
};

/**
 * AC-318 reviewer masking (display rule, documented): keep the first character (first letter of the first word for Latin names)
 * and always add two asterisks, so the name length is not revealed: 김민수 -> 김**, Emma Johnson -> E**. Empty/absent -> null.
 */
export function maskAuthor(author: string | null | undefined): string | null {
  const first = Array.from((author ?? '').trim())[0];
  return first ? `${first}**` : null;
}

/* 메시지·리뷰 응대 */
export const projectAiResponse: Projector<'ai-response'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const threads: ThreadRow[] = t.inquiryThread.map((th) => ({
    threadId: th.threadId, type: th.type, channelKey: th.channelKey, isPublic: th.isPublic, receivedAt: th.receivedAt, status: th.status,
    needsPersonReason: th.needsPersonReason, needsPersonKey: th.needsPersonReason ? `data.needsPerson.${th.needsPersonReason}` : null,
    body: { key: th.bodyKey },
    // N17 saved copy takes precedence over the legacy seed label.
    draft: th.sentReplyBody !== undefined ? { raw: th.sentReplyBody } : th.replyDraft ? { raw: th.replyDraft.body } : th.draftKey ? { key: th.draftKey } : null,
    groundKeys: th.replyDraft ? th.replyDraft.grounding.map(line => `seed:${line}`) : th.groundKeys,
    // End N17 saved copy.
    rating: th.rating, waiting: th.status !== 'done', sentiment: th.sentiment, authorMasked: maskAuthor(th.author),
  }));
  const waiting = threads.filter((th) => th.waiting);
  const channels = [...new Set(waiting.map((th) => th.channelKey))];
  const model: AiResponseModel = {
    shopGuidance: selectShopGuidance(ctx.snapshot,{manuals:t.manual.filter(m=>m.section==='store-info' && m.isPublished).map(m=>({title:m.title,body:t.manualStep.find(s=>s.manualId===m.manualId)?.body ?? null}))}),
    waitingCount: waiting.length,
    byType: { message: waiting.filter((th) => th.type === 'message').length, review: waiting.filter((th) => th.type === 'review').length, call: waiting.filter((th) => th.type === 'call').length },
    byChannel: channels.map((channelKey) => ({ channelKey, count: waiting.filter((th) => th.channelKey === channelKey).length })),
    priority: [...waiting].sort((a, b) => Number(b.needsPersonReason !== null) - Number(a.needsPersonReason !== null) || a.receivedAt.localeCompare(b.receivedAt) || a.threadId.localeCompare(b.threadId)),
    threads,
    autoReply: t.autoReplyRule.map((r) => ({ channelKey: r.channelKey, topicKey: `data.storeInfoTopic.${r.topic}`, enabled: r.enabled })),
    connected: t.integration.channels,
    praiseCount: threads.filter((th) => th.type === 'review' && th.sentiment === 'positive').length,
  };
  return ready('ai-response', condition, variant, model, variant === 'send-failure' ? [note('ai-response', 'send-failure')] : undefined);
};

/* 커뮤니티 */
export const projectCommunity: Projector<'community'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const offers: OfferRow[] = [...t.partnershipOffer].sort((a, b) => a.respondBy.localeCompare(b.respondBy) || a.offerId.localeCompare(b.offerId)).map((o) => ({
    offerId: o.offerId, fromStoreKey: o.fromStoreKey, visibility: o.visibility, titleKey: o.titleKey, categoryKey: o.categoryKey, termsKey: o.termsKey, period: { start: o.periodStart, end: o.periodEnd },
    respondBy: o.respondBy, status: o.status, sharedContactKey: o.sharedContactKey, interestSent: t.offerInterest.some((i) => i.offerId === o.offerId),
  }));
  const pending = offers.filter((o) => o.visibility === 'direct' && o.status === 'pending');
  const model: CommunityModel = {
    pendingCount: pending.length, received: offers.filter((o) => o.visibility === 'direct'), pending,
    publicOffers: offers.filter((o) => o.visibility === 'public' && o.status === 'pending'), inProgress: offers.filter((o) => o.status === 'accepted'),
  };
  return ready('community', condition, variant, model);
};
