import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UiProvider } from '../UiProvider';
import { screenPresets } from '../../layout/presets';
import { createTableLayout } from '../../layout/table-layout';
import { TableSettingsPanel } from './table-grid-editor';
afterEach(cleanup);
it('renders a controlled link picker in each table row and reports changes', () => {
  const change = vi.fn();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><TableSettingsPanel layout={createTableLayout()} onCountChange={() => {}} onSeatsChange={() => {}} linkPicker={{ valueFor: id => id === 'T1' ? 'zone-1' : null, optionsFor: id => id === 'T1' ? [{ value: 'zone-1', label: 't1' }] : [], onChange: change }}/></UiProvider>);
  const picker = screen.getByRole('combobox', { name: 'T1 CCTV 구역 연결' });
  expect(picker).toHaveValue('zone-1');
  fireEvent.change(picker, { target: { value: '' } });
  expect(change).toHaveBeenCalledExactlyOnceWith('T1', null);
});
