import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import './test-setup';
import { screenPresets } from '../layout/presets';
import { UiProvider, DialogFrame, DetailDialog, BriefingCard } from './index';
import { FullscreenToggle } from './components/overlays';

afterEach(cleanup);
const wrap = (child: React.ReactNode) => <UiProvider screenPreset={screenPresets.A} reducedMotion>{child}</UiProvider>;

describe('dialog notice portal slot', () => {
  it.each([
    ['detail', (footer: string | undefined) => <DialogFrame open title="상세" footer={footer} onClose={vi.fn()}>내용</DialogFrame>],
    ['settings', (footer: string | undefined) => <DialogFrame open variant="settings" title="상세" footer={footer} onClose={vi.fn()}>내용</DialogFrame>],
    ['fullscreen', (footer: string | undefined) => <DetailDialog open fullscreen title="상세" footer={footer} onClose={vi.fn()}>내용</DetailDialog>],
    ['briefing', (footer: string | undefined) => <BriefingCard open title="상세" footer={footer} onClose={vi.fn()}>내용</BriefingCard>],
  ])('%s provides an empty stable slot with and without footer text', (_name, frame) => {
    const view = render(wrap(frame(undefined)));
    const dialog = screen.getByRole('dialog');
    const slot = dialog.querySelector('.ui-overlay-notice-slot');
    expect(slot).not.toBeNull();
    expect(slot).toBeEmptyDOMElement();
    expect(slot?.parentElement?.tagName).toBe('FOOTER');
    expect(dialog.querySelector('.ui-overlay-note')).toBeNull();
    view.rerender(wrap(frame('안내')));
    expect(dialog.querySelector('.ui-overlay-note')).not.toBeNull();
    expect(dialog.querySelector('.ui-overlay-notice-slot')).toBe(slot);
    expect(slot).toBeEmptyDOMElement();
  });

  it('keeps the notice slot while the icon-only fullscreen control changes state', () => {
    const frame = (fullscreen: boolean) => <DetailDialog open title="상세" fullscreen={fullscreen} onClose={vi.fn()} headerAction={<FullscreenToggle fullscreen={fullscreen} onChange={vi.fn()} accessibleLabel={fullscreen ? '자세히 보기 원래 크기로 보기' : '자세히 보기 전체 화면으로 보기'} />}>내용</DetailDialog>;
    const view = render(wrap(frame(false)));
    const slot = screen.getByRole('dialog').querySelector('.ui-overlay-notice-slot');
    expect(screen.getByRole('button', { name: '자세히 보기 전체 화면으로 보기' })).toHaveTextContent('');
    view.rerender(wrap(frame(true)));
    expect(screen.getByRole('dialog').querySelector('.ui-overlay-notice-slot')).toBe(slot);
    expect(screen.getByRole('button', { name: '자세히 보기 원래 크기로 보기' })).toHaveTextContent('');
  });

  it('keeps a portal and its undo button when footer text changes', () => {
    const frame = (footer: string) => <DialogFrame open title="상세" footer={footer} onClose={vi.fn()}>내용</DialogFrame>;
    const view = render(wrap(frame('예시 자료')));
    const dialog = screen.getByRole('dialog');
    const slot = dialog.querySelector('.ui-overlay-notice-slot');
    expect(slot).not.toBeNull();
    const undo = vi.fn();
    const portal = createPortal(<button onClick={undo}>되돌리기</button>, slot!);
    view.rerender(wrap(<>{frame('예시 자료')}{portal}</>));
    const button = within(dialog).getByRole('button', { name: '되돌리기' });
    view.rerender(wrap(<>{frame('Example data')}{portal}</>));
    expect(within(dialog).getByRole('button', { name: '되돌리기' })).toBe(button);
    button.click();
    expect(undo).toHaveBeenCalledOnce();
    view.rerender(wrap(<><DialogFrame open title="상세" onClose={vi.fn()}>내용</DialogFrame>{portal}</>));
    expect(within(dialog).getByRole('button', { name: '되돌리기' })).toBe(button);
  });
});
