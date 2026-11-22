import { cafeBinding, marketingCards } from '../15/card-bindings.ts';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { isUuid } from '../../promo/contracts.ts';
import { inStore } from '../../transaction.ts';
import { storeClock } from '../14/wire.ts';
import { cafePostInput, cafeReceipt, reserveCafePost, finishCafePost, type CafeOptions } from './cafe.ts';
import { readProjectedSales } from './pos.ts';
import { advanceSource, readSourceRevision } from './revision.ts';
import { addTrendCandidate, readTrendCache, readTrendList, removeTrendCandidate, seedTrendList, trendFingerprint, writeTrendCache } from './trend-candidates.ts';
import { createTrendRanker, maxTrendCandidates, trendDays, trendKeyword, trendKeywordKey } from './trend-ranking.ts';
import { matchTrendMenu, type TrendMenuItem } from './trend-menu-match.ts';
import { createTrendRecommendations, defaultTrendKeywords, ruleTrendRecommendations, untrackedTrendRecommendations,
  type TrendCandidateChooser, type TrendRecommendations } from './trend-recommendations.ts';
import { day, invalid, LocalError, parseSearch, period, readNewsReferences, readSales, readSearch, readStoreLocation,
  salesByHour, type Sources } from './sources.ts';

const prefix = '/internal/v1/marketing/stores/:storeId';
const localSources = ['local-changes', 'briefing'];
const offerSources = ['community', 'calendar', 'briefing'];
const trendSources = ['local-trends'];
const coverageFilter = `(kind = 'owner-record' OR EXISTS (
  SELECT 1 FROM marketing.local_coverage coverage
  WHERE coverage.store_id = local_change.store_id AND coverage.region = local_change.region
    AND local_change.kind = ANY (coverage.kinds)
))`;
type Scope = { storeId: string; actorId: string };
type Request = FastifyRequest<{ Params: { storeId: string; id?: string } }>;
type Tx = Scope & { db: PoolClient };
type Receipt = { resourceId: string; revision: number; receiptId: string; affectedSources: string[]; undoUntil?: string };
type Change = { id: string; revision: number; acknowledgedAt: string | null };
type Offer = { id: string; revision: number; recipientStoreId: string; senderStoreId: string;
  status: 'pending' | 'accepted' | 'declined'; interested: boolean; respondBy: string; startsOn: string; endsOn: string };

export type LocalOptions = Sources & {
  cafe?: CafeOptions;
  now?: () => Date;
  readToken: string;
  commandToken: string;
  trendMenu?(owner: Scope): Promise<readonly TrendMenuItem[] | null>;
  chooseTrendCandidates?: TrendCandidateChooser;
  /** Resolve live participation/visibility approval through account. */
  canOffer?(senderStoreId: string, recipientStoreId: string): Promise<boolean>;
  listPeers?(storeId: string): Promise<{ storeId: string; displayName: string }[]>;
};

const digest = (value: string) => createHash('sha256').update(value).digest();

function scope(req: Request, token: Buffer): Scope {
  if (!timingSafeEqual(digest(req.headers.authorization ?? ''), token)) throw new LocalError(401, 'UNAUTHENTICATED');
  const { storeId } = req.params;
  const actorId = req.headers['x-navis-user-id'];
  if (!isUuid(storeId) || !isUuid(actorId) || storeId !== req.headers['x-navis-store-id'] ||
    req.headers['x-navis-store-role'] !== 'owner') throw new LocalError(403, 'FORBIDDEN');
  return { storeId, actorId };
}

function fields(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid();
  return value.trim();
}

function uuid(value: unknown): string {
  if (!isUuid(value)) invalid();
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= 2147483647) invalid();
  return value;
}

function sourceUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const input = text(value, 2048);
  let url: URL;
  try { url = new URL(input); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password) invalid();
  return url.href;
}

function limitOf(value: unknown) {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 200) invalid();
  return Number(value);
}

function page<T extends { id: string; revision: number }>(items: T[], limit: number, sourceRevision: number) {
  return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1].id : null,
    asOf: new Date().toISOString(), sourceRevision };
}

async function readChange(tx: Tx, id: string) {
  const result = await tx.db.query<Change>(`SELECT id, revision, acknowledged_at AS "acknowledgedAt"
    FROM marketing.local_change WHERE store_id = $1 AND id = $2 AND ${coverageFilter}`, [tx.storeId, id]);
  if (!result.rows[0]) throw new LocalError(404, 'NOT_FOUND');
  return result.rows[0];
}

