import { afterEach, describe, expect, it, vi } from 'vitest';
import { editClashCount, fitScore, runFit } from './fit';

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function build(editing: boolean) {
  document.body.innerHTML = `<article class="ui-feature-panel" data-editing="${editing}"><div class="ui-panel-remove"></div><div class="ui-panel-content"><span class="num ui-metric-fit">3</span><p class="sub">note</p></div></article>`;
  const panel = document.querySelector('.ui-feature-panel')!;
  const remove = panel.querySelector<HTMLElement>('.ui-panel-remove')!;
  const content = panel.querySelector<HTMLElement>('.ui-panel-content')!;
  remove.getBoundingClientRect = () => rect(8, 8, 56, 56);
  return { content, sub: content.querySelector<HTMLElement>('.sub')!, num: content.querySelector<HTMLElement>('.num')! };
}

const mockLines = (lines: (text: string) => DOMRect) => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value(this: Range) { return [lines(this.toString())] as unknown as DOMRectList; } });
};
afterEach(() => { delete (Range.prototype as { getClientRects?: unknown }).getClientRects; vi.restoreAllMocks(); });

describe('edit-mode button clearance (T-063)', () => {
  it.each([
    ['inert', 'inert', 0],
    ['data-hidden', 'data-hidden="true"', 0],
    ['visible', 'data-hidden="false"', 1],
  ])('counts %s action text only when visible', (_name, attribute, expected) => {
    document.body.innerHTML = `<article class="ui-feature-panel" data-editing="true"><div class="ui-panel-resize"></div><div class="ui-panel-content"><div ${attribute}><button><span>Action</span></button></div></div></article>`;
    const handle = document.querySelector<HTMLElement>('.ui-panel-resize')!;
    const content = document.querySelector<HTMLElement>('.ui-panel-content')!;
    handle.getBoundingClientRect = () => rect(8, 8, 56, 56);
    mockLines(() => rect(20, 20, 50, 40));

    expect(editClashCount(content)).toBe(expected);
    expect(fitScore(content)).toBe(expected * 1000);
  });

  it('counts a key number closer than 8px to the remove button, and only in edit mode', () => {
    mockLines((text) => (text === '3' ? rect(17, 60, 45, 104) : rect(17, 120, 100, 140)));
    expect(editClashCount(build(true).content)).toBe(1);
    expect(editClashCount(build(false).content)).toBe(0);
  });

  it('hides the next droppable part while text still touches a button, then stops', () => {
    mockLines((text) => (text === 'note' ? rect(17, 40, 100, 60) : rect(17, 200, 45, 240)));
    const { content, sub } = build(true);
    Object.defineProperty(content, 'clientHeight', { value: 100, configurable: true });
    // the note touches the remove button; the key number is far away. Hiding the note clears the clash.
    expect(runFit(content, [{ selector: '.sub' }])).toBe(1);
    expect(sub.hasAttribute('data-fit-hidden')).toBe(true);
  });

  it('shows everything again when dropping cannot fix the overflow (a wide key number never removes parts that fit)', () => {
    mockLines(() => rect(300, 200, 340, 220));
    const { content, sub } = build(false);
    Object.defineProperty(content, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(content, 'clientWidth', { value: 200, configurable: true });
    Object.defineProperty(content, 'scrollWidth', { value: 205, configurable: true });
    expect(runFit(content, [{ selector: '.sub' }])).toBe(0);
    expect(sub.hasAttribute('data-fit-hidden')).toBe(false);
  });

  it('gives back dropped parts that were not needed once the layout fits', () => {
    mockLines(() => rect(300, 200, 340, 220));
    document.body.innerHTML = '<article class="ui-feature-panel"><div class="ui-panel-content"><p class="a">a</p><p class="b">b</p></div></article>';
    const content = document.querySelector<HTMLElement>('.ui-panel-content')!;
    const a = content.querySelector<HTMLElement>('.a')!;
    const b = content.querySelector<HTMLElement>('.b')!;
    Object.defineProperty(content, 'clientHeight', { value: 100, configurable: true });
    // only part `a` is the problem: while it is visible the content is 20px too tall
    Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => (a.hasAttribute('data-fit-hidden') ? 100 : 121) });
    runFit(content, [{ selector: '.b' }, { selector: '.a' }]);
    expect(a.hasAttribute('data-fit-hidden')).toBe(true);
    expect(b.hasAttribute('data-fit-hidden')).toBe(false);
  });
});

it('drops essential secondary text, then the label after the other money parts', async () => {
  const { MONEY_FIT } = await import('./shared');
  const selectors = MONEY_FIT.map(part => part.selector);
  expect(selectors.slice(-2)).toEqual(['.mm-sub--essential', '.mm-label']);
});

it('keeps sentence values 8px from the edit handle', () => {
  mockLines(text => text === '3' ? rect(17, 60, 45, 104) : rect(17, 120, 100, 140));
  const { content, num } = build(true);
  num.className = 'mm-text-value';
  expect(editClashCount(content)).toBe(1);
});

it('measures the badge box, including its padding, with 8px handle clearance', () => {
  mockLines(() => rect(70, 120, 100, 140));
  const { content, sub } = build(true);
  sub.className = 'ui-status-badge';
  sub.getBoundingClientRect = () => rect(60, 20, 130, 48);
  expect(editClashCount(content)).toBe(1);
  sub.getBoundingClientRect = () => rect(64, 20, 134, 48);
  expect(editClashCount(content)).toBe(0);
});

it('measures slot overflow in the same coordinate space during a scaled panel entrance', () => {
  document.body.innerHTML = '<div class="ui-panel-content"><div class="ui-panel-body"><div class="primary"></div><div class="list"></div></div></div>';
  const content = document.querySelector<HTMLElement>('.ui-panel-content')!;
  const body = content.querySelector<HTMLElement>('.ui-panel-body')!;
  const primary = content.querySelector<HTMLElement>('.primary')!;
  const list = content.querySelector<HTMLElement>('.list')!;
  for (const el of [content, body]) Object.defineProperties(el, {clientHeight:{value:100},scrollHeight:{value:100},clientWidth:{value:200},scrollWidth:{value:200}});
  Object.defineProperties(primary,{clientHeight:{value:40},scrollHeight:{value:40}});
  Object.defineProperties(list,{clientHeight:{value:60},scrollHeight:{value:60}});
  primary.getBoundingClientRect=()=>rect(0,0,100,20);
  list.getBoundingClientRect=()=>rect(0,30,100,60);
  expect(fitScore(content)).toBe(0);
});
