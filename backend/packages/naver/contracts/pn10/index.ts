export const searchSources = {
  blog: 'https://api.ncloud-docs.com/docs/naver-api-hub-search-blog',
  cafearticle: 'https://api.ncloud-docs.com/docs/naver-api-hub-search-cafearticle',
  local: 'https://api.ncloud-docs.com/docs/naver-api-hub-search-local',
  news: 'https://api.ncloud-docs.com/docs/naver-api-hub-search-news',
  trend: 'https://api.ncloud-docs.com/docs/naver-api-hub-search-trend',
  geocode: 'https://api.ncloud-docs.com/docs/application-maps-geocoding',
} as const;

export type SearchItems = {
  blog: { title: string; link: string; description: string; bloggername: string; bloggerlink: string; postdate: string };
  cafearticle: { title: string; link: string; description: string; cafename: string; cafeurl: string };
  news: { title: string; link: string; description: string; originallink: string; pubDate: string };
  local: { title: string; link: string; category: string; description: string; telephone: '';
    address: string; roadAddress: string; mapx: string; mapy: string };
};

export type SearchResult<T> = { lastBuildDate: string; total: number; start: number; display: number; items: T[] };
export type SearchTrendRequest = {
  startDate: string;
  endDate: string;
  timeUnit: 'date' | 'week' | 'month';
  keywordGroups: { groupName: string; keywords: string[] }[];
  device?: 'pc' | 'mo';
  gender?: 'm' | 'f';
  ages?: string[];
};
export type SearchTrendResult = Pick<SearchTrendRequest, 'startDate' | 'endDate' | 'timeUnit'> & {
  results: { title: string; keywords: string[]; data: { period: string; ratio: number }[] }[];
};
export type GeocodeAddress = {
  roadAddress: string;
  jibunAddress: string;
  englishAddress: string;
  addressElements: { types: string[]; longName: string; shortName: string; code: string }[];
  x: string;
  y: string;
  distance: number;
};
export type GeocodeResult = {
  status: 'OK' | 'INVALID_REQUEST' | 'SYSTEM_ERROR';
  meta: { totalCount: number; page: number; count: number };
  addresses: GeocodeAddress[];
  errorMessage?: string;
};
