/**
 * PAR-1 / D-386: the example data of the three NAVER-reported figures the briefing shows (SmartCall, review AI statistics, channel results).
 * Over HTTP those come from the services; with the example data the briefing reads these. The source widgets (예약, 메시지·리뷰 응대, 마케팅 성과)
 * must read the SAME functions in their example mode so a figure is identical in the briefing and in its widget.
 */
import { TODAY, addDays } from '../../data/db/time';
import type { CallDayDto } from '../../data/reality/06/dto';
import type { ReviewStatisticsDto } from '../../data/reality/15/dto';
import type { ChannelReportsDto } from '../../data/reality/19/dto';

/** SmartCall daily aggregates of the last seven days (the period the service answers for). */
export function exampleCallDays(): readonly CallDayDto[] {
  const calls = [6, 9, 4, 7, 11, 8, 5];
  return calls.map((totalCalls, index) => ({
    date: addDays(TODAY, index - 6), totalCalls, connectedCalls: totalCalls - 1, arsCalls: 0, missedCalls: 1, busyCalls: 0,
    averageDurationSeconds: 42, callsAtLeastTenSeconds: totalCalls - 1,
  }));
}

/** Review AI statistics of the last full week, which the provider delivers with a two-day lag. */
export function exampleReviewStatistics(): Extract<ReviewStatisticsDto, { readonly state: 'ready' }> {
  return {
    state: 'ready', source: 'NAVER 리뷰 AI 통계', sourceUrl: 'https://new.smartplace.naver.com/',
    period: { unit: 'week', from: addDays(TODAY, -8), to: addDays(TODAY, -2) },
    coverage: { requestedTo: TODAY, dataThrough: addDays(TODAY, -2), lagDays: 2 },
    themes: [{ theme: '맛', positiveCount: 14, negativeCount: 2 }, { theme: '서비스', positiveCount: 9, negativeCount: 1 }, { theme: '분위기', positiveCount: 7, negativeCount: 0 }],
    topKeywords: { positive: [], negative: [] },
  };
}

/** Channel results of the month so far: one reported figure per channel. */
export function exampleChannelReports(): ChannelReportsDto {
  const period = { startDate: `${TODAY.slice(0, 7)}-01`, endDate: TODAY };
  return {
    asOf: `${TODAY}T00:00:00.000Z`, businessDate: TODAY,
    items: [
      { channel: 'place', state: 'ready', source: 'NAVER 스마트플레이스', period, cards: [{ metric: 'views', value: 1240 }] },
      { channel: 'blog', state: 'ready', source: 'NAVER 블로그', period, cards: [{ metric: 'views', value: 380 }] },
    ],
  };
}
