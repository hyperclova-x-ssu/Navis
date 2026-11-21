import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { screenPresets } from '../layout/presets';
import { UiProvider } from './UiProvider';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('defaults an uncontrolled provider to light under a dark OS and accepts explicit theme changes', () => {
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: true, media, addEventListener() {}, removeEventListener() {} }));
  const view = render(<UiProvider screenPreset={screenPresets.A}>내용</UiProvider>);
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  expect(document.documentElement).toHaveAttribute('data-reduced-motion', 'true');
  view.rerender(<UiProvider screenPreset={screenPresets.A} theme="dark">내용</UiProvider>);
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  view.rerender(<UiProvider screenPreset={screenPresets.A} theme="light">내용</UiProvider>);
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
});
