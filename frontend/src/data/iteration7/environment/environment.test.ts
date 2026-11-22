import { describe, expect, it } from 'vitest';
import { seedSupplement } from '../../db/generated/supplement';
import { deepFreeze } from '../../db/freeze';
import { createEnvironmentSeed, environmentHandlers, selectStoreEnvironment, type EnvironmentPlayerCommand } from './index';

const sample = seedSupplement.environment[0];
const measuredAt = sample.measuredAt.slice(0, 16);
const fixture = () => createEnvironmentSeed();
function run(tables: ReturnType<typeof fixture>, command: EnvironmentPlayerCommand) {
  return environmentHandlers[command.type]({ tables, snapshot: { revision: 0, tables } }, command);
}

describe('store environment domain', () => {
  it('reads the cafe measurement and preserves five-minute trend samples when supplied', () => {
    const t = fixture(), model = selectStoreEnvironment({ tables: t }, 'normal');
    expect(model).toMatchObject({ sensorStatus: 'connected', current: { temperatureC: sample.temperature, humidityPct: sample.humidity }, lastMeasuredAt: measuredAt, music: { playing: true, volumePct: sample.volume, track: { title: '오후의 재즈 피아노', artist: '카페 연주곡집' } }, alerts: [] });
    expect(model.trend).toHaveLength(32);
    expect(model.trend.at(-1)?.measuredAt).toBe(measuredAt);
    const prior = { measuredAt: '2026-11-17T15:40', temperatureC: 22, humidityPct: 46 };
    const tables = { storeEnvironment: { ...t.storeEnvironment, readings: [prior, t.storeEnvironment.current!] } };
    expect(selectStoreEnvironment({ tables }).trend.map(row => row.measuredAt)).toEqual([prior.measuredAt, measuredAt]);
  });

  it('isolates special preview readings and briefing reasons from normal facts', () => {
    const t = deepFreeze(fixture());
    const unusual = selectStoreEnvironment({ tables: t }, 'out_of_range');
    expect(unusual.current?.temperatureC).toBe(28.5);
    expect(unusual.alerts).toMatchObject([{ reason: 'OUT_OF_RANGE', group: 'tasks' }]);
    const disconnected = selectStoreEnvironment({ tables: t }, 'sensor_disconnected');
    expect(disconnected).toMatchObject({ sensorStatus: 'disconnected', current: { temperatureC: sample.temperature }, lastMeasuredAt: measuredAt, alerts: [{ reason: 'SENSOR_DISCONNECTED', group: 'tasks' }] });
    expect(selectStoreEnvironment({ tables: t }, 'normal').current?.temperatureC).toBe(sample.temperature);
    expect(t.storeEnvironment.sensor).toBe('connected');
  });

  it.each([[18, 40, 0], [25, 60, 0], [17.9, 40, 1], [25.1, 60, 1], [22, 39, 1], [22, 61, 1]])('uses inclusive ranges %s %s', (temperatureC, humidityPct, count) => {
    const t = fixture();
    const tables = { ...t, storeEnvironment: { ...t.storeEnvironment, current: { measuredAt: '2026-10-26T15:40', temperatureC, humidityPct } } };
    expect(selectStoreEnvironment({ tables }, 'normal').alerts).toHaveLength(count);
  });

  it('pauses, wraps tracks, changes playlists and retains play state and volume', () => {
    const t = fixture();
    const paused = run(t, { type: 'environment.setPlaying', playing: false });
    if (!paused.ok) throw new Error(paused.reason);
    const loud = run(paused.tables, { type: 'environment.setVolume', volumePct: 70 });
    if (!loud.ok) throw new Error(loud.reason);
    const selected = run(loud.tables, { type: 'environment.selectPlaylist', playlistId: t.storeEnvironment.playlists[0].id });
    if (!selected.ok) throw new Error(selected.reason);
    expect(selected.value).toMatchObject({ playing: false, volumePct: 70, track: { id: t.storeEnvironment.playlists[0].tracks[0].id } });
    const previous = run(selected.tables, { type: 'environment.skipTrack', direction: 'previous' });
    if (!previous.ok) throw new Error(previous.reason);
    expect(previous.tables.storeEnvironment.trackId).toBe(t.storeEnvironment.playlists[0].tracks.at(-1)?.id);
    const next = run(previous.tables, { type: 'environment.skipTrack', direction: 'next' });
    if (!next.ok) throw new Error(next.reason);
    expect(next.tables.storeEnvironment.trackId).toBe(t.storeEnvironment.playlists[0].tracks[0].id);
    expect(next.tables.storeEnvironment.current).toBe(t.storeEnvironment.current);
    expect(run(next.tables, { type: 'environment.setVolume', volumePct: 70 })).toMatchObject({ ok: true, tables: next.tables });
  });

  it.each([-1, 101, 1.5, Number.NaN])('rejects invalid volume %s', volumePct => {
    const t = deepFreeze(fixture());
    expect(run(t, { type: 'environment.setVolume', volumePct })).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(t.storeEnvironment.volumePct).toBe(sample.volume);
  });

  it('selects an exact track across playlists and preserves playback, volume and sensor state', () => {
    const tables = fixture();
    const closing = tables.storeEnvironment.playlists.at(-1)!;
    const trackId = closing.tracks.at(-1)!.id;
    const selected = run(tables, { type: 'environment.selectTrack', trackId });
    if (!selected.ok) throw new Error(selected.reason);
    expect(selected).toMatchObject({ noticeKey: 'data.environment.trackSelected', undoable: false,
      value: { playlistId: closing.id, track: { id: trackId }, playing: true, volumePct: sample.volume } });
    expect(selected.tables.storeEnvironment.current).toBe(tables.storeEnvironment.current);
    expect(run(tables, { type: 'environment.selectTrack', trackId, playlistId: 'morning' }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND', reason: 'UNKNOWN_TRACK' });
    const ambiguous = { storeEnvironment: { ...tables.storeEnvironment, playlists: tables.storeEnvironment.playlists.map(playlist =>
      playlist.id === 'morning' ? { ...playlist, tracks: [...playlist.tracks, closing.tracks.at(-1)!] } : playlist) } };
    expect(run(ambiguous, { type: 'environment.selectTrack', trackId })).toMatchObject({ ok: false, reason: 'AMBIGUOUS_TRACK' });
    expect(run(ambiguous, { type: 'environment.selectTrack', trackId, playlistId: closing.id })).toMatchObject({ ok: true });
  });

  it('rejects unavailable devices, unknown and empty playlists without changing canonical state', () => {
    const t = fixture();
    expect(run(t, { type: 'environment.selectPlaylist', playlistId: 'missing' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const absent = { ...t, storeEnvironment: { ...t.storeEnvironment, musicDevice: 'none' as const } };
    expect(run(absent, { type: 'environment.setPlaying', playing: false })).toMatchObject({ ok: false, reason: 'DEVICE_UNAVAILABLE' });
    const empty = { ...t, storeEnvironment: { ...t.storeEnvironment, playlists: t.storeEnvironment.playlists.map(p => ({ ...p, tracks: [] })) } };
    expect(run(empty, { type: 'environment.skipTrack', direction: 'next' })).toMatchObject({ ok: false, reason: 'DEVICE_UNAVAILABLE' });
    expect(selectStoreEnvironment({ tables: absent }, 'normal').music.unavailableReason).toBe('DEVICE_UNAVAILABLE');
  });

  it('returns empty and error fallbacks while preserving manual control state', () => {
    const t = deepFreeze(fixture());
    expect(selectStoreEnvironment({ tables: t }, 'empty')).toMatchObject({ sensorStatus: 'none', current: null, music: { deviceStatus: 'none', unavailableReason: 'DEVICE_UNAVAILABLE' }, alerts: [] });
    expect(selectStoreEnvironment({ tables: t }, 'error')).toMatchObject({ status: 'error', retryable: true });
    expect(selectStoreEnvironment({ tables: t }, 'normal').music).toMatchObject({ playing: true, volumePct: sample.volume });
  });
});
