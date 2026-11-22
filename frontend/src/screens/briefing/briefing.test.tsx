import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useRef, useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunStore } from '../../state';
import { ActionButton, UiProvider, fitViewport, timePolicy } from '../../ui';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import type { LayoutAdapter, ViewportSnapshot } from '../../contracts';
import { BriefingOverlay } from './index';
import { DataHost } from './test-support';

afterEach(cleanup);
function renderBriefing(presetId: 'A' | 'B', reduced = true, explicitFocus = true, layoutAdapter?: LayoutAdapter) {
  const preset = screenPresets[presetId];
  let now = 0;
  const run = createRunStore({ screenPreset: preset, catalog: getRegistry(presetId), time: timePolicy, clock: () => now, theme: 'light', reducedMotion: reduced, layoutAdapter });
  const advance = (ms: number) => act(() => { now += ms; run.actions.tick(); });
  function Harness({ viewport }: { readonly viewport: ViewportSnapshot }) {
    const state = useSyncExternalStore(run.subscribe, run.getState); const source = useRef<HTMLButtonElement>(null);
    return <DataHost><UiProvider screenPreset={state.screenPreset} transform={fitViewport(preset, viewport)!} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}><main><h1>우리 가게</h1><ActionButton ref={source}>가게 화면</ActionButton></main><BriefingOverlay run={run} returnFocusRef={explicitFocus ? source : undefined} /></UiProvider></DataHost>;
  }
  const view = render(<Harness viewport={{ width: preset.baselineWidth, height: preset.baselineHeight }} />);
  const resize = (viewport: ViewportSnapshot) => view.rerender(<Harness viewport={viewport} />);
  function finishCoaching() {
    act(() => { beginDashboard(run,'cafe'); run.actions.visualSettled(); }); advance(400);
    act(() => { run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); }); advance(200);
    // Clear the queued widget guidance; resize guidance waits until edit mode.
    act(() => run.actions.skipWidgetCoaches()); advance(200);
    act(() => { run.actions.clearNotice(); run.actions.finishEditing(); });
  }
  return { run, advance, finishCoaching, resize };
}
function outside() {
  const target = screen.getByTestId('ui-dialog-backdrop');
  fireEvent.pointerDown(target, { pointerId: 1, button: 0 }); fireEvent.mouseDown(target, { button: 0 });
  fireEvent.pointerUp(target, { pointerId: 1, button: 0 }); fireEvent.mouseUp(target, { button: 0 }); fireEvent.click(target);
}

