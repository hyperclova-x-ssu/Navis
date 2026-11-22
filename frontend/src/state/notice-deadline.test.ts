import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { testTime } from '../layout/test-policy';
import type { LayoutAdapter } from '../contracts';
import { createRunStore, selectCommonNotice } from './index';
import { completeEmptyOnboarding } from './test-fixtures';

const adapter = (): LayoutAdapter => ({ ready: async () => {}, submit() {}, cancel() {}, dispose() {} });
let now = 0;
beforeEach(() => { now = 0; vi.spyOn(Date, 'now').mockReturnValue(1_000_000); });
afterEach(() => vi.restoreAllMocks());

function run() {
  const store = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, clock: () => now, theme: 'light', layoutAdapter: adapter() });
  completeEmptyOnboarding(store, 'cafe'); store.actions.visualSettled();
  return store;
}
const base = { kind: 'success' as const, messageKey: 'data.management.notice.saved', undo: { target: 'data' as const, token: 'real-undo:rc-1' } };

describe('notice undo deadline from a server receipt', () => {
  it('keeps the standard toast time when there is no server deadline', () => {
    const store = run();
    store.actions.showNotice(base);
    expect(selectCommonNotice(store.getState())!.expiresAt - now).toBe(testTime.undoMs);
  });

  it('never outlives the receipt deadline', () => {
    const store = run();
    store.actions.showNotice({ ...base, undoUntil: 1_000_000 + 1_500 });
    expect(selectCommonNotice(store.getState())!.expiresAt - now).toBe(1_500);
  });

  it('keeps counting down a server receipt while focused or hidden', () => {
    const store = run();
    store.actions.showNotice({ ...base, undoUntil: 1_000_000 + 1_500 });
    store.actions.pauseUndo('toast-focus');
    expect(selectCommonNotice(store.getState())!.expiresAt).toBe(1_500);
    now = 500;
    store.actions.setPageHidden(true);
    expect(selectCommonNotice(store.getState())!.expiresAt).toBe(1_500);
    now = 1_600;
    store.actions.setPageHidden(false);
    expect(selectCommonNotice(store.getState())).toBeNull();
  });

  it('preserves the remaining undo time on a local notice when focus moves away', () => {
    const store = run();
    store.actions.showNotice({ ...base, undo: { target: 'data', token: 'data-undo:fixture' } });
    now = 250;
    store.actions.pauseUndo('toast-focus');
    expect(selectCommonNotice(store.getState())!.expiresAt).toBe(Infinity);
    now = 750;
    store.actions.resumeUndo('toast-focus');
    expect(selectCommonNotice(store.getState())!.expiresAt).toBe(testTime.undoMs + 500);
  });

  it('does not extend past the standard toast time for a far deadline', () => {
    const store = run();
    store.actions.showNotice({ ...base, undoUntil: 1_000_000 + 10 * testTime.undoMs });
    expect(selectCommonNotice(store.getState())!.expiresAt - now).toBe(testTime.undoMs);
  });

  it('an already expired receipt offers no undo toast at all', () => {
    const store = run();
    store.actions.showNotice({ ...base, undoUntil: 1_000_000 - 5 });
    expect(selectCommonNotice(store.getState())).toBeNull();
  });
});
