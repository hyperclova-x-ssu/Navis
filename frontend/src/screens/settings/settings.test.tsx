import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useRef, useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunStore, selectCommonNotice } from '../../state';
import { getRegistry, getBusinessPreset } from '../../catalog';
import type { BusinessType } from '../../contracts';
import { ActionButton, UiProvider, timePolicy } from '../../ui';
import { screenPresets } from '../../layout/presets';
import { createWidgetDataStore } from '../../data/widget-data';
import { createSessionActions } from '../../app/session-actions';
import { SettingsOverlay } from './index';

const exitObservers = new Set<MutationObserver>();
afterEach(() => { for (const observer of exitObservers) observer.disconnect(); exitObservers.clear(); cleanup(); });

// Capture the exit when it is inserted. Its 80ms lifetime can end before focus settles.
function observeExit() {
  let captured: { inert: boolean; pointerEvents: string } | null = null;
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      const surface = node.matches('[data-testid="ui-overlay-exit"]') ? node : node.querySelector<HTMLElement>('[data-testid="ui-overlay-exit"]');
      if (!surface) continue;
      captured = { inert: surface.hasAttribute('inert'), pointerEvents: surface.style.pointerEvents };
      observer.disconnect(); exitObservers.delete(observer); return;
    }
  });
  observer.observe(document.body, { childList: true, subtree: true }); exitObservers.add(observer);
  return () => captured;
}
function renderSettings(presetId: 'A' | 'B', business: BusinessType | null = 'cafe', explicitRef = true) {
  const run = createRunStore({ screenPreset: screenPresets[presetId], catalog: getRegistry(presetId), time: timePolicy, theme: 'light', reducedMotion: true, clock: () => 0 });
  run.actions.chooseBusiness(business);
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  run.actions.startEmpty();
  const sessionActions=createSessionActions(run,createWidgetDataStore(undefined,{runId:run.getState().runId}));
  run.actions.applyLayoutIntent({ type: 'add-drop', featureId: 'margin', column: 2, row: 1 });
  run.actions.applyLayoutIntent({ type: 'resize', featureId: 'margin', width: 2, height: 2 });
  run.actions.applyLayoutIntent({ type: 'add-drop', featureId: 'calendar', column: 5, row: 3 });
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState); const trigger = useRef<HTMLButtonElement>(null);
    return <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}><main><h1 tabIndex={-1}>우리 가게</h1><ActionButton data-focus-key="settings" ref={trigger} onClick={run.actions.openSettings}>설정</ActionButton></main><SettingsOverlay run={run} sessionActions={sessionActions} returnFocusRef={explicitRef ? trigger : undefined} /></UiProvider>;
  }
  render(<Harness />); return run;
}
async function open() { await userEvent.setup().click(screen.getByRole('button', { name: '설정' })); await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible()); }
async function changeBusiness() { await userEvent.setup().click(screen.getByRole('button', { name: '업종 바꾸기' })); }
function outside() {
  const target = screen.getByTestId('ui-dialog-backdrop');
  fireEvent.pointerDown(target, { pointerId: 1, button: 0 }); fireEvent.mouseDown(target, { button: 0 });
  fireEvent.pointerUp(target, { pointerId: 1, button: 0 }); fireEvent.mouseUp(target, { button: 0 }); fireEvent.click(target);
}

