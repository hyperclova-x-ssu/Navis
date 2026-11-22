import { expect, it } from 'vitest';
import { menuPatch, validHours, venuePatch } from '../../../../packages/naver/contracts/pn01/wire.ts';

it('bounds owner edits to the published visible fields', () => {
  expect(venuePatch({ name: '안숭잘부 카페', keywords: ['카페'] })).toBe(true);
  expect(venuePatch({ name: '안숭잘부 카페', searchVisible: true })).toBe(false);
  expect(venuePatch({ photos: ['https://example.com/photo.jpg'] })).toBe(false);
  expect(menuPatch({ price: 3800 })).toBe(true);
  expect(menuPatch({ price: 3800, cost: 900 })).toBe(false);
  expect(menuPatch({ price: 1.5 })).toBe(false);
});

it('preserves configured hours and rejects undocumented nested fields', () => {
  expect(validHours({ businessHours: [] })).toBe(false);
  expect(validHours({ businessHours: [{ day: 'mon', open: '08:07', close: '19:00' }] })).toBe(false);
  expect(validHours({ holidayHours: [{ date: '2026-11-18', closed: true }] })).toBe(true);
  expect(validHours({ holidayHours: [{ date: '2026-02-30', closed: true }] })).toBe(false);
  expect(validHours({ holidayHours: [{ date: '2026-11-18', closed: true, reason: '점검' }] })).toBe(false);
});
