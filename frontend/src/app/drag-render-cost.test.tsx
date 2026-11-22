import '@testing-library/jest-dom/vitest';
import '../ui/test-setup';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setup } from '../pos/loyalty/test-setup';
import { PosProvider } from '../pos/react';
import { renderWithKit } from '../ui/test-utils';
import { UiProvider, useUi } from '../ui';
import { screenPresets } from '../layout/presets';
import { useWidgetView } from '../data/react';
import { M2RunHost, useM2WidgetBindings } from './pos-host';
import { SessionActionsProvider } from './session-actions';

afterEach(cleanup);

// PERF-DRAG-REAL: during a widget drag the run store notifies on every drop-cell change (preview pending, then accepted).
// Neither the shared UI context nor the POS host's providers may change for those updates, or every widget re-renders (and
// re-measures its text) on each cell change. These tests count consumer renders across unrelated run updates.

it('UiProvider keeps one context value while its inputs are equal', () => {
  let renders = 0;
  function Probe() { useUi(); renders += 1; return null; }
  const child = <Probe />;
  const props = { screenPreset: screenPresets.A, theme: 'light' as const, textScale: 100 as const, reducedMotion: true };
  const view = render(<UiProvider {...props}>{child}</UiProvider>);
  const settled = renders; // the portal host and canvas elements arrive after mount
  expect(settled).toBeGreaterThan(0);
  view.rerender(<UiProvider {...props}>{child}</UiProvider>);
  view.rerender(<UiProvider {...props}>{child}</UiProvider>);
  expect(renders).toBe(settled);
  view.rerender(<UiProvider {...props} theme="dark">{child}</UiProvider>);
  expect(renders).toBe(settled + 1);
});

it('the POS host does not re-render widget consumers for run updates it does not read', () => {
  const h = setup();
  let data = 0, host = 0;
  function DataProbe() { useWidgetView('menu'); data += 1; return null; }
  function HostProbe() { useM2WidgetBindings(); host += 1; return null; }
  const probes = <><DataProbe /><HostProbe /></>;
  renderWithKit(<SessionActionsProvider value={h.actions}><PosProvider value={h.pos}><M2RunHost run={h.run}>{probes}</M2RunHost></PosProvider></SessionActionsProvider>, { store: h.data, reducedMotion: true });
  const before = { data, host };
  expect(before.data).toBeGreaterThan(0);
  for (let i = 0; i < 4; i += 1) act(() => { h.run.actions.showNotice({ kind: 'complete', messageKey: i % 2 ? 'common.undone' : 'common.saved' }); });
  expect({ data, host }).toEqual(before);
});

it('the POS host still follows the run fields it reads', () => {
  const h = setup();
  let hostRenders = 0;
  function HostProbe() { useM2WidgetBindings(); hostRenders += 1; return null; }
  const probes = <HostProbe />;
  renderWithKit(<SessionActionsProvider value={h.actions}><PosProvider value={h.pos}><M2RunHost run={h.run}>{probes}</M2RunHost></PosProvider></SessionActionsProvider>, { store: h.data, reducedMotion: true });
  const before = hostRenders;
  // The layer is read by the host (membership handoff, alerts): a change must still reach it.
  act(() => { h.run.actions.switchLayer('orders-payment'); });
  expect(h.run.getState().layer).toBe('orders-payment');
  expect(hostRenders).toBeGreaterThan(before);
  const afterLayer = hostRenders;
  // The POS state feeds the linked-table join the host builds: a POS change must still reach it.
  act(() => { expect(h.pos.setTab('status')).toBe(true); });
  expect(h.run.getState().posUi.tab).toBe('status');
  expect(hostRenders).toBeGreaterThan(afterLayer);
});
