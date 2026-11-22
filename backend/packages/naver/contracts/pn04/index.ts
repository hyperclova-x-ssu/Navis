export const newsSources = {
  news: 'https://help.naver.com/service/30026/contents/20513',
  writing: 'https://new.smartplace.naver.com/notices/695',
  video: 'https://new.smartplace.naver.com/notices/922',
} as const;

export type News = {
  ref: string;
  title: string;
  text: string;
  video: string | null;
  pin: { from: string; to: string; order: number } | null;
};
export type NewsWrite = {
  title?: string;
  text?: string;
  video?: string | null;
  pin?: { to: string; order: number } | null;
};
export type NewsCreate = Pick<News, 'title' | 'text'> & Pick<NewsWrite, 'video' | 'pin'>;
