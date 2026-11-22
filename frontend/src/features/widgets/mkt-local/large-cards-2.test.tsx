/**
 * LARGE-CARDS-2 (D-333): the 4x4 동네 변화 알림, 상권분석 and 로컬 트렌드 cards show more of the real data they hold
 * (distance, source and update time, every hour, every keyword with its mentions) and never write a line the data does not have.
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
  it('adds the distance and update time under each change, and the same-category badge, at 4x4', () => {
    expect(m.openChanges.length).toBeGreaterThan(0);
    panel('local-changes', 4, 4);
    expect(rows()).toHaveLength(m.openChanges.length);
    rows().forEach((li, i) => {
      const change = m.openChanges[i]!;
      const [when, extra] = subs(li);
      expect(when).not.toMatch(/매장에서/);
      expect(extra).toContain(`매장에서 ${change.distanceM}m`);
      expect(extra).toMatch(/ · .+ 갱신$/);
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
      expect(rows().map(text).join('|')).not.toMatch(/매장에서|같은 업종/);
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
  it('lists every hour of the data in clock order at 4x4, the area and period beside the average line', () => {
    expect(m.hours.length).toBeGreaterThan(5);
    panel('trade-area', 4, 4);
    expect(rows()).toHaveLength(m.hours.length);
    const titles = rows().map((li) => li.querySelector('.mkt-row__title')!.textContent);
    expect(titles[0]).toMatch(/^\d+~\d+시$/);
    expect(rows().map((li) => li.querySelector('.mkt-row__value')!.textContent)).toEqual([...m.hours].sort((a, b) => a.hour - b.hour).map((h) => `${h.people}명`));
    const note = text(document.querySelector('.mkt-secondary')!);
    expect(note).toMatch(/ · .+ · 시간대별 일평균$/);
    // the busiest five stay the rows a tight card keeps; the rest are the extra rows that drop first
    expect(rows().filter((li) => li.hasAttribute('data-mkt-extra'))).toHaveLength(m.hours.length - 5);
  });
  it('keeps the 4x2 and 2x2 cards as before: the busiest hours only', () => {
    panel('trade-area', 4, 2);
    expect(rows()).toHaveLength(5);
    expect(text(document.querySelector('.mkt-secondary')!)).toBe('시간대별 일평균');
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

describe('로컬 트렌드 (18) on large cards', () => {
  const m = model('local-trends');
  it('4x4 gives each keyword its mentions and the count before, and the area and period beside the key number', () => {
    panel('local-trends', 4, 4);
    expect(rows()).toHaveLength(m.keywords.length);
    rows().forEach((li, i) => {
      const keyword = m.notable[i]!;
      const [category, mentions] = subs(li);
      expect(category).toMatch(/^연관 카테고리: /);
      expect(mentions).toContain(`언급 ${keyword.mentions}회`);
      expect(mentions.includes('이전')).toBe(keyword.previous !== null);
    });
    expect(text(document.querySelector('.mkt-secondary')!)).toMatch(/^지역: .+ · \d/);
  });
  it('lists the keywords that are not notable after the notable ones, as the extra rows that drop first', () => {
    const base = createSeedTables();
    const first = base.trendKeyword[0]!;
    const store = createWidgetDataStore({ trendKeyword: [...base.trendKeyword,
      { ...first, keywordId: 'kw-large-flat', mentions: 40, prevMentions: 40 },
      { ...first, keywordId: 'kw-large-new', mentions: 12, prevMentions: null }] });
    const all = readModel(store.getSnapshot(), 'local-trends');
    expect(all.keywords.length).toBe(all.notable.length + 2);
    panel('local-trends', 4, 4, { store });
    expect(rows()).toHaveLength(all.keywords.length);
    const extra = rows().slice(all.notable.length);
    expect(extra.every((li) => li.hasAttribute('data-mkt-extra'))).toBe(true);
    expect(rows().slice(0, all.notable.length).some((li) => li.hasAttribute('data-mkt-extra'))).toBe(false);
    expect(text(extra[0]!)).toContain('언급 40회');
    expect(text(extra[0]!)).toContain('이전 40회');
    expect(text(extra[1]!)).toContain('언급 12회');
    expect(text(extra[1]!)).not.toContain('이전');
    cleanup();
    panel('local-trends', 4, 2, { store });
    expect(rows()).toHaveLength(all.notable.length);
  });
  it('keeps the 4x2 and 2x2 cards as before: the notable keywords, one caption line, no area line', () => {
    for (const [w, h] of [[4, 2], [2, 2]] as const) {
      panel('local-trends', w, h);
      expect(rows()).toHaveLength(m.notable.length);
      for (const li of rows()) expect(subs(li)).toHaveLength(1);
      expect(document.querySelector('.mkt-secondary')).toBeNull();
      cleanup();
    }
  });
  it('lists only the keywords the data has', () => {
    const base = createSeedTables();
    const store = createWidgetDataStore({ trendKeyword: base.trendKeyword.slice(0, 2) });
    panel('local-trends', 4, 4, { store });
    expect(rows().length).toBeLessThanOrEqual(2);
  });
});
