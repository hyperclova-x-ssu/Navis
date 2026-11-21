import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useRef, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan, WidgetHost } from '../../../contracts';
import { panelShape } from '../../../ui/panel-layout';
import { renderWithKit } from '../../../ui/test-utils';
import { MenuPanel } from '../mgmt-products/menu';
import { CustomerAnalysisPanel } from './customer-analysis';
import { VoiceBookingPanel } from './voice-booking';
import { Bars, useFitDrop } from './shared';

const css = readFileSync('src/features/widgets/mgmt-customers/widgets.css', 'utf8');

const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: () => true };
const panelProps = { condition: { kind: 'default' as const }, host, presetId: 'A' as const, editing: false };
let resize: () => void;
let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.append(sheet);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() { /* Geometry is supplied below because jsdom has no layout. */ }
    disconnect() { /* No native observer in jsdom. */ }
  });
});
afterEach(() => { cleanup(); sheet.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function measured(node: HTMLElement, values: Record<string, () => number | HTMLElement>) {
  for (const [key, get] of Object.entries(values)) Object.defineProperty(node, key, { configurable: true, get });
}

function FitHarness({ children, measure }: { children: ReactNode; measure: (root: HTMLDivElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFitDrop(ref);
  return <div className="mc-root" ref={node => { ref.current = node; if (node) measure(node); }}>{children}</div>;
}

describe('CA-L2: drop key-block supporting lines before chart/list content', () => {
  it.each([[9, 6], [8, 6], [8, 8]] as const)('drops key-block line rank %i before optional content rank %i', (rank, otherRank) => {
    const view = render(<FitHarness measure={root => {
      const sub = root.querySelector<HTMLElement>('.mc-sub')!;
      const row = root.querySelector<HTMLElement>('li')!;
      const excess = () => sub.hidden || row.hidden ? 100 : 124;
      measured(root, { clientHeight: () => 100, scrollHeight: excess });
      const list = root.querySelector<HTMLElement>('.ui-panel-list')!;
      measured(list, { offsetParent: () => root, clientHeight: () => 100, scrollHeight: excess });
    }}><div className="ui-panel-body"><div className="ui-panel-primary"><div className="mc-kpi"><p className="mc-sub" data-drop={rank}>카메라 3대 정상</p></div></div><div className="ui-panel-list"><ul><li data-drop={otherRank}>14시대 방문 24건</li></ul></div></div></FitHarness>);
    expect(view.container.querySelector<HTMLElement>('.mc-sub')!.hidden).toBe(true);
    expect(view.container.querySelector<HTMLElement>('li')!.hidden).toBe(false);
  });

  it.each([[3, 2], [4, 2], [2, 3], [2, 4]] as const)('lets the %ix%i camera bars share the available row with the list', (width, height) => {
    const view = renderWithKit(<CustomerAnalysisPanel {...panelProps} featureId="customer-analysis" width={width} height={height} shape="L" />);
    const bars = view.container.querySelector<HTMLElement>('.mc-camera-chart .mc-bars')!;
    expect(getComputedStyle(bars).height).toBe('auto');
    expect(getComputedStyle(bars).flexGrow).toBe('1');
    // The chart may shrink, but its direct value/hour labels and track must still fit.
    expect(getComputedStyle(bars).minHeight).toBe('min-content');
    const staff = bars.querySelector<HTMLElement>('.mc-bar__sub')!;
    expect(Number(staff.dataset.drop)).toBeGreaterThan(6);
    expect(getComputedStyle(staff).height).toBe('auto');
  });
});

it('CA-SUBWRAP: hides every staff caption when one cannot fit its column and restores them on widening', () => {
  let columnWidth = 20;
  vi.spyOn(document, 'createRange').mockImplementation(() => ({ selectNodeContents: () => {}, getBoundingClientRect: () => ({ width: 75 }) }) as unknown as Range);
  const view = render(<FitHarness measure={root => {
    root.querySelectorAll<HTMLElement>('.mc-bar__sub').forEach(sub => {
      measured(sub, { clientWidth: () => columnWidth, scrollWidth: () => 75 });
      sub.getBoundingClientRect = () => ({ width: columnWidth }) as DOMRect;
    });
  }}><Bars label="Visits and staff" max={24} items={[
    { key: '14', label: '14', value: 24, display: '24', sub: '2 people' },
    { key: '15', label: '15', value: 18, display: '18', sub: '3 people' },
  ]} /></FitHarness>);
  const staff = [...view.container.querySelectorAll<HTMLElement>('.mc-bar__sub')];
  expect(staff.map(el => el.hidden)).toEqual([true, true]);
  expect(getComputedStyle(staff[0]!).whiteSpace).toBe('nowrap');
  expect(view.container.querySelectorAll('.mc-bar__display')).toHaveLength(2);
  columnWidth = 100;
  act(() => resize());
  expect(staff.map(el => el.hidden)).toEqual([false, false]);
});

it('hides all staff captions for subpixel overflow and restores them at the half-pixel boundary', () => {
  let textWidth = 38.55;
  let selected: Node | null = null;
  vi.spyOn(document, 'createRange').mockImplementation(() => ({
    selectNodeContents: (node: Node) => { selected = node; },
    getBoundingClientRect: () => ({ width: (selected as HTMLElement).textContent === '2 人' ? textWidth : 34.45 }),
  }) as unknown as Range);
  const view = render(<FitHarness measure={root => {
    root.querySelectorAll<HTMLElement>('.mc-bar__sub').forEach(sub => {
      measured(sub, { clientWidth: () => 38, scrollWidth: () => 39 });
      sub.getBoundingClientRect = () => ({ width: 37.5 }) as DOMRect;
    });
  }}><Bars label="Visits and staff" max={24} items={[
    { key: '14', label: '14', value: 24, display: '24', sub: '1 人' },
    { key: '15', label: '15', value: 18, display: '18', sub: '2 人' },
  ]} /></FitHarness>);
  const staff = [...view.container.querySelectorAll<HTMLElement>('.mc-bar__sub')];
  expect(staff.map(el => el.hidden)).toEqual([true, true]);
  textWidth = 38;
  act(() => resize());
  expect(staff.map(el => el.hidden)).toEqual([false, false]);
});

it('reserves resize-handle space only for the customer chart in edit mode', () => {
  const panel = document.createElement('div');
  panel.className = 'ui-feature-panel';
  panel.dataset.editing = 'true';
  panel.innerHTML = '<div class="mc-root" data-widget="customer-analysis"><div class="mc-camera-chart"></div></div>';
  document.body.append(panel);
  const chart = panel.querySelector<HTMLElement>('.mc-camera-chart')!;
  const paddingRules = Array.from(sheet.sheet!.cssRules).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && !!rule.style.getPropertyValue('padding-bottom'));
  const reserved = () => paddingRules.find(rule => chart.matches(rule.selectorText))?.style.getPropertyValue('padding-bottom');
  expect(reserved()).toBe('calc(var(--target-default) + var(--space-4) - var(--panel-padding))');
  panel.dataset.editing = 'false';
  expect(reserved()).toBeUndefined();
  panel.dataset.editing = 'true';
  chart.parentElement!.dataset.widget = 'voice-booking';
  expect(reserved()).toBeUndefined();
  panel.remove();
});

describe('MENU-W: keep the list in the second column of all wide one-row panels', () => {
  const sizes: readonly [CellSpan, CellSpan, string][] = [
    [1, 1, ''], [1, 2, ''], [1, 3, ''], [1, 4, ''],
    [2, 1, ''], [2, 2, ''], [2, 3, '1 / -1'], [2, 4, '1 / -1'],
    [3, 1, ''], [3, 2, '1 / -1'], [3, 3, '1 / -1'], [3, 4, '1 / -1'],
    [4, 1, ''], [4, 2, '1 / -1'], [4, 3, '1 / -1'], [4, 4, '1 / -1'],
  ];
  it.each(sizes)('%ix%i has the intended list column', (width, height, column) => {
    const view = renderWithKit(<MenuPanel {...panelProps} featureId="menu" width={width} height={height} shape={panelShape(width, height)} />);
    const list = view.container.querySelector<HTMLElement>('.ui-panel-list');
    expect(list ? getComputedStyle(list).gridColumn : '').toBe(column);
  });
});

describe('VB-CHARTROW: the list takes the flexible row and a hidden chart leaves no grid band', () => {
  const sizes: readonly [CellSpan, CellSpan][] = [
    [1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3], [2, 4],
    [3, 1], [3, 2], [3, 3], [3, 4], [4, 1], [4, 2], [4, 3], [4, 4],
  ];
  it.each(sizes)('collapses and restores the %ix%i chart wrapper', (width, height) => {
    const view = renderWithKit(<VoiceBookingPanel {...panelProps} featureId="voice-booking" width={width} height={height} shape={panelShape(width, height)} />);
    const chart = view.container.querySelector<HTMLElement>('.mc-chart-slot');
    if (height === 1) { expect(chart).toBeNull(); return; }
    const body = view.container.querySelector<HTMLElement>('.ui-panel-body')!;
    const rows = getComputedStyle(body).gridTemplateRows;
    const large = panelShape(width, height) === 'L';
    if (large) expect(rows).toBe('auto auto minmax(0, 1fr)');
    const wrapper = chart!.parentElement!;
    chart!.hidden = true;
    expect(getComputedStyle(wrapper).display).toBe('none');
    // With the chart gone the kit's two-row layout is used again, including 3x2/4x2.
    expect(getComputedStyle(body).gridTemplateRows).toBe(large ? '' : rows);
    chart!.hidden = false;
    expect(getComputedStyle(wrapper).display).not.toBe('none');
    expect(getComputedStyle(body).gridTemplateRows).toBe(rows);
  });
});

describe('MC-FONT: rerun fitting when fonts change without resizing the root', () => {
  function fonts() {
    let ready!: () => void;
    const events = new EventTarget();
    Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(events, { ready: new Promise<void>(resolve => { ready = resolve; }) }) });
    return { ready, events };
  }
  afterEach(() => { Reflect.deleteProperty(document, 'fonts'); });
  function panel() {
    let needed = 80;
    const view = render(<FitHarness measure={root => {
      measured(root, { clientHeight: () => 100, scrollHeight: () => root.querySelector<HTMLElement>('[data-drop]')!.hidden ? 60 : needed });
    }}><p data-drop="9">보조 문구</p></FitHarness>);
    return { ...view, sub: view.container.querySelector<HTMLElement>('p')!, need: (height: number) => { needed = height; } };
  }
  it('fits again after the initial cold-cache font promise resolves', async () => {
    const font = fonts(), view = panel();
    expect(view.sub.hidden).toBe(false);
    view.need(124);
    await act(async () => { font.ready(); await document.fonts.ready; });
    expect(view.sub.hidden).toBe(true);
  });
  it('drops and restores supporting content on later font loads', () => {
    const font = fonts(), view = panel();
    view.need(124);
    act(() => font.events.dispatchEvent(new Event('loadingdone')));
    expect(view.sub.hidden).toBe(true);
    view.need(80);
    act(() => font.events.dispatchEvent(new Event('loadingdone')));
    expect(view.sub.hidden).toBe(false);
  });
  it('ignores late font completion after unmounting', async () => {
    const font = fonts(), view = panel();
    view.unmount(); view.need(124);
    await act(async () => { font.ready(); await document.fonts.ready; });
    font.events.dispatchEvent(new Event('loadingdone'));
    expect(view.sub.hidden).toBe(false);
  });
});

it.each(['customer-analysis', 'voice-booking'] as const)('R-13: marks the new %s supporting copy as Korean on an English screen', id => {
  const Panel = id === 'customer-analysis' ? CustomerAnalysisPanel : VoiceBookingPanel;
  const view = renderWithKit(<Panel {...panelProps} featureId={id} width={2} height={3} shape="L" />, { locale: 'en' });
  expect(view.container.querySelector(`[data-slot="${id}.metric.secondary"]`)).toHaveAttribute('lang', 'ko');
});