describe.each(['A', 'B'] as const)('%s settings', presetId => {
  const setup = (business: BusinessType | null = 'cafe') => renderSettings(presetId, business);
  it.each([100, 125] as const)('keeps business dialog height at text scale %s through selection and visual exit', async textScale => {
    const run = setup(); act(() => run.actions.setTextScale(textScale)); const before = run.getState(); await open();
    expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--settings');
    await changeBusiness();
    expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--settings');
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.getByTestId('ui-overlay-exit')).toHaveStyle({ height: '640px' });
    expect(run.getState().screenPreset).toBe(before.screenPreset);
    expect(run.getState().undo).toEqual(before.undo); expect(run.getState().panels).toEqual(before.panels);
    expect(run.getState().guidance).toEqual(before.guidance);
    expect(run.getState().briefing).toBe(before.briefing);
  });
  it('shows current business, mutually exclusive mode tabs and the labelled large-text switch', async () => {
    setup(); await open();
    expect(screen.getByRole('dialog', { name: '설정' })).toBeVisible(); expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus();
    expect(screen.getByText('카페')).toBeVisible();
    expect(screen.getByRole('tab', { name: '라이트' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '다크' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('switch', { name: '큰 글자' })).not.toBeChecked();
  });
  it('represents a skipped business without forcing selection', async () => {
    const run = setup(null); await open();
    expect(screen.getByText('아직 고르지 않았어요')).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: '닫기' })); expect(run.getState().businessType).toBeNull();
  });
  it('uses one dialog for the business subview and marks the current choice', async () => {
    setup(); await open(); await changeBusiness();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: '업종' })).toBeVisible();
    expect(screen.getByRole('button', { name: '카페' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button').filter(button => button.hasAttribute('aria-pressed'))).toHaveLength(8);
  });
  it.each(['restaurant', 'pub', 'beauty', 'retail', 'academy', 'fitness', 'other'] as const)('changes business to %s while preserving layout and progress', async type => {
    const labels = { restaurant: '음식점', pub: '주점', beauty: '미용·뷰티', retail: '소매', academy: '학원', fitness: '운동', other: '기타' };
    const run = setup(); const before = run.getState(); await open(); await changeBusiness();
    await userEvent.setup().click(screen.getByRole('button', { name: labels[type] }));
    const after = run.getState(); expect(after.businessType).toBe(type); expect(after.overlay.type).toBe('settings');
    expect(after.panels).toEqual(before.panels); expect(after.layoutRevision).toBe(before.layoutRevision);
    expect(after.undo).toEqual(before.undo); expect(after.guidance).toEqual(before.guidance); expect(after.briefing).toBe(before.briefing);
    expect(getBusinessPreset(after.businessType).businessType).toBe(type);
    expect(selectCommonNotice(run.getState())?.messageKey).toBe('settings.businessChanged');
  });
  it.each(['button', 'Esc', 'outside'] as const)('closes without changing business by %s and restores focus', async reason => {
    const run = setup(); const before = run.getState(); await open(); await changeBusiness();
    const readExit = observeExit();
    if (reason === 'button') fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    else if (reason === 'Esc') await userEvent.setup().keyboard('{Escape}');
    else outside();
    expect(run.getState().overlay.type).toBe('none'); expect(screen.queryByRole('dialog')).toBeNull();
    expect(run.getState().businessType).toBe('cafe'); expect(run.getState().undo).toEqual(before.undo); expect(run.getState().panels).toEqual(before.panels);
    await waitFor(() => expect(screen.getByRole('button', { name: '설정' })).toHaveFocus());
    await waitFor(() => expect(run.getState().exitPendingToken).toBeNull());
    expect(readExit()).toEqual({ inert: true, pointerEvents: 'none' });
  });
  it('applies dark mode and 125% text immediately while retaining the dialog and all run progress', async () => {
    const run = setup(); const before = run.getState(); await open();
    const user = userEvent.setup(); await user.click(screen.getByRole('tab', { name: '다크' })); await user.click(screen.getByRole('switch', { name: '큰 글자' }));
    expect(run.getState().theme).toBe('dark'); expect(run.getState().textScale).toBe(125);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark'); expect(document.documentElement.style.fontSize).toBe('20px');
    expect(screen.getByRole('dialog', { name: '설정' })).toBeVisible();
    expect(run.getState().undo).toEqual(before.undo); expect(run.getState().panels).toEqual(before.panels); expect(run.getState().guidance).toEqual(before.guidance);
    await user.click(screen.getByRole('switch', { name: '큰 글자' })); expect(run.getState().textScale).toBe(100);
    expect(within(screen.getByRole('dialog')).getByRole('tab', { name: '다크' })).toHaveAttribute('aria-selected', 'true');
  });
  it.each(['button', 'Esc', 'outside'] as const)('returns to the stable settings trigger without an explicit ref or pointer focus on %s', async reason => {
    const run = renderSettings(presetId, 'cafe', false);
    // Safari touch may open a button without focusing it.
    screen.getByRole('heading', { name: '우리 가게' }).focus();
    act(() => run.actions.openSettings());
    await waitFor(() => expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus());
    await changeBusiness();
    if (reason === 'button') fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    else if (reason === 'Esc') await userEvent.setup().keyboard('{Escape}');
    else outside();
    await waitFor(() => expect(screen.getByRole('button', { name: '설정' })).toHaveFocus());
  });
  it('focuses the dashboard heading when the settings trigger disappears', async () => {
    const run = renderSettings(presetId, 'cafe', false);
    act(() => run.actions.openSettings());
    await waitFor(() => expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus());
    screen.getByRole('button', { name: '설정', hidden: true }).remove();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '우리 가게' })).toHaveFocus());
  });
  it('focuses the dashboard heading when the trigger has no stable key and no ref', async () => {
    const run = renderSettings(presetId, 'cafe', false);
    screen.getByRole('button', { name: '설정' }).removeAttribute('data-focus-key');
    act(() => run.actions.openSettings());
    await waitFor(() => expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '우리 가게' })).toHaveFocus());
  });
  it('prefers an explicit trigger ref over a different element with the stable key', async () => {
    setup();
    const trigger = screen.getByRole('button', { name: '설정' });
    const decoy = document.createElement('button'); decoy.dataset.focusKey = 'settings';
    trigger.before(decoy);
    await open();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
