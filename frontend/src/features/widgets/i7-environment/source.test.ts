import { describe, expect, it, vi } from 'vitest';
import { createEnvironmentSeed, selectStoreEnvironment, type EnvironmentCommand } from '../../../data/iteration7/environment';
import type { DataCommandResult } from '../../../data/commands/types';
import { seedSupplement } from '../../../data/db/generated/supplement';
import { createEnvironmentPort, environmentView } from './source';

/** The cafe seed's one DB sensor sample (안숭잘부 카페, 2026-11-17 15:45): the view must show exactly what the DB holds. */
const sample = seedSupplement.environment[0];

describe('environment source adapter', () => {
  it('feeds manual DB readings to the original climate view without claiming a connected sensor', () => {
    const { storeEnvironment } = createEnvironmentSeed();
    const reading = { measuredAt: '2026-11-17T15:45', temperatureC: 29, humidityPct: 45 };
    const tables = { storeEnvironment: { ...storeEnvironment, source: 'manual' as const, current: reading, readings: [reading] } };
    expect(environmentView(selectStoreEnvironment({ tables }))).toMatchObject({
      status: 'ready', sensorStatus: 'manual', current: { temperature: 29, humidity: 45 }, lastMeasuredAt: '15:45',
      trend: [{ time: '15:45', temperature: 29, humidity: 45 }], music: { deviceStatus: 'disconnected' },
    });
  });
  it('uses the same selector as briefing for both ordinary and special states', () => {
    const tables = createEnvironmentSeed();
    expect(environmentView(selectStoreEnvironment({ tables }, 'normal'))).toMatchObject({ status: 'ready', current: { temperature: sample.temperature, humidity: sample.humidity }, lastMeasuredAt: sample.measuredAt.slice(11, 16) });
    expect(environmentView(selectStoreEnvironment({ tables }, 'out_of_range'))).toMatchObject({ status: 'ready', current: { temperature: 28.5 } });
    expect(environmentView(selectStoreEnvironment({ tables }, 'sensor_disconnected'))).toMatchObject({ status: 'ready', sensorStatus: 'disconnected' });
    expect(environmentView(selectStoreEnvironment({ tables }, 'empty'))).toEqual({ status: 'empty' });
    expect(environmentView(selectStoreEnvironment({ tables }, 'error'))).toEqual({ status: 'error' });
  });
  it('passes music commands to the shared dispatcher', () => {
    const dispatch = vi.fn<(command: EnvironmentCommand) => DataCommandResult>(() => ({ ok: true, revision: 1 }));
    const port = createEnvironmentPort(dispatch, () => {});
    port.setPlaying(false); port.skipTrack('next'); port.setVolume(70); port.selectPlaylist('p1');
    expect(dispatch.mock.calls.map(call => call[0])).toEqual([{ type: 'environment.setPlaying', playing: false }, { type: 'environment.skipTrack', direction: 'next' }, { type: 'environment.setVolume', volumePct: 70 }, { type: 'environment.selectPlaylist', playlistId: 'p1' }]);
  });
});
