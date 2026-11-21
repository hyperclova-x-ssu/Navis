import './test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricFit, chooseMetricStage, heroMetricSize } from './components/metric-fit';
import { FeaturePanel } from './components/card';
import { UiProvider } from './UiProvider';
import { screenPresets } from '../layout';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const measure = (text: string, px: number) => [...text].length * px * 0.6;

describe('MetricFit unit before value', () => {
  it('keeps the stage thresholds based on value plus gap plus unit', () => {
    expect(chooseMetricStage({ width: 260, text: '1,284,000', unit: '₩', textScale: 125, measure })).toBe(1);
    expect(chooseMetricStage({ width: 200, text: '1,284,000', unit: '₩', textScale: 125, measure })).toBe(2);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(260);
    render(<MetricFit value="1,284,000" unit="₩" unitPlacement="before" measure={measure}/>);
    expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage', '0');
  });
  it('exposes the prefix as one uninterrupted accessible text with unit first in the DOM', () => {
    render(<button><MetricFit value="1,284,000" unit="₩" unitPlacement="before"/></button>);
    const metric = document.querySelector('.ui-metric-fit')!;
    expect(metric).toHaveAttribute('data-unit-placement', 'before');
    expect([...metric.children].map(child => child.className)).toEqual(['ui-metric-fit__unit', 'ui-metric-fit__value']);
    expect(metric.textContent).toBe('₩1,284,000');
    expect(screen.getByRole('button')).toHaveAccessibleName('₩1,284,000');
  });
  it('measures the larger management metric and scales it down when needed', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    render(<div className="ui-root" data-theme="light"><div className="dashboard-screen" data-layer="management"><MetricFit value="1234" unit="개" measure={measure}/></div></div>);
    expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage', '1');
  });
  it('keeps the same management number fit in both themes', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    const content = <div className="dashboard-screen" data-layer="management"><MetricFit value="1234" unit="개" measure={measure}/></div>;
    const view = render(<UiProvider screenPreset={screenPresets.A} theme="light">{content}</UiProvider>);
    expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage', '1');
    view.rerender(<UiProvider screenPreset={screenPresets.A} theme="dark">{content}</UiProvider>);
    expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage', '1');
  });
  it('keeps the default unit after the value', () => {
    render(<MetricFit value="128.4" unit="만원"/>);
    const metric = document.querySelector('.ui-metric-fit')!;
    expect([...metric.children].map(child => child.textContent)).toEqual(['128.4', '만원']);
  });
  it('visually places the unit below the value in stage 2 and explicitly stacked layouts while preserving text order', () => {
    const css = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = [...css.matchAll(/([^{}]*\.ui-metric-fit[^{}]*)\{([^{}]*)\}/g)].map(match => `${match[1]}{${match[2]}}`).join('\n');
    document.head.append(style);
    try {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
      const view = render(<MetricFit value="1,284,000" unit="₩" unitPlacement="before" measure={measure}/>);
      const metric = document.querySelector('.ui-metric-fit')!;
      expect(metric).toHaveAttribute('data-stage', '2');
      expect(getComputedStyle(metric).flexDirection).toBe('column');
      expect(getComputedStyle(metric.querySelector('.ui-metric-fit__unit')!).order).toBe('1');
      expect(metric.textContent).toBe('₩1,284,000');
      view.rerender(<MetricFit value="1" unit="₩" unitPlacement="before" stacked measure={measure}/>);
      expect(getComputedStyle(metric).flexDirection).toBe('column');
      expect(getComputedStyle(metric.querySelector('.ui-metric-fit__unit')!).order).toBe('1');
    } finally { style.remove(); }
  });
});

it.each([
  ['A',100,1,52,56], ['B',100,1,77,83],
  ['A',125,1,55,59], ['B',125,1,65,70],
  ['A',100,2,79,85.32], ['B',125,2,98.75,106.65],
] as const)('DS 19.2 uses %s / %s%% / %s row number budget', (preset,textScale,height,size,leading) => {
  expect(heroMetricSize({preset,textScale,height})).toEqual({size,leading});
});
it('fits a payment hero down to display size without stacking the unit', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(456);
  render(<MetricFit value="123,456,789" unit="원" presentation="payment" measure={measure}/>);
  expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage','1');
  expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-presentation','payment');
});

it.each(['light','dark'] as const)('uses the one-row marketing budget in %s mode before applying width fallback', theme => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  render(<UiProvider screenPreset={screenPresets.A} theme={theme} textScale={125}><main className="dashboard-screen" data-layer="marketing"><FeaturePanel featureId="customer-groups" label="손님 그룹" groupId="customers" width={1} height={1}><MetricFit value="123" unit="명" minStage={1} measure={measure}/></FeaturePanel></main></UiProvider>);
  expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage','0');
  expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-presentation','hero');
});
