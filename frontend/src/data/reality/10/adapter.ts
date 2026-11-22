import { staffLocalTimestamp } from '../../iteration7/staff/clock';
import type { EnvironmentReading, EnvironmentPlayerCommand, StoreEnvironment } from '../../iteration7/environment/types';
import { defineBinding, PortError, type DomainAdapter, type ListPage } from '../00';
import type { PosTableDto } from '../02/dto';
import type { BucketDto, CameraDto, EnvironmentSummaryDto, ReadingDto, RealInsight, ReviewDto, TableLinkDto, ZoneDto } from './dto';
import { insightHourlyRows, observationBusinessDate } from './observations';

const root = '/insight';
const path = (collection: string, id: string, action: string) => `${root}/${collection}/${encodeURIComponent(id)}/${action}`;
const emptyEnvironment: StoreEnvironment = {
  source: 'manual', sensor: 'none', current: null, readings: [], temperatureRange: [18, 25], humidityRange: [40, 60],
  musicDevice: 'none', playlistId: null, trackId: null, playing: false, volumePct: 0, playlists: [],
};
const playerCommands: readonly EnvironmentPlayerCommand['type'][] = [
  'environment.setPlaying', 'environment.skipTrack', 'environment.selectPlaylist', 'environment.selectTrack', 'environment.setVolume',
];

function localStamp(instant: string): string {
  const { date, time } = staffLocalTimestamp(instant);
  return `${date}T${time}`;
}
function localReading({ measuredAt, temperatureC, humidityPct }: ReadingDto): EnvironmentReading {
  return { measuredAt: localStamp(measuredAt), temperatureC, humidityPct };
}

