import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useRef, useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { ActionButton, UiProvider, timePolicy } from '../../ui';
import { SettingsOverlay } from './index';

const runs = new Set<ReturnType<typeof createRunStore>>();
afterEach(() => {
  cleanup();
  for (const run of runs) run.dispose();
  runs.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setup(presetId: 'A' | 'B', focus: 'ref' | 'key' = 'key') {
  const run = createRunStore({ screenPreset: screenPresets[presetId], catalog: getRegistry(presetId), time: timePolicy, clock: () => 0, theme: 'dark', reducedMotion: true });
  runs.add(run);
  run.actions.chooseBusiness('cafe');
  run.actions.applyLayoutIntent({ type: 'add-drop', featureId: 'margin', column: 3, row: 2 });
  run.actions.setTextScale(125);
  let failContent = false;
  const onRetry = vi.fn(() => { failContent = false; view.rerender(<Harness />); });
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    const trigger = useRef<HTMLButtonElement>(null);
    return <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}>
      <main><h1>우리 가게</h1>
        <ActionButton data-focus-key="settings" onClick={run.actions.openSettings}>설정</ActionButton>
        {focus === 'ref' ? <ActionButton ref={trigger} onClick={run.actions.openSettings}>명시 설정</ActionButton> : null}
      </main>
      <SettingsOverlay run={run} returnFocusRef={focus === 'ref' ? trigger : undefined} verification={{ failContent, onRetry }} />
    </UiProvider>;
  }
  const view = render(<Harness />);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const trigger = screen.getByRole('button', { name: focus === 'ref' ? '명시 설정' : '설정' });
  return { run, trigger, onRetry, fail: () => act(() => { failContent = true; view.rerender(<Harness />); }) };
}

// Initial focus can arrive before the real reduced-motion entrance has settled.
const waitForSettingsEntry = () => waitFor(() => expect(screen.getByRole('dialog', { name: '설정' })).toHaveStyle({ opacity: '1' }));

describe.each(['A', 'B'] as const)('%s settings verification', presetId => {
  it.each(['ref', 'key'] as const)('retries the failed body while preserving the title, close control and %s focus target', async focus => {
    const { run, trigger, onRetry, fail } = setup(presetId, focus);
    fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: '닫기' });
    const title = screen.getByRole('heading', { name: '설정' });
    await waitFor(() => expect(close).toHaveFocus());
    await waitForSettingsEntry();
    const before = run.getState();
    fail();
    expect(screen.getByRole('alert')).toHaveTextContent('다시 열어 주세요');
    expect(title).toBeVisible();
    expect(close).toBeEnabled();
    expect(close).toHaveFocus();
    expect(screen.queryByRole('switch', { name: '큰 글자' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '큰 글자' })).toBeChecked());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: '설정' })).toBe(title);
    expect(screen.getByRole('button', { name: '닫기' })).toBe(close);
    expect(screen.getByRole('tab', { name: '다크' })).toHaveAttribute('aria-selected', 'true');
    expect(run.getState()).toBe(before);
    fireEvent.click(close);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each([['ref', 'button'], ['key', 'Escape']] as const)('closes the failed body with %s focus return using %s', async (focus, method) => {
    const { run, trigger, onRetry, fail } = setup(presetId, focus);
    fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: '닫기' });
    await waitFor(() => expect(close).toHaveFocus());
    await waitForSettingsEntry();
    const before = run.getState();
    fail();
    expect(screen.getByRole('dialog', { name: '설정' })).toBeVisible();
    expect(screen.getByRole('alert')).toBeVisible();
    if (method === 'button') fireEvent.click(close);
    else await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(run.getState().overlay.type).toBe('none');
    expect(run.getState().panels).toBe(before.panels);
    expect(run.getState().undo).toBe(before.undo);
    expect(run.getState().guidance).toBe(before.guidance);
    expect(run.getState().screenPreset).toBe(before.screenPreset);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('ignores failure injection in production mode', async () => {
    vi.stubEnv('DEV', false);
    const { trigger, onRetry, fail } = setup(presetId);
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus());
    await waitForSettingsEntry();
    fail();
    await waitFor(() => expect(screen.getByRole('switch', { name: '큰 글자' })).toBeChecked());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: '설정' })).toBeVisible();
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
