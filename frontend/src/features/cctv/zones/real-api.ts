import { commandFailureText } from '../../../data/commands/failure-copy';
import type { DataCommandResult } from '../../../data/commands/types';
import type { WidgetDataStore } from '../../../data/db/store';
import { failure, type CommandReceipt } from '../../../data/reality/00';
import type { DataMessageKey } from '../../../data/messages';
import type { ZoneDto, ZoneInput } from '../../../data/reality/10/dto';
import type { Translator } from '../../../i18n';
import type { CctvMessageKey } from '../messages';
import { ZonesApiError, type ZonesApi } from './api';
import { decodeRle, encodeRle, lassoCells, simplifyRing, zoneOutline } from './mask';
import type { Zone } from './types';

type SaveFailure = Extract<DataCommandResult, { ok: false }>;

export class StoreZonesSaveError extends Error {
  constructor(readonly result: SaveFailure) { super('CCTV zone save failed'); }

  get reload() {
    return this.result.reason === 'STALE_REVISION' || this.result.reason === 'ZONE_NOT_FOUND' || this.result.reason === 'SAVED_RELOAD_REQUIRED';
  }
}

const copy: Readonly<Record<string, readonly [CctvMessageKey, CctvMessageKey | DataMessageKey]>> = {
  VALIDATION: ['cctv.zoneSave.invalid', 'cctv.zoneSave.checkDrawing'],
  INVALID_ZONES: ['cctv.zoneSave.invalid', 'cctv.zoneSave.checkDrawing'],
  INVALID_REQUEST: ['cctv.zoneSave.invalid', 'cctv.zoneSave.checkDrawing'],
  INVALID_OUTLINE: ['cctv.zoneSave.outline', 'cctv.zoneSave.redraw'],
  MISSING_OUTLINE: ['cctv.zoneSave.missingOutline', 'cctv.zoneSave.replaceOutline'],
  CAMERA_NOT_FOUND: ['cctv.zoneSave.cameraMissing', 'cctv.zoneSave.checkCamera'],
  ZONE_NOT_FOUND: ['cctv.zoneSave.zoneMissing', 'cctv.zoneSave.reload'],
  STALE_REVISION: ['cctv.zoneSave.stale', 'cctv.zoneSave.reload'],
  CONFIRMATION_REQUIRED: ['cctv.zoneSave.confirmationRequired', 'cctv.zoneSave.confirmDeletion'],
  IDEMPOTENCY_KEY_REQUIRED: ['cctv.zoneSave.invalidRequest', 'data.real.commandFailure.next.PREVIEW_FAILURE'],
};

export function storeZonesSaveText(t: Translator<CctvMessageKey | DataMessageKey>['t'], { result }: StoreZonesSaveError) {
  if (result.reason === 'SAVED_RELOAD_REQUIRED') return t('cctv.zoneSave.savedReload');
  const key = result.reason ?? result.code;
  const specific = Object.hasOwn(copy, key) ? copy[key] : undefined;
  return commandFailureText(t, result, {
    ...(specific && { reason: t(specific[0]), next: t(specific[1]) }),
    unknownKey: 'cctv.zoneSave.outcomeUnknown',
  });
}

function savedMask(zone: ZoneDto) {
  return lassoCells(zone.polygon?.map(point => [point.x, point.y]) ?? []);
}

function wireZone(zone: Zone, prior?: ZoneDto): ZoneInput {
  const cells = decodeRle(zone.mask);
  const original = prior && savedMask(prior);
  let polygon = prior?.polygon;
  if (!original || original.some((value, index) => value !== cells[index])) {
    const rings = zoneOutline(cells);
    const ring = rings.length === 1 ? simplifyRing(rings[0]) : [];
    if (ring.length < 3 || ring.length > 32) throw new StoreZonesSaveError(failure('VALIDATION', 'INVALID_OUTLINE', 'cctv.zoneSave.outline'));
    polygon = ring.map(([x, y]) => ({ x, y }));
  }
  if (!polygon) throw new StoreZonesSaveError(failure('VALIDATION', 'MISSING_OUTLINE', 'cctv.zoneSave.missingOutline'));
  return { ...(prior ? { zoneId: prior.zoneId } : {}), label: prior?.label ?? `구역 ${zone.number}`, polygon };
}

export function createStoreZonesApi(store: WidgetDataStore, cameraId: string): ZonesApi {
  const port = store.real;
  const camera = () => store.getSnapshot().tables.realInsight?.cameras.find(row => row.cameraId === cameraId);
  const rows = () => store.getSnapshot().tables.realInsight?.zones.filter(zone => zone.cameraId === cameraId) ?? [];
  const saved = (revision: number) => {
    const zones: Zone[] = rows().map((zone, index) => ({ id: zone.zoneId, number: index + 1, source: 'drawn', mask: encodeRle(savedMask(zone)) }));
    return { revision, savedAt: null, frameAspect: null, zones };
  };
  return {
    storeScoped: true,
    async get() {
      const state = await port?.retry('cctv');
      if (state?.status !== 'ready' || !state.complete) throw new ZonesApiError('UNREACHABLE', '구역을 불러오지 못했어요');
      const current = camera();
      if (!current) throw new ZonesApiError('UNREACHABLE', '카메라를 불러오지 못했어요');
      return saved(current.zoneSetRevision);
    },
    async put(body) {
      if (!port || port.mode('cctv') !== 'http' || !port.state('cctv').complete) {
        throw new StoreZonesSaveError(failure('PREVIEW_FAILURE', 'SOURCE_UNAVAILABLE', 'data.real.error.SOURCE_UNAVAILABLE'));
      }
      const previous = camera();
      if (!previous) throw new StoreZonesSaveError(failure('NOT_FOUND', 'CAMERA_NOT_FOUND', 'cctv.zoneSave.cameraMissing'));
      if (body.baseRevision !== previous.zoneSetRevision) {
        throw new StoreZonesSaveError(failure('CONFLICT', 'STALE_REVISION', 'cctv.zoneSave.stale'));
      }
      const prior = new Map(rows().map(zone => [zone.zoneId, zone]));
      const zones = body.zones.map(zone => wireZone(zone, prior.get(zone.id)));
      const result = await store.execute({ type: 'cctv.saveZones', cameraId, expectedRevision: body.baseRevision, zones, confirmed: body.confirmed });
      if (!result.ok) throw new StoreZonesSaveError(result);
      const current = camera();
      const state = port.state('cctv');
      if (!current || current.zoneSetRevision !== (result.value as CommandReceipt).revision || state.status !== 'ready' || !state.complete) {
        throw new StoreZonesSaveError(failure('CONFLICT', 'SAVED_RELOAD_REQUIRED', 'cctv.zoneSave.savedReload'));
      }
      return saved(current.zoneSetRevision);
    },
    async suggest() { return { zones: [], frameAspect: null }; },
  };
}
