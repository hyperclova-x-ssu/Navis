import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WidgetDataProvider } from '../../data/react';
import { createRealPort } from '../../data/reality/00';
import { fakeBackend, reply } from '../../data/reality/00/testing';
import { createWidgetDataStore } from '../../data/widget-data';
import { PosMenuPhoto } from './PosMenuPhoto';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('loads the Inventory photo reference through the authenticated Account port and releases the object URL', async () => {
  const backend = fakeBackend();
  backend.on('GET', '/files/test-photo/content', () => reply(200, 'test-image'));
  const revoke = vi.fn();
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = () => 'blob:inventory-photo';
    static revokeObjectURL = revoke;
  });
  const store = createWidgetDataStore();
  store.bindReal(createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [] }));
  const { container, unmount } = render(<WidgetDataProvider store={store}>
    <PosMenuPhoto photoFileId="test-photo" photoKey={null} name="라테" size="card"/>
  </WidgetDataProvider>);
  await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'blob:inventory-photo'));
  expect(backend.callsTo('GET', '/files/test-photo/content')[0].headers.get('authorization')).toBe('Bearer token-1');
  unmount();
  expect(revoke).toHaveBeenCalledWith('blob:inventory-photo');
});
