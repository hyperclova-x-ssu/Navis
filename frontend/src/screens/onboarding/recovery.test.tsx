import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { ContentRecovery, UiProvider, timePolicy } from '../../ui';

afterEach(cleanup);
describe.each(['A', 'B'] as const)('%s content recovery', presetId => {
it('recovers an actual content render failure without resetting chosen business or layout', () => {
  const run = createRunStore({ screenPreset: screenPresets[presetId], catalog: getRegistry(presetId), time: timePolicy, theme: 'dark', clock: () => 0 });
  run.actions.chooseBusiness('cafe'); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'margin' });
  const before = run.getState(); let failed = true;
  function LocalContent() { if (failed) throw new Error('Local display failure'); return <p>카페</p>; }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(() => render(<UiProvider screenPreset={run.getState().screenPreset}><ContentRecovery><LocalContent /></ContentRecovery></UiProvider>)).not.toThrow();
  expect(screen.getByRole('alert')).toHaveTextContent('화면을 보여 주지 못했어요. 다시 열어 주세요');
  failed = false; fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
  expect(screen.getByText('카페')).toBeVisible(); expect(run.getState()).toEqual(before);
});
});
