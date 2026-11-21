import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { screenPresets } from '../../layout/presets';
import { UiProvider } from '../UiProvider';
import { BriefingCard, DetailDialog, FullscreenToggle } from './overlays';

afterEach(cleanup);

it('changes the detail frame without remounting its content', () => {
  const dialog = (fullscreen: boolean) => <UiProvider screenPreset={screenPresets.A} reducedMotion><DetailDialog open title="상세" fullscreen={fullscreen} onClose={vi.fn()}><input aria-label="입력" defaultValue="초안" /></DetailDialog></UiProvider>;
  const view = render(dialog(false));
  const input = screen.getByRole('textbox', { name: '입력' });
  view.rerender(dialog(true));
  expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--fullscreen');
  expect(screen.getByRole('textbox', { name: '입력' })).toBe(input);
});

it('lets a controlled briefing toggle request fullscreen without replacing its body', () => {
  const change = vi.fn();
  const dialog = (fullscreen: boolean) => <UiProvider screenPreset={screenPresets.A} reducedMotion><BriefingCard open fullscreen={fullscreen} onClose={vi.fn()} headerAction={<FullscreenToggle fullscreen={fullscreen} onChange={change} accessibleLabel={fullscreen ? '자세히 보기 원래 크기로 보기' : '자세히 보기 전체 화면으로 보기'} />}><input aria-label="브리핑 메모" /></BriefingCard></UiProvider>;
  const view = render(dialog(false));
  const input = screen.getByRole('textbox', { name: '브리핑 메모' });
  const toggle = screen.getByRole('button', { name: '자세히 보기 전체 화면으로 보기' });
  expect(toggle).toHaveTextContent('');
  expect(toggle).not.toHaveAttribute('title');
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(toggle);
  expect(change).toHaveBeenCalledWith(true);
  view.rerender(dialog(true));
  expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--fullscreen');
  expect(screen.getByRole('textbox', { name: '브리핑 메모' })).toBe(input);
  expect(screen.getByRole('button', { name: '자세히 보기 원래 크기로 보기' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '자세히 보기 원래 크기로 보기' })).toHaveTextContent('');
});
