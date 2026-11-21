import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KitProviders, renderWithKit } from '../../../ui/test-utils';
import { MktPanel } from './panel';
import { fitCouponPanel } from './fit';
import { keepDots, NoteLine } from './shared';
import { widgets } from './index';
import { ExpiryCouponPanel } from './expiry-coupon';
import { makeHost } from '../mkt-promo/test-helpers';
import { readFileSync } from 'node:fs';
const css = readFileSync('src/features/widgets/mkt-coupon/widget.css', 'utf8');

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); Reflect.deleteProperty(document, 'fonts'); });

describe('W4 coupon fitting', () => {
  it('keeps the Q description at 125% when there is room', () => {
    const descs = ['방문 기록 <다음> & "확인" · 안내', '짧은 설명'];
    const tree = (scale: 100 | 125) => <KitProviders textScale={scale}><MktPanel label="다음 주 빈 시간" id="customer-groups" shape="Q" width={1} height={1} editing={false} kpi={{ value: '7', unit: '명' }} descs={descs} action={null}/></KitProviders>;
    const view = render(tree(125));
    const description = document.querySelector('.mkt-desc')!;
    expect(description).not.toBeNull();
    expect(description.getAttribute('data-slot')).toBe('customer-groups.metric.desc');
    const spans = description.querySelectorAll('span');
    expect(spans[0].getAttribute('lang')).toBe('ko');
    expect(spans[0].textContent).toBe(keepDots(descs[0]));
    expect(spans[1].hasAttribute('hidden')).toBe(true);
    expect(spans[1].textContent).toBe(descs[1]);
    expect(description.querySelector('다음')).toBeNull();
    view.rerender(tree(100));
    expect(document.querySelector('template[data-fit-part]')).toBeNull();
    expect(document.querySelector('.mkt-desc span')!.textContent).toBe(keepDots(descs[0]));
  });

  it.each(widgets.map(widget => [widget.id, widget.Panel] as const))('%s puts W supporting copy in the right column', (id, Panel) => {
    const props = { featureId: id, condition: { kind: 'default' } as const, width: 2 as const, height: 1 as const, shape: 'W' as const, presetId: 'A' as const, editing: false, host: makeHost() };
    const view = renderWithKit(<Panel {...props} />);
    expect(view.container.querySelector('.ui-panel-secondary .mkt-desc')).not.toBeNull();
  });

  it('marks the Q description as fit-hidden on overflow and restores it when room returns', () => {
    let room = 30;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? room : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('ui-panel-content') ? 20 + (this.querySelector('.mkt-desc:not([data-fit-hidden])') ? 20 : 0) : 0;
    });
    const tree = <KitProviders textScale={125}><div className="ui-panel-content"><MktPanel label="다음 주 빈 시간" id="customer-groups" shape="Q" width={1} height={1} editing={false} kpi={{ value: '7', unit: '명' }} descs={['방문 기록']} action={null}/></div></KitProviders>;
    const view = render(tree);
    expect(view.container.querySelector('.mkt-desc')).toHaveAttribute('data-fit-hidden');
    room = 100;
    view.rerender(tree);
    // The fit callback is also run on a layout resize in the real host.
    fitCouponPanel(view.container.querySelector('.ui-panel-content')!);
    expect(view.container.querySelector('.mkt-desc')).not.toHaveAttribute('data-fit-hidden');
  });

  it.each([
    ['사용 · 발행', '사용\u00a0·\u00a0발행'],
    ['원가·기한', '원가\u2060·기한'],
    ['원가\u2060·기한', '원가\u2060·기한'],
    ['사용\u00a0· 발행', '사용\u00a0·\u00a0발행'],
  ])('keeps the separator attached without changing the visible spelling: %s (C10)', (value, expected) => {
    expect(keepDots(value)).toBe(expected);
  });

  it.each(['resize', 'font', 'edit'] as const)('restores the full description and rows after temporary overflow ends (%s, C2)', async event => {
    vi.useFakeTimers();
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { observers.push(cb); } observe() {} disconnect() {} });
    const fonts = new EventTarget();
    Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(fonts, { ready: Promise.resolve() }) });
    let room = 35;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? room : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('ui-panel-content')) return 0;
      const desc = this.querySelector('.mkt-desc:not([data-fit-hidden])');
      return 20 + (desc ? 20 : 0) + this.querySelectorAll('.mkt-rows > li:not([data-fit-hidden])').length * 10;
    });
    const body = <article className="ui-feature-panel" data-editing="false"><div className="ui-panel-content"><MktPanel label="다음 주 빈 시간" id="customer-groups" shape="T" width={1} height={2} editing={false} kpi={{ value: '7', unit: '명' }} descs={['방문 기록']} rows={[<li key="a">a</li>, <li key="b">b</li>]} action={null} /></div></article>;
    const view = renderWithKit(body);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(document.querySelector('.mkt-desc:not([data-fit-hidden])')).toBeNull();
    room = 100;
    await act(async () => {
      if (event === 'resize') observers.forEach(cb => cb([], {} as ResizeObserver));
      else if (event === 'font') fonts.dispatchEvent(new Event('loadingdone'));
      else document.querySelector('article')!.setAttribute('data-editing', 'true');
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(document.querySelector('.mkt-desc:not([data-fit-hidden])')).toHaveTextContent('방문 기록');
    expect(document.querySelectorAll('.mkt-rows > li:not([data-fit-hidden])')).toHaveLength(2);
    view.unmount();
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'fonts');
  });

  it('glues both spaced and unspaced middle dots to the previous character (C10) and marks Korean fallback (R-13)', () => {
    renderWithKit(<NoteLine notes={[{ messageKey: 'data.state.expiry-coupon.partial' }]} />, { locale: 'ko' });
    // This is the real T-202 note; its Korean-only copy must keep the original spelling.
    const note = document.querySelector('.mkt-note__sentence')!;
    expect(note.textContent).toMatch(/원가\u2060·기한/);
    expect(note).toHaveAttribute('lang', 'ko');
  });

  it('does not clamp or shrink state messages (C3)', () => {
    render(<><style>{css}</style><div className="mkt-state"><p className="ui-panel-state__message">상태</p></div></>);
    const style = getComputedStyle(document.querySelector('p')!);
    expect(style.getPropertyValue('-webkit-line-clamp')).toBe('');
    expect(style.overflow).not.toBe('hidden');
    expect(style.flexShrink).toBe('0');
  });

  it('drops the slot-coupon note when only a single row fits (C7b)', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? 50 : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('ui-panel-content') ? 10 + this.querySelectorAll('.mkt-rows > li:not([data-fit-hidden])').length * 35 : 0;
    });
    renderWithKit(<div className="ui-panel-content"><MktPanel label="다음 주 빈 시간" id="slot-coupon" shape="T" width={1} height={2} editing kpi={{ value: '3', unit: '칸' }} rows={[<li key="a">row one</li>, <li key="b">row two</li>]} aside={<NoteLine compact notes={[{ messageKey: 'data.state.expiry-coupon.partial' }]} />} action={null} /></div>);
    expect(document.querySelectorAll('.mkt-rows > li:not([data-fit-hidden])')).toHaveLength(1);
    expect(document.querySelector('.mkt-note')!.closest('[data-fit-hidden]')).not.toBeNull();
  });

  it('removes the note grid slot itself before sacrificing unrelated coupon rows (C7)', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? 85 : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('ui-panel-content')) return 0;
      return 20 + this.querySelectorAll('.mkt-rows > li:not([data-fit-hidden])').length * 30 + (this.querySelector('.ui-panel-secondary:not([data-fit-hidden])') ? 40 : 0);
    });
    renderWithKit(<div className="ui-panel-content"><MktPanel label="다음 주 빈 시간" id="expiry-coupon" shape="T" width={1} height={2} editing kpi={{ value: '6', unit: '개' }} rows={[<li key="a">a</li>, <li key="b">b</li>]} aside={<NoteLine compact notes={[{ messageKey: 'data.state.expiry-coupon.partial' }]} />} action={null} /></div>);
    expect(document.querySelectorAll('.mkt-rows > li:not([data-fit-hidden])')).toHaveLength(2);
    expect(document.querySelector('.ui-panel-secondary')).toHaveAttribute('data-fit-hidden');
  });

  it('leaves a one-row slot note visible when its full list fits naturally (C7b boundary)', () => {
    renderWithKit(<MktPanel label="다음 주 빈 시간" id="slot-coupon" shape="T" width={1} height={2} editing={false} kpi={{ value: '1', unit: '칸' }} rows={[<li key="a">row one</li>]} aside={<NoteLine notes={[{ messageKey: 'data.state.expiry-coupon.partial' }]} />} action={null} />);
    expect(document.querySelector('.mkt-note')!.closest('[data-fit-hidden]')).toBeNull();
  });

  it('marks only the note sentence as screen-reader text in coupon edit mode (C7)', () => {
    renderWithKit(<ExpiryCouponPanel featureId="expiry-coupon" condition={{ kind: 'default' }} width={1} height={2} shape="T" presetId="A" editing host={makeHost()} />, { preview: { family: 'normal', overrides: { 'expiry-coupon': 'partial' } } });
    expect(document.querySelector('.mkt-note__sentence')).toHaveClass('ui-sr-only');
    expect(document.querySelector('.mkt-note .ui-status-badge')).not.toBeNull();
  });
});


describe('T-212o coupon panel content padding', () => {
  it('keeps the action margin for non-Q coupon panels at large text size', () => {
    render(<><style>{'.ui-panel-action-area { margin-top: 4px; }'}{css}</style><div className="ui-root" data-text-scale="125"><div className="mkt-panel"><div className="ui-panel-body" data-shape="W"><div className="ui-panel-action-area" /></div></div></div></>);
    expect(getComputedStyle(document.querySelector('.ui-panel-action-area')!).marginTop).toBe('4px');
  });

  it.each([100, 125])('removes the extra Q action margin at text scale %s', scale => {
    render(<><style>{'.ui-panel-action-area { margin-top: 4px; }'}{css}</style><div className="ui-root" data-text-scale={scale}><div className="mkt-panel"><div className="ui-panel-body" data-shape="Q"><div className="ui-panel-action-area" /></div></div></div></>);
    expect(getComputedStyle(document.querySelector('.ui-panel-action-area')!).marginTop).toBe(scale === 125 ? '0px' : '4px');
  });
});
