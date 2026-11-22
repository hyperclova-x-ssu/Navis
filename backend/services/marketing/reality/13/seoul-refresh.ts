import type { Pool } from 'pg';
import { inStore } from '../../transaction.ts';
import { allSeoulRows, eventRows, licenseRows, populationBands, sangdoDongs, seoulDatasets, seoulDay,
  type SeoulDataset, type SeoulProvider } from './seoul-public.ts';

export function claimSeoulDataset(pool: Pool, storeId: string, dataset: SeoulDataset, at: Date) {
  return inStore(pool, storeId, async db => {
    const result = await db.query(`INSERT INTO marketing.local_public_fetch AS existing (store_id, dataset, attempt_day)
      VALUES ($1,$2,$3) ON CONFLICT (store_id, dataset) DO UPDATE SET attempt_day = EXCLUDED.attempt_day
      WHERE existing.attempt_day < EXCLUDED.attempt_day`, [storeId, dataset, seoulDay(at)]);
    return result.rowCount === 1;
  });
}

export function persistSeoulDataset(pool: Pool, storeId: string, dataset: SeoulDataset, at: Date, referenceDate: string,
  rows: readonly object[]) {
  return inStore(pool, storeId, db => db.query('SELECT marketing.apply_seoul_public($1,$2,$3,$4,$5)', [
    storeId, dataset, at, referenceDate, JSON.stringify(rows),
  ]), { serialize: true });
}

export function projectSeoulDataset(dataset: SeoulDataset, rows: Awaited<ReturnType<typeof allSeoulRows>>, at: Date) {
  if (dataset === 'events') return { rows: eventRows(rows, at), referenceDate: seoulDay(at) };
  if (dataset === 'population') {
    const bands = populationBands(rows, at);
    return { rows: bands, referenceDate: bands.map(band => band.referenceDate).sort().at(-1) ?? '' };
  }
  return licenseRows(rows, dataset, at);
}

export async function refreshSeoulDataset(pool: Pool, provider: SeoulProvider, storeId: string, dataset: SeoulDataset,
  at: Date) {
  if (!await claimSeoulDataset(pool, storeId, dataset, at)) return;
  const raw = dataset === 'population'
    ? (await Promise.all(sangdoDongs.map(dong => allSeoulRows(provider, dataset, [' ', ' ', dong])))).flat()
    : await allSeoulRows(provider, dataset);
  const result = projectSeoulDataset(dataset, raw, at);
  if (!result.referenceDate) throw new Error('Seoul feed has no usable source date');
  const uniqueRows = [...new Map(result.rows.map(row => [
    'id' in row ? row.id : `${row.quarter}:${row.weekday}:${row.startHour}`, row,
  ])).values()];
  await persistSeoulDataset(pool, storeId, dataset, at, result.referenceDate, uniqueRows);
}

export function startSeoulRefresh(pool: Pool, provider: SeoulProvider, storeId: string, report: (dataset: SeoulDataset) => void) {
  let current: Promise<void> | undefined;
  const datasets = Object.keys(seoulDatasets) as SeoulDataset[];
  const tick = () => {
    if (current) return;
    const at = new Date();
    current = Promise.all(datasets.map(dataset => refreshSeoulDataset(pool, provider, storeId, dataset, at)
      .catch(() => report(dataset)))).then(() => {}).finally(() => { current = undefined; });
  };
  tick();
  const timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await current;
  };
}
