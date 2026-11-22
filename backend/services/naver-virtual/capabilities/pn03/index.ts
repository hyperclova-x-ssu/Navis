import type { PoolClient } from 'pg';
import type { PersonaCapability } from '../../app.ts';
import type { Review, ReviewList, ReviewStatistics } from '../../../../packages/naver/contracts/pn03/index.ts';
import { reviewPeriods, reviewThemes } from '../../../../packages/naver/contracts/pn03/index.ts';
import {
  day, emptyBody, fields, fingerprint, kstDay, oneOf, page, partnerError, partnerPrefix, ref, shiftDay, text,
} from '../../../../packages/naver/contracts/pn03/partner.ts';
import { registerPartnerErrors, scoped } from './partner-db.ts';

type ReviewRow = {
  ref: string;
  body: string;
  keywords: string[];
  media: Review['media'];
  stars: number | null;
  reply: string | null;
  scope: 'venue' | 'booking';
  use_date: string | null;
  product: string | null;
};
const projection = `
  ref, body, keywords, media,
  CASE WHEN $2::date >= DATE '2026-07-09' AND
    (use_date >= DATE '2026-04-06' OR rated_on <= DATE '2021-10-25') THEN stars END AS stars,
  reply, scope, use_date::text, product
`;
const syntheticReviewThumbnail =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAjElEQVR4nGPI9LWmCmKgh0Hvn15BQyQbhGkEQePQDULWEK0vg4bwGMeA1RRMI7AaR8AgZD1X11fCEaZZ2A1CMwXZCKzGoZmF3SBcpiCbhd0gNOe8ubYeF8LlKCwGAZXiNwiro2hsEEFEX4OIjDXsBlEt+qmZIKmWRaiZaalWjFCzYMNvHB7FdCn8SUIAidk8/uVCWfgAAAAASUVORK5CYII=';

function project(row: ReviewRow): Review {
  return {
    ref: row.ref, text: row.body, keywords: row.keywords,
    media: row.media.length ? [{ type: 'photo', url: syntheticReviewThumbnail }] : [],
    stars: row.stars, reply: row.reply, hasReply: row.reply !== null,
    ...(row.scope === 'booking' && row.product && row.use_date
      ? { product: row.product, useDate: row.use_date } : {}),
  };
}

async function readReview(client: PoolClient, account: string, now: Date, reviewRef: string) {
  const { rows } = await client.query<ReviewRow>(
    `SELECT ${projection} FROM naver_virtual.pn03_reviews WHERE account_id = $1 AND ref = $3 AND visible`,
    [account, kstDay(now), reviewRef],
  );
  if (!rows[0]) partnerError(404, '리뷰를 찾을 수 없어요.');
  return project(rows[0]);
}

