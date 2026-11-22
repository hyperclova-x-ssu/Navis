import { randomUUID } from 'node:crypto';
import type { PersonaCapability } from '../../app.ts';
import { digest } from '../pn11/oauth.ts';
import { type Channel, type ClipPublication, type ClipUpload, type OwnerReport } from
  '../../../../packages/naver/contracts/pn12/index.ts';
import { registerAds } from './ads.ts';
import { shiftDay, validDay } from './dates.ts';

type Metrics = Partial<Record<OwnerReport['cards'][number]['metric'], number>>;
type ReportRow = { day: string; metrics: Metrics };
const kstDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });
const prefix = '/partner-assumed/v1';

function totals(rows: ReportRow[], startDate: string, endDate: string): Metrics {
  const totals: Metrics = {};
  const days = rows.filter((row) => row.day >= startDate && row.day <= endDate);
  const expectedDays = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
  if (days.length !== expectedDays) return totals;
  for (const [metric, value] of Object.entries(days[0]?.metrics ?? {}) as [keyof Metrics, number][]) {
    if (days.every((row) => row.metrics[metric] !== undefined)) {
      totals[metric] = days.slice(1).reduce((sum, row) => sum + row.metrics[metric]!, value);
    }
  }
  return totals;
}

function reportCards(channel: Channel, startDate: string, endDate: string, rows: ReportRow[]): OwnerReport {
  const cards: OwnerReport['cards'] = [];
  if (channel === 'blog') {
    const daily = rows.find((row) => row.day === endDate)?.metrics.dailyViews;
    if (daily !== undefined) {
      cards.push({ metric: 'dailyViews', value: daily });
      const first = rows[0]?.day;
      if (first) {
        const cumulativeViews = totals(rows, first, endDate).dailyViews;
        if (cumulativeViews !== undefined) cards.push({ metric: 'cumulativeViews', value: cumulativeViews,
          period: { startDate: first, endDate } });
      }
    }
  } else {
    const current = totals(rows, startDate, endDate);
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
    const previous = totals(rows, shiftDay(startDate, -days), shiftDay(endDate, -days));
    for (const [key, value] of Object.entries(current)) {
      const metric = key as keyof Metrics;
      const before = previous[metric];
      const changeRate = before ? Number((100 * (value - before) / before).toFixed(2)) : undefined;
      cards.push({ metric, value, ...(changeRate !== undefined && { changeRate }) });
    }
  }
  return { period: { startDate, endDate }, cards };
}

