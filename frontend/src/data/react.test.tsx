import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { PreviewSelection } from '../contracts';
import { WidgetDataProvider, useDataDispatch, useDataUndo, useWidgetDataStore, useWidgetView } from './react';
import { createWidgetDataStore, selectCameras, type WidgetDataStore } from './widget-data';

const normal: PreviewSelection = { family: 'normal', overrides: {} };
const wrap = (store: WidgetDataStore, preview: PreviewSelection = normal) => ({ children }: { children: ReactNode }) => <WidgetDataProvider store={store} preview={preview}>{children}</WidgetDataProvider>;

function Restock() {
  const view = useWidgetView('inventory-booking');
  return <p>{view.status === 'ready' ? `restock ${view.model.restockCount}` : view.status}</p>;
}

describe('WidgetDataProvider hooks', () => {
  it('useWidgetView re-renders after a command and returns the memoized view', () => {
    const store = createWidgetDataStore();
    render(<Restock />, { wrapper: wrap(store) });
    expect(screen.getByText('restock 0')).toBeTruthy();
    act(() => { expect(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-milk', threshold: 30_000 }).ok).toBe(true); });
    expect(screen.getByText('restock 1')).toBeTruthy();
    const { result, rerender } = renderHook(() => useWidgetView('ledger', { kind: 'default' }), { wrapper: wrap(store) });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
  it('applies the sample-state selection to that widget only', () => {
    const store = createWidgetDataStore();
    const preview: PreviewSelection = { family: 'error', overrides: { calendar: 'normal' } };
    const { result } = renderHook(() => ({ ledger: useWidgetView('ledger'), calendar: useWidgetView('calendar'), briefing: useWidgetView('briefing') }), { wrapper: wrap(store, preview) });
    expect(result.current.ledger).toMatchObject({ status: 'error', messageKey: 'data.state.ledger.error' });
    expect(result.current.calendar.status).toBe('ready');
    expect(result.current.briefing.status).toBe('error');
  });
  it('useDataDispatch fills the send-failure sample state into inquiry commands; useDataUndo undoes', () => {
    const store = createWidgetDataStore();
    const thread = store.getSnapshot().tables.inquiryThread.find(row => row.type === 'message' && row.status === 'waiting')!;
    const failing = renderHook(() => useDataDispatch(), { wrapper: wrap(store, { family: 'normal', overrides: { 'ai-response': 'send-failure' } }) });
    expect(failing.result.current({ type: 'inquiry.send', threadId: thread.threadId, idempotencyKey: 'x' })).toMatchObject({ ok: false, code: 'PREVIEW_FAILURE' });
    const { result } = renderHook(() => ({ dispatch: useDataDispatch(), undo: useDataUndo(), store: useWidgetDataStore() }), { wrapper: wrap(store) });
    expect(result.current.store).toBe(store);
    expect(result.current.dispatch({ type: 'inquiry.send', threadId: thread.threadId, idempotencyKey: 'y' })).toMatchObject({ ok: true });
    let token = '';
    act(() => { const r = result.current.dispatch({ type: 'localChanges.acknowledge', changeId: 'sample-local-1' }); token = r.ok ? r.undoToken ?? '' : ''; });
    act(() => { expect(result.current.undo(token)).toMatchObject({ ok: true, noticeKey: 'data.notice.undone' }); });
  });
  it('throws a clear error outside the provider', () => {
    expect(() => renderHook(() => useWidgetView('ledger'))).toThrow(/WidgetDataProvider/);
  });
});

it('카메라 끊김은 provider의 브리핑 주요 업무에만 연결하고 정상 selector를 보존한다', () => {
  const store = createWidgetDataStore();
  const wrapper = wrap(store, { family: 'normal', overrides: { 'customer-analysis': 'camera-disconnected' } });
  const { result } = renderHook(() => useWidgetView('briefing'), { wrapper });
  expect(result.current.status).toBe('ready');
  if (result.current.status !== 'ready') throw new Error('브리핑 없음');
  expect(result.current.model.importantAlerts.groups.find((g) => g.id === 'tasks')?.items.some((i) => i.id === 'camera:sample-window')).toBe(true);
  expect(selectCameras(store.getSnapshot(), {}).map(camera => camera.connection)).toEqual(['connected', 'connected']);
});