export const personaCapability: PersonaCapability = {
  id: 'pn03',
  migrations: [{
    id: '20261123000300_pn03_reviews',
    up: `
      CREATE TABLE naver_virtual.pn03_reviews (
        account_id text NOT NULL, ref text NOT NULL, scope text NOT NULL CHECK (scope IN ('venue','booking')),
        body text NOT NULL, keywords text[] NOT NULL DEFAULT '{}', media jsonb NOT NULL DEFAULT '[]',
        visible boolean NOT NULL, use_date date NOT NULL, product text, stars smallint CHECK (stars BETWEEN 1 AND 5),
        rated_on date, reviewer_ref text NOT NULL, reviewer_name text, reply text,
        PRIMARY KEY (account_id, ref)
      );
      CREATE INDEX pn03_review_view ON naver_virtual.pn03_reviews (account_id, scope, use_date DESC, ref) WHERE visible;
      CREATE TABLE naver_virtual.pn03_settings (
        account_id text PRIMARY KEY, show_venue_average boolean NOT NULL
      );
      CREATE TABLE naver_virtual.pn03_mentions (
        account_id text NOT NULL, observation integer NOT NULL, published_on date NOT NULL, review_ref text NOT NULL,
        theme text NOT NULL, keyword text NOT NULL, sentiment text NOT NULL CHECK (sentiment IN ('positive','negative','neutral')),
        visible_excerpt text NOT NULL, PRIMARY KEY (account_id, observation)
      );
      CREATE INDEX pn03_mention_period ON naver_virtual.pn03_mentions (account_id, published_on);
      ${scoped('pn03_reviews', 'SELECT, UPDATE')}
      ${scoped('pn03_settings', 'SELECT')}
      ${scoped('pn03_mentions', 'SELECT')}
    `,
    down: 'DROP TABLE naver_virtual.pn03_mentions, naver_virtual.pn03_settings, naver_virtual.pn03_reviews',
  }, {
    id: '20261123000301_pn03_drop_reviewer_name',
    up: 'ALTER TABLE naver_virtual.pn03_reviews DROP COLUMN reviewer_name',
    down: 'ALTER TABLE naver_virtual.pn03_reviews ADD COLUMN reviewer_name text',
  }],
  async seed(client, { accountId, now, previousGeneration }) {
    if (previousGeneration) {
      await client.query('DELETE FROM naver_virtual.pn03_mentions WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn03_reviews WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn03_settings WHERE account_id = $1', [accountId]);
    }
    const today = kstDay(now);
    await client.query(`INSERT INTO naver_virtual.pn03_settings VALUES ($1, true) ON CONFLICT DO NOTHING`, [accountId]);
    const comments = [
      '라떼가 고소하고 매장이 조용해요.', '테이블이 깨끗해요.', '드립커피 향이 좋아요.',
      '학교 근처에 있어서 들르기 좋아요.', '바쁜 시간에는 음료가 늦게 나왔어요.',
      '디저트와 커피를 같이 먹기 좋아요.', '따뜻하게 맞아주셔서 좋았어요.',
      '창가에 앉아 쉬기 좋았어요.', '커피가 부드러워요.', '다음에도 방문할게요.',
      '테이크아웃 했어요.', '예약한 시간에 바로 앉았어요.', '창가 자리가 편했어요.',
    ];
    for (const [index, body] of comments.entries()) {
      const reviewRef = `review-${String(index + 1).padStart(2, '0')}`;
      const used = shiftDay(today, -2 - index);
      await client.query(`
        INSERT INTO naver_virtual.pn03_reviews
          (account_id, ref, scope, body, keywords, media, visible, use_date, product, stars, rated_on, reviewer_ref, reply)
        VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$7,$10,$11)
        ON CONFLICT DO NOTHING
      `, [
        accountId, reviewRef, index >= 11 ? 'booking' : 'venue', body,
        index === 0 ? ['커피가 맛있어요', '집중하기 좋아요'] : [],
        JSON.stringify(index === 0 ? [{ type: 'photo', url: syntheticReviewThumbnail }] : []),
        used, index >= 11 ? '카페 좌석 예약' : null, index === 10 ? null : index === 4 ? 3 : 5,
        `reviewer-${index + 1}`, index === 1 ? '방문해 주셔서 감사합니다.' : null,
      ]);
    }
    const mentions = [
      [-2, 'review-01', '메뉴', '고소한 라떼', 'positive', comments[0]],
      [-2, 'review-01', '분위기', '조용한 공간', 'positive', comments[0]],
      [-2, 'blog-01', '메뉴', '고소한 라떼', 'positive', '라떼가 고소했어요.'],
      [-2, 'review-05', '운영', '대기 시간', 'negative', comments[4]],
      [-2, 'review-11', '운영', '포장', 'neutral', comments[10]],
      [-1, 'blog-02', '서비스', '친절한 안내', 'positive', '안내를 친절하게 받았어요.'],
    ] as const;
    for (const [index, [offset, reviewRef, theme, keyword, sentiment, excerpt]] of mentions.entries()) {
      await client.query(`INSERT INTO naver_virtual.pn03_mentions VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [accountId, index, shiftDay(today, offset), reviewRef, theme, keyword, sentiment, excerpt]);
    }
  },
  register(app, context) {
    registerPartnerErrors(app);
    const reviews = `${partnerPrefix}/reviews`;

    // Place+ 876, stars 20497 and booking reviews 20716.
    app.get(reviews, { config: { personaOperation: 'pn03.reviews.list' } }, async (request) => {
      const query = fields(request.query, [], ['scope', 'product', 'rating', 'hasReply', 'sort', 'limit', 'offset']);
      const scope = oneOf(query.scope ?? 'venue', ['venue', 'booking']);
      if (scope === 'venue' && [query.product, query.rating, query.hasReply, query.sort].some((value) => value !== undefined)) {
        partnerError(400, '예약 리뷰에서 사용할 수 있는 검색 조건이에요.');
      }
      const product = query.product === undefined ? null : text(query.product, 100);
      const rating = query.rating === undefined ? null : oneOf(query.rating, ['1', '2', '3', '4', '5']);
      const hasReply = query.hasReply === undefined ? null : oneOf(query.hasReply, ['true', 'false']) === 'true';
      if (query.sort !== undefined) oneOf(query.sort, ['use-date']);
      const [limit, offset] = page(query);
      const account = context.accountId(request);
      const today = kstDay(context.now());
      return context.transaction(request, async (client): Promise<ReviewList> => {
        const { rows } = await client.query<ReviewRow>(`
          SELECT * FROM (
            SELECT ${projection} FROM naver_virtual.pn03_reviews WHERE account_id = $1 AND visible AND scope = $3
          ) AS reviews
          WHERE ($4::text IS NULL OR product = $4) AND ($5::smallint IS NULL OR stars = $5)
            AND ($6::boolean IS NULL OR (reply IS NOT NULL) = $6)
          ORDER BY use_date DESC, ref LIMIT $7 OFFSET $8
        `, [account, today, scope, product, rating, hasReply, limit, offset]);
        const items = rows.map(project);
        if (scope === 'booking') return { items };
        const { rows: [average] } = await client.query<{ average: number | null }>(`
          SELECT CASE WHEN (SELECT show_venue_average FROM naver_virtual.pn03_settings WHERE account_id = $1)
            AND COUNT(DISTINCT reviewer_ref) >= 10 THEN ROUND(AVG(stars), 1)::float8 END AS average
          FROM naver_virtual.pn03_reviews WHERE account_id = $1 AND scope = 'venue' AND visible AND stars IS NOT NULL
            AND $2::date >= DATE '2026-07-09' AND (use_date >= DATE '2026-04-06' OR rated_on <= DATE '2021-10-25')
        `, [account, today]);
        return { items, averageStars: average.average };
      });
    });

    // Place+ 876, stars 20497 and booking reviews 20716.
    app.get<{ Params: { ref: string } }>(`${reviews}/:ref`, {
      config: { personaOperation: 'pn03.reviews.get' },
    }, (request) => {
      fields(request.query, []);
      const reviewRef = ref(request.params.ref);
      return context.transaction(request, (client) => readReview(client, context.accountId(request), context.now(), reviewRef));
    });

    // Owner reply 20545. Creation triggers the documented author notice in the owner flow.
    for (const [method, operation] of [['POST', 'create'], ['PATCH', 'update'], ['DELETE', 'delete']] as const) {
      app.route<{ Params: { ref: string } }>({
        method, url: `${reviews}/:ref/reply`, config: { personaOperation: `pn03.reply.${operation}` },
        async handler(request, reply) {
          fields(request.query, []);
          const reviewRef = ref(request.params.ref);
          let value: string | null = null;
          if (operation === 'delete') emptyBody(request.body);
          else value = text(fields(request.body, ['text']).text, 2000);
          const account = context.accountId(request);
          const result = await context.effect(request, fingerprint({ reviewRef, value }), async (client) => {
            const { rows: [row] } = await client.query<Pick<ReviewRow, 'reply'>>(`
              SELECT reply FROM naver_virtual.pn03_reviews
              WHERE account_id = $1 AND ref = $2 AND visible FOR UPDATE
            `, [account, reviewRef]);
            if (!row) partnerError(404, '리뷰를 찾을 수 없어요.');
            if ((operation === 'create') !== (row.reply === null)) partnerError(409, '답글 상태가 바뀌었어요.');
            await client.query(`UPDATE naver_virtual.pn03_reviews SET reply = $3 WHERE account_id = $1 AND ref = $2`,
              [account, reviewRef, value]);
            return reviewRef;
          });
          if (operation === 'delete') return reply.code(204).send();
          return context.transaction(request, (client) => readReview(client, account, context.now(), ref(result.ref)));
        },
      });
    }

    // AI review drafts 25102. Generating a synthetic draft never writes a reply.
    app.post<{ Params: { ref: string } }>(`${reviews}/:ref/reply-draft`, {
      config: { personaOperation: 'pn03.reply.draft' },
    }, async (request) => {
      fields(request.query, []);
      const input = fields(request.body, ['style', 'length']);
      text(input.style, Infinity);
      text(input.length, Infinity);
      const reviewRef = ref(request.params.ref);
      await context.transaction(request,
        (client) => readReview(client, context.accountId(request), context.now(), reviewRef));
      return { text: '방문해 주시고 소중한 후기를 남겨 주셔서 감사합니다.' };
    });

    // AI review statistics 24863. Only completed KST days available under the two-day analysis lag.
    app.get(`${partnerPrefix}/review-statistics`, { config: { personaOperation: 'pn03.stats.read' } }, async (request) => {
      const query = fields(request.query, [], ['period', 'to']);
      const unit = oneOf(query.period ?? 'week', reviewPeriods);
      const availableTo = shiftDay(kstDay(context.now()), -2);
      const requestedTo = query.to === undefined ? availableTo : day(query.to);
      const to = requestedTo > availableTo ? availableTo : requestedTo;
      const from = unit === 'month' ? to.slice(0, 7) + '-01' : shiftDay(to, unit === 'week' ? -6 : 0);
      return context.transaction(request, async (client): Promise<ReviewStatistics> => {
        const { rows } = await client.query<{
          theme: typeof reviewThemes[number]; sentiment: 'positive' | 'negative'; keyword: string;
          review_ref: string; visible_excerpt: string;
        }>(`
          SELECT theme, sentiment, keyword, review_ref, visible_excerpt FROM naver_virtual.pn03_mentions
          WHERE account_id = $1 AND published_on BETWEEN $2 AND $3 AND sentiment <> 'neutral'
          ORDER BY published_on DESC, observation
        `, [context.accountId(request), from, to]);
        const themes = reviewThemes.map((theme) => ({
          theme,
          positiveCount: rows.filter((row) => row.theme === theme && row.sentiment === 'positive').length,
          negativeCount: rows.filter((row) => row.theme === theme && row.sentiment === 'negative').length,
        }));
        function topKeywords(sentiment: 'positive' | 'negative') {
          const keywords = new Map<string, Map<string, string>>();
          for (const row of rows) {
            if (row.sentiment !== sentiment) continue;
            const reviewsForKeyword = keywords.get(row.keyword) ?? new Map<string, string>();
            reviewsForKeyword.set(row.review_ref, row.visible_excerpt);
            keywords.set(row.keyword, reviewsForKeyword);
          }
          return Array.from(keywords, ([keyword, related]) => ({
            keyword, count: related.size, relatedReviews: Array.from(related.values()).slice(0, 500).map((excerpt) => ({ text: excerpt })),
          })).sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword, 'ko')).slice(0, 3);
        }
        return { period: { unit, from, to }, themes, topKeywords: { positive: topKeywords('positive'), negative: topKeywords('negative') } };
      });
    });
  },
};
