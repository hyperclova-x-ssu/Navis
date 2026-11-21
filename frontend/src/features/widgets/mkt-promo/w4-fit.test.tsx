import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { MarketingPerformancePanel } from './marketing-performance';
import { cafeModel, makeHost, manText } from './test-helpers';
import { PromoVideoPanel } from './promo-video';
import { MarketingTodayPanel } from './marketing-today';
import { readFileSync } from 'node:fs';
const css = readFileSync('src/features/widgets/mkt-promo/widget.css', 'utf8');
const promoCss = readFileSync('src/features/widgets/mkt-promo/promo.css', 'utf8');

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('W4 promotion fitting', () => {
  it('drops only supplementary performance blocks and restores them after a temporary overflow (C2b/C8)', () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { observers.push(cb); } observe() {} disconnect() {} });
    let overflow = true;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? 100 : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('ui-panel-content')) return 0;
      return overflow && this.querySelectorAll('.mp-block:not([data-fit-hidden])').length > 1 ? 120 : 100;
    });
    renderWithKit(<div className="ui-panel-content"><MarketingPerformancePanel featureId="marketing-performance" condition={{ kind: 'default' }} width={3} height={1} shape="W" presetId="A" editing={true} host={makeHost()} /></div>);
    expect(document.querySelectorAll('.mp-block:not([data-fit-hidden])')).toHaveLength(1);
    expect(document.querySelector('[data-slot="marketing-performance.metric.rate"]')!.closest('.mp-block')).not.toHaveAttribute('data-fit-hidden');
    overflow = false;
    act(() => { observers.forEach(cb => cb([], {} as ResizeObserver)); });
    expect(document.querySelectorAll('.mp-block:not([data-fit-hidden])')).toHaveLength(3);
  });

  it('state messages and the photo sentence wrap without clamping or shrinking (C3/C6)', () => {
    render(<><style>{css}{promoCss}</style><div className="mp-root" data-state="empty"><p className="ui-panel-state__message">상태</p><p className="pv-panel__sentence">사진이 필요해요</p></div></>);
    for (const el of document.querySelectorAll('p')) {
      const style = getComputedStyle(el);
      expect(style.getPropertyValue('-webkit-line-clamp')).toBe('');
      expect(style.overflow).not.toBe('hidden');
      expect(style.flexShrink).toBe('0');
    }
  });

  it('marks the Korean-only materials label and unit on English screens (R-13)', () => {
    renderWithKit(<PromoVideoPanel featureId="promo-video" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={makeHost()} />, { locale: 'en' });
    expect(document.querySelector('.pv-panel__materials')).toHaveAttribute('lang', 'ko');
  });

  it('uses the shared board body origin for a flow video panel without extra help padding (DS 19)', () => {
    render(<><style>{css + readFileSync('src/screens/dashboard/dashboard.css', 'utf8')}</style>
      <div className="ui-root" data-screen-preset="A" data-text-scale="100">
        <main className="dashboard-screen" data-layer="marketing">
          <article className="ui-feature-panel" data-flow="true" data-editing="true" data-width="1" data-height="1">
            <div className="ui-panel-surface">
              <h2 className="ui-panel-title">AI 홍보 영상</h2>
              <div className="ui-panel-content" data-help-pad=""><div className="mp-root pv-panel" /></div>
            </div>
          </article>
        </main>
      </div>
    </>);
    const surface = document.querySelector('.ui-panel-surface')!;
    const title = document.querySelector('.ui-panel-title')!;
    const content = document.querySelector('.ui-panel-content')!;
    expect(getComputedStyle(surface).display).toBe('flex');
    expect(getComputedStyle(surface).flexDirection).toBe('column');
    expect(getComputedStyle(title).position).toBe('static');
    expect(title.nextElementSibling).toBe(content);
    expect(getComputedStyle(content).position).toBe('static');
    expect(getComputedStyle(content).inset).toBe('auto');
    expect(getComputedStyle(content).paddingTop).toBe('0px');
    expect(getComputedStyle(document.querySelector('.pv-panel')!).paddingTop).toBe('0px');
  });
});

