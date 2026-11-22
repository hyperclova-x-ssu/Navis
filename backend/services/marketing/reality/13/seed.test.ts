import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { seedCatalog } from '../../../../../frontend/src/data/db/generated/catalog.ts';
import official from './data/sangdo-official.json' with { type: 'json' };
import { officialSnapshot, seedOfficialLocal } from './seed.ts';

const day = /^\d{4}-\d{2}-\d{2}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function recordingPool() {
  const queries: { text: string; values?: unknown[] }[] = [];
  const client = {
    async query(text: string, values?: unknown[]) { queries.push({ text, values }); return { rows: [], rowCount: 0 }; },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, queries };
}

describe('Sangdo official snapshot', () => {
  it('covers one region with dated official kinds and the Seoul attribution', () => {
    expect(officialSnapshot.region).toBe('서울 동작구 상도동');
    expect(officialSnapshot.coverageDate).toMatch(day);
    expect(officialSnapshot.kinds).toEqual(['food-license', 'festival']);
    expect(official.meta.attribution).toContain('출처: 서울특별시·KT, 서울시 통신데이터');
    expect(official.meta.population.sheetMismatchRows).toBe(0);
    expect(official.meta.skippedGarbledRows).toBe(0);
    for (const file of [...official.meta.population.files, ...official.meta.licenses.files, ...official.meta.events.files]) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.disposition).toMatch(/^attachment; filename=/);
    }
  });

  it('keeps every change as a sourced official row with a stable unique ID', () => {
    const { changes, kinds, coverageDate } = officialSnapshot;
    expect(changes.length).toBeGreaterThan(0);
    expect(new Set(changes.map(change => change.id)).size).toBe(changes.length);
    for (const change of changes) {
      expect(change.id).toMatch(uuid);
      expect(kinds).toContain(change.kind);
      expect(change.title.length).toBeGreaterThan(0);
      expect([...change.title].length).toBeLessThanOrEqual(160);
      expect(`${change.title}${change.authority}`).not.toContain('�');
      expect([...change.authority].length).toBeLessThanOrEqual(100);
      expect(change.referenceDate).toMatch(day);
      const url = new URL(change.sourceUrl);
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toMatch(/(^|\.)go\.kr$/);
    }
    const licenses = changes.filter(change => change.kind === 'food-license');
    expect(licenses.length).toBe(official.meta.licenses.count);
    expect(licenses.every(change => change.referenceDate <= coverageDate)).toBe(true);
    expect(changes.filter(change => change.kind === 'festival').length).toBe(official.meta.events.count);
  });

  it('has a full 7 x 24 band grid per quarter dated to the last day used', () => {
    const quarters = official.meta.population.quarters as Record<string, { from: string; to: string; days: number }>;
    expect(Object.keys(quarters)).toEqual(['2026-Q3', '2026-Q4']);
    for (const [quarter, span] of Object.entries(quarters)) {
      const bands = officialSnapshot.population.filter(band => band.quarter === quarter);
      expect(bands).toHaveLength(7 * 24);
      expect(new Set(bands.map(band => `${band.weekday}:${band.startHour}`)).size).toBe(7 * 24);
      for (const band of bands) {
        expect(band.endHour).toBe(band.startHour + 1);
        expect(Number.isInteger(band.estimate) && band.estimate > 0).toBe(true);
        expect(band.referenceDate).toBe(span.to);
        expect(band.sourceUrl).toBe('https://data.seoul.go.kr/dataList/OA-23016/S/1/datasetView.do');
        expect(Number.isFinite(Date.parse(band.refreshedAt))).toBe(true);
      }
    }
  });
});

describe('seedOfficialLocal', () => {
  it('imports the reviewed snapshot for the café store in one serialized store transaction', async () => {
    const { pool, queries } = recordingPool();
    await seedOfficialLocal(pool);
    const store = seedCatalog.store.storeId;
    expect(queries[0].text).toBe('BEGIN');
    expect(queries[1].values).toEqual([store]);
    expect(queries[2].text).toContain('pg_advisory_xact_lock');
    const coverage = queries.find(query => query.text.includes('marketing.local_coverage'));
    expect(coverage?.values).toEqual([store, officialSnapshot.region, officialSnapshot.coverageDate, officialSnapshot.kinds]);
    const changes = queries.find(query => query.text.includes('INSERT INTO marketing.local_change'));
    expect(JSON.parse(String(changes?.values?.[2]))).toHaveLength(officialSnapshot.changes.length);
    const bands = queries.find(query => query.text.includes('marketing.local_population_band'));
    expect(JSON.parse(String(bands?.values?.[2]))).toHaveLength(officialSnapshot.population.length);
    expect(queries.at(-1)?.text).toBe('COMMIT');
  });

  it('rejects a store ID that is not a UUID before opening a transaction', async () => {
    const { pool, queries } = recordingPool();
    await expect(seedOfficialLocal(pool, 'cafe')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(queries).toHaveLength(0);
  });
});
