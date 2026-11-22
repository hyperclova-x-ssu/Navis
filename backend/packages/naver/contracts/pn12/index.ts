export const channelSources = {
  place: 'https://help.naver.com/service/30026/contents/20524?lang=ko&osType=COMMONOS',
  blog: 'https://help.naver.com/service/5593/contents/15314?lang=ko&osType=COMMONOS',
  clip: 'https://help.naver.com/service/30048/contents/25170?osType=PC',
  clipUpload: 'https://help.naver.com/service/30048/bookmark/24422?osType=COMMONOS',
  ads: 'https://naver.github.io/searchad-apidoc/#/operations/GET/~2Fstats%7B%3Fid,fields,timeRange,datePreset,timeIncrement,breakdown%7D',
} as const;

export const channelMetrics = {
  place: ['views', 'bookingOrderApplications', 'reviews', 'smartCallCalls'],
  blog: ['dailyViews', 'cumulativeViews'],
  clip: ['clipViews', 'profileViews', 'newFollowers'],
} as const;

export type Channel = keyof typeof channelMetrics;
export type ReportPeriod = { startDate: string; endDate: string };
export type OwnerReport<T extends Channel = Channel> = {
  period: ReportPeriod;
  cards: {
    metric: (typeof channelMetrics)[T][number];
    value: number;
    changeRate?: number;
    period?: ReportPeriod;
  }[];
};

export type ClipUpload = {
  media: string;
  caption?: string;
  category?: string;
  tags?: string[];
  visibility: 'public' | 'private';
};
// Synthetic persona receipt. Operational links come from the owner’s input.
export type ClipPublication = { link?: string };

export const adsFields = ['impCnt', 'clkCnt', 'salesAmt'] as const;
export type AdsField = (typeof adsFields)[number];
export type AdsMetrics = Partial<Record<AdsField, number>>;
export type AdsDailyStats = { summary: { dateStart: string; dateEnd: string };
  data: ({ dateStart: string; dateEnd: string } & AdsMetrics)[] };
export type AdsSummaryStats = { data: ({ id: string } & AdsMetrics)[] };
