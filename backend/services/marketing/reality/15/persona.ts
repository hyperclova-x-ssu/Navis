import { randomUUID } from 'node:crypto';
import type { FakeNoticeProvider, Owner } from './ports.ts';
import { date, NoticeError } from './wire.ts';
import type { Audience, BusinessHours } from './wire.ts';

type Confirmed = { readBack: 'confirmed' | 'pending' };
type ReplyKey = { reviewRef: string; attemptKey: string };
type NewsKey = { attemptKey: string };
type NewsPin = { startDate: string; endDate: string; order: number };
type ProviderNews = { ref: string; text: string; notice: NewsPin | null; video: { ref: string } | null };
type ConsultationStatus = 'waiting' | 'in_progress' | 'on_hold' | 'completed' | 'blocked' | 'spam';
type CampaignGroup = 'benefit-subscribers' | 'recent-reviewers';
type HolidayHours = { date: string; closed: true } | { date: string; open: string; close: string };
type ReviewFilters = { scope: 'venue' | 'booking'; product?: string; rating?: 1 | 2 | 3 | 4 | 5;
  hasReply?: boolean; sort?: 'use-date' };

type ReviewSource = {
  reviews(storeId: string, filters: ReviewFilters): ReturnType<NonNullable<FakeNoticeProvider['reviews']>>;
  review(storeId: string, ref: string): ReturnType<NonNullable<FakeNoticeProvider['review']>>;
  reviewStatistics(storeId: string, filter: { period: 'day' | 'week' | 'month' }): Promise<unknown>;
};

type OwnerPorts = {
  reply: {
    post(input: ReplyKey & { text: string }): Promise<Confirmed>;
    update(input: ReplyKey & { text: string }): Promise<Confirmed>;
    remove(input: ReplyKey & { confirmation: 'confirmed-twice' }): Promise<Confirmed>;
    draft(input: ReplyKey & { style: string; length: string }): Promise<{ text: string }>;
  };
  news: {
    list(input: { cursor?: string }): Promise<{ items: ProviderNews[]; nextCursor: string | null }>;
    create(input: NewsKey & { text: string; notice: NewsPin | null }): Promise<Confirmed & { news: ProviderNews }>;
    remove(input: NewsKey & { ref: string; confirmation: 'confirmed-twice' }): Promise<Confirmed>;
  };
  talkTalk: {
    listConsultations(input: { from: string; to: string; cursor?: string; status?: ConsultationStatus }): Promise<{
      items: { ref: string; status: ConsultationStatus; lastMessageAt: string }[]; nextCursor: string | null }>;
    readConsultation(ref: string): ReturnType<NonNullable<FakeNoticeProvider['consultation']>>;
    sendReply(input: { user: string; text: string; attemptKey?: string }): Promise<{ state: 'accepted' }>;
  };
  campaign: {
    audiences(): Promise<{ quota: { month: string; assigned: number } | null;
      audiences: { ref: string; group: CampaignGroup }[] }>;
    send(input: { audienceRef: string; title: string; body: string; couponRef: string | null; attemptKey: string }):
      Promise<{ receipt: { ref: string; status: 'accepted' } }>;
  };
};

