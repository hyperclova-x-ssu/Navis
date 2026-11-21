import { screenPresets } from '../layout/presets';
import { createRef, useRef, useState } from 'react';
import { motionValue, type MotionStyle } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './test-setup';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import {
  ActionButton,
  DetailDialog,
  DialogFrame,
  OverlayExitSurface,
  UiProvider,
  panelLayoutId,
  type DialogFrameProps,
  type OverlayExitSurfaceProps,
} from './index';

afterEach(cleanup);

describe('caller-controlled overlay surfaces', () => {
  it.each([
    { name: 'DialogFrame/shared layout', Popup: DialogFrame, layoutId: panelLayoutId('popup-ref-frame') },
    { name: 'DetailDialog/shared layout', Popup: DetailDialog, layoutId: panelLayoutId('popup-ref-detail') },
    { name: 'DialogFrame/caller transform', Popup: DialogFrame, layoutId: undefined },
    { name: 'DetailDialog/caller transform', Popup: DetailDialog, layoutId: undefined },
  ])('$name connects the popup ref and live MotionStyle without changing modal behavior', async ({ Popup, layoutId }) => {
    const popupRef = createRef<HTMLDivElement>();
    const transform = motionValue('translateX(40px) scale(0.8)');
    const popupStyle: MotionStyle = { transform, transformOrigin: 'top left' };
    const close = vi.fn();
    const behind = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      const trigger = useRef<HTMLButtonElement>(null);
      const props: DialogFrameProps = {
        open,
        title: '가계부 자세히 보기',
        popupRef,
        popupStyle,
        layoutId,
        returnFocusRef: trigger,
        onClose: (reason) => { close(reason); setOpen(false); },
        children: <ActionButton>내용 행동</ActionButton>,
      };
      return <><div data-testid="background"><ActionButton ref={trigger} onClick={() => setOpen(true)}>자세히 보기</ActionButton><ActionButton onClick={behind}>뒤 패널</ActionButton></div><Popup {...props} /></>;
    }

    const user = userEvent.setup();
    render(<UiProvider screenPreset={screenPresets.A} theme="dark" reducedMotion={false}><Harness /></UiProvider>);
    const trigger = screen.getByRole('button', { name: '자세히 보기' });
    const behindButton = screen.getByRole('button', { name: '뒤 패널' });
    await user.click(trigger);
    const popup = await screen.findByRole('dialog', { name: '가계부 자세히 보기' });
    expect(popupRef.current).toBe(popup);
    expect(popup).toHaveStyle({ transform: 'translateX(40px) scale(0.8)', transformOrigin: 'top left' });
    expect(popup.closest('[data-theme]')).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByTestId('background')).toHaveAttribute('aria-hidden', 'true');
    await waitFor(() => expect(within(popup).getByRole('button', { name: '닫기' })).toHaveFocus());
    await user.tab({ shift: true });
    await waitFor(() => expect(within(popup).getByRole('button', { name: '내용 행동' })).toHaveFocus());

    act(() => transform.set('translateX(12px) scale(0.95)'));
    await waitFor(() => expect(popup).toHaveStyle({ transform: 'translateX(12px) scale(0.95)' }));
    expect(popupRef.current).toBe(popup);
    await user.keyboard('{Escape}');
    expect(close).toHaveBeenLastCalledWith('Esc');
    expect(popupRef.current).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('background')).not.toHaveAttribute('aria-hidden');
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(close).toHaveBeenLastCalledWith('button');
    expect(popupRef.current).toBeNull();
    await user.click(trigger);
    await user.pointer([{ target: screen.getByTestId('ui-dialog-backdrop'), keys: '[MouseLeft>]' }, { target: behindButton, keys: '[/MouseLeft]' }]);
    expect(close).toHaveBeenLastCalledWith('outside');
    expect(popupRef.current).toBeNull();
    expect(behind).not.toHaveBeenCalled();
    await user.click(behindButton);
    expect(behind).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('attaches surfaceRef for shrinking while leaving the background interactive (shared layout: %s)', async (sharedLayout) => {
    const surfaceRef = createRef<HTMLDivElement>();
    const transform = motionValue('translateX(12px) scale(0.95)');
    const complete = vi.fn();
    const behind = vi.fn();
    const props: OverlayExitSurfaceProps = {
      token: 'exit-with-ref',
      kind: 'detail',
      layoutId: sharedLayout ? panelLayoutId('exit-ref') : undefined,
      surfaceRef,
      style: { transform, transformOrigin: 'top left', pointerEvents: 'auto' },
      onComplete: complete,
      children: '닫히는 창',
    };
    // Exits occur after the application provider and its portal host have mounted.
    const view = render(<UiProvider screenPreset={screenPresets.A} theme="dark" reducedMotion={false}><ActionButton onClick={behind}>뒤 패널</ActionButton></UiProvider>);
    view.rerender(<UiProvider screenPreset={screenPresets.A} theme="dark" reducedMotion={false}><ActionButton onClick={behind}>뒤 패널</ActionButton><OverlayExitSurface {...props} /></UiProvider>);
    const surface = screen.getByTestId('ui-overlay-exit');
    expect(surfaceRef.current).toBe(surface);
    expect(surface).toHaveStyle({ transform: 'translateX(12px) scale(0.95)', transformOrigin: 'top left', pointerEvents: 'none' });
    expect(surface).toHaveAttribute('inert');
    expect(surface).toHaveAttribute('aria-hidden', 'true');
    expect(surface.closest('[data-theme]')).toHaveAttribute('data-theme', 'dark');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const background = screen.getByRole('button', { name: '뒤 패널' });
    background.focus();
    expect(background).toHaveFocus();
    act(() => transform.set('translateX(40px) scale(0.8)'));
    await waitFor(() => expect(surface).toHaveStyle({ transform: 'translateX(40px) scale(0.8)' }));
    await userEvent.setup().click(background);
    expect(behind).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith('exit-with-ref'));
    expect(surface).toHaveStyle({ transform: 'translateX(40px) scale(0.8)', opacity: '0' });
    view.unmount();
    expect(surfaceRef.current).toBeNull();
  });

  it('preserves the default scale and opacity when no caller transform is supplied', async () => {
    const complete = vi.fn();
    const view = render(<UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion={false}><DialogFrame open title="기본 모션" onClose={vi.fn()}>내용</DialogFrame></UiProvider>);
    const popup = screen.getByRole('dialog', { name: '기본 모션' });
    expect(popup).toHaveStyle({ transform: 'scale(0.98)', opacity: '0' });
    await waitFor(() => expect(popup).toHaveStyle({ transform: 'scale(1)', opacity: '1' }));
    view.rerender(<UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion={false}><OverlayExitSurface token="default-exit" kind="detail" onComplete={complete}>닫히는 창</OverlayExitSurface></UiProvider>);
    const surface = screen.getByTestId('ui-overlay-exit');
    await waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith('default-exit'));
    expect(surface).toHaveStyle({ transform: 'scale(0.98)', opacity: '0' });
  });

  it.each([false, true])('preserves caller opacity through popup, exit and reverse without restarting a fade (reduced: %s)', async (reducedMotion) => {
    const opacity = motionValue(0.6);
    const style: MotionStyle = { opacity, transform: 'translateX(12px) scale(0.95)' };
    const popup = <DetailDialog open title="다시 열리는 창" onClose={vi.fn()} popupStyle={style}>내용</DetailDialog>;
    const view = render(<UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion={reducedMotion}>{null}</UiProvider>);
    view.rerender(<UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion={reducedMotion}>{popup}</UiProvider>);
    expect(screen.getByRole('dialog')).toHaveStyle({ opacity: '0.6' });
    act(() => opacity.set(0.4));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveStyle({ opacity: '0.4' }));
    view.rerender(<UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion={reducedMotion}><OverlayExitSurface token="opacity-exit" kind="detail" style={style} onComplete={vi.fn()}>닫히는 창</OverlayExitSurface></UiProvider>);
    expect(screen.getByTestId('ui-overlay-exit')).toHaveStyle({ opacity: '0.4' });
    act(() => opacity.set(0.2));
    await waitFor(() => expect(screen.getByTestId('ui-overlay-exit')).toHaveStyle({ opacity: '0.2' }));
    view.rerender(<UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion={reducedMotion}>{popup}</UiProvider>);
    expect(screen.getByRole('dialog')).toHaveStyle({ opacity: '0.2' });
    act(() => opacity.set(0.8));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveStyle({ opacity: '0.8' }));
  });

  it('treats an explicit zero opacity as caller controlled on both surfaces', () => {
    const view = render(<UiProvider screenPreset={screenPresets.A} theme="light"><DialogFrame open title="투명한 창" popupStyle={{ opacity: 0 }} onClose={vi.fn()}>내용</DialogFrame></UiProvider>);
    expect(screen.getByRole('dialog')).toHaveStyle({ opacity: '0' });
    view.rerender(<UiProvider screenPreset={screenPresets.A} theme="light"><OverlayExitSurface token="zero-opacity" kind="detail" style={{ opacity: 0 }} onComplete={vi.fn()}>닫히는 창</OverlayExitSurface></UiProvider>);
    expect(screen.getByTestId('ui-overlay-exit')).toHaveStyle({ opacity: '0' });
  });
});