function clipInput(body: unknown): ClipUpload | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const { media, caption, category, tags, visibility, ...extra } = body as Record<string, unknown>;
  if (Object.keys(extra).length || typeof media !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(media) ||
      (visibility !== 'public' && visibility !== 'private') ||
      (caption !== undefined && (typeof caption !== 'string' || [...caption].length > 3000)) ||
      (category !== undefined && (typeof category !== 'string' || !category.trim())) ||
      (tags !== undefined && (!Array.isArray(tags) || tags.length > 5 ||
        !tags.every((tag) => typeof tag === 'string' && /^#?[\p{L}\p{N}_]+$/u.test(tag))))) return;
  return { media, visibility, ...(caption !== undefined && { caption }), ...(category !== undefined && { category }),
    ...(tags !== undefined && { tags }) };
}

export const personaCapability: PersonaCapability = {
  id: 'pn12',
  migrations: [{
    id: 'pn12-reports-001',
    up: `
      CREATE TABLE naver_virtual.pn12_report (
        account_id text NOT NULL, channel text NOT NULL CHECK (channel IN ('place','blog','clip')),
        day date NOT NULL, metrics jsonb NOT NULL,
        PRIMARY KEY (account_id, channel, day)
      );
      CREATE TABLE naver_virtual.pn12_ads (
        account_id text NOT NULL, ad_id text NOT NULL, day date NOT NULL,
        impressions integer NOT NULL CHECK (impressions >= 0), clicks integer NOT NULL CHECK (clicks >= 0),
        cost integer NOT NULL CHECK (cost >= 0), PRIMARY KEY (account_id, ad_id, day)
      );
      CREATE TABLE naver_virtual.pn12_clip_media (
        account_id text NOT NULL, ref text NOT NULL, PRIMARY KEY (account_id, ref)
      );
      CREATE TABLE naver_virtual.pn12_clip (
        account_id text NOT NULL, ref uuid NOT NULL, media_ref text NOT NULL,
        caption text, category text, tags text[], visibility text NOT NULL CHECK (visibility IN ('public','private')),
        published_at timestamptz NOT NULL, PRIMARY KEY (account_id, ref),
        FOREIGN KEY (account_id, media_ref) REFERENCES naver_virtual.pn12_clip_media (account_id, ref)
      );
      ALTER TABLE naver_virtual.pn12_report ENABLE ROW LEVEL SECURITY;
      ALTER TABLE naver_virtual.pn12_ads ENABLE ROW LEVEL SECURITY;
      ALTER TABLE naver_virtual.pn12_clip_media ENABLE ROW LEVEL SECURITY;
      ALTER TABLE naver_virtual.pn12_clip ENABLE ROW LEVEL SECURITY;
      CREATE POLICY account_scope ON naver_virtual.pn12_report
        USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
      CREATE POLICY account_scope ON naver_virtual.pn12_ads
        USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
      CREATE POLICY account_scope ON naver_virtual.pn12_clip_media
        USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
      CREATE POLICY account_scope ON naver_virtual.pn12_clip
        USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
      GRANT SELECT ON naver_virtual.pn12_report, naver_virtual.pn12_ads, naver_virtual.pn12_clip_media TO nvirtual_run;
      GRANT SELECT, INSERT ON naver_virtual.pn12_clip TO nvirtual_run;
    `,
    down: 'DROP TABLE naver_virtual.pn12_clip, naver_virtual.pn12_clip_media, naver_virtual.pn12_ads, naver_virtual.pn12_report;',
  }],
  async seed(client, { accountId, now, previousGeneration }) {
    if (previousGeneration) await client.query('DELETE FROM naver_virtual.pn12_clip WHERE account_id = $1', [accountId]);
    const date = kstDay.format(now);
    await client.query('DELETE FROM naver_virtual.pn12_report WHERE account_id = $1', [accountId]);
    await client.query(`
      INSERT INTO naver_virtual.pn12_report (account_id, channel, day, metrics)
      SELECT $1, channel, $2::date - days, metrics
      FROM generate_series(1, 14) AS days
      CROSS JOIN LATERAL (VALUES
        ('place', jsonb_build_object('views', 155 - 4 * days, 'bookingOrderApplications', 3 + days % 3, 'reviews', days % 4)),
        ('blog', jsonb_build_object('dailyViews', 22 + days % 8)),
        ('clip', jsonb_build_object('clipViews', 95 - 3 * days, 'profileViews', 12 - days / 2, 'newFollowers', days % 3))
      ) observations(channel, metrics)
      WHERE channel <> 'blog' OR days < 14
    `, [accountId, date]);
    await client.query('DELETE FROM naver_virtual.pn12_ads WHERE account_id = $1', [accountId]);
    await client.query(`
      INSERT INTO naver_virtual.pn12_ads (account_id, ad_id, day, impressions, clicks, cost)
      SELECT $1, ad_id, $2::date - days, positions * (110 - 5 * days), positions * (12 - days), positions * (1200 - 50 * days)
      FROM generate_series(1, 7) AS days CROSS JOIN (VALUES
        ('cmp-a001-01-000000000000001', 1), ('cmp-a001-01-000000000000002', 2)
      ) AS campaigns(ad_id, positions)
    `, [accountId, date]);
    await client.query(`
      INSERT INTO naver_virtual.pn12_clip_media (account_id, ref) VALUES ($1, 'fixture-cafe-promo')
      ON CONFLICT DO NOTHING
    `, [accountId]);
  },
  register(app, context) {
    registerAds(app, context);
    const channels = ['place', 'blog', 'clip'] as const;
    for (const channel of channels) {
      // Place 20524, Blog 15314, Clip 25170 in channelSources are the owner-visible field allowlists.
      app.get<{ Querystring: Record<string, string> }>(`${prefix}/reports/${channel}`, {
        config: { personaOperation: `pn12.${channel}` },
      }, async (request, reply) => {
        const { date = shiftDay(kstDay.format(context.now()), -1), unit = 'day', ...extra } = request.query;
        if (!validDay(date) || (unit !== 'day' && (unit !== 'week' || channel !== 'place')) ||
            Object.keys(extra).length || (channel === 'clip' && Object.keys(request.query).length)) {
          return reply.code(400).send({ code: 'INVALID_REQUEST' });
        }
        const days = channel === 'clip' || unit === 'week' ? 7 : 1;
        const startDate = shiftDay(date, 1 - days);
        const from = shiftDay(startDate, channel === 'blog' ? -14 : -days);
        const rows = await context.transaction(request, async (client) => {
          // Isolated PN12 fixtures can run with only the report schema installed.
          const smartCall = channel === 'place' && (await client.query<{ installed: boolean }>(`
            SELECT to_regclass('naver_virtual.pn08_settings') IS NOT NULL AS installed
          `)).rows[0]?.installed;
          return client.query<ReportRow>(`
            SELECT report.day::text, report.metrics ${smartCall ? `
              || CASE WHEN EXISTS (
                SELECT 1 FROM naver_virtual.pn08_settings WHERE account_id = report.account_id
              ) THEN jsonb_build_object('smartCallCalls', (
                SELECT count(*) FROM naver_virtual.pn08_call
                WHERE account_id = report.account_id
                  AND call_at >= (report.day::timestamp AT TIME ZONE 'Asia/Seoul')
                  AND call_at < ((report.day + 1)::timestamp AT TIME ZONE 'Asia/Seoul')
              )) ELSE '{}'::jsonb END
            ` : ''} AS metrics
            FROM naver_virtual.pn12_report AS report
            WHERE report.account_id = $1 AND report.channel = $2 AND report.day BETWEEN $3 AND $4
            ORDER BY report.day
          `, [context.accountId(request), channel, from, date]);
        });
        return reportCards(channel, startDate, date, rows.rows);
      });
    }

    // https://help.naver.com/service/30048/bookmark/24422?osType=COMMONOS
    app.post(`${prefix}/clips`, { config: { personaOperation: 'pn12.clip.create' } }, async (request, reply) => {
      const input = clipInput(request.body);
      if (!input) return reply.code(400).send({ code: 'INVALID_REQUEST' });
      const account = context.accountId(request);
      const media = await context.transaction(request, async (client) => client.query(`
        SELECT ref FROM naver_virtual.pn12_clip_media WHERE account_id = $1 AND ref = $2
      `, [account, input.media]));
      if (!media.rowCount) return reply.code(404).send({ code: 'NOT_FOUND' });
      const publication = await context.effect(request, digest(JSON.stringify(input)), async (client) => {
        const ref = randomUUID();
        await client.query(`
          INSERT INTO naver_virtual.pn12_clip (account_id, ref, media_ref, caption, category, tags, visibility, published_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [account, ref, input.media, input.caption, input.category, input.tags, input.visibility, context.now()]);
        return ref;
      });
      const result: ClipPublication = input.visibility === 'public' ? { link: `https://clip.example.invalid/${publication.ref}` } : {};
      return reply.code(201).header('location', `${prefix}/clips/${publication.ref}`).send(result);
    });

    // https://help.naver.com/service/30048/bookmark/24422?osType=COMMONOS
    app.get<{ Params: { ref: string } }>(`${prefix}/clips/:ref`, { config: { personaOperation: 'pn12.clip.read' } },
      async (request, reply) => {
        const { ref } = request.params;
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(ref)) return reply.code(404).send({ code: 'NOT_FOUND' });
        const { rows } = await context.transaction(request, async (client) => client.query<{ visibility: 'public' | 'private' }>(`
          SELECT visibility FROM naver_virtual.pn12_clip WHERE account_id = $1 AND ref = $2
        `, [context.accountId(request), ref]));
        if (!rows[0]) return reply.code(404).send({ code: 'NOT_FOUND' });
        const result: ClipPublication = rows[0].visibility === 'public' ? { link: `https://clip.example.invalid/${ref}` } : {};
        return result;
      });
  },
};
