import type { DataCommandResult } from '../../commands/types';
import { selectStoreEnvironment } from './selectors';
import { staffLocalTimestamp } from '../staff/clock';
import type { EnvironmentPlayerCommand, EnvironmentTables, ObservationCommand, StoreEnvironment, StoreEnvironmentModel } from './types';

type Failure = Extract<DataCommandResult, { ok: false }>;
type Context<T extends EnvironmentTables> = { readonly tables: T; readonly snapshot: { readonly revision: number; readonly tables?: T } };
const receiptKeys = {
  'environment.setPlaying': 'data.environment.playingSet',
  'environment.skipTrack': 'data.environment.trackSkipped',
  'environment.selectPlaylist': 'data.environment.playlistSelected',
  'environment.selectTrack': 'data.environment.trackSelected',
  'environment.setVolume': 'data.environment.volumeSet',
} as const satisfies Record<EnvironmentPlayerCommand['type'], string>;

type Result<T> = Failure | { readonly ok: true; readonly tables: T; readonly undoable: false;
  readonly noticeKey?: typeof receiptKeys[EnvironmentPlayerCommand['type']]; readonly value: StoreEnvironmentModel['music'] };
function handle<T extends EnvironmentTables>(ctx: Context<T>, c: EnvironmentPlayerCommand): Result<T> {
  const e = ctx.tables.storeEnvironment;
  const fail = (reason: string, code: Failure['code'] = 'VALIDATION', field?: string): Failure => ({ ok: false, code, reason, field, messageKey: `data.environment.error.${reason}` });
  if (c.baseRevision !== undefined && c.baseRevision !== ctx.snapshot.revision) return fail('STALE_REVISION', 'CONFLICT');
  if (e.musicDevice === 'none') return fail('DEVICE_UNAVAILABLE', 'CONFLICT');
  let patch: Partial<StoreEnvironment>;
  if (c.type === 'environment.setPlaying') {
    if (typeof c.playing !== 'boolean') return fail('INVALID_PLAYING', 'VALIDATION', 'playing');
    if (selectStoreEnvironment({ tables: ctx.tables }).music.unavailableReason) return fail('DEVICE_UNAVAILABLE', 'CONFLICT');
    patch = { playing: c.playing };
  } else if (c.type === 'environment.setVolume') {
    if (!Number.isInteger(c.volumePct) || c.volumePct < 0 || c.volumePct > 100) return fail('INVALID_VOLUME', 'VALIDATION', 'volumePct');
    patch = { volumePct: c.volumePct };
  } else if (c.type === 'environment.selectPlaylist') {
    const playlist = e.playlists.find(p => p.id === c.playlistId);
    if (!playlist) return fail('UNKNOWN_PLAYLIST', 'NOT_FOUND', 'playlistId');
    if (!playlist.tracks.length) return fail('DEVICE_UNAVAILABLE', 'CONFLICT');
    patch = { playlistId: playlist.id, trackId: playlist.tracks[0].id };
  } else if (c.type === 'environment.selectTrack') {
    const playlists = c.playlistId === undefined ? e.playlists : e.playlists.filter(playlist => playlist.id === c.playlistId);
    const [match, duplicate] = playlists.flatMap(playlist => playlist.tracks
      .filter(track => track.id === c.trackId).map(track => ({ playlistId: playlist.id, trackId: track.id })));
    if (!match) return fail('UNKNOWN_TRACK', 'NOT_FOUND', 'trackId');
    if (duplicate) return fail('AMBIGUOUS_TRACK', 'CONFLICT', 'trackId');
    patch = match;
  } else {
    if (c.direction !== 'previous' && c.direction !== 'next') return fail('INVALID_DIRECTION', 'VALIDATION', 'direction');
    const playlist = e.playlists.find(p => p.id === e.playlistId), tracks = playlist?.tracks;
    const index = tracks?.findIndex(t => t.id === e.trackId) ?? -1;
    if (!tracks?.length || index < 0) return fail('DEVICE_UNAVAILABLE', 'CONFLICT');
    patch = { trackId: tracks[(index + (c.direction === 'next' ? 1 : -1) + tracks.length) % tracks.length].id };
  }
  const changed = Object.entries(patch).some(([key, value]) => e[key as keyof StoreEnvironment] !== value);
  const tables = changed ? { ...ctx.tables, storeEnvironment: { ...e, ...patch } } : ctx.tables;
  return { ok: true, tables, undoable: false, ...(changed ? { noticeKey: receiptKeys[c.type] } : {}), value: selectStoreEnvironment({ tables }).music };
}
const realOnly = (): Failure => ({ ok: false, code: 'CONFLICT', reason: 'REAL_ONLY', messageKey: 'data.real.error.SOURCE_UNAVAILABLE' });
const between = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
function recordReading<T extends EnvironmentTables>({ tables }: Context<T>, command: Extract<ObservationCommand, { type: 'environment.recordReading' }>) {
  const { measuredAt, temperatureC, humidityPct } = command;
  if (!Number.isFinite(Date.parse(measuredAt)) || !between(temperatureC, -50, 80) || !between(humidityPct, 0, 100)) {
    return { ok: false, code: 'VALIDATION', messageKey: 'data.real.error.VALIDATION' } as const;
  }
  const environment = tables.storeEnvironment;
  const { date, time } = staffLocalTimestamp(measuredAt);
  const reading = { measuredAt: `${date}T${time}`, temperatureC, humidityPct };
  const readings = [...environment.readings.filter(row => row.measuredAt !== reading.measuredAt), reading].sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  return { ok: true, undoable: false, tables: { ...tables, storeEnvironment: { ...environment, readings, current: readings.at(-1)! } } } as const;
}
function updateLimits<T extends EnvironmentTables>({ tables }: Context<T>, command: Extract<ObservationCommand, { type: 'environment.updateLimits' }>) {
  const environment = tables.storeEnvironment;
  const revision = environment.limitsRevision ?? 0;
  if (command.expectedRevision !== revision) return { ok: false, code: 'CONFLICT', reason: 'STALE_REVISION', messageKey: 'data.real.error.STALE_REVISION' } as const;
  const { temperatureRange, humidityRange } = command;
  if (!between(temperatureRange[0], -50, temperatureRange[1]) || !between(temperatureRange[1], -50, 80)
    || !between(humidityRange[0], 0, humidityRange[1]) || !between(humidityRange[1], 0, 100)) {
    return { ok: false, code: 'VALIDATION', messageKey: 'data.real.error.VALIDATION' } as const;
  }
  return { ok: true, undoable: false, tables: { ...tables, storeEnvironment: { ...environment, temperatureRange, humidityRange, limitsRevision: revision + 1 } } } as const;
}
export const environmentHandlers = {
  'environment.setPlaying': handle, 'environment.skipTrack': handle,
  'environment.selectPlaylist': handle, 'environment.selectTrack': handle, 'environment.setVolume': handle,
  'environment.recordReading': recordReading, 'environment.updateLimits': updateLimits,
  'cctv.saveZones': realOnly, 'cctv.setTableLink': realOnly,
};
