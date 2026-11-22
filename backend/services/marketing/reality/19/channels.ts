import type { ChannelReportPort, OwnerReport, ReportChannel, ReportPeriod } from './ports.ts';
import { addDays, date, invalid, object, validDate } from './wire.ts';

/** Official owner-screen sources (PN12, D-347 D3). A report whose source differs is not shown. */
export const channelSources: Record<ReportChannel, string> = {
  place: 'https://help.naver.com/service/30026/contents/20524?lang=ko&osType=COMMONOS',
  blog: 'https://help.naver.com/service/5593/contents/15314?lang=ko&osType=COMMONOS',
  clip: 'https://help.naver.com/service/30048/contents/25170?osType=PC',
};
const metrics: Record<ReportChannel, readonly string[]> = {
  place: ['views', 'bookingOrderApplications', 'reviews', 'smartCallCalls'],
  blog: ['dailyViews', 'cumulativeViews'],
  clip: ['clipViews', 'profileViews', 'newFollowers'],
};
const channels: readonly ReportChannel[] = ['place', 'blog', 'clip'];
const timeoutMs = 5_000;

type Card = { metric: string; value: number; changeRate?: number; period?: ReportPeriod };
export type ChannelItem = { channel: ReportChannel; state: 'ready' | 'unavailable'; source: string; period: ReportPeriod | null; cards: Card[] };

function reportPeriod(value: unknown): ReportPeriod {
  const input = object(value, ['startDate', 'endDate']);
  if (!validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate) throw new Error('period');
  return { startDate: input.startDate, endDate: input.endDate };
}

/** Keep each owner-visible card as reported, with its own period; drop metrics outside the contract. */
function normalize(channel: ReportChannel, report: OwnerReport): ChannelItem {
  if (report?.source !== channelSources[channel] || !Array.isArray(report.cards)) throw new Error('source');
  const period = reportPeriod(report.period);
  const cards: Card[] = [];
  for (const card of report.cards) {
    if (!metrics[channel].includes(card?.metric)) continue;
    if (!Number.isSafeInteger(card.value) || card.value < 0) throw new Error('value');
    if (card.changeRate !== undefined && !Number.isFinite(card.changeRate)) throw new Error('changeRate');
    if (cards.some(prior => prior.metric === card.metric)) throw new Error('duplicate');
    cards.push({ metric: card.metric, value: card.value, ...(card.changeRate !== undefined && { changeRate: card.changeRate }),
      ...(card.period !== undefined && { period: reportPeriod(card.period) }) });
  }
  return { channel, state: 'ready', source: report.source, period, cards };
}

function within<T>(promise: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

export async function readChannelReports(storeId: string, day: string, query: unknown, port: ChannelReportPort | undefined) {
  const input = object(query ?? {}, ['date', 'unit']);
  const end = input.date === undefined ? addDays(day, -1) : date(input.date, 'date');
  if (end > day) invalid('INVALID_DATE', 'date');
  if (input.unit !== undefined && input.unit !== 'day' && input.unit !== 'week') invalid('INVALID_UNIT', 'unit');
  const unit = input.unit as 'day' | 'week' | undefined;
  const options = (channel: ReportChannel) => channel === 'clip' ? {}
    : channel === 'place' && unit ? { date: end, unit } : { date: end };
  return Promise.all(channels.map(async (channel): Promise<ChannelItem> => {
    try {
      if (!port) throw new Error('unconfigured');
      return normalize(channel, await within(port.channelReport(storeId, channel, options(channel))));
    } catch {
      return { channel, state: 'unavailable', source: channelSources[channel], period: null, cards: [] };
    }
  }));
}
