import type { Pool } from 'pg';
import { inStore } from '../../scope.ts';
import { matchNotices, type GrantNotice, type GrantProvider } from './bizinfo.ts';
import { create, lockCommands, noticesForSync, run, type Context } from './records.ts';

type Profile = { region: string; industry: string };
const korea = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });
const systemActor = '00000000-0000-0000-0000-000000000001';

export async function grantSync(ctx: Context, profile: Profile, mode: GrantProvider['mode'], notices: GrantNotice[]) {
  const { region, industry } = profile;
  if (mode === 'live') {
    await ctx.db.query(`INSERT INTO insight.grant_refresh_profile (store_id, region, industry, attempt_day, fetched_at)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (store_id) DO UPDATE SET region = EXCLUDED.region,
      industry = EXCLUDED.industry, attempt_day = EXCLUDED.attempt_day, fetched_at = EXCLUDED.fetched_at`,
    [ctx.storeId, region, industry, korea.format(ctx.now), ctx.now]);
    await ctx.db.query('DELETE FROM insight.grant_provider_notice WHERE store_id = $1', [ctx.storeId]);
    await ctx.db.query(`INSERT INTO insight.grant_provider_notice (store_id, provider_id, notice, fetched_at)
      SELECT $1, notice->>'providerId', notice, $2 FROM jsonb_array_elements($3::jsonb) AS notice`,
    [ctx.storeId, ctx.now, JSON.stringify(notices)]);
  }
  const fetched = matchNotices(notices, region, industry, mode === 'live')
    .filter(notice => mode === 'fake' || notice.deadline === null || notice.deadline >= ctx.businessDay);
  const existing = await noticesForSync(ctx, fetched.map(notice => notice.noticeId));
  const pending = new Map(existing.map(notice => [notice.id, notice]));
  const upserts = fetched.map(notice => {
    const previous = pending.get(notice.noticeId);
    pending.delete(notice.noticeId);
    const data = { ...notice, region, industry, reviewStatus: previous?.data.reviewStatus ?? 'before',
      matchStatus: 'matched', sourceMode: mode, sourceUpdatedAt: ctx.now.toISOString() };
    return create('notice', data, { id: notice.noticeId });
  });
  const refreshed = new Set(notices.map(notice => notice.noticeId));
  const remove = [...pending.values()].filter(notice => !notice.archived && (notice.data.region !== region
    || notice.data.industry !== industry || notice.data.sourceMode !== mode
    || (mode === 'live' && (refreshed.has(notice.id) ||
      typeof notice.data.deadline === 'string' && notice.data.deadline < ctx.businessDay))));
  const changes = [...upserts, ...remove.map(notice => ({ ...notice, archived: true }))];
  return { resourceId: changes[0]?.id ?? ctx.storeId, changes };
}

export async function refreshGrantStore(pool: Pool, provider: GrantProvider, storeId: string, at: Date) {
  const day = korea.format(at);
  const profile = await inStore(pool, storeId, async db => {
    const result = await db.query<Profile>(`UPDATE insight.grant_refresh_profile SET attempt_day = $2
      WHERE store_id = $1 AND (attempt_day IS NULL OR attempt_day < $2)
      RETURNING region, industry`, [storeId, day]);
    return result.rows[0];
  });
  if (!profile) return;
  const notices = await provider.load(profile.region);
  await inStore(pool, storeId, async db => {
    await lockCommands(db, storeId);
    // A newer manual sync can have changed the filter or already committed this day's data.
    const claim = await db.query(`SELECT 1 FROM insight.grant_refresh_profile
      WHERE store_id = $1 AND attempt_day = $2 AND region = $3 AND industry = $4
        AND (fetched_at IS NULL OR fetched_at < $5)`, [storeId, day, profile.region, profile.industry, at]);
    if (!claim.rowCount) return;
    const ctx = { db, storeId, actorId: systemActor, now: at, businessDay: day };
    await run(ctx, `bizinfo-daily:${day}`, profile, 'sync', () => grantSync(ctx, profile, 'live', notices));
  });
}

export function startGrantRefresh(pool: Pool, provider: GrantProvider, initialStoreId: string | undefined, report: () => void) {
  let current: Promise<void> | undefined;
  const initialize = (storeId: string) => inStore(pool, storeId, db => db.query(`INSERT INTO insight.grant_refresh_profile
    (store_id, region, industry) VALUES ($1, '서울', '카페') ON CONFLICT (store_id) DO NOTHING`, [storeId]));
  const tick = () => {
    if (current) return;
    const at = new Date();
    current = (async () => {
      if (initialStoreId) await initialize(initialStoreId);
      const { rows } = await pool.query<{ store_id: string }>(
        'SELECT insight.due_grant_refreshes($1) AS store_id', [korea.format(at)]);
      for (const { store_id } of rows) {
        await refreshGrantStore(pool, provider, store_id, at).catch(report);
      }
    })().catch(report).finally(() => { current = undefined; });
  };
  tick();
  const timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await current;
  };
}
