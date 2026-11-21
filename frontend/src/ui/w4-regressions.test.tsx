import { StrictMode, useLayoutEffect, useRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import './test-setup';
import { I18nProvider } from '../i18n';
import type { Locale, ScreenPreset } from '../contracts';
import { screenPresets } from '../layout/presets';
import { UiProvider } from './UiProvider';
import { CoachMark } from './components/overlays';
import { EmptyStartOption } from './components/onboarding';
import { FeaturePanel } from './components/card';
import { MetricFit } from './components/metric-fit';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('reads the new root font size in descendant layout effects on the same 100→125→100 commit', () => {
  const reads: { scale: number; font: string }[] = [];
  function Fitter({ scale }: { scale: 100 | 125 }) {
    useLayoutEffect(() => { reads.push({ scale, font: getComputedStyle(document.documentElement).fontSize }); }, [scale]);
    return null;
  }
  const tree = (scale: 100 | 125) => <StrictMode><UiProvider screenPreset={screenPresets.A} textScale={scale}><Fitter scale={scale}/></UiProvider></StrictMode>;
  const view = render(tree(100));
  reads.length = 0;
  view.rerender(tree(125));
  expect(reads).toEqual([{ scale: 125, font: '20px' }]);
  reads.length = 0;
  view.rerender(tree(100));
  expect(reads).toEqual([{ scale: 100, font: '16px' }]);
});

it('restores the pre-mount root font only on unmount, without clearing it during scale updates', () => {
  const root = document.documentElement;
  const before = root.style.fontSize;
  root.style.fontSize = '18px';
  const writes: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(root.style), 'fontSize')!;
  vi.spyOn(root.style, 'fontSize', 'set').mockImplementation(value => { writes.push(value); descriptor.set!.call(root.style, value); });
  const view = render(<UiProvider screenPreset={screenPresets.A} textScale={100}>내용</UiProvider>);
  writes.length = 0;
  view.rerender(<UiProvider screenPreset={screenPresets.A} textScale={125}>내용</UiProvider>);
  try {
    expect(writes).toEqual(['20px']);
    view.unmount();
    expect(root.style.fontSize).toBe('18px');
  } finally { view.unmount(); root.style.fontSize = before; }
});

it('names the empty-start button with the exact SCR-203 separator', async () => {
  const start = vi.fn();
  render(<I18nProvider locale="en"><EmptyStartOption onClick={start}/></I18nProvider>);
  await userEvent.setup().click(screen.getByRole('button', { name: '빈 화면으로 시작하기, 패널을 직접 골라 놓아요' }));
  expect(start).toHaveBeenCalledTimes(1);
});

describe('R-13 panel titles', () => {
  it.each(['en', 'zh-Hans', 'zh-Hant'] satisfies Locale[])('marks Korean-only titles on %s screens, preserving translated titles', locale => {
    const view = render(<I18nProvider locale={locale}><FeaturePanel featureId="manuals" groupId="store" label="매뉴얼 작성" width={1} height={1}/></I18nProvider>);
    expect(screen.getByRole('heading', { name: '매뉴얼 작성' })).toHaveAttribute('lang', 'ko');
    view.rerender(<I18nProvider locale={locale}><FeaturePanel featureId="manuals" groupId="store" label="Manual" title="Manual" width={1} height={1}/></I18nProvider>);
    expect(screen.getByRole('heading', { name: 'Manual' })).not.toHaveAttribute('lang', 'ko');
  });
});

it('gives stacked metric units their intrinsic CSS width, bounded by their containing metric', () => {
  // jsdom cannot lay out boxes; exercise the cascade here and actual glyph/box geometry in the dev check.
  const tokenCss = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');
  const style = document.createElement('style');
  style.textContent = [...tokenCss.matchAll(/([^{}]*\.ui-metric-fit[^{}]*)\{([^{}]*)\}/g)].map(match => `${match[1]}{${match[2]}}`).join('\n');
  document.head.append(style);
  try {
    render(<FeaturePanel featureId="manuals" groupId="store" label="매뉴얼 작성" width={1} height={1}><MetricFit value="3" unit="개 항목"/></FeaturePanel>);
    const unit = screen.getByText('개 항목');
    const unitRule = [...style.sheet!.cssRules].filter((rule): rule is CSSStyleRule => 'selectorText' in rule && unit.matches((rule as CSSStyleRule).selectorText)).find(rule => rule.style.width === 'max-content');
    expect(unitRule).toBeDefined();
    expect(getComputedStyle(unit).maxWidth).toBe('100%');
    expect(getComputedStyle(unit).flexShrink).toBe('0');
  } finally { style.remove(); }
});

