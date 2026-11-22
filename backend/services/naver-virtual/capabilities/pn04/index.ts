import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PersonaCapability } from '../../app.ts';
import type { News, NewsWrite } from '../../../../packages/naver/contracts/pn04/index.ts';
import {
  day, emptyBody, fields, fingerprint, integer, kstDay, page, partnerError, partnerPrefix, ref, shiftDay, text,
} from '../../../../packages/naver/contracts/pn03/partner.ts';
import { registerPartnerErrors, lockAccount, scoped } from '../pn03/partner-db.ts';

const newsPath = `${partnerPrefix}/place/news`;
const columns = 'ref, title, body, video_ref, pinned_from::text, pinned_to::text, pin_order';
type NewsRow = {
  ref: string; title: string; body: string; video_ref: string | null;
  pinned_from: string | null; pinned_to: string | null; pin_order: number | null;
};

function project(row: NewsRow, today: string): News {
  return {
    ref: row.ref, title: row.title, text: row.body, video: row.video_ref,
    pin: row.pinned_from && row.pinned_to && row.pinned_to >= today && row.pin_order !== null
      ? { from: row.pinned_from, to: row.pinned_to, order: row.pin_order } : null,
  };
}

async function read(client: PoolClient, account: string, newsRef: string, today: string) {
  const { rows: [row] } = await client.query<NewsRow>(
    `SELECT ${columns} FROM naver_virtual.pn04_news WHERE account_id = $1 AND ref = $2`, [account, newsRef],
  );
  if (!row) partnerError(404, '소식을 찾을 수 없어요.');
  return project(row, today);
}

function newsInput(body: unknown, create: boolean): NewsWrite {
  const input = fields(body, create ? ['title', 'text'] : [], create ? ['video', 'pin'] : ['title', 'text', 'video', 'pin']);
  if (Object.keys(input).length === 0) partnerError(400, '변경할 항목을 입력해 주세요.');
  const result: NewsWrite = {};
  if (input.title !== undefined) result.title = text(input.title, 40, 5);
  if (input.text !== undefined) result.text = text(input.text, 1000, 10);
  if (input.video !== undefined) result.video = input.video === null ? null : ref(input.video);
  if (input.pin === null) result.pin = null;
  else if (input.pin !== undefined) {
    const pin = fields(input.pin, ['to', 'order']);
    result.pin = { to: day(pin.to), order: integer(pin.order, 1, 5) };
  }
  return result;
}

async function applyPin(client: PoolClient, account: string, news: News, today: string, pin: NewsWrite['pin']) {
  const { rows } = await client.query<{ ref: string }>(`
    SELECT ref FROM naver_virtual.pn04_news
    WHERE account_id = $1 AND pinned_to >= $2 AND ref <> $3 ORDER BY pin_order, ref
  `, [account, today, news.ref]);
  const ordered = rows.map((row) => row.ref);
  if (pin) {
    if (pin.to < today || pin.to > shiftDay(today, 44)) partnerError(400, '공지 기간은 최대 45일이에요.');
    if (ordered.length >= 5) partnerError(409, '공지 중인 소식은 최대 5개예요.');
    if (pin.order > ordered.length + 1) partnerError(400, '공지 순서를 확인해 주세요.');
    ordered.splice(pin.order - 1, 0, news.ref);
  }
  const start = pin && news.pin && news.pin.to >= today && news.pin.to === pin.to ? news.pin.from : today;
  await client.query(`
    UPDATE naver_virtual.pn04_news SET pinned_from = $3, pinned_to = $4, pin_order = $5
    WHERE account_id = $1 AND ref = $2
  `, [account, news.ref, pin ? start : null, pin?.to ?? null, pin?.order ?? null]);
  if (ordered.length > 0) {
    await client.query(`
      UPDATE naver_virtual.pn04_news AS news SET pin_order = positions.ordinal
      FROM unnest($2::text[]) WITH ORDINALITY AS positions(ref, ordinal)
      WHERE news.account_id = $1 AND news.ref = positions.ref
    `, [account, ordered]);
  }
}

