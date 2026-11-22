export const reviewSources = {
  linkedPos: 'https://smartplace.naver.com/notices/876',
  venue: 'https://help.naver.com/service/30026/contents/20497?lang=ko&osType=COMMONOS',
  booking: 'https://help.naver.com/service/30026/contents/20716?osType=COMMONOS',
  reply: 'https://help.naver.com/service/30026/contents/20545?lang=ko&osType=COMMONOS',
  statistics: 'https://help.naver.com/service/30026/contents/24863?lang=ko&osType=COMMONOS',
  draft: 'https://help.naver.com/service/30026/contents/25102?lang=ko&osType=COMMONOS',
} as const;

export const reviewReplyNotice = '답글을 올리면 리뷰 작성자에게 알림이 가요.';
export const reviewThemes = ['음식', '메뉴', '가격', '분위기', '매장', '시설', '좌석', '서비스', '운영'] as const;
export const reviewPeriods = ['day', 'week', 'month'] as const;

export interface Review {
  ref: string;
  text: string;
  keywords: string[];
  // Synthetic review media for owner display only. Never a marketing asset selector.
  media: { type: 'photo' | 'video'; url: string }[];
  stars: number | null;
  reply: string | null;
  hasReply: boolean;
  product?: string;
  useDate?: string;
}

export type ReviewList = { items: Review[]; averageStars?: number | null };
export type ReviewReplyWrite = { text: string };
// The help page confirms the style and length settings without enumerating their labels.
export type ReviewDraftRequest = { style: string; length: string };
export type ReviewDraft = { text: string };

type ReviewKeyword = {
  keyword: string;
  count: number;
  relatedReviews: { text: string }[];
};
export type ReviewStatistics = {
  period: { unit: typeof reviewPeriods[number]; from: string; to: string };
  themes: { theme: typeof reviewThemes[number]; positiveCount: number; negativeCount: number }[];
  topKeywords: { positive: ReviewKeyword[]; negative: ReviewKeyword[] };
};
