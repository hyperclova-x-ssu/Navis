import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, timePolicy } from '../../ui';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { BriefingOverlay } from './index';
import { DataHost } from './test-support';

/** K-E 9: the briefing failure sample is shown as a state (alert + retry) without throwing, so no console error is logged. */
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('briefing failure sample', () => {
  it('shows the inline failure state with title and close, and logs no console error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let now = 0;
    const preset = screenPresets.A;
    const run = createRunStore({ screenPreset: preset, catalog: getRegistry('A'), time: timePolicy, clock: () => now, theme: 'light', reducedMotion: true });
    beginDashboard(run, 'cafe'); run.actions.visualSettled(); now += 400; run.actions.tick();
    run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); now += 200; run.actions.tick();
    for (let i = 0; i < 12; i += 1) { const g = run.getState().guidance; if (!g.active && !g.activeWidget && !g.queue.length && !g.widgetQueue.length) break; run.actions.dismissCoach(); now += 200; run.actions.tick(); }
    run.actions.clearNotice(); run.actions.finishEditing();
    now += 1200; run.actions.tick();
    render(<DataHost><UiProvider screenPreset={preset} theme="light" reducedMotion><BriefingOverlay run={run} verification={{ failContent: true, onRetry: () => undefined }} /></UiProvider></DataHost>);
    expect(screen.getByRole('alert')).toHaveTextContent('화면을 보여 주지 못했어요. 다시 열어 주세요');
    expect(screen.getByRole('button', { name: '다시 시도하기' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '닫기' })).toBeEnabled();
    expect(errors).not.toHaveBeenCalled();
    run.dispose();
  });
});
