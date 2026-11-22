/**
 * LARGE-CARDS-3 (D-333): the 4x4 메시지·리뷰 응대 and 커뮤니티 cards show more of the real threads and offers they hold
 * (more rows, the received time, the reason, the reply deadline) and never write a row the data does not have.
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
const text = (li: Element) => (li.textContent ?? '').replace(/[ ⁠]/g, ' ');
const seedText = (key: string) => key.replace(/^seed:/, '');
const shortKo = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${'일월화수목금토'[d.getUTCDay()]})`; };

describe('메시지·리뷰 응대 (21) on large cards', () => {
  /** Priority rows carry the customer's text; the channel rows (name + count) do not. */
  const priority = () => rows().filter((li) => li.querySelector('.mkt-row__text'));
  it('shows six waiting items at 4x4, three at 2x2 and 4x2, with the received time and the reason', () => {
    const m = readModel(createWidgetDataStore().getSnapshot(), 'ai-response');
    expect(m.priority.length).toBeGreaterThan(6);
    panel('ai-response', 4, 4);
    expect(priority()).toHaveLength(6);
    const first = m.priority[0]!;
    expect(text(priority()[0]!)).toContain(seedText((first.body as { key: string }).key).slice(0, 20));
    expect(priority()[0]!.querySelector('.mkt-row__sub')!.textContent).toMatch(/받음/);
    expect(priority()[0]!.querySelector('.mkt-row__sub')!.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text(priority()[0]!)).toMatch(/확인 필요\s*·\s*\S+/);
    expect(priority().filter((li) => li.hasAttribute('data-mkt-extra'))).toHaveLength(3);
    cleanup(); panel('ai-response', 4, 2);
    expect(priority()).toHaveLength(3);
    cleanup(); panel('ai-response', 2, 2);
    expect(priority().length).toBeLessThanOrEqual(3);
    expect(rows().map(text).join('|')).not.toMatch(/받음/);
    expect(rows().map(text).join('|')).not.toMatch(/확인 필요\s*·/);
  });
  it('never lists more waiting items than the data has', () => {
    const base = createSeedTables();
    const keep = new Set(base.inquiryThread.filter((th) => th.status !== 'done').slice(0, 2).map((th) => th.threadId));
    const store = createWidgetDataStore({ inquiryThread: base.inquiryThread.filter((th) => th.status === 'done' || keep.has(th.threadId)) });
    panel('ai-response', 4, 4, { store });
    expect(priority()).toHaveLength(2);
  });
});

describe('커뮤니티 (22) on large cards', () => {
  const offers = () => rows().filter((li) => li.querySelector('.mkt-row__text'));
  it('adds the offers to browse and the reply deadline at 4x4, and keeps 2x2 and 4x2 to the offers awaiting a reply', () => {
    const m = readModel(createWidgetDataStore().getSnapshot(), 'community');
    expect(m.pending.length).toBe(1); expect(m.publicOffers.length).toBe(3);
    panel('community', 4, 4);
    expect(offers()).toHaveLength(m.pending.length + m.publicOffers.length);
    const lines = offers().map(text);
    expect(lines[0]).toContain(seedText(m.pending[0]!.titleKey));
    expect(lines[0]).toContain(`${shortKo(m.pending[0]!.respondBy.slice(0, 10))} 18:00까지 응답`);
    for (const offer of m.publicOffers) {
      const line = lines.find((l) => l.includes(seedText(offer.titleKey)))!;
      expect(line).toContain(`동네 둘러보기 · ${seedText(offer.fromStoreKey)}`);
      expect(line).toMatch(/(오늘|\d+\/\d+\([일월화수목금토]\)) 18:00까지 응답/);
    }
    cleanup(); panel('community', 2, 2);
    expect(offers()).toHaveLength(1);
    expect(rows().map(text).join('|')).not.toContain('까지 응답');
    cleanup(); panel('community', 4, 2);
    expect(offers()).toHaveLength(1);
  });
  it('adds the offers in progress and writes nothing for groups that have no offers', () => {
    const base = createSeedTables();
    const noPublic = createWidgetDataStore({ partnershipOffer: base.partnershipOffer.filter((o) => o.visibility !== 'public') });
    panel('community', 4, 4, { store: noPublic });
    expect(offers()).toHaveLength(1);
    expect(rows().map(text).join('|')).not.toContain('동네 둘러보기 ·');
    cleanup();
    const accepted = createWidgetDataStore({ partnershipOffer: base.partnershipOffer.map((o, i) => (i === 1 ? { ...o, visibility: 'direct' as const, status: 'accepted' as const } : o)) });
    panel('community', 4, 4, { store: accepted });
    const inProgress = rows().find((li) => li.querySelector('.ui-status-badge, .ui-status-chip') && text(li).includes('진행 중') && li.querySelector('.mkt-row__text'));
    expect(inProgress).toBeTruthy();
    expect(text(inProgress!)).toContain(seedText(base.partnershipOffer[1]!.titleKey));
    expect(offers()).toHaveLength(1 + 1 + (base.partnershipOffer.filter((o, i) => i !== 1 && o.visibility === 'public').length));
  });
});
