/** Test helpers for the mgmt-store widgets (T-050): a recording host and panel/detail renderers. */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderWithKit, type KitRenderOptions } from '../../../ui/test-utils';
import { panelShape } from '../../../ui';
import type { CellSpan, DetailRef, FeatureId, WidgetHost, WidgetModule } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { dataBundle, NORMAL_VARIANT, resolveDataText, selectWidget, type DataText } from '../../../data/widget-data';
import { managementBundle } from '../../../data/messages/management';
import { createTranslator } from '../../../i18n';
import { mgmtStoreBundle } from './messages';
import { widgets } from './index';

export type TestHost = WidgetHost & { readonly [K in keyof WidgetHost]: WidgetHost[K] };

export function makeHost(): { host: WidgetHost; resetPreview: ReturnType<typeof vi.fn>; openLinked: ReturnType<typeof vi.fn>; openDetail: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> } {
  const resetPreview = vi.fn(); const openLinked = vi.fn(); const openDetail = vi.fn(); const notify = vi.fn();
  return { host: { layer: 'management', openClosing: vi.fn(() => true), resetPreview, openLinked, openDetail, notify, acknowledgeBriefing: vi.fn() }, resetPreview, openLinked, openDetail, notify };
}

export const moduleOf = (id: FeatureId): WidgetModule => {
  const found = widgets.find((m) => m.id === id);
  if (!found) throw new Error(`no module ${id}`);
  return found;
};

export function renderPanel(id: FeatureId, width: CellSpan, height: CellSpan, host: WidgetHost, options: KitRenderOptions = {}) {
  const { Panel } = moduleOf(id);
  const ui: ReactElement = <div className="ui-feature-panel" data-shape={panelShape(width, height)}><Panel featureId={id} condition={{ kind: 'default' }} width={width} height={height} shape={panelShape(width, height)} presetId="A" editing={false} host={host} /></div>;
  return renderWithKit(ui, options);
}

export function renderDetail(id: FeatureId, host: WidgetHost, options: KitRenderOptions = {}, ref: DetailRef = { featureId: id }) {
  const { Detail } = moduleOf(id);
  if (!Detail) throw new Error('no detail');
  return renderWithKit(<Detail featureId={id} condition={{ kind: 'default' }} detailRef={ref} host={host} />, options);
}

export { createWidgetDataStore };

/** The manuals model the widget reads (same selector), so tests take counts, titles and steps from the seed instead of literals. */
export function manualsModel(store: ReturnType<typeof createWidgetDataStore>) {
  const view = selectWidget(store.getSnapshot(), 'manuals', { kind: 'default' }, NORMAL_VARIANT);
  if (view.status !== 'ready') throw new Error('not ready');
  return view.model;
}

/** Korean text of a data value, resolved the way the widget does (raw text or a message key). */
const ko = createTranslator<string>('ko', mgmtStoreBundle, dataBundle, managementBundle);
export const koText = (value: DataText | null | undefined): string => resolveDataText((key, params) => ko.t(key, params), value);
export const koKey = (key: string): string => ko.t(key);
