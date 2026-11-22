/**
 * LARGE-CARDS-2 (D-333): the 4x4 동네 변화 알림, 상권분석 and 로컬 트렌드 cards show more of the real data they hold
 * (distance, source and update time, every hour, and ranked search terms).
 */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CellSpan, ContentShape, FeatureId, WidgetHost } from '../../../contracts';
import { createSeedTables } from '../../../data/db/seed';
import { createWidgetDataStore } from '../../../data/db/store';
import { readModel } from '../../../data/widget-data';
import { renderWithKit, type KitRenderOptions } from '../../../ui/test-utils';
import { widgets } from './index';
import { testTrendRows, trendTestStore } from './local-trends.testing';

afterEach(cleanup);

const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
const host = (): WidgetHost => ({ layer: 'marketing', openClosing: () => true, resetPreview: () => {}, openLinked: () => {}, openDetail: () => {}, notify: () => {}, acknowledgeBriefing: () => {} });
function panel(id: FeatureId, w: CellSpan, h: CellSpan, options: KitRenderOptions = {}) {
  const Panel = widgets.find((x) => x.id === id)!.Panel;
  return renderWithKit(<Panel featureId={id} condition={{ kind: 'default' }} width={w} height={h} shape={shapeOf(w, h)} presetId="A" editing={false} host={host()} />, { ...options, modules: widgets });
}
const rows = () => Array.from(document.querySelectorAll('.mkt-rows > li'));
const text = (el: Element) => (el.textContent ?? '').replace(/[\u00a0\u2060]/g, ' ');
const subs = (li: Element) => Array.from(li.querySelectorAll('.mkt-row__sub')).map(text);
const model = <T extends FeatureId>(id: T) => readModel(createWidgetDataStore().getSnapshot(), id);

describe('동네 변화 알림 (19) on large cards', () => {
  const m = model('local-changes');
  it('adds the source and update time under each change, and the same-category badge, at 4x4', () => {
    expect(m.openChanges.length).toBeGreaterThan(0);
    panel('local-changes', 4, 4);
    expect(rows()).toHaveLength(m.openChanges.length);
    rows().forEach((li, i) => {
      const change = m.openChanges[i]!;
      const [when, extra] = subs(li);
      expect(when).not.toMatch(/출처/);
      expect(extra).not.toMatch(/매장에서/);
      expect(extra).toMatch(/^출처: .+ · .+ 갱신$/);
      expect(text(li).includes('같은 업종')).toBe(change.sameCategory);
    });
  });
  it('shows the same lines at 2x4 and keeps the 4x2, 4x3 and 2x2 cards as before: one caption line, no badge', () => {
    panel('local-changes', 2, 4);
    for (const li of rows()) expect(subs(li)).toHaveLength(2);
    cleanup();
    for (const [w, h] of [[4, 2], [2, 2], [4, 3]] as const) {
      panel('local-changes', w, h);
      for (const li of rows()) expect(subs(li)).toHaveLength(1);
      expect(rows().map(text).join('|')).not.toMatch(/출처|같은 업종/);
      cleanup();
    }
  });
  it('never lists more changes than the data has', () => {
    const base = createSeedTables();
    const store = createWidgetDataStore({ localChange: base.localChange.filter((c) => c.changeId === m.openChanges[0]!.changeId) });
    panel('local-changes', 4, 4, { store });
    expect(rows()).toHaveLength(1);
  });
});

describe('상권분석 (20) on large cards', () => {
  const m = model('trade-area');
  it('lists the other measured hours in clock order alongside the 4x4 peak metric', () => {
    expect(m.hours.length).toBeGreaterThan(5);
    panel('trade-area', 4, 4);
    const remaining = m.hours.filter(h => h.hour !== m.peak?.hour);
    expect(rows()).toHaveLength(remaining.length);
    const titles = rows().map((li) => li.querySelector('.mkt-row__title')!.textContent);
    expect(titles[0]).toMatch(/^\d+~\d+시$/);
    expect(rows().map((li) => li.querySelector('.mkt-row__value')!.textContent)).toEqual(remaining.sort((a, b) => a.hour - b.hour).map((h) => `${h.people}명`));
    // PAR-3: the same source line as the real screen
    expect(text(document.querySelector('.mkt-secondary')!)).toMatch(/^서울 공개 자료 · /);
    // the busiest five stay the rows a tight card keeps; the rest are the extra rows that drop first
    expect(rows().filter((li) => li.hasAttribute('data-mkt-extra'))).toHaveLength(m.hours.length - 5);
  });
  it('keeps the 4x2 and 2x2 cards as before: the busiest hours only', () => {
    panel('trade-area', 4, 2);
    expect(rows()).toHaveLength(5);
    expect(text(document.querySelector('.mkt-secondary')!)).toMatch(/^서울 공개 자료 · /);
    cleanup();
    panel('trade-area', 2, 2);
    expect(rows()).toHaveLength(3);
  });
  it('lists no more hours than the data has', () => {
    const base = createSeedTables();
    const store = createWidgetDataStore({ footTraffic: base.footTraffic.slice(0, 3) });
    panel('trade-area', 4, 4, { store });
    expect(rows().length).toBeLessThanOrEqual(3);
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().filter((li) => li.hasAttribute('data-mkt-extra'))).toHaveLength(0);
  });
});

describe('search growth on large cards', () => {
  it('fills the large panel with ranked terms and marks extra rows to drop first', () => {
    panel('local-trends', 4, 4, { store: trendTestStore() });
    const following = testTrendRows.slice(1);
    expect(rows()).toHaveLength(following.length);
    expect(rows().filter(li => li.hasAttribute('data-mkt-extra'))).toHaveLength(following.length - 5);
    expect(rows().map(li => text(li.querySelector('.mkt-row__value')!))).toEqual(following.map(row => `+${row.changePercent.toFixed(1)}%`));
    expect(subs(rows()[0])).toEqual(['우리 메뉴에 없음']);
  });

  it('shows only the ranked rows that fit the shorter card', () => {
    for (const [w, h, count] of [[4, 2, 5], [2, 2, 3]] as const) {
      panel('local-trends', w, h, { store: trendTestStore() });
      expect(rows()).toHaveLength(count);
      expect(text(rows()[0])).toContain('2. 소금빵');
      cleanup();
    }
  });
});
