/** T-076: where the toggle sits (SCREENS 9.2 "패널 안 위치") and that the 1×1 unit stays in the DOM next to the number. jsdom has no layout: positions are checked in the browser. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { setLiveClientForTest } from '../../cctv/live/hooks';
import { resetCctvModeForTest, setCctvMode } from '../../cctv/live/mode';
import { frameHeader, zoneSet } from '../../cctv/live/testFakes';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

const host = { layer: 'management', resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) } satisfies WidgetHost;
const Panel = widgets.find((w) => w.id === 'customer-analysis')!.Panel;
const render = (w: number, h: number) => renderWithKit(<Panel featureId="customer-analysis" condition={{ kind: 'default' }} width={w as 1} height={h as 1} shape="Q" presetId="A" editing={false} host={host} />).container;
/** D-230: the 반복 5-C layout is the live panel now (mock is the 반복 5 CCTV 현황 panel). */
function goLive() {
  const snap = { connection: 'live', camera: 'live', frame: frameHeader(), bitmap: null, zones: zoneSet(), zonesAspectMismatch: false, e2eMs: null };
  setLiveClientForTest({ getSnapshot: () => snap, subscribe: () => () => undefined, acquire: () => () => undefined, retry: vi.fn(), notePaired: vi.fn() } as never);
  setCctvMode('live');
}
afterEach(() => { cleanup(); setLiveClientForTest(null); resetCctvModeForTest(); });

describe('panel layout hooks', () => {
  it('1×1: the number and its unit 명 come before the toggle, which is the last thing in the panel', () => {
    goLive();
    const c = render(1, 1);
    const root = c.querySelector('.cc-root')!;
    expect(root).toHaveClass('cc-root--Q');
    expect(c.querySelector('.cc-head')).toBeNull();
    expect(c.querySelector('[data-slot="customer-analysis.metric.value"]')).toHaveTextContent(/\d\s*명/);
    const toggle = root.querySelector('.cc-toggle--q')!;
    expect(toggle.compareDocumentPosition(root.querySelector('.cc-body')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
  it('2×1 and 2×2: the toggle is placed on the title row; 1×2 keeps it in the body', () => {
    goLive();
    expect(render(2, 1).querySelector('.cc-head')).toHaveClass('cc-head--title');
    cleanup();
    expect(render(2, 2).querySelector('.cc-head')).toHaveClass('cc-head--title');
    cleanup();
    expect(render(1, 2).querySelector('.cc-head')).not.toHaveClass('cc-head--title');
  });
  it('mock (D-230): the 반복 5 panel has no head at any size', () => {
    expect(render(2, 1).querySelector('.cc-head')).toBeNull();
    cleanup();
    expect(render(1, 1).querySelector('.cc-head')).toBeNull();
    cleanup();
    expect(render(1, 2).querySelector('.cc-head')).toBeNull();
  });
  it('the stylesheet puts the title-row head next to the shell title and keeps the title from running under it', () => {
    const css = readFileSync('src/features/widgets/mgmt-customers/widgets.css', 'utf8');
    expect(css).toMatch(/\.cc-head--title \{[^}]*position: absolute/);
    expect(css).toMatch(/data-feature-id="customer-analysis"\][^{]*\.ui-panel-title \{[^}]*text-overflow: ellipsis/);
  });
});
