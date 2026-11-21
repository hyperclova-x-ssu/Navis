import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider, timePolicy } from '../../ui';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { BriefingOverlay } from './index';
import { DataHost } from './test-support';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe.each(['A', 'B'] as const)('%s briefing recovery', presetId => {
  it('keeps the actual title and close control after body failure, retries and closes without changing panels', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let now = 0;
    const preset = screenPresets[presetId];
    const run = createRunStore({ screenPreset: preset, catalog: getRegistry(presetId), time: timePolicy, clock: () => now, theme: 'light', reducedMotion: true });
    beginDashboard(run,'cafe'); run.actions.visualSettled(); now += 400; run.actions.tick();
    run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); now += 200; run.actions.tick();
    // F-03 steps and one explanation per started widget (F-21).
    for (let i = 0; i < 12; i += 1) { const g = run.getState().guidance; if (!g.active && !g.activeWidget && !g.queue.length && !g.widgetQueue.length) break; run.actions.dismissCoach(); now += 200; run.actions.tick(); }
    run.actions.clearNotice(); run.actions.finishEditing();
    now += 1200; run.actions.tick();
    let fails = true;
    const content = () => <DataHost><UiProvider screenPreset={preset} theme="light" reducedMotion><BriefingOverlay run={run} verification={{ failContent: fails, onRetry: () => { fails = false; view.rerender(content()); } }} /></UiProvider></DataHost>;
    const view = render(content());
    expect(screen.getByRole('alert')).toHaveTextContent('화면을 보여 주지 못했어요. 다시 열어 주세요');
    await waitFor(() => expect(screen.getByRole('heading', { name: '오늘 가게 소식이에요' })).toBeVisible());
    const close = screen.getByRole('button', { name: '닫기' });
    expect(close).toBeEnabled(); expect(screen.getByRole('dialog')).not.toHaveTextContent('가짜 데이터로 만든 화면이에요');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    await waitFor(() => expect(screen.getByText('오늘 일정 3개')).toBeVisible());
    expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('button', { name: '닫기' })).toBe(close);
    const before = run.getState();
    act(() => { fails = true; view.rerender(content()); });
    expect(screen.getByRole('alert')).toBeVisible();
    fireEvent.click(close);
    expect(run.getState().overlay.type).toBe('none'); expect(run.getState().briefing).toBe('dismissed');
    expect(run.getState().panels).toBe(before.panels); expect(run.getState().layoutRevision).toBe(before.layoutRevision);
    await waitFor(() => expect(run.getState().exitPendingToken).toBeNull());
    run.dispose();
  });
});