export const personaCapability: PersonaCapability = {
  id: 'pn04',
  migrations: [{
    id: '20261123000400_pn04_news',
    up: `
      CREATE TABLE naver_virtual.pn04_owner_videos (
        account_id text NOT NULL, ref text NOT NULL, PRIMARY KEY (account_id, ref)
      );
      CREATE TABLE naver_virtual.pn04_news (
        account_id text NOT NULL, ref text NOT NULL, title text NOT NULL, body text NOT NULL, video_ref text,
        created_at timestamptz NOT NULL,
        pinned_from date, pinned_to date, pin_order smallint,
        PRIMARY KEY (account_id, ref),
        FOREIGN KEY (account_id, video_ref) REFERENCES naver_virtual.pn04_owner_videos (account_id, ref),
        CHECK ((pinned_from IS NULL AND pinned_to IS NULL AND pin_order IS NULL)
          OR (pinned_from IS NOT NULL AND pinned_to - pinned_from BETWEEN 0 AND 44 AND pin_order BETWEEN 1 AND 5))
      );
      CREATE INDEX pn04_news_recency ON naver_virtual.pn04_news (account_id, created_at DESC, ref);
      ${scoped('pn04_owner_videos', 'SELECT')}
      ${scoped('pn04_news', 'SELECT, INSERT, UPDATE, DELETE')}
    `,
    down: 'DROP TABLE naver_virtual.pn04_news, naver_virtual.pn04_owner_videos',
  }],
  async seed(client, { accountId, now, previousGeneration }) {
    if (previousGeneration) {
      await client.query('DELETE FROM naver_virtual.pn04_news WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn04_owner_videos WHERE account_id = $1', [accountId]);
    }
    const today = kstDay(now);
    await client.query('INSERT INTO naver_virtual.pn04_owner_videos VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [accountId, 'video-cafe-01']);
    await client.query(`
      INSERT INTO naver_virtual.pn04_news (account_id, ref, title, body, video_ref, created_at, pinned_from, pinned_to, pin_order)
      VALUES ($1, 'news-01', '안숭잘부 카페 이번 주 소식', '이번 주 안숭잘부 카페에서는 고소한 라떼를 준비했어요.',
        'video-cafe-01', $2, $3, $4, 1),
        ($1, 'news-02', '주말 원두 안내', '이번 주말에는 고소한 하우스 블렌드 원두를 판매해요.',
          NULL, $2, $3, $4, 2),
        ($1, 'news-03', '텀블러 이용 안내', '텀블러를 가져오시면 주문할 때 직원에게 알려 주세요.',
          NULL, $2, $3, $4, 3),
        ($1, 'news-04', '포장 주문 안내', '포장 주문은 카운터에서 음료와 함께 말씀해 주세요.',
          NULL, $2, $3, $4, 4)
      ON CONFLICT DO NOTHING
    `, [accountId, now, today, shiftDay(today, 6)]);
  },
  register(app, context) {
    registerPartnerErrors(app);
    // Place news management 20513 and official owner video notice 922.
    app.get(newsPath, { config: { personaOperation: 'pn04.news.list' } }, (request) => {
      const [limit, offset] = page(fields(request.query, [], ['limit', 'offset']));
      const today = kstDay(context.now());
      return context.transaction(request, async (client) => {
        const { rows } = await client.query<NewsRow>(`
          SELECT ${columns} FROM naver_virtual.pn04_news WHERE account_id = $1
          ORDER BY CASE WHEN pinned_to >= $2 THEN pin_order END NULLS LAST, created_at DESC, ref LIMIT $3 OFFSET $4
        `, [context.accountId(request), today, limit, offset]);
        return { items: rows.map((row) => project(row, today)) };
      });
    });

    // Place news management 20513 and official owner video notice 922.
    app.get<{ Params: { ref: string } }>(`${newsPath}/:ref`, {
      config: { personaOperation: 'pn04.news.get' },
    }, (request) => {
      fields(request.query, []);
      const newsRef = ref(request.params.ref);
      return context.transaction(request, (client) => read(client, context.accountId(request), newsRef, kstDay(context.now())));
    });

    // Place news management 20513, title/body limits 695 and official owner video notice 922.
    for (const [method, operation] of [['POST', 'create'], ['PATCH', 'update'], ['DELETE', 'delete']] as const) {
      app.route<{ Params: { ref: string } }>({
        method, url: operation === 'create' ? newsPath : `${newsPath}/:ref`,
        config: { personaOperation: `pn04.news.${operation}` },
        async handler(request, reply) {
          fields(request.query, []);
          const newsRef = operation === 'create' ? null : ref(request.params.ref);
          let input: NewsWrite = {};
          if (operation === 'delete') emptyBody(request.body);
          else input = newsInput(request.body, operation === 'create');
          const account = context.accountId(request);
          const now = context.now();
          const today = kstDay(now);
          const result = await context.effect(request, fingerprint({ newsRef, input }), async (client) => {
            await lockAccount(client, 'pn04-news', account);
            const news = newsRef ? await read(client, account, newsRef, today) : {
              ref: randomUUID(), title: '', text: '', video: null, pin: null,
            };
            if (operation === 'delete') {
              if (news.pin && news.pin.to >= today) await applyPin(client, account, news, today, null);
              await client.query('DELETE FROM naver_virtual.pn04_news WHERE account_id = $1 AND ref = $2', [account, news.ref]);
              return news.ref;
            }
            if (input.video) {
              const { rowCount } = await client.query(
                'SELECT 1 FROM naver_virtual.pn04_owner_videos WHERE account_id = $1 AND ref = $2', [account, input.video],
              );
              if (!rowCount) partnerError(404, '등록할 수 있는 동영상을 찾을 수 없어요.');
            }
            const title = input.title ?? news.title;
            const body = input.text ?? news.text;
            const video = input.video === undefined ? news.video : input.video;
            if (operation === 'create') {
              await client.query(`
                INSERT INTO naver_virtual.pn04_news (account_id, ref, title, body, video_ref, created_at)
                VALUES ($1,$2,$3,$4,$5,$6)
              `, [account, news.ref, title, body, video, now]);
            } else {
              await client.query(`UPDATE naver_virtual.pn04_news SET title = $3, body = $4, video_ref = $5
                WHERE account_id = $1 AND ref = $2`, [account, news.ref, title, body, video]);
            }
            if (input.pin !== undefined) await applyPin(client, account, news, today, input.pin);
            return news.ref;
          });
          if (operation === 'delete') return reply.code(204).send();
          return context.transaction(request, (client) => read(client, account, ref(result.ref), today));
        },
      });
    }
  },
};
