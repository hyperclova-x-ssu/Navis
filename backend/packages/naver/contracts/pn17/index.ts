export const cafeArticleSource = 'https://developers.naver.com/docs/login/cafe-api/cafe-api.md';

export type CafeArticleInput = { subject: string; content: string };
export type CafeArticleResponse = {
  '@type': 'response';
  '@service': 'korea.naverkoreaservice.community.cafe';
  '@version': '1.0.0';
  status: '200';
  result: { msg: 'Success'; cafeUrl: string; articleId: number; articleUrl: string };
};

export function cafeArticleForm({ subject, content }: CafeArticleInput) {
  // The outer form escapes the already encoded UTF-8 values using ASCII-compatible MS949.
  return new URLSearchParams({ subject: encodeURIComponent(subject), content: encodeURIComponent(content) });
}
