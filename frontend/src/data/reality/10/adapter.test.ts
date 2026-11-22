import { describe, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../db/store';
import { selectStoreEnvironment } from '../../iteration7/environment';
import { createRealPort } from '../00';
import { fakeBackend } from '../00/testing';
import { registeredAdapters } from '../00/registry';
import { insightHourlyRows, insightHours, insightPeak, observationBusinessDate } from './observations';
import type { BucketDto, RealInsight } from './dto';
import '../00/autoload';

const asOf = '2026-11-17T06:45:00.000Z';
const cameraId = 'c721b8c9-bca1-4211-b055-2301dc253a32';
const zoneId = '17d94bef-eca5-40eb-b351-214ee4652569';
const polygon = [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.4 }];
const page = (items: unknown[]) => ({ items, nextCursor: null, asOf, sourceRevision: 1 });
const limits = { revision: 0, temperatureRange: [18, 25], humidityRange: [40, 60] };

function rig() {
  const backend = fakeBackend();
  let zoneSetRevision = 0;
  let current: { measuredAt: string; temperatureC: number; humidityPct: number } | null = null;
  backend.on('GET', '/insight/cameras', () => page([{ cameraId, zoneSetRevision, lastObservedAt: null, measurementStatus: 'none', deviceStatus: 'registered' }]));
  backend.on('GET', '/insight/zones', () => page(zoneSetRevision ? [{ zoneId, zoneVersionId: zoneId, cameraId, zoneSetRevision, label: '창가', polygon, linkRevision: 0 }] : []));
  for (const path of ['/insight/table-links', '/insight/cctv-buckets']) {
    backend.on('GET', path, () => page([]));
  }
  backend.on('GET', '/pos/tables', ({ query }) => {
    expect(query.limit).toBe('50');
    return page([]);
  });
  backend.on('GET', '/insight/cctv-reviews', ({ query }) => {
    expect(Object.keys(query)).toEqual(['date']);
    return page([]);
  });
  backend.on('GET', '/insight/environment-readings', () => page(current ? [{ ...current, source: 'manual', readingId: 'reading' }] : []));
  backend.on('GET', '/insight/environment-summary', () => ({ current, limits, alerts: current ? [{ metric: 'temperatureC', direction: 'above' }] : [], asOf, sourceRevision: 1 }));
  backend.on('POST', '/insight/environment-readings', ({ body }) => {
    current = body as typeof current;
    return { resourceId: 'reading', revision: 1, receiptId: 'record', affectedSources: ['environment.summary', 'briefing'] };
  });
  backend.on('PATCH', `/insight/cameras/${cameraId}/zones`, () => ({ resourceId: cameraId, revision: ++zoneSetRevision, receiptId: 'zone', affectedSources: ['cctv.zones'] }));
  const connect = () => {
    const store = createWidgetDataStore();
    const adapter = registeredAdapters().find(item => item.domain === 'cctv');
    const port = createRealPort({ store, adapters: adapter ? [adapter] : [], source: () => 'http', fetch: backend.fetch });
    store.bindReal(port);
    return { store, port };
  };
  return { backend, connect };
}