describe('T-212l performance fitting regressions', () => {
  it('measures all newly mounted metric blocks before running the panel fit', () => {
    const measured: string[] = [];
    let firstFitMeasurements: string[] | undefined;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('mp-block__value')) measured.push(this.textContent ?? '');
      return 240;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? 100 : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('ui-panel-content') && !firstFitMeasurements) firstFitMeasurements = [...measured];
      return 100;
    });
    renderWithKit(<div className="ui-panel-content"><MarketingPerformancePanel featureId="marketing-performance" condition={{ kind: 'default' }} width={2} height={1} shape="W" presetId="A" editing={false} host={makeHost()} /></div>);
    const perf = cafeModel('marketing-performance');
    expect(firstFitMeasurements).toEqual(expect.arrayContaining([`${perf.rate}%`, manText(perf.revenue.total)]));
  });

  it('gives a single performance block the full grid width', () => {
    render(<><style>{css}</style><div className="mp-wblocks" data-count="1"><div className="mp-wblocks__blocks" /></div></>);
    expect(getComputedStyle(document.querySelector('.mp-wblocks')!).getPropertyValue('--mp-count').trim()).toBe('1');
  });

  it('keeps the best channel and its action when the strip needs to drop a supplementary line', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? 100 : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('ui-panel-content')) return 0;
      return this.querySelector('.mp-strip__top:not([data-fit-hidden])') ? 104 : 100;
    });
    renderWithKit(<div className="ui-panel-content"><MarketingPerformancePanel featureId="marketing-performance" condition={{ kind: 'default' }} width={4} height={1} shape="W" presetId="A" editing={false} host={makeHost()} /></div>);
    expect(document.querySelector('.mp-strip__top')).toHaveAttribute('data-fit-hidden');
    expect(document.querySelector('.mp-strip__best')).not.toHaveAttribute('data-fit-hidden');
    expect(document.querySelector('.mp-best__value')).not.toHaveAttribute('data-fit-hidden');
    expect(document.querySelector('.mp-strip__best button')?.closest('[data-fit-hidden]')).toBeNull();
  });
});


describe('T-212o panel content padding', () => {
  it.each([2, 3])('places the %sx1 performance action alongside the blocks at normal text size', width => {
    render(<><style>{css}</style><div className="mp-wblocks" data-large="false" data-width={width}><div className="mp-wblocks__blocks" /><div className="ui-panel-action-slot" /></div></>);
    expect(getComputedStyle(document.querySelector('.mp-wblocks')!).display).toBe('grid');
    expect(getComputedStyle(document.querySelector('.mp-wblocks__blocks')!).alignSelf).toBe('start');
    expect(getComputedStyle(document.querySelector('.ui-panel-action-slot')!).alignSelf).toBe('end');
  });

  it.each([100, 125])('uses the compact video gap at text scale %s', scale => {
    render(<><style>{promoCss}</style><div className="ui-root" data-text-scale={scale}><div className="ui-feature-panel" data-shape="Q"><div className="pv-panel" /></div></div></>);
    expect(getComputedStyle(document.querySelector('.pv-panel')!).gap).toBe(scale === 125 ? 'var(--space-1)' : 'var(--space-2)');
  });

  it('preserves the wide video gap at large text size', () => {
    render(<><style>{promoCss}</style><div className="ui-root" data-text-scale="125"><div className="ui-feature-panel" data-shape="W"><div className="pv-panel pv-panel--wide" /></div></div></>);
    expect(getComputedStyle(document.querySelector('.pv-panel')!).gap).toBe('var(--space-4)');
  });

  it('drops the compact today sentence one size on overflow and restores it when space returns', () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { observers.push(cb); } observe() {} disconnect() {} });
    let tight = true;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? 100 : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('ui-panel-content')) return 0;
      return tight && this.querySelector('.mp-slot__big:not([data-fit-hidden])') ? 120 : 100;
    });
    renderWithKit(<div className="ui-panel-content"><MarketingTodayPanel featureId="marketing-today" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={makeHost()} /></div>, { locale: 'en' });
    const marker = document.querySelector('.mp-slot__big');
    expect(marker).toHaveAttribute('hidden');
    expect(marker).toHaveAttribute('data-fit-hidden');
    expect(document.querySelector('.mp-slot__first')).toBeVisible();
    tight = false;
    act(() => { observers.forEach(cb => cb([], {} as ResizeObserver)); });
    expect(marker).not.toHaveAttribute('data-fit-hidden');
  });


  it('switches the compact sentence from section to body when its fit marker is dropped', () => {
    const view = render(<><style>{css}</style><div className="mp-today" data-slots="1" data-w="1" data-h="1"><section className="mp-slot"><span className="mp-slot__big" hidden /><p className="mp-slot__text">sentence</p></section></div></>);
    const text = view.container.querySelector('.mp-slot__text')!;
    expect(getComputedStyle(text).fontSize).toBe('var(--type-section)');
    view.container.querySelector('.mp-slot__big')!.setAttribute('data-fit-hidden', '');
    expect(getComputedStyle(text).fontSize).toBe('var(--type-body)');
  });

  it('only offers the today size step for 1x1 at 100% text', () => {
    const panel = (width: 1 | 2) => <MarketingTodayPanel featureId="marketing-today" condition={{ kind: 'default' }} width={width} height={1} shape={width === 1 ? 'Q' : 'W'} presetId="A" editing={false} host={makeHost()} />;
    const large = renderWithKit(panel(1), { textScale: 125 });
    expect(large.container.querySelector('.mp-slot__big')).toBeNull();
    large.unmount();
    const wide = renderWithKit(panel(2));
    expect(wide.container.querySelector('.mp-slot__big')).toBeNull();
  });
});
