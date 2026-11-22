import { isDate } from '../scope.ts';
import {
  count, date, invalid, items, object, partner, periodOf, query, ref, string, unavailable, validPeriod,
  type Period, type ReadJson,
} from './protocol.ts';

type ReviewFilters =
  | { scope: 'venue'; limit?: number; offset?: number }
  | { scope: 'booking'; product?: string; rating?: 1 | 2 | 3 | 4 | 5; hasReply?: boolean;
      sort?: 'use-date'; limit?: number; offset?: number };

const reviews = partner + '/reviews';
const recommendations = partner + '/financial-center/recommendations';
const units = ['day', 'week', 'month'] as const;
type Unit = (typeof units)[number];

function httpsLink(input: unknown) {
  const value = string(input);
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* An invalid provider link is unavailable. */ }
  unavailable();
}

function viewOnlyMedia(input: unknown) {
  const value = string(input);
  if (/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(value)) return value;
  if (/^\/fixtures\/persona\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|mp4)$/i.test(value)) return value;
  return httpsLink(value);
}

function review(value: unknown) {
  const item = object(value);
  const reply = item.reply === null ? null : string(item.reply);
  if (item.hasReply !== (reply !== null)) unavailable();
  const stars = item.stars === null ? null : count(item.stars);
  if (stars !== null && (stars < 1 || stars > 5)) unavailable();
  return {
    ref: ref(string(item.ref)), text: string(item.text), keywords: items(item.keywords, string),
    media: items(item.media, value => {
      const media = object(value);
      if (media.type !== 'photo' && media.type !== 'video') unavailable();
      return { type: media.type, url: viewOnlyMedia(media.url) };
    }),
    stars, reply, hasReply: item.hasReply,
    ...(item.product !== undefined && { product: string(item.product) }),
    ...(item.useDate !== undefined && { useDate: date(item.useDate) }),
  };
}

function keywords(value: unknown) {
  return items(value, input => {
    const row = object(input);
    return { keyword: string(row.keyword), count: count(row.count),
      relatedReviews: items(row.relatedReviews, item => ({ text: string(object(item).text) })) };
  });
}

function recommendationSummary(item: Record<string, unknown>) {
  return { title: string(item.title), officialNoticeUrl: httpsLink(item.officialNoticeUrl),
    ...(item.startDate !== undefined && { startDate: date(item.startDate) }),
    ...(item.endDate !== undefined && { endDate: date(item.endDate) }),
    ...(item.status === 'closed' && { status: 'closed' as const }) };
}

function financialRef(selector: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(selector)) invalid();
  return selector;
}

export function createOwnerReads(read: ReadJson) {
  return {
    // https://smartplace.naver.com/notices/876
    // https://help.naver.com/service/30026/contents/20497?lang=ko
    // https://help.naver.com/service/30026/contents/20716
    async reviews(storeId: string, filters: ReviewFilters) {
      const params: Record<string, string | number | boolean | undefined> = {
        scope: filters.scope, limit: filters.limit, offset: filters.offset,
      };
      if (filters.scope === 'booking') Object.assign(params, {
        product: filters.product, rating: filters.rating, hasReply: filters.hasReply, sort: filters.sort,
      });
      const { data } = await read('pn03.reviews.list', storeId, query(reviews, params));
      const row = object(data);
      const result = items(row.items, review);
      if (filters.scope !== 'venue' || row.averageStars === undefined) return { items: result };
      const average = row.averageStars;
      if (average !== null && (typeof average !== 'number' || !Number.isFinite(average) || average < 1 || average > 5)) unavailable();
      return { items: result, averageStars: average };
    },
    async review(storeId: string, selector: string) {
      const { data } = await read('pn03.reviews.get', storeId, reviews + '/' + ref(selector));
      const result = review(data);
      if (result.ref !== selector) unavailable();
      return result;
    },
    // https://help.naver.com/service/30026/contents/24863?lang=ko
    async reviewStatistics(storeId: string, filter: { period?: Unit; to?: string } = {}) {
      if (filter.to !== undefined && !isDate(filter.to)) invalid();
      const { data } = await read('pn03.stats.read', storeId,
        query(partner + '/review-statistics', { period: filter.period, to: filter.to }));
      const row = object(data);
      const period = object(row.period);
      const unit = string(period.unit) as Unit;
      const from = date(period.from);
      const to = date(period.to);
      if (!units.includes(unit) || (filter.period !== undefined && filter.period !== unit) ||
          from > to || (filter.to !== undefined && to > filter.to)) unavailable();
      const top = object(row.topKeywords);
      return { period: { unit, from, to }, themes: items(row.themes, entry => {
        const theme = object(entry);
        return { theme: string(theme.theme), positiveCount: count(theme.positiveCount), negativeCount: count(theme.negativeCount) };
      }), topKeywords: { positive: keywords(top.positive), negative: keywords(top.negative) } };
    },
    // https://help.naver.com/service/30026/contents/25102?lang=ko
    async reviewDraft(storeId: string, selector: string, options: { style: string; length: string }) {
      const { data } = await read('pn03.reply.draft', storeId, reviews + '/' + ref(selector) + '/reply-draft', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ style: options.style, length: options.length }),
      });
      return { text: string(object(data).text) };
    },
    // https://help.naver.com/service/30026/contents/20474?lang=ko
    async smartCallSummary(storeId: string, requested: Period) {
      if (!validPeriod(requested)) invalid();
      const { startDate, endDate } = requested;
      const { data } = await read('pn08.smartcall.calls', storeId,
        query(partner + '/smartcall/calls', { startDate, endDate }));
      const row = object(data);
      const period = periodOf(row.period);
      if (period.startDate !== startDate || period.endDate !== endDate) unavailable();
      return { period, channels: items(row.channels, string), daily: items(row.daily, entry => {
        const day = object(entry);
        const observed = date(day.date);
        if (observed < startDate || observed > endDate) unavailable();
        return { date: observed, totalCalls: count(day.totalCalls), connectedCalls: count(day.connectedCalls),
          arsCalls: count(day.arsCalls), missedCalls: count(day.missedCalls), busyCalls: count(day.busyCalls),
          averageDurationSeconds: day.averageDurationSeconds === null ? null : count(day.averageDurationSeconds),
          callsAtLeastTenSeconds: count(day.callsAtLeastTenSeconds) };
      }) };
    },
    // https://help.admin.pay.naver.com/faq/content.help?faqId=13148
    async recommendations(storeId: string) {
      const { data, headers } = await read('pn09.financial-center.list', storeId, recommendations);
      const summaries = items(data, item => recommendationSummary(object(item)));
      const links = headers.get('link');
      const selectors = links ? links.split(',').map(link => {
        const match = /^<\/partner-assumed\/v1\/financial-center\/recommendations\/([A-Za-z0-9_-]{1,64})>;\s*rel="item"$/.exec(link.trim());
        return match?.[1] ?? unavailable();
      }) : [];
      if (selectors.length !== summaries.length || new Set(selectors).size !== selectors.length) unavailable();
      return { items: summaries.map((item, i) => ({ ...item, ref: selectors[i] })) };
    },
    async recommendation(storeId: string, selector: string) {
      const { data } = await read('pn09.financial-center.read', storeId, recommendations + '/' + financialRef(selector));
      const row = object(data);
      return { ...recommendationSummary(row), overview: string(row.overview), eligibility: string(row.eligibility),
        applicationMethod: string(row.applicationMethod), ...(row.documents !== undefined && { documents: items(row.documents, string) }) };
    },
  };
}