/** Wrap scope-bound PN-A2 ports, PN-A3 review reads and PN-A1 hours after the Persona transport is composed. */
export function createFakeNoticeProvider(options: {
  mode: 'virtual';
  forOwner: (scope: Owner) => OwnerPorts;
  reviews: ReviewSource;
  talkTalkRecipient: (scope: Owner, consultationRef: string) => Promise<string | null>;
  hours: {
    hours(scope: Owner): Promise<{ businessHours: BusinessHours[]; holidayHours: HolidayHours[] }>;
    updateHours(scope: Owner, card: { key: string }, patch: { businessHours?: BusinessHours[]; holidayHours?: HolidayHours[] }):
      Promise<{ businessHours: BusinessHours[]; holidayHours: HolidayHours[] }>;
  };
}): FakeNoticeProvider {
  if (options.mode !== 'virtual') throw new Error('B15 requires Persona transport');
  const campaignGroup = (audience: Audience): CampaignGroup =>
    audience === 'recent-visitor-reviewers' ? 'recent-reviewers' : audience;
  function confirmed(result: Confirmed) {
    if (result.readBack !== 'confirmed') throw new NoticeError(409, 'PROVIDER_READBACK_PENDING');
    return { state: 'saved' as const };
  }
  return {
    mode: 'virtual',
    reviews({ storeId }, query) {
      return options.reviews.reviews(storeId, { scope: query.view, product: query.product, rating: query.rating,
        hasReply: query.hasReply, sort: query.sort });
    },
    review: ({ storeId }, ref) => options.reviews.review(storeId, ref),
    reviewStatistics: ({ storeId }, period) => options.reviews.reviewStatistics(storeId, { period }),
    reviewDraft(scope, { ref, style, length }) {
      return options.forOwner(scope).reply.draft({ reviewRef: ref, style, length, attemptKey: randomUUID() });
    },
    async reviewReply(scope, { operation, effectId, ref, text }) {
      const port = options.forOwner(scope).reply;
      const key = { reviewRef: ref, attemptKey: effectId };
      if (operation === 'create') return confirmed(await port.post({ ...key, text }));
      if (operation === 'edit') return confirmed(await port.update({ ...key, text }));
      return confirmed(await port.remove({ ...key, confirmation: 'confirmed-twice' }));
    },
    async consultations(scope, { status, ...query }) {
      const tab = status?.replace('-', '_') as ConsultationStatus | undefined;
      const response = await options.forOwner(scope).talkTalk.listConsultations({ ...query, status: tab });
      return { ...response, items: response.items.map(item => ({ ...item, status: item.status.replace('_', '-') })) };
    },
    async consultation(scope, ref) {
      const response = await options.forOwner(scope).talkTalk.readConsultation(ref);
      return { ...response, status: response.status.replace('_', '-') };
    },
    async talkTalkReply(scope, { ref, text, user: inboxUser, effectId }) {
      const user = inboxUser ?? await options.talkTalkRecipient(scope, ref);
      if (!user) throw new NoticeError(409, 'TALKTALK_REPLY_UNAVAILABLE');
      return options.forOwner(scope).talkTalk.sendReply({ user, text, attemptKey: effectId });
    },
    async audiences(scope) {
      const { audiences, quota } = await options.forOwner(scope).campaign.audiences();
      return { items: audiences.map(item => ({
        audience: item.group === 'recent-reviewers' ? 'recent-visitor-reviewers' : item.group,
      })), ...(quota && { quota: { month: quota.month, assigned: quota.assigned } }) };
    },
    async campaign(scope, { effectId, audience, title, body, couponRef }) {
      const port = options.forOwner(scope).campaign;
      const { audiences, quota } = await port.audiences();
      const target = audiences.find(item => item.group === campaignGroup(audience));
      if (!target || quota?.assigned === 0) throw new NoticeError(409, 'AUDIENCE_OR_QUOTA_CHANGED');
      const { receipt } = await port.send({ audienceRef: target.ref, title, body, couponRef, attemptKey: effectId });
      return { state: 'accepted', providerRef: receipt.ref };
    },
    async news(scope) {
      const { items } = await options.forOwner(scope).news.list({});
      return { items: items.map(item => ({ ref: item.ref, title: null, text: item.text, video: item.video?.ref ?? null,
        pin: item.notice && { from: item.notice.startDate, to: item.notice.endDate, order: item.notice.order } })) };
    },
    async publishNews(scope, { effectId, title, text, pin }) {
      const result = await options.forOwner(scope).news.create({ attemptKey: effectId, text: title + '\n\n' + text,
        notice: pin && { startDate: pin.from, endDate: pin.to, order: pin.order } });
      return { ...confirmed(result), providerRef: result.news.ref };
    },
    async deleteNews(scope, { ref, effectId }) {
      return confirmed(await options.forOwner(scope).news.remove({ ref, attemptKey: effectId, confirmation: 'confirmed-twice' }));
    },
    hours: scope => options.hours.hours(scope),
    async publishClosure(scope, { effectId, closure }) {
      const first = +new Date(date(closure.date));
      const last = +new Date(date(closure.endDate));
      const days = (last - first) / 86400000 + 1;
      if (days < 1 || days > 31) throw new NoticeError(409, 'HOLIDAY_HOURS_LIMIT');
      const holidays = Array.from({ length: days }, (_, index) => ({
        date: new Date(first + index * 86400000).toISOString().slice(0, 10), closed: true as const,
      }));
      const current = await options.hours.hours(scope);
      const changed = new Set(holidays.map(item => item.date));
      const holidayHours = [...current.holidayHours.filter(item => !changed.has(item.date)), ...holidays];
      if (holidayHours.length > 31) throw new NoticeError(409, 'HOLIDAY_HOURS_LIMIT');
      const saved = await options.hours.updateHours(scope, { key: effectId }, { holidayHours });
      if (!holidays.every(item => saved.holidayHours.some(row => row.date === item.date && 'closed' in row && row.closed))) {
        throw new NoticeError(409, 'PROVIDER_READBACK_PENDING');
      }
      return { state: 'saved' };
    },
    async publishBusinessHours(scope, { effectId, businessHours }) {
      const saved = await options.hours.updateHours(scope, { key: effectId }, { businessHours });
      if (!businessHours.every(item => saved.businessHours.some(row =>
        row.day === item.day && row.open === item.open && row.close === item.close))) {
        throw new NoticeError(409, 'PROVIDER_READBACK_PENDING');
      }
      return { state: 'saved' };
    },
  };
}
