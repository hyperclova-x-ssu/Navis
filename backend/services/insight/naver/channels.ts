import { createHmac } from 'node:crypto';
import { isDate } from '../scope.ts';
import { count, invalid, items, object, partner, periodOf, query, ref, unavailable, validPeriod,
  type Period, type ReadJson } from './protocol.ts';

const channelSources = {
  place: 'https://help.naver.com/service/30026/contents/20524?lang=ko&osType=COMMONOS',
  blog: 'https://help.naver.com/service/5593/contents/15314?lang=ko&osType=COMMONOS',
  clip: 'https://help.naver.com/service/30048/contents/25170?osType=PC',
  ads: 'https://naver.github.io/searchad-apidoc/#/operations/GET/~2Fstats%7B%3Fid,fields,timeRange,datePreset,timeIncrement,breakdown%7D',
} as const;

const metrics = {
  place: ['views', 'bookingOrderApplications', 'reviews', 'smartCallCalls'],
  blog: ['dailyViews', 'cumulativeViews'],
  clip: ['clipViews', 'profileViews', 'newFollowers'],
} as const;
type Channel = keyof typeof metrics;
const adMeasures = { impCnt: 'impressions', clkCnt: 'clicks', salesAmt: 'cost' } as const;
const adFields = Object.keys(adMeasures) as Array<keyof typeof adMeasures>;

// Official Search Ads sample signs timestamp.method.path without the query.
// https://github.com/naver/searchad-apidoc/blob/master/python-sample/examples/ad_management_sample.py
export function searchAdsAuthorization(customerId: string, keyId: string, now: () => Date = () => new Date()) {
  return (secret: string) => {
    const timestamp = String(+now());
    return {
      'X-API-KEY': keyId,
      'X-Customer': customerId,
      'X-Timestamp': timestamp,
      'X-Signature': createHmac('sha256', secret).update(timestamp + '.GET./stats').digest('base64'),
    };
  };
}

export function createChannelReads(read: ReadJson) {
  return {
    async channelReport(storeId: string, channel: Channel, options: { date?: string; unit?: 'day' | 'week' } = {}) {
      if (!Object.hasOwn(metrics, channel) || (options.date !== undefined && !isDate(options.date)) ||
          (channel === 'clip' && (options.date !== undefined || options.unit !== undefined)) ||
          (options.unit !== undefined && options.unit !== 'day' && !(channel === 'place' && options.unit === 'week'))) invalid();
      const source = channelSources[channel];
      const { data } = await read('pn12.' + channel, storeId,
        query(partner + '/reports/' + channel, { date: options.date, unit: options.unit }));
      const row = object(data);
      const period = periodOf(row.period);
      const days = channel === 'clip' || options.unit === 'week' ? 7 : 1;
      if ((options.date !== undefined && period.endDate !== options.date) ||
          Date.parse(period.endDate) - Date.parse(period.startDate) !== (days - 1) * 86_400_000) unavailable();

      const allowed: readonly string[] = metrics[channel];
      const cards = items(row.cards, entry => {
        const card = object(entry);
        const metric = card.metric;
        if (typeof metric !== 'string' || !allowed.includes(metric)) return [];
        const changeRate = card.changeRate;
        if (changeRate !== undefined && (typeof changeRate !== 'number' || !Number.isFinite(changeRate))) unavailable();
        const cardPeriod = card.period === undefined ? undefined : periodOf(card.period);
        if (cardPeriod && cardPeriod.endDate !== period.endDate) unavailable();
        return [{ metric, value: count(card.value), ...(changeRate !== undefined && { changeRate }),
          ...(cardPeriod && { period: cardPeriod }) }];
      }).flat();
      if (new Set(cards.map(card => card.metric)).size !== cards.length) unavailable();
      return { source, period, cards };
    },
    async adsReport(storeId: string, selector: string, period: Period, approvalScope?: unknown) {
      if (!validPeriod(period)) invalid();
      const id = ref(selector);
      const { data } = await read('pn12.ads', storeId, query('/stats', {
        ids: id, fields: JSON.stringify(adFields),
        timeRange: JSON.stringify({ since: period.startDate, until: period.endDate }),
      }), { approvalScope });
      const rows = items(object(data).data, object);
      if (rows.length > 1 || (rows.length === 1 && rows[0].id !== id)) unavailable();
      const row = rows[0] ?? {};
      const cards = adFields.flatMap(field => row[field] === undefined || row[field] === null ? [] :
        [{ metric: adMeasures[field], value: count(row[field]) }]);
      return { source: channelSources.ads, period: { startDate: period.startDate, endDate: period.endDate }, cards };
    },
  };
}
