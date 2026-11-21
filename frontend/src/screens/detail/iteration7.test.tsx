import { beginDashboard } from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { UiProvider, timePolicy } from '../../ui';
import { DetailOverlay } from './DetailOverlay';
import { DetailHost, stubDetailModule, stubDetailModules } from './test-modules';

afterEach(cleanup);

function setup() {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => performance.now(), theme: 'light', reducedMotion: true });
  beginDashboard(run);
  for (const featureId of ['calendar', 'briefing', 'inventory-booking', 'suppliers'] as const) run.actions.applyLayoutIntent({ type: 'add-tap', featureId });
  const modules = [stubDetailModule('calendar', () => <input aria-label="메모" defaultValue="초안" />), ...stubDetailModules(['briefing', 'inventory-booking', 'suppliers'])];
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    return <DetailHost modules={modules}><UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}><button id="opener">열기</button><DetailOverlay run={run} /></UiProvider></DetailHost>;
  }
  render(<Harness />);
  return run;
}

it('expands and restores without replacing the mounted form or changing layout', async () => {
  const run = setup();
  act(() => run.actions.openDetail('calendar', 'opener'));
  const input = await screen.findByRole('textbox', { name: '메모' });
  fireEvent.change(input, { target: { value: '작성 중' } });
  const scroll = input.closest('.ui-overlay-body') as HTMLElement;
  scroll.scrollTop = 42;
  const before = run.getState().layoutRevision;
  const button = screen.getByRole('button', { name: '자세히 보기 전체 화면으로 보기' });
  expect(button).toHaveTextContent('');
  expect(button).not.toHaveAttribute('title');
  expect(button).toHaveAttribute('aria-pressed', 'false');
  button.focus(); fireEvent.click(button);
  expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--fullscreen');
  expect(screen.getByRole('textbox', { name: '메모' })).toBe(input);
  expect(input).toHaveValue('작성 중');
  expect(scroll.scrollTop).toBe(42);
  expect(screen.getByRole('button', { name: '자세히 보기 원래 크기로 보기' })).toHaveFocus();
  expect(run.getState().layoutRevision).toBe(before);
  fireEvent.click(button);
  expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--detail');
});

it('keeps the preference across compact and workspaces and lets each restore it', async () => {
  const run = setup();
  act(() => run.actions.openDetail('briefing', 'opener'));
  const toggle = await screen.findByRole('button', { name: '자세히 보기 전체 화면으로 보기' });
  fireEvent.click(toggle);
  expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--fullscreen');
  expect(screen.getByRole('dialog').style.width).not.toBe('1080px');
  for (const id of ['inventory-booking', 'suppliers'] as const) {
    act(() => { run.actions.closeOverlay('button'); run.actions.openDetail(id, 'opener'); });
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--fullscreen'));
    expect(screen.getByRole('button', { name: '자세히 보기 원래 크기로 보기' })).toHaveAttribute('aria-pressed', 'true');
    expect(run.getState().detailDialogFullscreen).toBe(true);
  }
  act(() => { run.actions.closeOverlay('button'); run.actions.openDetail('calendar', 'opener'); });
  await waitFor(() => expect(screen.getByRole('button', { name: '자세히 보기 원래 크기로 보기' })).toBeVisible());
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
  expect(run.getState().overlay.type).toBe('none');
});
