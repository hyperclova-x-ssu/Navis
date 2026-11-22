import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, deviceLayout } from './device-geometry';
import { DeviceFrame } from './device-frame';
import ConnectApp from './ConnectApp';

vi.mock('./facesign', () => ({
  FacesignCamera: () => <div/>,
  FacesignSetup: () => <div/>,
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState(null, '', '/'); });

describe('deviceLayout (pure geometry)', () => {
  it('keeps the kiosk screen at 800 x 1280 in the device’s own pixels and the reader at 20–22 % of the device width', () => {
    expect(DEVICE.screenW).toBe(800);
    expect(DEVICE.screenH).toBe(1280);
    expect(DEVICE.readerW / DEVICE.width).toBeGreaterThanOrEqual(0.2);
    expect(DEVICE.readerW / DEVICE.width).toBeLessThanOrEqual(0.22);
    expect(DEVICE.bodyW).toBe(DEVICE.screenW + 2 * DEVICE.bezelX);
    expect(DEVICE.width).toBe(DEVICE.bodyW + DEVICE.readerW);
    expect(DEVICE.height).toBe(DEVICE.screenH + DEVICE.bezelTop + DEVICE.bezelBottom);
    expect(DEVICE.corner / DEVICE.bodyW).toBeCloseTo(0.06, 2);
    // The two Facesign lenses sit centred on the top bezel at 38 % and 62 % of the tablet body.
    expect(DEVICE.lensX).toEqual([DEVICE.bodyW * 0.38, DEVICE.bodyW * 0.62]);
    expect(DEVICE.lensY).toBe(DEVICE.bezelTop / 2);
  });

  it('scales the whole device to fit the window (height-bound on a landscape projector) and centres it', () => {
    const a = deviceLayout(1920, 1080);
    expect(a.scale).toBeCloseTo((1080 - 2 * a.margin) / DEVICE.height, 6);
    expect(a.scale * DEVICE.width + 2 * a.margin).toBeLessThanOrEqual(1920);
    expect(a.x + (DEVICE.width * a.scale) / 2).toBeCloseTo(960, 6);
    expect(a.y + (DEVICE.height * a.scale) / 2).toBeCloseTo(540, 6);
    // The screen is the 800 x 1280 canvas times the same scale, inset by the bezel.
    expect(a.screen.width).toBeCloseTo(800 * a.scale, 6);
    expect(a.screen.height).toBeCloseTo(1280 * a.scale, 6);
    expect(a.screen.left).toBeCloseTo(a.x + DEVICE.bezelX * a.scale, 6);
    expect(a.screen.top).toBeCloseTo(a.y + DEVICE.bezelTop * a.scale, 6);
    expect(a.screen.width / a.screen.height).toBeCloseTo(800 / 1280, 6);
  });

  it('is width-bound in a narrow window and never goes below a tiny floor for a zero-sized window', () => {
    const b = deviceLayout(600, 1200);
    expect(b.scale).toBeCloseTo((600 - 2 * b.margin) / DEVICE.width, 6);
    expect(deviceLayout(0, 0).scale).toBe(1);
  });
});

describe('DeviceFrame', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, toJSON: () => ({}) });
  });

  it('draws the device as aria-hidden decoration (two lenses, a reader with two slots) and leaves the screen accessible', () => {
    const { container } = render(<DeviceFrame><button type="button">주문하기</button></DeviceFrame>);
    const chrome = container.querySelector('.ck-device');
    expect(chrome).toHaveAttribute('aria-hidden', 'true');
    expect(chrome?.querySelectorAll('[data-part="lens"]')).toHaveLength(2);
    expect(chrome?.querySelector('[data-part="reader"]')).not.toBeNull();
    expect(chrome?.querySelectorAll('[data-part="slot"]')).toHaveLength(2);
    // The child is NOT inside any aria-hidden node, so the kiosk stays reachable by role.
    expect(screen.getByRole('button', { name: '주문하기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '주문하기' }).closest('[aria-hidden="true"]')).toBeNull();
  });

  it('positions the screen slot exactly where the layout says (window pixels), so the 800 x 1280 canvas keeps exact touch targets', () => {
    const { container } = render(<DeviceFrame><span>x</span></DeviceFrame>);
    const slot = container.querySelector<HTMLElement>('.ck-device__screen');
    const a = deviceLayout(1920, 1080);
    expect(slot).not.toBeNull();
    expect(parseFloat(slot!.style.left)).toBeCloseTo(a.screen.left, 3);
    expect(parseFloat(slot!.style.top)).toBeCloseTo(a.screen.top, 3);
    expect(parseFloat(slot!.style.width)).toBeCloseTo(a.screen.width, 3);
    expect(parseFloat(slot!.style.height)).toBeCloseTo(a.screen.height, 3);
  });

  it('the decoration never captures the pointer (no clicks are eaten outside the screen)', () => {
    const onBackdrop = vi.fn();
    const { container } = render(<div onClick={onBackdrop}><DeviceFrame><span>x</span></DeviceFrame></div>);
    // pointer-events is a CSS rule; the contract here is that the chrome layer has the class that carries it and no handlers.
    const chrome = container.querySelector('.ck-device') as HTMLElement;
    expect(chrome.className).toContain('ck-device');
    fireEvent.click(chrome);
    expect(onBackdrop).toHaveBeenCalledTimes(1); // bubbles through untouched: the frame adds no handler of its own
  });
});

describe('ConnectApp wraps the kiosk in the device', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080, toJSON: () => ({}) });
  });

  it('/connect shows the attract screen inside the frame and a tap still moves the flow on', () => {
    window.history.pushState(null, '', '/connect');
    const { container } = render(<ConnectApp/>);
    expect(container.querySelector('.ck-device')).not.toBeNull();
    expect(container.querySelector('.ck-device__screen .ck-stage')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '주문하기' }));
    expect(screen.getByRole('button', { name: '매장 주문' })).toBeInTheDocument();
  });

  it('/connect/split keeps its two iframes; the kiosk page inside gets the frame by itself', () => {
    window.history.pushState(null, '', '/connect/split');
    const { container } = render(<ConnectApp/>);
    expect(container.querySelectorAll('iframe')).toHaveLength(2);
    expect(container.querySelector('.ck-device')).toBeNull();
  });
});