describe.each(['A', 'B'] as const)('%s arrival briefing', presetId => {
  const setup = (reduced = true, explicitFocus = true) => renderBriefing(presetId, reduced, explicitFocus);
  it('does not show during a pending layout commit and restarts 1200ms safety after cancellation', async () => {
    // A held Worker response makes the real store take the layout-pending path.
    const layoutAdapter: LayoutAdapter = { ready: async () => undefined, submit: () => undefined, cancel: () => undefined, dispose: () => undefined };
    const { run, advance, finishCoaching } = renderBriefing(presetId, true, true, layoutAdapter);
    finishCoaching(); advance(1000);
    act(() => {
      const token = run.actions.beginPreview({ source: 'resize', pointerId: 7, intent: { type: 'resize', featureId: 'ledger', width: 2, height: 1 } })!;
      expect(run.actions.commitPreview(token).status).toBe('pending');
    });
    expect(run.getState().idle.blockedReasons).toContain('layout-pending');
    expect(run.getState().gesturePreview?.pendingCommit).toBe(true);
    advance(10000); expect(screen.queryByRole('dialog')).toBeNull();
    expect(run.getState().briefingSafeSince).toBeNull();
    act(() => { run.actions.cancelPreviewForViewportChange(); run.actions.consumeInput({ kind: 'pointer', id: 7 }, 'click'); run.actions.finishEditing(); });
    expect(run.getState().notice).toBeNull();
    expect(run.getState().briefingSafeSince).not.toBeNull();
    advance(1199); expect(screen.queryByRole('dialog')).toBeNull(); advance(1);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
  });

  it('keeps continuous safe time through repeated viewport changes without showing twice', async () => {
    const { run, advance, finishCoaching, resize } = setup(); finishCoaching(); advance(600);
    const before = run.getState();
    resize({ width: 1000, height: 800 }); resize({ width: 3200, height: 2000 });
    expect(run.getState()).toBe(before); advance(599); expect(screen.queryByRole('dialog')).toBeNull(); advance(1);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus();
    const shown = run.getState(); resize({ width: 960, height: 540 });
    expect(run.getState()).toBe(shown); expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(run.getState().exitPendingToken).toBeNull());
    resize({ width: 2560, height: 1440 }); advance(100000);
    expect(run.getState().briefing).toBe('dismissed'); expect(screen.queryByRole('dialog')).toBeNull();
    expect(run.getState().screenPreset).toBe(before.screenPreset);
    expect(run.getState().panels).toEqual(before.panels); expect(run.getState().layoutRevision).toBe(before.layoutRevision);
    expect(run.getState().guidance).toEqual(before.guidance);
  });

  it('waits for completed coaches and 1200 uninterrupted safe milliseconds before showing the the cafe summaries', async () => {
    const { run, advance, finishCoaching } = setup();
    advance(100000); expect(screen.queryByRole('dialog')).toBeNull();
    finishCoaching(); screen.getByRole('button', { name: '가게 화면' }).focus();
    advance(1199); expect(screen.queryByRole('dialog')).toBeNull(); advance(1);
    await waitFor(() => expect(screen.getByRole('dialog', { name: '오늘 가게 소식이에요' })).toBeVisible());
    expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus();
    for (const text of ['11월 17일 화요일', '오늘 일정 3건', '예약 브리핑', '오늘 근무 5명 · 17:00 교대', '오늘 4건 · 10명', '중요 알림 2개']) expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByRole('dialog')).not.toHaveTextContent('가짜 데이터로 만든 화면이에요');
    expect(within(screen.getByRole('dialog')).getAllByRole('listitem')).toHaveLength(2);
    // Three summary actions, two alert actions, fullscreen, and close.
    expect(within(screen.getByRole('dialog')).getAllByRole('button')).toHaveLength(7);
    const toggle = within(screen.getByRole('dialog')).getByRole('button', { name: '자세히 보기 전체 화면으로 보기' });
    expect(toggle).toHaveTextContent('');
    expect(toggle).not.toHaveAttribute('title');
    fireEvent.click(toggle);
    expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--fullscreen');
    expect(screen.getByRole('button', { name: '자세히 보기 원래 크기로 보기' })).toHaveAttribute('aria-pressed', 'true');
    expect(run.getState().panels).toHaveLength(3);
  });

  it.each(['button', 'Escape', 'outside'] as const)('closes by %s without changing layout, restores focus and starts a new idle period only after visual exit', async reason => {
    const { run, advance, finishCoaching } = setup(); finishCoaching();
    screen.getByRole('button', { name: '가게 화면' }).focus(); advance(1200);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible()); const before = run.getState();
    if (reason === 'button') fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    else if (reason === 'Escape') await userEvent.setup().keyboard('{Escape}');
    else outside();
    expect(run.getState().briefing).toBe('dismissed'); expect(run.getState().overlay.type).toBe('none');
    expect(run.getState().panels).toEqual(before.panels); expect(run.getState().layoutRevision).toBe(before.layoutRevision);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByTestId('ui-overlay-exit')).toHaveAttribute('inert');
    expect(screen.getByTestId('ui-overlay-exit')).toHaveStyle({ pointerEvents: 'none' });
    expect(run.getState().idle.blockedReasons).toContain('overlay-exit');
    await waitFor(() => expect(screen.getByRole('button', { name: '가게 화면' })).toHaveFocus());
    await waitFor(() => expect(run.getState().exitPendingToken).toBeNull());
    advance(29999); expect(run.getState().idle.mode).toBe('active'); advance(1); expect(run.getState().idle.mode).toBe('idle');
  });

  it('stays open without an automatic timeout and keeps content when theme/text changes', async () => {
    const { run, advance, finishCoaching } = setup(); finishCoaching(); advance(1200);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible()); const before = run.getState().panels;
    act(() => { run.actions.setTheme('dark'); run.actions.setTextScale(125); }); advance(100000);
    expect(screen.getByRole('dialog')).toBeVisible(); expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.fontSize).toBe('20px'); expect(run.getState().panels).toEqual(before);
    expect(screen.queryByText('화면을 준비하고 있어요')).toBeNull();
  });

  it('shows once per run and leaves the ordinary briefing panel available after dismissal', async () => {
    const { run, advance, finishCoaching } = setup(); finishCoaching(); advance(1200);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible()); fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(run.getState().exitPendingToken).toBeNull()); advance(100000);
    act(() => { const input = { kind: 'pointer', id: 2 } as const; run.actions.inputStarted(input); run.actions.inputEnded(input); run.actions.consumeInput(input, 'click'); });
    act(() => { expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'briefing' }).status).toBe('accepted'); expect(run.actions.openDetail('briefing', 'briefing-panel')).toBe(true); });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(run.getState().overlay.type).toBe('detail');
    act(() => { const token = run.actions.closeOverlay()!; run.actions.finishOverlayExit(token); }); advance(100000);
    expect(run.getState().briefing).toBe('dismissed'); expect(screen.queryByRole('dialog')).toBeNull();
    act(() => run.actions.resetRun({ screenPreset: screenPresets[presetId], catalog: getRegistry(presetId), theme: 'light' })); expect(run.getState().briefing).toBe('pending');
  });

  it('fades out without scale in ordinary motion and yields to a new overlay during exit', async () => {
    const { run, advance, finishCoaching } = setup(false); finishCoaching(); advance(1200);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.getByTestId('ui-overlay-exit')).toHaveStyle({ transform: 'none' });
    act(() => run.actions.openSettings());
    expect(screen.queryByTestId('ui-overlay-exit')).toBeNull();
    expect(run.getState().overlay.type).toBe('settings');
    expect(run.getState().exitPendingToken).toBeNull();
    expect(run.getState().briefing).toBe('dismissed');
  });

  it('returns to the previously focused control when no explicit focus ref is supplied', async () => {
    const { advance, finishCoaching } = setup(true, false); finishCoaching();
    const source = screen.getByRole('button', { name: '가게 화면' }); source.focus(); advance(1200);
    await waitFor(() => expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(source).toHaveFocus());
  });

  it.each(['settings', 'drawer', 'detail', 'edit', 'pointer', 'drag', 'resize', 'toast', 'visual-exit', 'hidden'] as const)('restarts the safe period after %s blocks the card', async blocker => {
    const { run, advance, finishCoaching } = setup(); finishCoaching(); advance(1000);
    let restore: () => void = () => undefined;
    act(() => {
      const a = run.actions;
      if (blocker === 'settings' || blocker === 'drawer' || blocker === 'detail' || blocker === 'visual-exit') {
        if (blocker === 'drawer') a.openDrawer('money'); else if (blocker === 'detail') a.openDetail('margin', 'margin'); else a.openSettings();
        if (blocker === 'visual-exit') { const token = a.closeOverlay()!; restore = () => a.finishOverlayExit(token); }
        else restore = () => { const token = a.closeOverlay()!; a.finishOverlayExit(token); };
      } else if (blocker === 'pointer') {
        const input = { kind: 'pointer', id: 3 } as const; a.inputStarted(input); restore = () => a.inputEnded(input);
      } else if (blocker === 'hidden') { a.setPageHidden(true); restore = () => a.setPageHidden(false); }
      else if (blocker === 'toast') {
        // An undo toast with no new widget: adding one would also queue its explanation (F-21), a separate blocker.
        a.applyLayoutIntent({ type: 'remove', featureId: 'calendar' }); a.visualSettled(); a.pauseUndo('toast-focus');
        restore = () => { a.resumeUndo('toast-focus'); advance(6000); };
      } else {
        if (blocker === 'edit') a.enterEditing();
        else a.beginPreview({ source: blocker === 'resize' ? 'resize' : 'panel', pointerId: 4, intent: blocker === 'resize' ? { type: 'resize', featureId: 'margin', width: 2, height: 1 } : { type: 'move', featureId: 'margin', column: 3, row: 1 } });
        restore = () => { a.cancelPreview(); a.finishEditing(); };
      }
    });
    advance(10000); expect(run.getState().briefing).toBe('pending'); expect(screen.queryByRole('dialog')).toBeNull();
    act(restore); advance(1199); expect(screen.queryByRole('dialog')).toBeNull(); advance(1);
    await waitFor(() => expect(screen.getByRole('dialog', { name: '오늘 가게 소식이에요' })).toBeVisible());
  });
});