describe('F10 HTTP widget data', () => {
  it('re-reads a manual measurement for the briefing and clears it on session change', async () => {
    const { connect, backend } = rig();
    const { store, port } = connect();
    await port.load('cctv');
    expect(port.state('cctv').status).toBe('ready');
    expect(selectStoreEnvironment(store.getSnapshot()).current).toBeNull();
    const reading = { measuredAt: asOf, temperatureC: 29, humidityPct: 45 };
    expect(await store.execute({ type: 'environment.recordReading', ...reading })).toMatchObject({ ok: true });
    expect(backend.callsTo('POST', '/insight/environment-readings')).toHaveLength(1);
    expect(selectStoreEnvironment(store.getSnapshot()).alerts).toMatchObject([{ reason: 'OUT_OF_RANGE' }]);
    const next = connect();
    await next.port.load('cctv');
    expect(selectStoreEnvironment(next.store.getSnapshot()).current).toMatchObject({ temperatureC: 29, humidityPct: 45 });
    port.reset();
    expect(selectStoreEnvironment(store.getSnapshot()).current).toBeNull();
  });

  it('saves a zone with its viewed revision and reads the same revision in a new session', async () => {
    const { connect, backend } = rig();
    const { store, port } = connect();
    await port.load('cctv');
    expect(await store.execute({ type: 'cctv.saveZones', cameraId, expectedRevision: 0, zones: [{ label: '창가', polygon }] })).toMatchObject({ ok: true });
    expect(backend.callsTo('PATCH', `/insight/cameras/${cameraId}/zones`)[0]?.body).toEqual({ expectedRevision: 0, zones: [{ label: '창가', polygon }] });
    const next = connect();
    await next.port.load('cctv');
    expect(next.store.getSnapshot().tables.realInsight?.cameras[0]).toMatchObject({ zoneSetRevision: 1, measurementStatus: 'none' });
    expect(next.store.getSnapshot().tables.realInsight?.zones[0]).toMatchObject({ zoneId, polygon });
    next.port.reset();
    expect(next.store.getSnapshot().tables.realInsight).toBeUndefined();
  });

  it('joins measured hours to real staff without summing cameras or counting visits', () => {
    const store = createWidgetDataStore();
    store.hydrate({ staffCalendarAsOf: asOf, staff: [{ staffId: 'person', name: '근무자', archivedAt: null }], staffSchedule: [
      { scheduleId: 'shift', staffId: 'person', date: '2026-11-17', kind: 'work', start: '15:00', end: '16:00', breakMinutes: 0 },
    ] });
    const bucket = (id: string, maxInStore: number): BucketDto => ({ cameraId: id, maxInStore, avgInStore: 2,
      bucketStart: '2026-11-17T06:35:00.000Z', observedUntil: '2026-11-17T06:40:00.000Z', bucketMinutes: 5,
      status: 'ok', entries: [], zoneSetRevision: 1 });
    const insight: RealInsight = { date: '2026-11-17', asOf, cameras: [], zones: [], links: [], tables: [],
      buckets: [bucket(cameraId, 8), bucket('second-camera', 6)], reviews: [] };
    expect(insightPeak(insightHours(insight, store.getSnapshot()))).toMatchObject({ hour: 15, max: 8, staff: 1 });
    expect(observationBusinessDate('2026-11-17T19:50:00.000Z')).toBe('2026-11-17');
    expect(observationBusinessDate('2026-11-17T20:00:00.000Z')).toBe('2026-11-18');
  });

  it('fills the table the original CCTV screens read with the measured hours (PARITY-FIX-MGMT)', () => {
    const bucket = (id: string, start: string, maxInStore: number | null, status: BucketDto['status'] = 'ok'): BucketDto => ({
      cameraId: id, maxInStore, avgInStore: maxInStore, bucketStart: start,
      observedUntil: new Date(Date.parse(start) + 300_000).toISOString(), bucketMinutes: 5, status, entries: [], zoneSetRevision: 1 });
    const insight: RealInsight = { date: '2026-11-17', asOf, cameras: [], zones: [], links: [], tables: [], reviews: [
      { reviewId: 'review', hour: 15, revision: 1, markedAt: asOf }],
    buckets: [
      bucket(cameraId, '2026-11-17T06:35:00.000Z', 8), bucket('second-camera', '2026-11-17T06:35:00.000Z', 6),
      bucket(cameraId, '2026-11-17T07:05:00.000Z', 3, 'partial'), bucket(cameraId, '2026-11-17T08:05:00.000Z', null, 'none'),
      // The previous business day stays in the table for the weekly trend, under its own date.
      bucket(cameraId, '2026-11-16T07:05:00.000Z', 5) ] };
    const rows = insightHourlyRows(insight);
    expect(rows.filter(row => row.businessDate === '2026-11-17')).toEqual([
      { businessDate: '2026-11-17', hour: 15, entries: 8, status: 'ok', reviewMarked: true },
      { businessDate: '2026-11-17', hour: 16, entries: 3, status: 'partial', reviewMarked: false },
      { businessDate: '2026-11-17', hour: 17, entries: null, status: 'none', reviewMarked: false },
    ]);
    expect(rows.find(row => row.businessDate === '2026-11-16')).toMatchObject({ hour: 16, entries: 5, reviewMarked: false });
  });

  it('loads the measured hours into the hourly table next to the camera rows', async () => {
    const { connect, backend } = rig();
    backend.on('GET', '/insight/cctv-buckets', () => page([{ cameraId, bucketStart: '2026-11-17T06:35:00.000Z', bucketMinutes: 5, zoneSetRevision: 0,
      observedUntil: '2026-11-17T06:40:00.000Z', status: 'ok', avgInStore: 2, maxInStore: 4, entries: [] }]));
    const { store, port } = connect();
    await port.load('cctv');
    expect(store.getSnapshot().tables.cctvHourly).toEqual([{ businessDate: '2026-11-17', hour: 15, entries: 4, status: 'ok', reviewMarked: false }]);
    expect(store.getSnapshot().tables.cctvCamera).toHaveLength(1);
  });
});
