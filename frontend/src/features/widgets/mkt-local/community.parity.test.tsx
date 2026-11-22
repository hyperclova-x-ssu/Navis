/** FIX-RV3 (RV-REALVERIFY-3): the community window keeps its original tabs in HTTP mode; the approved real-only tabs come after them. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { TODAY } from '../../../data/db/time';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { fakeBackend } from '../../../data/reality/00/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

afterEach(cleanup);

const at = `${TODAY}T06:45:00.000Z`;
const base = '/marketing';
const page = { items: [], nextCursor: null, asOf: at, sourceRevision: 1 };

function open() {
  const backend = fakeBackend();
  backend.on('GET', `${base}/local-changes`, ({ query }) => ({ ...page, coverage: null, unreadCount: 0, period: { from: query.from, to: query.to } }));
  backend.on('GET', `${base}/trade-area`, ({ query }) => ({ asOf: at, period: query, population: { status: 'unavailable', items: [] }, sales: { status: 'empty', items: [] } }));
  backend.on('GET', `${base}/local-trends`, ({ query }) => ({ asOf: at, period: query, search: null, sales: { status: 'empty', items: [] } }));
  backend.on('GET', `${base}/offers`, () => page);
  backend.on('GET', `${base}/offers/peers`, () => ({ status: 'available', items: [] }));
  backend.on('GET', `${base}/community/cafe-boards`, () => ({ items: [] }));
  backend.on('GET', `${base}/community/cafe-posts`, () => page);
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'local' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify: vi.fn(), acknowledgeBriefing() {} };
  const Detail = widgets.find(widget => widget.id === 'community')!.Detail!;
  renderWithKit(<Detail featureId="community" condition={{ kind: 'default' }} detailRef={{ featureId: 'community' }} host={host} />, { modules: widgets, store });
}

it('keeps the original tabs and adds the approved sent-offers and Café tabs after them', async () => {
  open();
  await screen.findByRole('tab', { name: '받은 제안' });
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['받은 제안', '동네 둘러보기', '보낸 제안', '카페 글쓰기']);
  // The original browse tab says plainly that there is nothing public to browse, like the sample window does with no public offers.
  fireEvent.click(screen.getByRole('tab', { name: '동네 둘러보기' }));
  expect(await screen.findByText('둘러볼 공개 제안이 없어요')).toBeInTheDocument();
});
