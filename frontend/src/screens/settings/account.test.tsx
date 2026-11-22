import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useRef, useSyncExternalStore } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { ActionButton, UiProvider, timePolicy } from '../../ui';
import { screenPresets } from '../../layout/presets';
import { createWidgetDataStore } from '../../data/widget-data';
import manifest from '../../data/db/generated/manifest.json';
import { createSessionActions } from '../../app/session-actions';
import { AccountProvider } from '../../app/account-context';
import type { AccountController, AccountHost } from '../../app/account-host';
import { SettingsOverlay } from './index';

afterEach(cleanup);
const stores = [{ storeId: 'a', name: '모아 카페', role: 'owner', current: true }, { storeId: 'b', name: '두 번째 매장', role: 'owner', current: false }];

function host(over: Partial<AccountController> = {}) {
  const controller: AccountController = { storeName: '모아 카페', stores, status: 'idle', switchStore: vi.fn(async () => {}), signIn: vi.fn(async () => {}), signOut: vi.fn(async () => {}), ...over };
  const value = { getController: () => controller, subscribe: () => () => {}, load: async () => {}, attach: () => () => {}, dispose() {} } as unknown as AccountHost;
  return { controller, value };
}
function renderSettings(account: AccountHost | null) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', reducedMotion: true, clock: () => 0 });
  run.actions.chooseBusiness('cafe'); run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' }); run.actions.startEmpty();
  const sessionActions = createSessionActions(run, createWidgetDataStore(undefined, { runId: run.getState().runId }));
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState); const trigger = useRef<HTMLButtonElement>(null);
    return <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}><AccountProvider host={account}><main><h1 tabIndex={-1}>우리 가게</h1><ActionButton data-focus-key="settings" ref={trigger} onClick={() => run.actions.openSettings()}>설정</ActionButton><SettingsOverlay run={run} sessionActions={sessionActions} returnFocusRef={trigger} /></main></AccountProvider></UiProvider>;
  }
  render(<Harness />);
  return run;
}
const open = async () => { await userEvent.setup().click(screen.getByRole('button', { name: '설정' })); await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible()); };

describe('settings: account', () => {
  it('offers store switching and sign-out only for a signed-in HTTP account with several stores', async () => {
    const { controller, value } = host();
    renderSettings(value);
    await open();
    expect(screen.getByRole('button', { name: /매장 바꾸기/ })).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /매장 바꾸기/ }));
    await user.click(await screen.findByRole('radio', { name: /두 번째 매장/ }));
    expect(controller.switchStore).toHaveBeenCalledWith('b');
  });

  it('signs out through the account', async () => {
    const { controller, value } = host();
    renderSettings(value);
    await open();
    await userEvent.setup().click(screen.getByRole('button', { name: '로그아웃' }));
    expect(controller.signOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the same overview rows for the HTTP café owner and the example session', async () => {
    const one = host({ stores: [{ ...stores[0], storeId: manifest.store.storeId, name: '안숭잘부 카페' }] });
    renderSettings(one.value);
    await open();
    expect(screen.queryByRole('button', { name: /매장 바꾸기/ })).toBeNull();
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeVisible();
    const buttons = () => screen.getByRole('region', { name: '설정 내용' }).querySelectorAll('button');
    const structure = () => Array.from(buttons(), button => button.getAttribute('aria-label') ?? button.textContent);
    const realRows = structure();
    expect(realRows.at(-1)).toMatch(/^처음부터 다시 보기/);
    cleanup();
    const run = renderSettings(null);
    await open();
    expect(structure()).toEqual(realRows);
    await userEvent.setup().click(screen.getByRole('button', { name: '로그아웃' }));
    expect(run.getState().screen).toBe('business-question');
  });

  it('keeps the café restart outside another store or a staff session', async () => {
    for (const store of [stores[0], { ...stores[0], storeId: manifest.store.storeId, role: 'staff' }]) {
      const { value } = host({ stores: [store] });
      const run = renderSettings(value);
      await open();
      expect(screen.queryByRole('button', { name: /^처음부터 다시 보기/ })).not.toBeInTheDocument();
      cleanup();
      run.dispose();
    }
  });
});