export const insightAdapter: DomainAdapter = {
  domain: 'cctv',
  tables: ['realInsight', 'storeEnvironment', 'cctvCamera', 'cctvHourly'],
  sources: ['cctv', 'cctv.cameras', 'cctv.zones', 'cctv.table-links', 'cctv.buckets', 'cctv.reviews', 'environment.summary',
    'environment.readings', 'environment.limits', 'pos.tables', 'pos', 'account'],
  errorKeys: {
    CCTV_TODAY_ONLY: 'data.management.error.CCTV_TODAY_ONLY', CCTV_HOUR_UNMEASURED: 'data.environment.error.unmeasured',
    TABLE_UNAVAILABLE: 'data.tableLinks.error.UNKNOWN_TABLE', LINK_IN_USE: 'data.tableLinks.error.LINK_IN_USE',
    TABLE_LINK_DISABLED: 'data.tableLinks.error.TABLE_LINK_DISABLED', DEVICE_UNAVAILABLE: 'data.environment.error.DEVICE_UNAVAILABLE',
  },
  clear: () => ({ realInsight: undefined, storeEnvironment: emptyEnvironment, cctvCamera: [], cctvHourly: [] }),
  async load({ reads, signal }) {
    const options = { signal };
    const summary = await reads.one<EnvironmentSummaryDto>({ resource: 'environment.summary', path: `${root}/environment-summary` }, options);
    // Keep the period fixed through pagination. The server supplies the upper bound for newly recorded measurements.
    const end = Date.parse(summary.asOf);
    const date = observationBusinessDate(summary.asOf);
    const period = { from: new Date(end - 86_400_000).toISOString(), to: summary.asOf, limit: 100 };
    const [cameras, zones, links, buckets, reviews, readings, tables] = await Promise.all([
      reads.all<CameraDto>({ resource: 'cctv.cameras', path: `${root}/cameras`, query: { limit: 100 } }, options),
      reads.all<ZoneDto>({ resource: 'cctv.zones', path: `${root}/zones`, query: { limit: 100 } }, options),
      reads.all<TableLinkDto>({ resource: 'cctv.table-links', path: `${root}/table-links`, query: { limit: 100 } }, options),
      reads.all<BucketDto>({ resource: 'cctv.buckets', path: `${root}/cctv-buckets`, query: period }, options),
      reads.one<ListPage<ReviewDto>>({ resource: 'cctv.reviews', path: `${root}/cctv-reviews`, query: { date } }, options),
      reads.all<ReadingDto>({ resource: 'environment.readings', path: `${root}/environment-readings`, query: period }, options),
      reads.all<PosTableDto>({ resource: 'pos.tables', path: '/pos/tables', query: { limit: 50 } }, options).catch(error => {
        if (signal.aborted || (error instanceof PortError && [401, 403].includes(error.status))) throw error;
        return null;
      }),
    ]);
    const active = tables?.complete ? tables.items.filter(row => row.state !== 'archived') : null;
    const insight: RealInsight = { date, asOf: summary.asOf, cameras: cameras.items, zones: zones.items,
      links: links.items.filter(link => link.tableState === 'active'), buckets: buckets.items, reviews: reviews.items, tables: active };
    const sameZoneSnapshot = cameras.sourceRevision === zones.sourceRevision && zones.sourceRevision === links.sourceRevision;
    return {
      tables: {
        realInsight: insight,
        storeEnvironment: { ...emptyEnvironment, current: summary.current ? localReading(summary.current) : null,
          readings: [...readings.items].reverse().map(localReading), limitsRevision: summary.limits.revision,
          temperatureRange: summary.limits.temperatureRange, humidityRange: summary.limits.humidityRange, manualAlert: summary.alerts.length > 0 },
        cctvCamera: cameras.items.map((camera, index) => ({ cameraId: camera.cameraId, name: { raw: `카메라 ${index + 1}` },
          connection: camera.deviceStatus === 'registered' ? 'connected' : 'disconnected', operation: 'stopped',
          // The original camera table formats this as a store-local time: a camera never observed was last checked when the service state was read.
          lastCheckedAt: localStamp(camera.lastObservedAt ?? summary.asOf), stillImageKey: '' })),
        cctvHourly: insightHourlyRows(insight),
      },
      asOf: summary.asOf, sourceRevision: Math.max(summary.sourceRevision, cameras.sourceRevision, zones.sourceRevision,
        links.sourceRevision, buckets.sourceRevision, reviews.sourceRevision, readings.sourceRevision),
      complete: sameZoneSnapshot && [cameras, zones, links, buckets, readings].every(result => result.complete),
    };
  },
  commands: [
    defineBinding({ type: 'environment.recordReading', request: ({ measuredAt, temperatureC, humidityPct }) => ({
      method: 'POST', path: `${root}/environment-readings`, body: { measuredAt, temperatureC, humidityPct },
    }) }),
    defineBinding({ type: 'environment.updateLimits', request: ({ expectedRevision, temperatureRange, humidityRange }) => ({
      method: 'PATCH', path: `${root}/environment-limits`, expectedRevision, body: { temperatureRange, humidityRange },
    }) }),
    defineBinding({ type: 'cctv.saveZones', request: ({ cameraId, expectedRevision, zones, confirmed }) => ({
      method: 'PATCH', path: path('cameras', cameraId, 'zones'), expectedRevision, body: { zones, ...(confirmed ? { confirmed } : {}) },
    }) }),
    defineBinding({ type: 'cctv.setTableLink', request: ({ zoneId, tableId, expectedRevision, confirmed }) => ({
      method: 'PATCH', path: path('zones', zoneId, 'table-link'), expectedRevision, body: { tableId, ...(confirmed ? { confirmed } : {}) },
    }) }),
    defineBinding({ type: 'cctv.markPeakForReview', receiptBase: root, noticeKey: 'data.notice.peakMarked',
      request: ({ date, hour }) => ({ method: 'POST', path: `${root}/cctv-reviews`, body: { date, hour } }) }),
    ...playerCommands.map(type => defineBinding({ type, request: () => { throw new PortError(409, 'CONFLICT', 'DEVICE_UNAVAILABLE'); } })),
  ],
};
