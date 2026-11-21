import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DetailRef, FeatureId, WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createSeedTables } from '../../../data/db/seed';
import { readModel } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

afterEach(cleanup);

/** N20: the chat hand-off opens each local widget at the row, hour or list it names. */
const host: WidgetHost = {
  layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify() {}, acknowledgeBriefing() {},
};
const condition = { kind: 'default' } as const;
function detail(id: FeatureId, ref: Partial<DetailRef>, store = createWidgetDataStore(createSeedTables())) {
  const Detail = widgets.find(widget => widget.id === id)!.Detail!;
  return renderWithKit(<Detail featureId={id} condition={condition} detailRef={{ featureId: id, ...ref }} host={host} />, { modules: widgets, store });
}

describe('N20 local widget hand-off', () => {
  it('opens the folded list already expanded when the hand-off names it', () => {
    const store = createWidgetDataStore(createSeedTables());
    const row = readModel(store.getSnapshot(), 'local-changes').openChanges[0];
    expect(store.dispatch({ type: 'localChanges.acknowledge', changeId: row.changeId }).ok).toBe(true);
    detail('local-changes', { view: 'folded', itemId: row.changeId }, store);
    const folded = document.querySelector('ul[aria-label]:not([data-slot])');
    expect(folded).toBeInTheDocument();
    expect(folded?.querySelector('[aria-current="true"]')).toBeInTheDocument();
  });

  it('keeps the folded list closed for an ordinary entry', () => {
    const store = createWidgetDataStore(createSeedTables());
    const row = readModel(store.getSnapshot(), 'local-changes').openChanges[0];
    expect(store.dispatch({ type: 'localChanges.acknowledge', changeId: row.changeId }).ok).toBe(true);
    detail('local-changes', {}, store);
    expect(document.querySelector('ul[aria-label]:not([data-slot])')).toBeNull();
  });

  it('shows the hour the hand-off names, and the peak otherwise', () => {
    const model = readModel(createWidgetDataStore(createSeedTables()).getSnapshot(), 'trade-area');
    const other = model.hours.find(item => item.hour !== model.peak.hour)!;
    detail('trade-area', { view: 'hour', hour: other.hour });
    expect(document.querySelector('[data-slot="trade-area.metric.value"]')?.textContent).toContain(String(other.people));
    cleanup();
    detail('trade-area', {});
    expect(document.querySelector('[data-slot="trade-area.metric.value"]')?.textContent).toContain(String(model.peak.people));
  });

  it('expands the keyword the hand-off names', () => {
    const model = readModel(createWidgetDataStore(createSeedTables()).getSnapshot(), 'local-trends');
    const keyword = model.keywords[model.keywords.length - 1];
    detail('local-trends', { view: 'keywords', itemId: keyword.keywordId });
    const expanded = document.querySelector('button[aria-expanded="true"]');
    expect(expanded).toBeInTheDocument();
    expect(expanded?.textContent).toContain(String(keyword.changePercent ?? ''));
    expect(screen.getAllByRole('heading', { level: 4 })[0].textContent).toBe(keyword.keywordKey.replace(/^seed:/u, ''));
  });
});
