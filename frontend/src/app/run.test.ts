import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserRun, readBrowserPreferences } from './run';

afterEach(() => vi.unstubAllGlobals());

it('starts a new run in light mode under a dark OS and retains reduced motion', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('dark') || query.includes('reduce') }));
  expect(readBrowserPreferences()).toEqual({ theme: 'light', reducedMotion: true });
  const run = createBrowserRun()!;
  expect(run.getState()).toMatchObject({ theme: 'light', reducedMotion: true });
  run.actions.setTheme('dark');
  expect(run.getState().theme).toBe('dark');
  run.dispose();
  const next = createBrowserRun()!;
  expect(next.getState().theme).toBe('light');
  next.dispose();
});
