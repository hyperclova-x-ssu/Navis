import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { FitList, PrimaryMetric } from './shared';
import { widgets } from './index';
import { makeHost } from '../mkt-promo/test-helpers';
import { readFileSync } from 'node:fs';
const css = readFileSync('src/features/widgets/mkt-local/widget.css', 'utf8');

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('W4 local fitting', () => {
  it('does not discard rows in a column because another column temporarily overflows (C1)', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? 120 : 60; });
    render(<div className="ui-panel-content"><FitList items={[<li key="a">a</li>, <li key="b">b</li>]} label="rows" slot="rows" resetKey="same" /></div>);
    expect(document.querySelectorAll('li')).toHaveLength(2);
  });

  it('fits rows after supporting text, restores them on resize and matches a fresh render (C1)', () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { observers.push(cb); } observe() {} disconnect() {} });
    let room = 50;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? room : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('ui-panel-content')) return 0;
      return 30 + this.querySelectorAll('.mkt-row:not([data-fit-hidden])').length * 20;
    });
    const body = <div className="ui-panel-content"><PrimaryMetric id="trade-area" shape="W" label="label" value="3" unit="" /><FitList items={[<li key="a" className="mkt-row">a</li>, <li key="b" className="mkt-row">b</li>]} label="rows" slot="rows" resetKey="same" /></div>;
    const view = renderWithKit(body);
    expect(document.querySelectorAll('.mkt-row:not([data-fit-hidden])')).toHaveLength(1);
    room = 100;
    act(() => { observers.forEach(cb => cb([], {} as ResizeObserver)); });
    expect(document.querySelectorAll('.mkt-row:not([data-fit-hidden])')).toHaveLength(2);
    const restored = document.querySelector('.ui-panel-content')!.innerHTML;
    view.unmount();
    renderWithKit(body);
    expect(document.querySelector('.ui-panel-content')!.innerHTML).toBe(restored);
  });

  it('never clamps a small metric label (C5)', () => {
    renderWithKit(<PrimaryMetric id="community" shape="Q" label="응답 대기 제안" value="2" unit="건" />, { textScale: 125 });
    expect(document.querySelector('.mkt-label')).not.toHaveAttribute('data-clamp');
  });

  it('drops support and row sublines before extra rows, and keeps the metric label until then (C1)', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? 50 : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('ui-panel-content')) return 0;
      const visible = (selector: string) => [...this.querySelectorAll(selector)].filter(el => !el.closest('[data-fit-hidden]')).length;
      return 20 + visible('.mkt-label') * 10 + visible('.mkt-secondary') * 10 + visible('.mkt-row') * 20 + visible('.mkt-row__sub') * 10;
    });
    renderWithKit(<div className="ui-panel-content"><PrimaryMetric id="community" shape="T" label="label" value="2" unit="" secondary="support" /><FitList items={['a', 'b'].map(key => <li key={key} className="mkt-row">{key}<span className="mkt-row__sub">sub</span></li>)} label="rows" slot="rows" resetKey="same" /></div>);
    expect(document.querySelector('.mkt-secondary')).toHaveAttribute('data-fit-hidden');
    expect(document.querySelector('.mkt-row .mkt-row__sub')).toHaveAttribute('data-fit-hidden');
    expect(document.querySelectorAll('.mkt-row:not([data-fit-hidden])')).toHaveLength(1);
    expect(document.querySelector('.mkt-label')).not.toHaveAttribute('data-fit-hidden');
  });

  it('keeps the send-failure note as a badge in edit mode and restores its sentence on exit (C7)', () => {
    const Panel = widgets.find(widget => widget.id === 'ai-response')!.Panel;
    const props = { featureId: 'ai-response', condition: { kind: 'default' }, width: 2, height: 2, shape: 'S', presetId: 'A', host: makeHost() } as const;
    const options = { modules: widgets, preview: { family: 'normal', overrides: { 'ai-response': 'send-failure' } } } as const;
    const view = renderWithKit(<Panel {...props} editing />, options);
    expect(document.querySelector('.mkt-panel-note .ui-status-badge')).not.toBeNull();
    expect(document.querySelector('.mkt-panel-note .ui-sr-only')).not.toBeNull();
    view.rerender(<Panel {...props} editing={false} />);
    expect(document.querySelector('.mkt-panel-note .ui-sr-only')).toBeNull();
  });

  it('marks Korean fallback labels on English screens without relabeling translated labels (R-13)', () => {
    renderWithKit(<><PrimaryMetric id="community" shape="Q" label="응답 대기" value="2" unit="" /><PrimaryMetric id="trade-area" shape="W" label="Foot traffic" value="3" unit="" /></>, { locale: 'en' });
    const labels = document.querySelectorAll('.mkt-label');
    expect(labels[0]).toHaveAttribute('lang', 'ko');
    expect(labels[1]).not.toHaveAttribute('lang');
  });
});

describe('W4 local text rules', () => {
  it('leaves state messages and customer excerpts at their natural height (C3/C4)', () => {
    render(<><style>{css}</style><div className="mkt-state"><p className="ui-panel-state__message">상태 문구</p></div><span className="mkt-row__title">손님 메시지</span></>);
    for (const el of document.querySelectorAll('.ui-panel-state__message, .mkt-row__title')) {
      const style = getComputedStyle(el);
      expect(style.getPropertyValue('-webkit-line-clamp')).toBe('');
      expect(style.overflow).not.toBe('hidden');
      expect(style.flexShrink).toBe('0');
    }
  });
});
