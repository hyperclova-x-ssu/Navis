/** FIX-RV3 (RV-REALVERIFY-3, 상권분석): the hourly chart shows the hours the store is open, like the sample chart; it never hides data that has no open hour. */
import { expect, it } from 'vitest';
import { STORE_HOURS } from '../../store-hours';
import { openHourBands, type PopulationBand } from './dto';

const band = (startHour: number): PopulationBand => ({ region: '서울 동작구 상도동', quarter: '2026-Q4', weekday: 1, startHour, endHour: startHour + 1, estimate: 100_000 + startHour,
  referenceDate: '2026-11-19', refreshedAt: '2026-11-21T00:00:00.000Z', sourceUrl: 'https://data.seoul.go.kr/' });
const day = Array.from({ length: 24 }, (_, hour) => band(hour));

it('keeps only the opening hours of that weekday', () => {
  // Monday: 08:00~22:00 → the 14 bars 8~21, as in the sample chart.
  expect(STORE_HOURS.mon).toEqual(['08:00', '22:00']);
  expect(openHourBands(day, 1).map(row => row.startHour)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  // Saturday 09:30~21:30 → hours that touch opening time (9 to 21); Sunday 10:00~20:30 → 10 to 20.
  expect(openHourBands(day, 6).map(row => row.startHour)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  expect(openHourBands(day, 7).map(row => row.startHour)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  expect(openHourBands(day, 0)).toBe(day);
});

it('keeps the whole day when no band falls inside opening time', () => {
  const night = [band(1), band(2), band(3)];
  expect(openHourBands(night, 1)).toBe(night);
  expect(openHourBands([], 1)).toEqual([]);
});
