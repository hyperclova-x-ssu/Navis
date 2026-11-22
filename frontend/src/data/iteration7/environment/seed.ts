import { seedSupplement } from '../../db/cafe-fixtures';
import { fixtureOccurred } from '../../db/fixture-dates';
import { timeOf } from '../../db/time';
import type { EnvironmentTables } from './types';

/** Five-minute example samples, fixed to the store's business clock. */
export function createLegacyEnvironmentSeed(): EnvironmentTables {
  const readings = Array.from({ length: 81 }, (_, i) => {
    const minute = 9 * 60 + i * 5;
    return { measuredAt: `2026-10-26T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, temperatureC: Math.round((21.5 + i / 80) * 10) / 10, humidityPct: 46 + Math.floor(i / 40) };
  });
  return { storeEnvironment: {
    sensor: 'connected', current: readings.at(-1)!, readings,
    temperatureRange: [18, 25], humidityRange: [40, 60], musicDevice: 'connected',
    playlistId: 'afternoon', trackId: 'afternoon-1', playing: true, volumePct: 55,
    playlists: [
      { id: 'morning', name: '아침 오픈 재즈', tracks: [{ id: 'morning-1', title: '아침의 재즈', artist: '카페 연주곡집' }, { id: 'morning-2', title: '창가의 피아노', artist: '카페 연주곡집' }] },
      { id: 'afternoon', name: '오후 잔잔한 로파이', tracks: [{ id: 'afternoon-1', title: '오후의 재즈 피아노', artist: '카페 연주곡집' }, { id: 'afternoon-2', title: '오후의 산책', artist: '카페 연주곡집' }] },
      { id: 'closing', name: '마감 차분한 어쿠스틱', tracks: [{ id: 'closing-1', title: '하루의 끝', artist: '카페 연주곡집' }, { id: 'closing-2', title: '저녁의 기타', artist: '카페 연주곡집' }] },
    ],
  } };
}

export function createEnvironmentSeed(): EnvironmentTables {
  const sample = seedSupplement.environment[0];
  const current = { ...sample, measuredAt: sample.measuredAt.slice(0, 16), temperatureC: sample.temperature, humidityPct: sample.humidity };
  const { storeEnvironment: earlier } = createLegacyEnvironmentSeed();
  // The supplement provides only the latest reading. Earlier points are sample indoor conditions for this cafe.
  const [hour, minute] = timeOf(current.measuredAt).split(':').map(Number);
  const firstMinute = 8 * 60;
  const span = hour * 60 + minute - firstMinute;
  const readings = Array.from({ length: Math.max(0, Math.ceil(span / 15)) }, (_, index) => {
    const elapsed = index * 15;
    const at = firstMinute + elapsed;
    const hh = String(Math.floor(at / 60)).padStart(2, '0');
    const mm = String(at % 60).padStart(2, '0');
    const progress = elapsed / span;
    const lunch = Math.sin(progress * Math.PI);
    return {
      measuredAt: `${current.measuredAt.slice(0, 10)}T${hh}:${mm}`,
      temperatureC: Math.round((current.temperatureC - 2.1 * (1 - progress) + 1.7 * lunch) * 10) / 10,
      humidityPct: Math.round(current.humidityPct - 3 * (1 - progress) + 5 * lunch),
    };
  });
  const elapsed = [...readings, current].filter(reading => fixtureOccurred(reading.measuredAt));
  return { storeEnvironment: {
    ...earlier, current: elapsed.at(-1) ?? null, readings: elapsed, volumePct: sample.volume,
    playlists: earlier.playlists.map(row => row.id === earlier.playlistId ? { ...row, name: sample.playlist } : row),
  } };
}
