import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { ActionButton, UiProvider, timePolicy } from '../../ui';
import { OnboardingScreen } from '../onboarding';
import { createWidgetDataStore } from '../../data/widget-data';
import { createSessionActions } from '../../app/session-actions';
import { SettingsOverlay, type SettingsOverlayProps } from './index';

const failure = vi.hoisted(() => ({ cards: false, settings: false }));
vi.mock('../onboarding/BusinessOptions', async importOriginal => {
  const original = await importOriginal<typeof import('../onboarding/BusinessOptions')>();
  return {
    ...original,
    BusinessOptions(props: Parameters<typeof original.BusinessOptions>[0]) {
      if (failure.cards) throw new Error('Business content render failure');
      return <original.BusinessOptions {...props} />;
    },
  };
});
// The settings body renders the kit ThemeTabs (T-055: the translated copy is gone); make that body part fail.
vi.mock('../../ui', async importOriginal => {
  const original = await importOriginal<typeof import('../../ui')>();
  return {
    ...original,
    ThemeTabs(props: Parameters<typeof original.ThemeTabs>[0]) {
      if (failure.settings) throw new Error('Settings content render failure');
      return <original.ThemeTabs {...props} />;
    },
  };
});
afterEach(() => { failure.cards = false; failure.settings = false; vi.unstubAllEnvs(); vi.restoreAllMocks(); cleanup(); });

describe.each(['A', 'B'] as const)('%s shared body recovery', presetId => {
  function setup(question = false, verification?: SettingsOverlayProps['verification']) {
    const run = createRunStore({ screenPreset: screenPresets[presetId], catalog: getRegistry(presetId), time: timePolicy, clock: () => 0, theme: 'dark', reducedMotion: true });
    if (!question) {
      run.actions.chooseBusiness('cafe');
      run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});
      run.actions.startEmpty();
      run.actions.applyLayoutIntent({ type: 'add-drop', featureId: 'margin', column: 3, row: 2 });
    }
    const sessionActions=createSessionActions(run,createWidgetDataStore(undefined,{runId:run.getState().runId}));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Harness() {
      const state = useSyncExternalStore(run.subscribe, run.getState);
      return <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}>
        {question ? <OnboardingScreen run={run} /> : <main><h1>우리 가게</h1><ActionButton data-focus-key="settings" onClick={run.actions.openSettings}>설정</ActionButton></main>}
        <SettingsOverlay run={run} sessionActions={sessionActions} verification={verification} />
      </UiProvider>;
    }
    render(<Harness />);
    return run;
  }

  it('keeps the question heading and skip action usable while failed cards retry', () => {
    failure.cards = true;
    const run = setup(true); const before = run.getState();
    expect(screen.getByRole('heading', { name: '어떤 가게를 하세요?' })).toBeVisible();
    expect(screen.getByRole('button', { name: '나중에 고를게요' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('다시 열어 주세요');
    failure.cards = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    expect(screen.getByRole('button', { name: '미용·뷰티' })).toBeVisible();
    expect(run.getState()).toEqual(before);
  });

  it('keeps the settings title and close action while retry restores the body without resetting the run', async () => {
    failure.settings = true;
    const run = setup(); const before = run.getState();
    act(() => run.actions.openSettings());
    await waitFor(() => expect(screen.getByRole('dialog', { name: '설정' })).toBeVisible());
    expect(screen.getByRole('button', { name: '닫기' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('다시 열어 주세요');
    failure.settings = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '큰 글자' })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '설정' })).toHaveFocus());
    expect(run.getState().panels).toEqual(before.panels);
    expect(run.getState().undo).toEqual(before.undo);
    expect(run.getState().guidance).toEqual(before.guidance);
    expect(run.getState().screenPreset).toBe(before.screenPreset);
  });

  it('can close a failed business subview without making a selection', async () => {
    const run = setup(); const before = run.getState();
    act(() => run.actions.openSettings());
    failure.cards = true;
    fireEvent.click(screen.getByRole('button', { name: '업종 바꾸기' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '업종' })).toBeVisible());
    expect(screen.getByRole('alert')).toHaveTextContent('다시 열어 주세요');
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '설정' })).toHaveFocus());
    expect(run.getState().businessType).toBe('cafe');
    expect(run.getState().panels).toEqual(before.panels);
    expect(run.getState().undo).toEqual(before.undo);
  });

  it('ignores the verification retry callback in production while recovering a real body error', async () => {
    vi.stubEnv('DEV', false);
    failure.settings = true;
    const onRetry = vi.fn();
    const run = setup(false, { failContent: true, onRetry });
    act(() => run.actions.openSettings());
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    failure.settings = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '큰 글자' })).toBeVisible());
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '설정' })).toHaveFocus());
  });
});
