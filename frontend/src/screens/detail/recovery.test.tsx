import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { UiProvider, timePolicy } from '../../ui';
import { DetailOverlay } from './DetailOverlay';
import { DetailHost, stubDetailModules } from './test-modules';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.getElementById('source')?.remove(); });
it('keeps the detail title and close control after a body failure, retries locally and restores focus', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => performance.now() });
  beginDashboard(run); run.actions.applyLayoutIntent({ type: 'add-drop', featureId: 'margin', column: 4, row: 2 });
  const source = document.createElement('button'); source.id = 'source'; document.body.append(source);
  const before = run.getState().panels;
  render(<DetailHost modules={stubDetailModules(['margin'])}><UiProvider screenPreset={screenPresets.A}><DetailOverlay run={run} simulateContentError /></UiProvider></DetailHost>);
  act(() => { run.actions.openDetail('margin', 'source'); });
  await waitFor(() => expect(screen.getByRole('dialog', { name: '마진' })).toBeVisible());
  expect(screen.getByRole('button', { name: '닫기' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
  // The module body comes back after the local retry (it was replaced by the error state, title and close kept).
  await waitFor(() => expect(screen.getByRole('region', { name: 'margin 본문' })).toBeVisible());
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  await waitFor(() => expect(source).toHaveFocus());
  expect(run.getState().panels).toEqual(before);
});
