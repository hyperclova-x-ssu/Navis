// D-333 (LARGE-CARDS-1): the large 회원목록 card lists more recent visitors, each with the grade the data holds.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, selectMembers } from '../../../data/widget-data';
import type { CellSpan, ContentShape } from '../../../contracts';
import { MembersPanel } from './members';
import { CustomerAnalysisPanel } from './customer-analysis';
import { selectCameras } from '../../../data/widget-data';

const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
afterEach(cleanup);
const seed = selectMembers(createWidgetDataStore().getSnapshot(), {});
const mount = (w: CellSpan, h: CellSpan, preview?: Parameters<typeof renderWithKit>[1]) =>
  renderWithKit(<MembersPanel featureId="members" condition={{ kind: 'default' }} host={host} width={w} height={h} shape={shapeOf(w, h)} presetId="A" editing={false} />, preview);
const visitRows = () => [...document.querySelectorAll('[data-slot="members.list"]')].find((l) => l.querySelector('.mc-list__title')?.textContent === '최근 방문')?.querySelectorAll('li') ?? [];

describe('회원목록 4×4 (D-333)', () => {
  it('lists more recent visitors than the 6 of a 2×3 card, each with its grade', () => {
    expect(seed.rows.length).toBeGreaterThan(14);
    mount(2, 3);
    expect(visitRows()).toHaveLength(6);
    expect([...visitRows()].some((r) => r.querySelector('.mc-row__note'))).toBe(false);
    cleanup();
    mount(4, 4);
    const rows = [...visitRows()];
    expect(rows.length).toBeGreaterThan(6);
    expect(rows.length).toBeLessThanOrEqual(seed.rows.length);
    const grades = ['단골', '자주 방문', '가끔 방문', '오랜 기간 미방문'];
    for (const row of rows) expect(grades).toContain(row.querySelector('.mc-row__note')!.textContent);
  });
  it('writes each visitor\'s own grade and last visit date from the member row', () => {
    mount(4, 4);
    const first = [...visitRows()][0]!;
    const newest = [...seed.rows].sort((a, b) => (b.lastVisit ?? '').localeCompare(a.lastVisit ?? ''))[0]!;
    const label: Record<string, string> = { regular: '단골', frequent: '자주 방문', occasional: '가끔 방문', inactive: '오랜 기간 미방문' };
    expect(first.querySelector('.mc-row__note')!.textContent).toBe(label[newest.grade]);
    expect(first.querySelector('.mc-row__value')!.textContent).toMatch(/\d+\/\d+\(.\)/);
  });
});

const cctv = (w: CellSpan, h: CellSpan, preview?: Parameters<typeof renderWithKit>[1]) =>
  renderWithKit(<CustomerAnalysisPanel featureId="customer-analysis" condition={{ kind: 'default' }} host={host} width={w} height={h} shape={shapeOf(w, h)} presetId="A" editing={false} />, preview);
/** The rows under the 「CCTV 상태」 title (the preview variants carry their own camera ids). */
const cameraRows = () => [...(([...document.querySelectorAll('[data-slot="customer-analysis.list"]')].find((l) => l.querySelector('.mc-list__title')?.textContent === 'CCTV 상태'))?.querySelectorAll<HTMLElement>('li') ?? [])];
const cameras = selectCameras(createWidgetDataStore().getSnapshot(), {});

describe('CCTV 현황 4×4 (D-333)', () => {
  it('lists every camera with its connection and whether it records, from the camera data', () => {
    expect(cameras.length).toBeGreaterThan(0);
    cctv(4, 4);
    const rows = cameraRows();
    expect(rows).toHaveLength(cameras.length);
    for (const row of rows) {
      const camera = cameras.find((c) => c.cameraId === row.getAttribute('data-row-id'))!;
      expect(row.querySelector('.mc-row__value')!.textContent).toBe(camera.connection === 'connected' ? '연결됨' : '연결 끊김');
      expect(row.querySelector('.mc-row__note')!.textContent).toBe(camera.operation === 'recording' ? '녹화 중' : '녹화 중지');
    }
  });
  it('shows the disconnected camera as 연결 끊김 and does not add the list to the shorter cards', () => {
    cctv(4, 4, { preview: { family: 'normal', overrides: { 'customer-analysis': 'camera-disconnected' } } });
    expect(cameraRows().map((r) => r.querySelector('.mc-row__value')?.textContent)).toContain('연결 끊김');
    cleanup();
    cctv(4, 2);
    expect(cameraRows()).toHaveLength(0);
    cleanup();
    cctv(2, 2);
    expect(cameraRows()).toHaveLength(0);
  });
});
