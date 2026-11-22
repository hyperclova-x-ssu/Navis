/** LARGE-CARDS-2 (D-333): the wide manuals card names the manuals under each category and lists every checklist; smaller cards stay as they were. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createWidgetDataStore, koKey, koText, makeHost, manualsModel as model, renderPanel } from './test-helpers';

afterEach(cleanup);
const rowOf = (container: HTMLElement, id: string) => container.querySelector(`[data-row-id="${id}"]`);

describe('manuals panel at large sizes (D-333)', () => {
  it('4x4 puts the titles of the manuals of a category under the category row', () => {
    const store = createWidgetDataStore();
    const { container } = renderPanel('manuals', 4, 4, makeHost().host, { store });
    const { byCategory, manuals } = model(store);
    expect(byCategory.length).toBeGreaterThan(1);
    for (const category of byCategory) {
      const row = rowOf(container, category.category);
      expect(row).toHaveTextContent(koKey(category.categoryKey));
      const titles = manuals.filter(manual => manual.category === category.category).map(manual => koText(manual.title));
      expect(titles).toHaveLength(category.count);
      expect(row?.querySelector('.mgmt-row__sub')?.textContent?.replace(/\u00a0/g, ' ')).toBe(titles.join(' · '));
    }
  });
  it('3x3 and 4x2 show the titles as well; 2x2, 2x3 and 1x4 keep the plain count rows', () => {
    for (const [width, height] of [[3, 3], [4, 2]] as const) {
      const { container } = renderPanel('manuals', width, height, makeHost().host, { store: createWidgetDataStore() });
      expect(container.querySelectorAll('.mgmt-row__sub').length).toBeGreaterThan(0);
      cleanup();
    }
    for (const [width, height] of [[2, 2], [2, 3], [2, 4]] as const) {
      const { container } = renderPanel('manuals', width, height, makeHost().host, { store: createWidgetDataStore() });
      expect(container.querySelectorAll('.mgmt-row__sub')).toHaveLength(0);
      cleanup();
    }
  });
  it('lists every checklist of today at 4x4, not only the first two', () => {
    const store = createWidgetDataStore();
    const checklists = model(store).todayChecklist;
    const { container } = renderPanel('manuals', 4, 4, makeHost().host, { store });
    expect(container.querySelectorAll('[data-row-id^="check-"]')).toHaveLength(checklists.length);
  });
  it('adds no sub-text rows when there are no manuals', () => {
    const { container } = renderPanel('manuals', 4, 4, makeHost().host, { preview: { family: 'empty', overrides: {} } });
    expect(container.querySelectorAll('.mgmt-row__sub')).toHaveLength(0);
    expect(container.querySelectorAll('.mgmt-row')).toHaveLength(0);
  });
});
