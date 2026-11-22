/**
 * LARGE-CARDS-3 (D-333): the 4x4 AI 홍보 영상 card shows more of the real data it holds (more menu rows with their photo counts) and never
 * writes a row the data does not have. (The 마케팅 성과 card of this file is gone with the widget, D-365.)
 */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan, ContentShape } from '../../../contracts';
import { createWidgetDataStore, type WidgetDataStore } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { promoSession } from './promo-session';
import { createFakeServer, type FakeServer } from './promo-test-server';
import { PromoVideoPanel } from './promo-video';
import { PHOTO_MENU, cafeModel, makeHost, rawOf, syncedCafeStore } from './test-helpers';

const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
let server: FakeServer;
let stores: WidgetDataStore[] = [];
const newStore = (photos = 10): WidgetDataStore => {
  const s = createWidgetDataStore(); stores.push(s);
  return syncedCafeStore(s, { [PHOTO_MENU]: photos });
};
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-10T10:00:00+09:00'));
  server = createFakeServer();
  vi.stubGlobal('fetch', vi.fn(server.fetch));
});
afterEach(() => {
  cleanup();
  for (const s of stores) promoSession(s).dispose();
  stores = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const text = (el: Element) => (el.textContent ?? '').replace(/[ ⁠]/g, ' ').replace(/\s+/g, ' ').trim();

describe('AI 홍보 영상 (26) on large cards', () => {
  const catalog = () => Array.from(document.querySelectorAll('[data-slot="promo-video.catalog"] li:not(.pv-panel__more)'));
  const panel = (store: WidgetDataStore, w: number, h: number) => renderWithKit(
    <PromoVideoPanel featureId="promo-video" condition={{ kind: 'default' }} width={w as CellSpan} height={h as CellSpan} shape={shapeOf(w, h)} presetId="A" editing={false} host={makeHost()} />, { store });

  it('lists ten menus with their photo counts at 4x4 and `외 n개` for the rest; 3x2 and 4x2 keep four rows', () => {
    const menus = cafeModel('promo-video').menus;
    expect(menus.length).toBeGreaterThan(10);
    panel(newStore(), 4, 4);
    expect(catalog()).toHaveLength(10);
    expect(text(catalog()[0]!)).toBe(`${rawOf(menus.find((m) => m.menuId === PHOTO_MENU)!.name)} 준비됨 · 사진 10장`);
    expect(document.querySelector('[data-slot="promo-video.catalog.more"]')).toHaveTextContent(`외 ${menus.length - 10}개`);
    expect(catalog().filter((li) => li.classList.contains('mp-extra'))).toHaveLength(6);
    cleanup(); panel(newStore(), 4, 3);
    expect(catalog()).toHaveLength(7);
    cleanup(); panel(newStore(), 3, 2);
    expect(catalog()).toHaveLength(4);
    expect(text(catalog()[0]!)).not.toContain('사진 10장');
    cleanup(); panel(newStore(), 4, 2);
    expect(catalog()).toHaveLength(4);
  });
  it('never lists a menu or a photo count the catalog does not have', () => {
    panel(newStore(), 4, 4);
    const lines = catalog().map(text);
    expect(lines.filter((line) => /사진 \d+장/.test(line)).length).toBe(1);
    expect(lines.filter((line) => line.endsWith('사진 없음')).length).toBe(9);
  });
});
