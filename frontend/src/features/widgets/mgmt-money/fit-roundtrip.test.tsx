import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CellSpan, WidgetHost, WidgetModule } from '../../../contracts';
import { FeaturePanel } from '../../../ui';
import { KitProviders } from '../../../ui/test-utils';
import { ledgerModule, LEDGER_FIT } from './ledger';
import { taxModule } from './tax';
import { marginModule } from './margin';
import { grantsModule } from './grants';
import { briefingModule } from './briefing';
import { manualsModule } from '../mgmt-store/manuals';
import { MONEY_FIT } from './shared';
import { STORE_FIT } from '../mgmt-store/shared';
import { runFit } from './fit';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };

// jsdom has no layout. Model the reported 108px box: heading number 42 + label 24 + closing 28 + gaps 8 = 102.
// The large panel's metric stage is 58px, so the same three parts need 118px until MetricFit commits its new stage.
function installGeometry() {
  const observers = new Set<() => void>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { this.callback = callback; }
    private callback: () => void;
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.closest('[data-width]')?.getAttribute('data-width') === '4' ? 1000 : 241;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches('.ui-panel-content') ? this.closest('[data-height]')?.getAttribute('data-height') === '4' ? 780 : 108 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.matches('.ui-panel-content')) return 0;
    const visible = (selector: string) => Array.from(this.querySelectorAll(selector)).filter(el => !el.closest('[data-fit-hidden]')).length;
    const stage = this.querySelector('.ui-metric-fit')?.getAttribute('data-stage');
    return (stage === '0' ? 58 : 42) + visible('.mm-label,.mgmt-label') * 24 + visible('.mm-sub,.mgmt-sub') * 48 + visible('[data-slot-id="ledger.dashboard.closing"]') * 28 + 8;
  });
  return () => { act(() => { for (const notify of observers) notify(); }); };
}

function panel(module: WidgetModule, size: CellSpan, scale: 100 | 125 = 100, editing = false, variant = 'normal') {
  return <KitProviders locale="en" textScale={scale} preview={{ family: 'normal', overrides: { [module.id]: variant } }}>
    <FeaturePanel featureId={module.id} label={module.id} groupId="finance" width={size} height={size} editing>
      <module.Panel featureId={module.id} condition={{ kind: 'default' }} width={size} height={size} shape={size === 1 ? 'Q' : 'L'} presetId="A" editing={editing} host={host} />
    </FeaturePanel>
  </KitProviders>;
}

it.each(['normal', 'no-expenses'])('restores the ledger %s label after the large metric shrinks on a 1x1 → 4x4 → 1x1 round trip', async variant => {
  const resize = installGeometry();
  const view = render(panel(ledgerModule, 1, 100, false, variant));
  const content = view.container.querySelector<HTMLElement>('.ui-panel-content')!;
  // Font-ready fitting gives the fresh render the settled heading-size metric, as in the sweep evidence.
  act(() => { runFit(content, LEDGER_FIT); });
  expect(content.querySelector('.mm-label')).not.toHaveAttribute('data-fit-hidden');
  view.rerender(panel(ledgerModule, 4, 100, false, variant));
  resize();
  expect(content.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage', '0');
  view.rerender(panel(ledgerModule, 1, 100, false, variant));
  resize();
  expect(content.querySelector('.ui-metric-fit')).not.toHaveAttribute('data-stage', '0');
  await waitFor(() => expect(content.querySelector('.mm-label')).not.toHaveAttribute('data-fit-hidden'));
});

it.each([ledgerModule, taxModule, marginModule, grantsModule, briefingModule, manualsModule].map(module => [module.id, module] as const))('restarts %s fitting from the full state across size, scale and edit round trips', async (_id, module) => {
  const resize = installGeometry();
  const view = render(panel(module, 1));
  const content = view.container.querySelector<HTMLElement>('.ui-panel-content')!;
  const order = module.id === 'manuals' ? STORE_FIT : module.id === 'ledger' ? LEDGER_FIT : MONEY_FIT;
  act(() => { runFit(content, order); });
  const hidden = () => Array.from(content.querySelectorAll('[data-fit-hidden]')).map(el => el.getAttribute('data-slot') ?? el.className);
  const fresh = hidden();
  for (const [size, scale, editing] of [[4, 100, false], [1, 100, false], [1, 125, false], [1, 100, false], [1, 100, true], [1, 100, false]] as const) {
    view.rerender(panel(module, size, scale, editing));
    resize();
    if (size === 1 && scale === 100 && !editing) await waitFor(() => expect(hidden()).toEqual(fresh));
  }
});
