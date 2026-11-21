import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenPresets } from '../../layout/presets';
import { naturalTextDetailHeight, observeTextDetailHeight } from '../../ui/text-detail-layout';
import { compactFrameHeight, detailFrameStyle, textDetailFrame } from './compact-layout';

afterEach(() => { document.body.replaceChildren(); });

describe('R4 text detail frames', () => {
  it.each([
    [28, 48, 72, 300.5, 0, 462.5],
    [28, 48, 72, 300.5, 24, 510.5],
    [140, 48, 72, 700.25, 30, 984.25],
    [35, 48, 88, 350, 60, 612],
  ])('measures real computed chrome and content without including the canvas scale', (title, close, header, body, note, expected) => {
    const surface = document.createElement('div');
    surface.style.cssText = 'padding:32px;border:1px solid;display:flex;gap:24px;transform:scale(.5)';
    const head = document.createElement('header'); head.className = 'ui-overlay-header'; head.style.minHeight = `${header}px`;
    for (const [className, height] of [['ui-dialog-title', title], ['ui-button--icon', close]] as const) {
      const node = document.createElement('div'); node.className = className; node.style.height = `${height}px`; head.append(node);
    }
    surface.append(head);
    for (const [className, height] of [['detail-module-body', body], ['ui-overlay-note', note]] as const) {
      const node = document.createElement('div'); node.className = className; node.style.height = `${height}px`; surface.append(node);
    }
    document.body.append(surface);
    expect(naturalTextDetailHeight(surface)).toBe(expected);
  });
  it('measures the visible body when a linked detail retains its previous view', () => {
    const parent = document.createElement('div');
    parent.innerHTML = '<div hidden><div class="detail-module-body" style="height:900px"></div></div><div class="detail-module-body" style="height:600px"></div>';
    document.body.append(parent);
    expect(naturalTextDetailHeight(parent)).toBe(600);
  });
  it('remeasures an open window as content is replaced', async () => {
    const surface = document.createElement('div');
    surface.innerHTML = '<div class="detail-module-body" style="height:430px">Short view</div>';
    document.body.append(surface);
    const resize = vi.fn();
    const stop = observeTextDetailHeight(surface, resize);
    try {
      expect(resize).toHaveBeenLastCalledWith(430);
      surface.innerHTML = '<div class="detail-module-body" style="height:720px">Expanded view</div>';
      await vi.waitFor(() => expect(resize).toHaveBeenLastCalledWith(720));
      surface.innerHTML = '<div class="detail-module-body" style="height:430px">Short view</div>';
      await vi.waitFor(() => expect(resize).toHaveBeenLastCalledWith(430));
    } finally {
      stop();
    }
  });
  // D-326 Q15: a widget's own scroller (the briefing list) shows less than it holds; the window must grow for what it hides.
  it('adds the content an inner scroller hides, once for the outermost scroller only', () => {
    const surface = document.createElement('div');
    surface.style.cssText = 'padding:32px;border:1px solid;display:flex;gap:24px';
    const head = document.createElement('header'); head.className = 'ui-overlay-header'; head.style.minHeight = '72px';
    surface.append(head);
    const body = document.createElement('div'); body.className = 'detail-module-body'; body.style.height = '558px';
    const tabs = document.createElement('div'); tabs.style.height = '81px';
    const scroller = document.createElement('div'); scroller.style.overflowY = 'auto';
    const inner = document.createElement('div'); inner.style.overflowY = 'auto';
    scroller.append(inner); body.append(tabs, scroller); surface.append(body);
    document.body.append(surface);
    const metrics = (node: HTMLElement, scrollHeight: number, clientHeight: number) => {
      Object.defineProperty(node, 'scrollHeight', { configurable: true, value: scrollHeight });
      Object.defineProperty(node, 'clientHeight', { configurable: true, value: clientHeight });
    };
    const fits = naturalTextDetailHeight(surface);
    expect(fits).toBe(66 + 72 + 24 + 558);
    metrics(scroller, 1980, 477);
    metrics(inner, 900, 300);
    expect(naturalTextDetailHeight(surface)).toBe(fits + (1980 - 477));
  });
  it('grows a briefing-like window with its hidden content up to the maximum, never past it', () => {
    const limits = { width: 960, minHeight: 720, largeTextMinHeight: 720, maxHeight: 952 };
    expect(textDetailFrame(screenPresets.A, limits, 100, 66 + 72 + 24 + 558 + (1980 - 477))).toEqual({ x: 480, y: 64, width: 960, height: 952 });
    expect(textDetailFrame(screenPresets.A, limits, 100, 600)).toEqual({ x: 480, y: 180, width: 960, height: 720 });
  });
  it.each([
    ['A', 100, 200, 480, 316, 960, 448], ['B', 100, 200, 760, 496, 1040, 448],
    ['A', 125, 200, 480, 284, 960, 512], ['B', 125, 200, 760, 464, 1040, 512],
    ['A', 100, 514.5, 480, 282.75, 960, 514.5], ['B', 125, 630.5, 760, 404.75, 1040, 630.5],
    ['A', 100, 2000, 480, 64, 960, 952], ['B', 125, 2000, 760, 96, 1040, 1248],
  ] as const)('%s/%s centers natural height %s within its permitted bounds', (id, scale, naturalHeight, x, y, width, height) => {
    const limits = { width: id === 'A' ? 960 : 1040, minHeight: 448, largeTextMinHeight: 512, maxHeight: id === 'A' ? 952 : 1248 };
    expect(textDetailFrame(screenPresets[id], limits, scale, naturalHeight)).toEqual({ x, y, width, height });
  });
});

describe('U-D detail frame style (the frame follows the open widget, never the previous one)', () => {
  const limits = { width: 960, minHeight: 448, largeTextMinHeight: 512, maxHeight: 952 };
  it('gives a large or fullscreen detail no inline frame at all, so the stylesheet frame applies', () => {
    expect(detailFrameStyle(false, false, limits, 100, 720)).toEqual({});
    expect(detailFrameStyle(false, false, limits, 125, 720)).toEqual({});
    expect(detailFrameStyle(true, true, limits, 100, 720)).toEqual({});
  });
  it('gives a compact detail its own width, measured height and 100% / 125% limits', () => {
    expect(detailFrameStyle(true, false, limits, 100, 500)).toEqual({ width: 960, height: 500, minHeight: 448, maxHeight: 952 });
    expect(detailFrameStyle(true, false, limits, 125, 600)).toEqual({ width: 960, height: 600, minHeight: 512, maxHeight: 952 });
  });
  it('restarts from the minimum whenever the frame identity differs from the measured one', () => {
    expect(compactFrameHeight(null, 'briefing|A|100', limits, 100)).toBe(448);
    expect(compactFrameHeight({ key: 'briefing|A|100', height: 720 }, 'briefing|A|100', limits, 100)).toBe(720);
    // another widget, another preset or another text size never inherits the last compact height
    expect(compactFrameHeight({ key: 'briefing|A|100', height: 720 }, 'local-trends|A|100', limits, 100)).toBe(448);
    expect(compactFrameHeight({ key: 'briefing|A|100', height: 720 }, 'briefing|A|125', limits, 125)).toBe(512);
  });
});