async function readOffer(tx: Tx, id: string) {
  const result = await tx.db.query<Offer>(`SELECT id, revision, sender_store_id AS "senderStoreId",
    recipient_store_id AS "recipientStoreId", status, interested, respond_by::text AS "respondBy",
    starts_on::text AS "startsOn", ends_on::text AS "endsOn"
    FROM marketing.community_offer WHERE id = $1`, [id]);
  if (!result.rows[0]) throw new LocalError(404, 'NOT_FOUND');
  return result.rows[0];
}

async function emit(tx: Tx, type: string, payload: object, aggregateId?: string) {
  // The existing outbox requires uniqueness per store/type/aggregate. Each
  // transition is its own aggregate and carries the model's ID in the payload.
  const transitionId = randomUUID();
  await tx.db.query(`
    WITH seq AS (
      INSERT INTO marketing.outbox_scope (scope_key, last_seq) VALUES ($2, 1)
      ON CONFLICT (scope_key) DO UPDATE SET last_seq = marketing.outbox_scope.last_seq + 1 RETURNING last_seq
    )
    INSERT INTO marketing.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
    SELECT $1, $2::text::uuid, $2, last_seq, $3, $4, clock_timestamp(), $5::jsonb FROM seq`,
  [transitionId, tx.storeId, type, aggregateId ?? transitionId, JSON.stringify(payload)]);
}

async function emitOffer(tx: Tx, offer: Pick<Offer, 'id' | 'senderStoreId' | 'recipientStoreId' | 'startsOn' | 'endsOn'>,
  status: Offer['status'], interested: boolean, revision: number) {
  const payload = { offerId: offer.id, senderStoreId: offer.senderStoreId, recipientStoreId: offer.recipientStoreId,
    status, interested, revision };
  const projections = status === 'accepted' ? {
    calendarProjection: { source: 'community-offer', sourceId: offer.id, revision,
      entry: { date: offer.startsOn, endDate: offer.endsOn } },
  } : {};
  // Both authorized parties need independent scoped projection delivery.
  // Acquire the two outbox scope rows in the same order for every offer.
  for (const storeId of [offer.senderStoreId, offer.recipientStoreId].sort()) {
    await tx.db.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    await advanceSource(tx.db, storeId, 'community');
    await emit({ ...tx, storeId }, status === 'accepted' ? 'marketing.partnership_changed.v1' : 'marketing.partnership_offer_changed.v1',
      { ...payload, ...projections }, status === 'accepted' ? offer.id : undefined);
  }
  await tx.db.query("SELECT set_config('app.store_id', $1, true)", [tx.storeId]);
}

async function command(tx: Tx, req: Request, operation: string, input: object,
  apply: () => Promise<{ id: string; revision: number; undoUntil?: string }>, affectedSources: string[]): Promise<Receipt> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_:-]{8,128}$/.test(key)) invalid();
  const fingerprint = digest(JSON.stringify([operation, input])).toString('hex');
  const args = [tx.storeId, tx.actorId, key];
  const previous = (await tx.db.query<{ fingerprint: string; receipt: Receipt }>(`
    SELECT fingerprint, receipt FROM marketing.local_command WHERE store_id = $1 AND actor_id = $2 AND key = $3`, args)).rows[0];
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new LocalError(409, 'IDEMPOTENCY_CONFLICT');
    return previous.receipt;
  }
  const result = await apply();
  const receipt = { resourceId: result.id, revision: result.revision, receiptId: randomUUID(), affectedSources,
    ...(result.undoUntil && { undoUntil: result.undoUntil }) };
  await tx.db.query(`INSERT INTO marketing.local_command (store_id, actor_id, key, fingerprint, receipt)
    VALUES ($1, $2, $3, $4, $5)`, [...args, fingerprint, receipt]);
  return receipt;
}

