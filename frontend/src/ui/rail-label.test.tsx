import './test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FunctionRailItem, UiProvider } from './index';
import { screenPresets } from '../layout/presets';
afterEach(cleanup);
it('shows a rail short name while keeping the full name as the accessible name (LOCALES 2, T-055)', () => {
  render(<UiProvider screenPreset={screenPresets.A}><FunctionRailItem label="Recommended" shortLabel="Picks" icon="recommended" /><FunctionRailItem label="Money" shortLabel="Money" icon="money" /><FunctionRailItem label="Search" aria-label="Search features" icon="search" /></UiProvider>);
  const picks = screen.getByRole('button', { name: 'Recommended' });
  expect(picks).toHaveTextContent('Picks'); expect(picks).not.toHaveTextContent('Recommended');
  const money = screen.getByRole('button', { name: 'Money' });
  expect(money).not.toHaveAttribute('aria-label');
  expect(screen.getByRole('button', { name: 'Search features' })).toHaveTextContent('Search');
});