type Box = { x: number; y: number; width: number; height: number };
const bounds = (box: Box): DOMRect => ({ ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box });
function BlockedCoach({ target, obstacles }: { target: Box; obstacles: { box: Box; className: string }[] }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return <UiProvider screenPreset={screenPresets.A} reducedMotion>
    <button ref={anchor} data-test-rect={JSON.stringify(target)}>대상</button>
    {obstacles.map((obstacle, i) => <button key={i} className={obstacle.className} data-test-rect={JSON.stringify(obstacle.box)}>조작 {i + 1}</button>)}
    <CoachMark open anchorRef={anchor} coachStep="choose-feature" onClose={() => {}}>안내</CoachMark>
  </UiProvider>;
}
function measureBlockedCoach() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return bounds(JSON.parse(this.dataset.testRect ?? '{"x":0,"y":0,"width":0,"height":0}') as Box);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(142);
}
function CoachFixture({ preset, close, help = true }: { preset: ScreenPreset; close: () => void; help?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return <UiProvider screenPreset={preset} reducedMotion>
    <div className="dashboard-rail"><button ref={anchor} className="ui-rail-item">추천</button></div>
    {help ? <button className="ui-help-button" aria-label="예약 설명 보기">?</button> : null}
    <CoachMark open anchorRef={anchor} coachStep="choose-feature" onClose={close}>필요한 기능을 여기서 눌러 추가해요</CoachMark>
  </UiProvider>;
}
function measureCoach(preset: ScreenPreset) {
  const rightShift = preset.baselineWidth - 1920;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('ui-rail-item')) return bounds({ x: 1816 + rightShift, y: 129, width: 72, height: 72 });
    if (this.classList.contains('dashboard-rail')) return bounds({ x: 1808 + rightShift, y: 24, width: 88, height: preset.baselineHeight - 48 });
    if (this.classList.contains('ui-help-button')) return bounds({ x: 1736 + rightShift, y: 120, width: 48, height: 48 });
    return bounds({ x: 0, y: 0, width: preset.baselineWidth, height: preset.baselineHeight });
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
  // Exact reported A candidate: (1404, 94, 400, 142).
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(142);
}
describe('coach placement fallback', () => {
  it('finds and closes the note by its English preview names', async () => {
    measureCoach(screenPresets.A);
    const close = vi.fn();
    render(<I18nProvider locale="en"><CoachFixture preset={screenPresets.A} close={close}/></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('note', { name: 'Tip' })).toBeVisible());
    await userEvent.setup().click(screen.getByRole('button', { name: 'OK' }));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it.each([screenPresets.A, screenPresets.B])('keeps coach #1 visible and dismissible despite the reservation help button ($id)', async preset => {
    measureCoach(preset);
    const close = vi.fn();
    render(<CoachFixture preset={preset} close={close}/>);
    const popup = screen.getByRole('note', { name: '안내' });
    await waitFor(() => expect(popup).toBeVisible());
    const positioner = popup.closest('.ui-coach-positioner')!;
    expect(positioner).toHaveStyle({ visibility: 'visible', left: `${1404 + preset.baselineWidth - 1920}px`, top: '94px' });
    expect(positioner).toHaveAttribute('data-coach-side', 'left');
    await userEvent.setup().click(screen.getByRole('button', { name: '확인' }));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('keeps the existing preferred placement when it is unobstructed', () => {
    measureCoach(screenPresets.A);
    render(<CoachFixture preset={screenPresets.A} close={() => {}} help={false}/>);
    expect(document.querySelector('.ui-coach-positioner')).toHaveStyle({ left: '1404px', top: '94px', visibility: 'visible' });
  });
  it.each([
    { name: 'least total overlap', leftClass: 'ui-panel-remove', leftWidth: 100, bottomClass: 'ui-panel-remove', bottomWidth: 10, side: 'bottom', x: 836, y: 584 },
    { name: 'help lower priority than even a small essential control', leftClass: 'ui-help-button', leftWidth: 100, bottomClass: 'ui-panel-remove', bottomWidth: 1, side: 'left', x: 588, y: 465 },
    { name: 'least help overlap when essential scores tie', leftClass: 'ui-help-button', leftWidth: 100, bottomClass: 'ui-help-button', bottomWidth: 10, side: 'bottom', x: 836, y: 584 },
  ])('chooses $name', ({ leftClass, leftWidth, bottomClass, bottomWidth, side, x, y }) => {
    measureBlockedCoach();
    render(<BlockedCoach target={{ x: 1000, y: 500, width: 72, height: 72 }} obstacles={[
      { className: leftClass, box: { x: 590, y: 470, width: leftWidth, height: 100 } },
      { className: bottomClass, box: { x: 1000, y: 600, width: bottomWidth, height: 10 } },
      { className: 'ui-panel-resize', box: { x: 840, y: 350, width: 40, height: 40 } },
      { className: 'ui-edit-toolbar', box: { x: 1090, y: 470, width: 40, height: 40 } },
    ]}/>);
    const positioner = document.querySelector('.ui-coach-positioner');
    expect(positioner).toHaveAttribute('data-coach-side', side);
    expect(positioner).toHaveStyle({ left: `${x}px`, top: `${y}px`, visibility: 'visible' });
  });
  it('clamps an edge placement inside the canvas while keeping its target uncovered', () => {
    measureBlockedCoach();
    render(<BlockedCoach target={{ x: 24, y: 24, width: 72, height: 72 }} obstacles={[
      { className: 'ui-help-button', box: { x: 24, y: 108, width: 400, height: 142 } },
      { className: 'ui-panel-remove', box: { x: 108, y: 24, width: 400, height: 142 } },
    ]}/>);
    // Clamping the preferred left/top candidates would cover the target.
    expect(document.querySelector('.ui-coach-positioner')).toHaveStyle({ left: '24px', top: '108px', visibility: 'visible' });
    expect(document.querySelector('.ui-coach-positioner')).toHaveAttribute('data-coach-side', 'bottom');
  });
});
