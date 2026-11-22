import Fastify from 'fastify';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { cafeArticleLink } from './cafe.ts';
import { registerLocalMarketingRoutes } from './routes.ts';

it('rejects an unknown workload token for a Café publish before database or provider access', async () => {
  const app = Fastify();
  const connect = vi.fn();
  const publish = vi.fn();
  const store = 'd85e9289-0b89-4e02-8eb7-3ce777285baa';
  registerLocalMarketingRoutes(app, { connect } as unknown as Pool, {
    readToken: 'read', commandToken: 'existing-command', cafe: {
      mode: 'fake', cardToken: 'verified-cafe-command', boards: async () => [], publish,
    },
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/internal/v1/marketing/stores/' + store + '/community/cafe-posts',
      headers: { authorization: 'Bearer unknown', 'x-navis-store-id': store,
        'x-navis-user-id': store, 'x-navis-store-role': 'owner', 'idempotency-key': 'navis:' + store },
      payload: { clubid: '1', menuid: '1', subject: '공지', text: '새 소식' } });
    expect(response.statusCode).toBe(401);
    expect(connect).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it('keeps a confirmed Café article even when its link is unexpected (RV-GAP-B-9)', () => {
  const board = { clubid: '10000001', menuid: '1' };
  expect(cafeArticleLink(board, { articleId: 7, articleUrl: 'https://cafe.naver.com/navis/7' })).toBe('https://cafe.naver.com/navis/7');
  for (const articleUrl of ['http://cafe.naver.com/navis/7', 'https://evil.example/7', 'not a url', 'https://u:p@cafe.naver.com/7']) {
    expect(cafeArticleLink(board, { articleId: 7, articleUrl })).toBe('https://cafe.naver.com/ca-fe/cafes/10000001/articles/7');
  }
});
