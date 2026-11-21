import { deepFreeze } from '../../db/freeze';
import type { EnvironmentAlert, EnvironmentTables, EnvironmentVariant, StoreEnvironmentModel } from './types';

/** Preview variants are presentation only; callers use normal for facts. */
export function selectStoreEnvironment(snapshot: { readonly tables: EnvironmentTables }, variant: EnvironmentVariant = 'normal'): StoreEnvironmentModel {
  const e = snapshot.tables.storeEnvironment;
  const unavailable = variant === 'empty' || variant === 'error';
  const sensorStatus = unavailable ? 'none' : variant === 'sensor_disconnected' ? 'disconnected' : e.sensor;
  const current = unavailable || sensorStatus === 'none' ? null : variant === 'out_of_range' && e.current ? { ...e.current, temperatureC: 28.5 } : e.current;
  const outside = current && (current.temperatureC < e.temperatureRange[0] || current.temperatureC > e.temperatureRange[1] || current.humidityPct < e.humidityRange[0] || current.humidityPct > e.humidityRange[1]);
  const reason = sensorStatus === 'disconnected' ? 'SENSOR_DISCONNECTED' : outside ? 'OUT_OF_RANGE' : null;
  const alerts: EnvironmentAlert[] = reason ? [{ reason, group: 'tasks', messageKey: `data.environment.alert.${reason}`, sourceFeatureId: 'store-environment' }] : [];
  const playlist = e.playlists.find(p => p.id === e.playlistId);
  const track = playlist?.tracks.find(t => t.id === e.trackId) ?? null;
  const noMusic = unavailable || e.musicDevice === 'none' || !playlist?.tracks.length || !track;
  return deepFreeze({
    status: variant === 'error' ? 'error' : variant === 'empty' ? 'empty' : 'ready', retryable: variant === 'error',
    ...(variant === 'error' ? { messageKey: 'data.environment.error.load' } : variant === 'empty' ? { messageKey: 'data.environment.empty.sensor' } : {}),
    sensorStatus, current, lastMeasuredAt: current?.measuredAt ?? null,
    ranges: { temperature: e.temperatureRange, humidity: e.humidityRange }, trend: unavailable || sensorStatus === 'none' ? [] : e.readings,
    music: { deviceStatus: unavailable ? 'none' : e.musicDevice, playlists: unavailable ? [] : e.playlists, playlistId: unavailable ? null : e.playlistId, track: unavailable ? null : track, playing: !noMusic && e.playing, volumePct: e.volumePct, unavailableReason: noMusic ? 'DEVICE_UNAVAILABLE' : null }, alerts,
  });
}
