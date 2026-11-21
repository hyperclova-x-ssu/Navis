import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import type { FeatureId } from '../../contracts';
import { ActionButton, DetailFooterContent, UiProvider, timePolicy } from '../../ui';
import { DetailOverlay } from './index';
import { DetailHost, stubDetailModule, stubDetailModules } from './test-modules';

afterEach(cleanup);
const modules = [...stubDetailModules(['margin', 'inventory-booking', 'suppliers']), stubDetailModule('calendar', () => <DetailFooterContent><button type="button">바닥줄 버튼</button></DetailFooterContent>)];
function setup(reducedMotion = false) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => performance.now(), theme: 'light', reducedMotion });
  beginDashboard(run);
  for (const featureId of ['margin', 'calendar', 'inventory-booking', 'suppliers'] as const) run.actions.applyLayoutIntent({ type: 'add-tap', featureId });
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    return <DetailHost modules={modules}><UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}>
      <main aria-label="대시보드"><h1>우리 가게</h1>{(['margin', 'calendar', 'inventory-booking', 'suppliers'] as const).map(id => <ActionButton id={`panel-${id}`} key={id} onClick={() => run.actions.openDetail(id, `panel-${id}`)}>{id} 보기</ActionButton>)}</main>
      <DetailOverlay run={run} />
    </UiProvider></DetailHost>;
  }
  render(<Harness />);
  return run;
}
const open = async (id: FeatureId) => {
  await userEvent.setup().click(screen.getByRole('button', { name: `${id} 보기` }));
  await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
};
function closeByOutside() {
  const backdrop = screen.getByTestId('ui-dialog-backdrop');
  fireEvent.pointerDown(backdrop, { pointerId: 11, button: 0, pointerType: 'mouse' });
  fireEvent.mouseDown(backdrop, { button: 0 });
  fireEvent.pointerUp(backdrop, { pointerId: 11, button: 0 });
  fireEvent.mouseUp(backdrop, { button: 0 });
  fireEvent.click(backdrop, { button: 0 });
}

describe('detail overlay coordination', () => {
  it.each(['button', 'Esc', 'outside'] as const)('closes by %s, restores focus immediately and keeps a noninteractive visual exit', async reason => {
    const run = setup(); const before = run.getState().panels;
    await open('margin');
    const dialog = screen.getByRole('dialog', { name: '마진' });
    expect(dialog).toBeVisible(); expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus();
    if (reason === 'button') fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    else if (reason === 'Esc') fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
    else closeByOutside();
    expect(run.getState().overlay.type).toBe('none');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'margin 보기' })).toHaveFocus());
    const exit = screen.getByTestId('ui-overlay-exit');
    expect(exit).toHaveAttribute('inert'); expect(exit).toHaveAttribute('aria-hidden', 'true'); expect(exit).toHaveStyle({ pointerEvents: 'none' });
    expect(exit).not.toHaveTextContent('가짜 데이터로 만든 화면이에요');
    expect(screen.getByTestId('detail-exit-backdrop')).toHaveStyle({ pointerEvents: 'none' });
    expect(screen.getByTestId('detail-exit-backdrop')).toHaveAttribute('aria-hidden', 'true');
    expect(run.getState().idle.blockedReasons).toContain('overlay-exit');
    expect(run.getState().panels).toEqual(before);
  });

  it('consumes the full outside-close contact before allowing a new panel input', async () => {
    const run = setup(); await open('margin');
    const before = run.getState().layoutRevision;
    closeByOutside();
    expect(run.getState().overlay.type).toBe('none');
    expect(run.getState().layoutRevision).toBe(before);
    await open('calendar');
    expect(screen.getByRole('dialog', { name: '캘린더' })).toBeVisible();
  });

  it('reopens the same panel during exit and ignores the old completion token', async () => {
    const run = setup(); await open('margin');
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    const oldToken = run.getState().exitPendingToken!;
    await open('margin');
    expect(screen.getByRole('dialog', { name: '마진' })).toBeVisible();
    expect(screen.queryByTestId('ui-overlay-exit')).not.toBeInTheDocument();
    act(() => run.actions.finishOverlayExit(oldToken));
    expect(run.getState().overlay.type).toBe('detail');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('starts a different panel while removing the previous visual layer', async () => {
    setup(); await open('margin'); fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await open('calendar');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: '캘린더' })).toBeVisible();
    expect(screen.queryByTestId('ui-overlay-exit')).not.toBeInTheDocument();
  });

  it('reverses the current reduced-motion opacity instead of restarting from invisible', async () => {
    setup(true); await open('margin');
    await waitFor(() => expect(Number(getComputedStyle(screen.getByRole('dialog')).opacity)).toBeGreaterThan(.95));
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    const before = Number(getComputedStyle(screen.getByTestId('ui-overlay-exit')).opacity);
    fireEvent.click(screen.getByRole('button', { name: 'margin 보기' }));
    expect(Number(getComputedStyle(screen.getByRole('dialog')).opacity)).toBeGreaterThanOrEqual(before - .05);
  });

  it.each(['inventory-booking', 'suppliers'] as const)('opens %s at normal size with toggle and Escape recovery', async id => {
    const run = setup(true); await open(id);
    expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--detail');
    expect(screen.getByRole('button', { name: '자세히 보기 전체 화면으로 보기' })).toBeVisible();
    expect(screen.getByRole('button', { name: '닫기' })).toBeVisible();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
    expect(run.getState().overlay.type).toBe('none');
    await waitFor(() => expect(run.getState().exitPendingToken).toBe(null));
  });

  it('keeps the dialog and its content when theme and 125% text change', async () => {
    const run = setup(); await open('margin');
    act(() => { run.actions.setTheme('dark'); run.actions.setTextScale(125); });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.fontSize).toBe('20px');
    expect(screen.getByRole('dialog', { name: '마진' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'margin 본문' })).toBeVisible();
    expect(screen.queryByText('가짜 데이터로 만든 화면이에요')).not.toBeInTheDocument();
  });
});

describe('bottom row slot', () => {
  it('keeps an empty footer slot for ordinary details', async () => {
    setup(); await open('margin');
    const note = screen.getByRole('dialog').querySelector('.ui-overlay-note');
    expect(note?.querySelector('.detail-footer-slot')).toBeEmptyDOMElement();
    expect(note).not.toHaveTextContent(/\S/u);
  });
  it('lets a module put its controls in the bottom row', async () => {
    setup(); await open('calendar');
    const note = screen.getByRole('dialog').querySelector('.ui-overlay-note')!;
    expect(note).not.toHaveTextContent('가짜 데이터로 만든 화면이에요');
    expect(note.querySelector('.detail-footer-slot')).toContainElement(screen.getByRole('button', { name: '바닥줄 버튼' }));
  });
});
