import type { Pool } from 'pg';
import { isUuid } from '../../promo/contracts.ts';
import { inStore } from '../../transaction.ts';
import { advanceSource } from './revision.ts';
import { day, invalid } from './sources.ts';

type OfficialKind = 'food-license' | 'festival';
type ChangeInput = { id: string; kind: OfficialKind; title: string; authority: string; referenceDate: string; sourceUrl: string };
type PopulationInput = {
  quarter: string; weekday: number; startHour: number; endHour: number; estimate: number;
  referenceDate: string; refreshedAt: string; sourceUrl: string;
};
type Snapshot = {
  region: string; coverageDate: string; kinds: OfficialKind[]; changes: ChangeInput[]; population: PopulationInput[];
  fetchedAt?: string;
};

function officialUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password ||
    !/(^|\.)(go\.kr|data\.seoul\.go\.kr)$/.test(url.hostname)) invalid();
  return url.href;
}

function whole(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Import reviewed rows with stable source IDs using the marketing migrator, with no HTTP collection. */
export function importOfficialLocalSnapshot(pool: Pool, storeId: string, input: Snapshot) {
  if (!isUuid(storeId) || !input.region.trim() || input.region.length > 100 ||
    input.kinds.some(kind => kind !== 'food-license' && kind !== 'festival') || input.changes.length > 5000 ||
    input.population.length > 5000) invalid();
  const coverageDate = day(input.coverageDate);
  const changes = input.changes.map(change => {
    if (!isUuid(change.id) || !input.kinds.includes(change.kind) || !change.title.trim() ||
      change.title.length > 160 || !change.authority.trim() || change.authority.length > 100) invalid();
    return { ...change, sourceUrl: officialUrl(change.sourceUrl), referenceDate: day(change.referenceDate),
      dateKind: change.kind === 'food-license' ? 'license-date' : 'event-date' };
  });
  const population = input.population.map(band => {
    if (!/^\d{4}-Q[1-4]$/.test(band.quarter) || !whole(band.weekday, 1, 7) ||
      !whole(band.startHour, 0, 23) || !whole(band.endHour, band.startHour + 1, 24) ||
      !whole(band.estimate, 0, 2147483647) || !Number.isFinite(Date.parse(band.refreshedAt))) invalid();
    return { ...band, sourceUrl: officialUrl(band.sourceUrl), referenceDate: day(band.referenceDate) };
  });
  return inStore(pool, storeId, async db => {
    const coverage = await db.query(`INSERT INTO marketing.local_coverage AS existing (store_id, region, reference_date, kinds, fetched_at)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (store_id)
      DO UPDATE SET region = EXCLUDED.region, reference_date = EXCLUDED.reference_date, kinds = EXCLUDED.kinds,
        fetched_at = coalesce(EXCLUDED.fetched_at, existing.fetched_at)
      WHERE (existing.fetched_at IS NULL OR EXCLUDED.fetched_at >= existing.fetched_at)
        AND (existing.region, existing.reference_date, existing.kinds, existing.fetched_at)
          IS DISTINCT FROM (EXCLUDED.region, EXCLUDED.reference_date, EXCLUDED.kinds, coalesce(EXCLUDED.fetched_at, existing.fetched_at))`,
    [storeId, input.region, coverageDate, input.kinds, input.fetchedAt ?? null]);
    const changed = await db.query(`INSERT INTO marketing.local_change AS existing
      (store_id, id, kind, title, region, authority, source_url, date_kind, reference_date)
      SELECT $1, row.id, row.kind, row.title, $2, row.authority, row."sourceUrl", row."dateKind", row."referenceDate"
      FROM jsonb_to_recordset($3) AS row(id uuid, kind text, title text, authority text,
        "sourceUrl" text, "dateKind" text, "referenceDate" date)
      ON CONFLICT (store_id, id) DO UPDATE SET title = EXCLUDED.title, region = EXCLUDED.region,
        authority = EXCLUDED.authority, source_url = EXCLUDED.source_url, reference_date = EXCLUDED.reference_date,
        revision = existing.revision + 1, imported_at = clock_timestamp()
      WHERE existing.kind = EXCLUDED.kind AND existing.imported_at <= coalesce($4::timestamptz, existing.imported_at) AND
        (existing.title, existing.region, existing.authority, existing.source_url, existing.reference_date)
          IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.region, EXCLUDED.authority, EXCLUDED.source_url, EXCLUDED.reference_date)`,
    [storeId, input.region, JSON.stringify(changes), input.fetchedAt ?? null]);
    await db.query(`INSERT INTO marketing.local_population_band AS existing
      (store_id, region, quarter, weekday, start_hour, end_hour, estimate, reference_date, refreshed_at, source_url)
      SELECT $1, $2, row.quarter, row.weekday, row."startHour", row."endHour", row.estimate,
        row."referenceDate", row."refreshedAt", row."sourceUrl"
      FROM jsonb_to_recordset($3) AS row(quarter text, weekday smallint, "startHour" smallint,
        "endHour" smallint, estimate integer, "referenceDate" date, "refreshedAt" timestamptz, "sourceUrl" text)
      ON CONFLICT (store_id, region, quarter, weekday, start_hour) DO UPDATE SET end_hour = EXCLUDED.end_hour,
        estimate = EXCLUDED.estimate, reference_date = EXCLUDED.reference_date, refreshed_at = EXCLUDED.refreshed_at,
        source_url = EXCLUDED.source_url WHERE existing.refreshed_at <= EXCLUDED.refreshed_at`,
    [storeId, input.region, JSON.stringify(population)]);
    if (coverage.rowCount || changed.rowCount) await advanceSource(db, storeId, 'local-changes');
  }, { serialize: true });
}