async function changeAcknowledgement(tx: Tx, id: string, expectedRevision: number, acknowledge: boolean) {
  const row = await readChange(tx, id);
  if (expectedRevision !== row.revision) throw new LocalError(409, 'STALE_REVISION');
  if ((row.acknowledgedAt !== null) === acknowledge) return row;
  const nextRevision = row.revision + 1;
  const result = await tx.db.query<{ undoUntil: Date }>(`UPDATE marketing.local_change SET revision = revision + 1,
    acknowledged_at = CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE store_id = $1 AND id = $2
    RETURNING acknowledged_at + interval '6 seconds' AS "undoUntil"`, [tx.storeId, id, acknowledge]);
  await advanceSource(tx.db, tx.storeId, 'local-changes');
  await emit(tx, 'marketing.local_change_acknowledged.v1', { changeId: id, revision: nextRevision, acknowledged: acknowledge });
  return { id, revision: nextRevision, undoUntil: result.rows[0].undoUntil?.toISOString() };
}

export function registerLocalMarketingRoutes(app: FastifyInstance, pool: Pool, options: LocalOptions) {
  if (!options.readToken || !options.commandToken || options.readToken === options.commandToken) {
    throw new Error('Local marketing read and confirmed command credentials must be distinct');
  }
  const cafe = options.cafe;
  if (cafe && (!['fake', 'virtual'].includes(cafe.mode) ||
    cafe.cardToken !== undefined && (!cafe.cardToken || [options.readToken, options.commandToken].includes(cafe.cardToken)))) {
    throw new Error('Café requires a fake or virtual provider and a distinct legacy credential if configured');
  }
  const cafeToken = cafe?.cardToken && digest(`Bearer ${cafe.cardToken}`);
  const readToken = digest(`Bearer ${options.readToken}`);
  const commandToken = digest(`Bearer ${options.commandToken}`);
  const now = options.now ?? (() => new Date());
  const rankTrends = createTrendRanker(options.searchInterest, now);
  const recommend = createTrendRecommendations(options.chooseTrendCandidates, now);
  const menuFor = (owner: Scope) => options.trendMenu?.(owner) ?? Promise.resolve([]);
  function recommendationFor(owner: Scope, menu: readonly TrendMenuItem[] | null) {
    if (!menu) return Promise.resolve({ events: null, recommendations: ruleTrendRecommendations([], [], now()) });
    return inStore(pool, owner.storeId, async db => {
      const { rows: [context] } = await db.query<{ events: number | null }>(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM marketing.local_coverage WHERE store_id = $1 AND region LIKE '서울 동작구%' AND 'festival' = ANY(kinds)
      ) THEN (SELECT count(*)::integer FROM marketing.local_change WHERE store_id = $1 AND kind = 'festival'
        AND region LIKE '서울 동작구%' AND reference_date BETWEEN $2::date + 1 AND $2::date + 14) END AS events`,
      [owner.storeId, trendDays(now()).to]);
      return context?.events ?? null;
    }).then(async events => ({ events, recommendations: await recommend(owner.storeId, [], menu, events) }));
  }
  async function initializeTrendCandidates(owner: Scope, menu: readonly TrendMenuItem[] | null, recommendations: TrendRecommendations) {
    if (!menu) throw new LocalError(503, 'UNAVAILABLE');
    return inStore(pool, owner.storeId, db => seedTrendList({ ...owner, db }, defaultTrendKeywords(recommendations, menu, now())), { serialize: true });
  }
  function businessDate(req: Request) {
    const timezone = req.headers['x-navis-store-timezone'];
    const dayStart = req.headers['x-navis-business-day-start'];
    return storeClock(now(), typeof timezone === "string" ? timezone : 'Asia/Seoul',
      typeof dayStart === "string" ? dayStart : '00:00').businessDate;
  }
  app.register(async routes => {
    routes.addHook('onRequest', async (_req, reply) => { reply.header('cache-control', 'no-store'); });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof LocalError) return reply.code(error.status).send({ code: error.code, reason: error.reason });
      const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      if (status === 400 || status === 413 || status === 415) {
        return reply.code(status).send({ code: 'INVALID_REQUEST', reason: 'INVALID_REQUEST' });
      }
      request.log.error('Local marketing request failed');
      return reply.code(503).send({ code: 'UNAVAILABLE', reason: 'UNAVAILABLE' });
    });
    type Params = { storeId: string; id?: string };
    const get = <T>(path: string, handler: (tx: Tx, req: Request) => Promise<T>,
      addSources?: (result: T, claims: Scope, req: Request) => Promise<T>) =>
      routes.get<{ Params: Params }>(prefix + path, async req => {
        const claims = scope(req, readToken);
        const result = await inStore(pool, claims.storeId, db => handler({ ...claims, db }, req));
        return addSources ? addSources(result, claims, req) : result;
      });
    const post = (path: string, handler: (tx: Tx, req: Request) => Promise<Receipt>, method: 'POST' | 'DELETE' = 'POST') =>
      routes.route<{ Params: Params }>({ method, url: prefix + path, bodyLimit: 8192, async handler(req) {
        const claims = scope(req, commandToken);
        return inStore(pool, claims.storeId, db => handler({ ...claims, db }, req), { serialize: true });
      } });
    const salesFor = (tx: Tx, range: ReturnType<typeof period>) => readSales({
      sales: options.sales ?? ((storeId, period) => readProjectedSales(tx.db, storeId, period)),
    }, tx.storeId, range);

    get('/local-changes', async (tx, req) => {
      const query = fields(req.query, ['from', 'to', 'cursor', 'limit', 'includeNews']);
      if (query.includeNews !== undefined && query.includeNews !== '1') invalid();
      const range = period(query);
      const limit = limitOf(query.limit);
      const cursor = query.cursor === undefined ? null : uuid(query.cursor);
      const result = await tx.db.query<Change>(`
        SELECT id, revision, kind, title, region, authority, source_url AS "sourceUrl", change_type AS "changeType",
          date_kind AS "dateKind", reference_date::text AS "referenceDate",
          acknowledged_at AS "acknowledgedAt", imported_at AS "updatedAt"
        FROM marketing.local_change
        WHERE store_id = $1 AND reference_date BETWEEN $2 AND $3 AND ${coverageFilter} AND
          ($4::uuid IS NULL OR (reference_date, id) < (SELECT reference_date, id
            FROM marketing.local_change WHERE store_id = $1 AND id = $4))
        ORDER BY reference_date DESC, id DESC LIMIT $5`, [tx.storeId, range.from, range.to, cursor, limit + 1]);
      const counts = await tx.db.query<{ unread: number }>(`
        SELECT count(*)::integer AS unread FROM marketing.local_change
        WHERE store_id = $1 AND reference_date BETWEEN $2 AND $3 AND ${coverageFilter}
          AND acknowledged_at IS NULL`, [tx.storeId, range.from, range.to]);
      const coverage = (await tx.db.query<{ region: string; kinds: string[]; referenceDate: string; fetchedAt: Date | null }>(`SELECT region, kinds, reference_date::text AS "referenceDate", fetched_at AS "fetchedAt"
        FROM marketing.local_coverage WHERE store_id = $1`, [tx.storeId])).rows[0] ?? null;
      return { ...page(result.rows, limit, await readSourceRevision(tx.db, tx.storeId, 'local-changes')),
        period: range, unreadCount: counts.rows[0].unread, coverage };
    }, async (page, owner, req) => {
      const { includeNews, cursor } = req.query as { includeNews?: string; cursor?: string };
      if (includeNews !== '1' || cursor) return page;
      // The DB supplies the supported region. These links never enter the changes list.
      const newsReferences = page.coverage && await readNewsReferences(options, owner.storeId, page.coverage.region, page.period);
      return newsReferences ? { ...page, newsReferences } : page;
    });

    post('/local-changes', async (tx, req) => {
      const body = fields(req.body, ['title', 'region', 'referenceDate', 'sourceUrl']);
      const input = { title: text(body.title, 160), region: text(body.region, 100),
        referenceDate: day(body.referenceDate), sourceUrl: sourceUrl(body.sourceUrl) };
      return command(tx, req, 'localChanges.create', input, async () => {
        const id = randomUUID();
        await tx.db.query(`INSERT INTO marketing.local_change
          (store_id, id, kind, title, region, authority, source_url, date_kind, reference_date)
          VALUES ($1, $2, 'owner-record', $3, $4, '사장님 기록', $5, 'recorded-date', $6)`,
        [tx.storeId, id, input.title, input.region, input.sourceUrl, input.referenceDate]);
        await advanceSource(tx.db, tx.storeId, 'local-changes');
        await emit(tx, 'marketing.local_change_recorded.v1', { changeId: id, revision: 1 });
        return { id, revision: 1 };
      }, localSources);
    });

    for (const [path, acknowledge] of [['ack', true], ['unack', false]] as const) {
      post(`/local-changes/:id/${path}`, async (tx, req) => {
        const id = uuid(req.params.id);
        const expectedRevision = revision(fields(req.body, ['expectedRevision']).expectedRevision);
        return command(tx, req, `localChanges.${path}`, { id, expectedRevision },
          () => changeAcknowledgement(tx, id, expectedRevision, acknowledge), localSources);
      });
    }

    post('/local-changes/receipts/:id/undo', async (tx, req) => {
      const id = uuid(req.params.id);
      fields(req.body ?? {}, []);
      return command(tx, req, 'localChanges.undo', { id }, async () => {
        const { rows: [row] } = await tx.db.query<{ receipt: Receipt; active: boolean }>(`
          SELECT receipt, (receipt->>'undoUntil')::timestamptz > clock_timestamp() AS active
          FROM marketing.local_command WHERE store_id = $1 AND actor_id = $2 AND receipt_id = $3`,
        [tx.storeId, tx.actorId, id]);
        if (!row?.receipt.undoUntil) throw new LocalError(404, 'NOT_FOUND');
        if (!row.active) throw new LocalError(409, 'UNDO_EXPIRED');
        return changeAcknowledgement(tx, row.receipt.resourceId, row.receipt.revision, false);
      }, localSources);
    });

    get('/trade-area', async (tx, req) => {
      const query = fields(req.query, ['from', 'to', 'quarter', 'weekday']);
      const range = period(query);
      const quarter = text(query.quarter, 7);
      const weekday = typeof query.weekday === 'string' && /^[1-7]$/.test(query.weekday) ? Number(query.weekday) : invalid();
      if (!/^\d{4}-Q[1-4]$/.test(quarter)) invalid();
      const official = (await tx.db.query(`
        SELECT band.region, band.quarter, band.weekday, band.start_hour AS "startHour", band.end_hour AS "endHour",
          band.estimate, band.reference_date::text AS "referenceDate", band.refreshed_at AS "refreshedAt", band.source_url AS "sourceUrl"
        FROM marketing.local_population_band band JOIN marketing.local_coverage coverage USING (store_id, region)
        WHERE band.store_id = $1 AND band.quarter = $2 AND band.weekday = $3 ORDER BY band.start_hour`,
      [tx.storeId, quarter, weekday])).rows;
      const sales = await salesFor(tx, range);
      const hourly = salesByHour(sales.items, weekday);
      return { asOf: new Date().toISOString(), period: range,
        population: { status: official.length ? 'available' : 'unavailable', source: 'seoul-living-population',
          unit: 'movement-estimate', quarter, weekday, items: official },
        sales: { ...sales, status: hourly.length || sales.status === 'unavailable' ? sales.status : 'empty',
          unit: 'quantity', items: hourly } };
    }, async (area, owner) => {
      const location = await readStoreLocation(options, owner.storeId);
      return location ? { ...area, location } : area;
    });

    routes.get<{ Params: Params }>(prefix + '/local-trends', async req => {
      const owner = scope(req, readToken);
      const query = fields(req.query, ['from', 'to', 'keyword']);
      const range = period(query);
      const request = query.keyword === undefined ? null : parseSearch(query);
      if (!request) {
        const menu = await menuFor(owner);
        const current = await inStore(pool, owner.storeId, db => readTrendList({ ...owner, db }));
        const suggestion = recommendationFor(owner, menu);
        const list = current ?? await initializeTrendCandidates(owner, menu, (await suggestion).recommendations);
        const keywords = list.items.map(item => item.keyword);
        const fingerprint = trendFingerprint(keywords, options.trendProvider);
        const [ranking, { events, recommendations }] = await Promise.all([
          (async () => {
            const cached = options.searchInterest && await inStore(pool, owner.storeId, db =>
              readTrendCache({ ...owner, db }, trendDays(now()).to, fingerprint));
            if (cached) return cached;
            const result = await rankTrends(owner.storeId, keywords);
            if (result.fetchedAt) await inStore(pool, owner.storeId, db => writeTrendCache({ ...owner, db }, fingerprint, result, list.revision));
            return result;
          })(),
          suggestion,
        ]);
        const ids = new Map(list.items.map(item => [item.keyword, item.id]));
        return { asOf: now().toISOString(), period: range, search: null, candidates: list.items, sourceRevision: list.revision,
          ranking: { ...ranking, events, recommendations: untrackedTrendRecommendations(recommendations, keywords, menu ?? [], now()), items: ranking.items.map(item => {
            const menuName = menu ? matchTrendMenu(item.keyword, menu) : null;
            return { ...item, id: ids.get(item.keyword)!, menuName, isMenu: menu ? menuName !== null : null };
          }) },
          // Retain the former field for installed clients without reading POS data for Widget 20.
          sales: { status: 'unavailable', source: 'pos', unit: 'quantity', items: [] } };
      }
      const search = await readSearch(options, owner.storeId, request);
      return { asOf: now().toISOString(), period: range, search,
        sales: { status: 'unavailable', source: 'pos', unit: 'quantity', items: [] } };
    });

    routes.get<{ Params: Params }>(prefix + '/local-trends/candidates', async req => {
      const owner = scope(req, readToken);
      fields(req.query, []);
      const current = await inStore(pool, owner.storeId, db => readTrendList({ ...owner, db }));
      const list = current ?? await menuFor(owner).then(async menu => initializeTrendCandidates(owner, menu, (await recommendationFor(owner, menu)).recommendations));
      return { items: list.items, nextCursor: null, asOf: now().toISOString(), sourceRevision: list.revision };
    });

    routes.post<{ Params: Params }>(prefix + '/local-trends/candidates', { bodyLimit: 8192 }, async req => {
      const owner = scope(req, commandToken);
      const keyword = trendKeyword(fields(req.body, ['keyword']).keyword);
      const current = await inStore(pool, owner.storeId, db => readTrendList({ ...owner, db }));
      const menu = current ? [] : await menuFor(owner);
      if (!menu) throw new LocalError(503, 'UNAVAILABLE');
      const defaults = current ? [] : defaultTrendKeywords((await recommendationFor(owner, menu)).recommendations, menu, now());
      return inStore(pool, owner.storeId, db => {
        const tx = { ...owner, db };
        return command(tx, req, 'localTrends.addCandidate', { keyword }, async () => {
          const candidate = await addTrendCandidate(tx, keyword, defaults);
          await emit(tx, 'marketing.local_trend_candidates_changed.v1', { candidateId: candidate.id, revision: candidate.revision, operation: 'added' });
          return candidate;
        }, trendSources);
      }, { serialize: true });
    });

    post('/local-trends/candidates/:id', async (tx, req) => {
      const id = uuid(req.params.id);
      const body = fields(req.body, ['expectedRevision', 'confirmed']);
      const expectedRevision = revision(body.expectedRevision);
      if (body.confirmed !== true) invalid();
      return command(tx, req, 'localTrends.removeCandidate', { id, expectedRevision }, async () => {
        const candidate = await removeTrendCandidate(tx, id, expectedRevision);
        await emit(tx, 'marketing.local_trend_candidates_changed.v1', { candidateId: id, revision: candidate.revision, operation: 'removed' });
        return candidate;
      }, trendSources);
    }, 'DELETE');

    routes.post<{ Params: Params }>(prefix + '/local-trends/preview', { bodyLimit: 8192 }, async req => {
      const owner = scope(req, commandToken);
      const { keywords, useDefaults } = fields(req.body, ['keywords', 'useDefaults']);
      if (!Array.isArray(keywords) || keywords.length > maxTrendCandidates ||
          (useDefaults !== undefined && (useDefaults !== true || keywords.length !== 0))) invalid();
      const menu = await menuFor(owner);
      const suggestion = recommendationFor(owner, menu);
      const initialKeywords = useDefaults === true ? defaultTrendKeywords((await suggestion).recommendations, menu ?? [], now()) : undefined;
      const names = initialKeywords ?? keywords.map(trendKeyword);
      if (new Set(names.map(trendKeywordKey)).size !== names.length) invalid();
      const [ranking, { events, recommendations }] = await Promise.all([
        (async () => {
          const cached = options.searchInterest && await inStore(pool, owner.storeId, db =>
            readTrendCache({ ...owner, db }, trendDays(now()).to, trendFingerprint(names, options.trendProvider)));
          return cached || rankTrends(owner.storeId, names);
        })(),
        suggestion,
      ]);
      return { ...ranking, events, initialKeywords, recommendations: untrackedTrendRecommendations(recommendations, names, menu ?? [], now()) };
    });

    routes.get<{ Params: Params }>(prefix + '/community/cafe-boards', async req => {
      const owner = scope(req, readToken);
      fields(req.query, []);
      if (!cafe) throw new LocalError(503, 'PROVIDER_UNAVAILABLE');
      return { items: (await cafe.boards(owner)).map(({ clubid, menuid }) => ({ clubid, menuid })) };
    });
    get('/community/cafe-posts', async (tx, req) => {
      const query = fields(req.query, ['cursor', 'limit']);
      const limit = limitOf(query.limit);
      const cursor = query.cursor === undefined ? null : uuid(query.cursor);
      const { rows } = await tx.db.query<{ id: string; revision: number }>(`
        SELECT id, receipt_id AS "receiptId", revision, state, subject,
          article_id AS "articleId", article_url AS "articleUrl", updated_at AS "updatedAt"
        FROM marketing.community_cafe_post
        WHERE store_id=$1 AND actor_id=$2 AND ($3::uuid IS NULL OR id>$3)
        ORDER BY id LIMIT $4`, [tx.storeId, tx.actorId, cursor, limit + 1]);
      return page(rows, limit, await readSourceRevision(tx.db, tx.storeId, 'community'));
    });
    routes.post<{ Params: Params }>(prefix + '/community/cafe-posts', { bodyLimit: 64 * 1024 }, async req => {
      if (!cafe) throw new LocalError(503, 'PROVIDER_UNAVAILABLE');
      const privateCardRequest = cafeToken && timingSafeEqual(digest(req.headers.authorization ?? ''), cafeToken);
      const owner = scope(req, privateCardRequest ? cafeToken : readToken);
      const input = cafePostInput(req.body);
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !key.startsWith('navis:') || !isUuid(key.slice(6))) invalid();
      // Resolve the owner's board grant before the store lock (RV-GAP-B-9); a replay never needs it.
      const boards = await cafe.boards(owner).catch(() => null);
      const { row, created } = await inStore(pool, owner.storeId, async db => {
        const prepared = await reserveCafePost({ ...owner, db }, key, input, async () => {
          if (!boards) throw new LocalError(503, 'PROVIDER_UNAVAILABLE');
          const revision = await readSourceRevision(db, owner.storeId, 'community');
          if (!await marketingCards.consume(db, cafeBinding(owner, revision, input), key.slice(6), now())) {
            throw new LocalError(403, 'CARD_REQUIRED');
          }
          return boards.some(board => input.clubid === board.clubid && input.menuid === board.menuid);
        });
        if (prepared.created) await advanceSource(db, owner.storeId, 'community');
        return prepared;
      }, { serialize: true });
      if (!created) return cafeReceipt(row);
      try {
        const result = await cafe.publish(owner, { ...input, attemptKey: row.receiptId });
        return await inStore(pool, owner.storeId, async db => {
          const saved = await finishCafePost({ ...owner, db }, row.id, result, input);
          await advanceSource(db, owner.storeId, 'community');
          await emit({ ...owner, db }, 'marketing.cafe_post_published.v1',
            { postId: row.id, revision: saved.revision }, row.id);
          return cafeReceipt(saved);
        }, { serialize: true });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error
          && ['FORBIDDEN', 'REJECTED', 'INVALID_INPUT', 'NOT_CONFIGURED'].includes(String(error.code))) {
          return inStore(pool, owner.storeId, async db => {
            const failed = await finishCafePost({ ...owner, db }, row.id, null);
            await advanceSource(db, owner.storeId, 'community');
            return cafeReceipt(failed);
          }, { serialize: true });
        }
        return cafeReceipt(row);
      }
    });

    get('/offers', async (tx, req) => {
      const query = fields(req.query, ['cursor', 'limit']);
      const limit = limitOf(query.limit);
      const cursor = query.cursor === undefined ? null : uuid(query.cursor);
      const result = await tx.db.query<Offer>(`
        SELECT id, revision, sender_store_id AS "senderStoreId", recipient_store_id AS "recipientStoreId",
          title, terms, starts_on::text AS "startsOn", ends_on::text AS "endsOn", respond_by::text AS "respondBy",
          interested, status, updated_at AS "updatedAt", 'direct' AS visibility,
          CASE WHEN status = 'accepted' THEN shared_contact END AS "sharedContact"
        FROM marketing.community_offer
        WHERE ($1::uuid IS NULL OR (respond_by, id) > (SELECT respond_by, id FROM marketing.community_offer WHERE id = $1))
        ORDER BY respond_by, id LIMIT $2`, [cursor, limit + 1]);
      const date = businessDate(req);
      const items = result.rows.map(row => ({ ...row,
        canRespond: row.recipientStoreId === tx.storeId && row.status === 'pending' && row.respondBy >= date }));
      return page(items, limit, await readSourceRevision(tx.db, tx.storeId, 'community'));
    });

    get('/offers/peers', async (tx, req) => {
      fields(req.query, []);
      const peers = await options.listPeers?.(tx.storeId);
      return { status: peers ? 'available' : 'unavailable', items: (peers ?? []).filter(peer =>
        isUuid(peer.storeId) && peer.storeId !== tx.storeId && typeof peer.displayName === 'string' &&
        peer.displayName.length > 0 && peer.displayName.length <= 160).slice(0, 200) };
    });

    post('/offers', async (tx, req) => {
      const body = fields(req.body, ['recipientStoreId', 'title', 'terms', 'startsOn', 'endsOn', 'respondBy', 'sharedContact']);
      const input = { recipientStoreId: uuid(body.recipientStoreId), title: text(body.title, 160),
        terms: text(body.terms, 1000), startsOn: day(body.startsOn), endsOn: day(body.endsOn), respondBy: day(body.respondBy),
        sharedContact: body.sharedContact === undefined ? null : text(body.sharedContact, 160) };
      if (input.recipientStoreId === tx.storeId || input.endsOn < input.startsOn || input.respondBy > input.endsOn) invalid();
      return command(tx, req, 'community.create', input, async () => {
        if (input.respondBy < businessDate(req)) throw new LocalError(409, 'OFFER_EXPIRED');
        if (!await options.canOffer?.(tx.storeId, input.recipientStoreId)) throw new LocalError(403, 'FORBIDDEN');
        const id = randomUUID();
        await tx.db.query(`INSERT INTO marketing.community_offer
          (sender_store_id, recipient_store_id, id, title, terms, starts_on, ends_on, respond_by, shared_contact)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tx.storeId, input.recipientStoreId, id, input.title, input.terms, input.startsOn, input.endsOn, input.respondBy, input.sharedContact]);
        await emitOffer(tx, { id, senderStoreId: tx.storeId, recipientStoreId: input.recipientStoreId,
          startsOn: input.startsOn, endsOn: input.endsOn }, 'pending', false, 1);
        return { id, revision: 1 };
      }, offerSources);
    });

    for (const action of ['accept', 'decline', 'interest'] as const) {
      post(`/offers/:id/${action}`, async (tx, req) => {
        const id = uuid(req.params.id);
        const body = fields(req.body, action === 'decline' ? ['expectedRevision', 'confirmed'] : ['expectedRevision']);
        const expectedRevision = revision(body.expectedRevision);
        if (action === 'decline' && body.confirmed !== true) throw new LocalError(400, 'CONFIRMATION_REQUIRED');
        return command(tx, req, `community.${action}`, { id, expectedRevision }, async () => {
          const row = await readOffer(tx, id);
          if (tx.storeId !== row.recipientStoreId || !await options.canOffer?.(row.senderStoreId, row.recipientStoreId)) {
            throw new LocalError(403, 'FORBIDDEN');
          }
          if (expectedRevision !== row.revision) throw new LocalError(409, 'STALE_REVISION');
          if (row.respondBy < businessDate(req)) throw new LocalError(409, 'OFFER_EXPIRED');
          if (row.status !== 'pending') throw new LocalError(409, 'OFFER_CLOSED');
          if (action === 'interest' && row.interested) return row;
          const status = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'pending';
          const interested = action === 'interest' || row.interested;
          const updated = await tx.db.query(`UPDATE marketing.community_offer SET status = $2,
            revision = revision + 1, interested = $3, updated_at = clock_timestamp()
            WHERE id = $1 AND revision = $4`, [id, status, interested, expectedRevision]);
          if (updated.rowCount !== 1) throw new LocalError(409, 'STALE_REVISION');
          await emitOffer(tx, row, status, interested, row.revision + 1);
          return { id, revision: row.revision + 1 };
        }, offerSources);
      });
    }
  });
}
