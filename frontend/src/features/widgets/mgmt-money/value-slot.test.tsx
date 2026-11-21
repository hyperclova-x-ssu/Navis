import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createVisibleSlotRegistry, VisibleSlotProvider } from '../../../ui/visible-slots';
import { ValueHighlights } from '../../../app/value-highlights';
import { createRunStore } from '../../../state';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout/presets';
import { timePolicy } from '../../../ui';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import type { WidgetHost } from '../../../contracts';
import { LedgerDetail, LedgerPanel } from './ledger';
import { BriefingDetail } from './briefing';
import { manualsModule } from '../mgmt-store/manuals';
import { ValueSlot } from './value-slot';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 24, width: 120, height: 24, toJSON: () => ({}) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };

it('excludes a fit-hidden row and registers it again when there is room', async () => {
  const registry = createVisibleSlotRegistry();
  renderWithKit(<VisibleSlotProvider registry={registry}><div data-testid="row"><ValueSlot slotId="ledger.dashboard.row.expenses" featureId="ledger" scope="dashboard" semanticValue={462000}>46.2만 원</ValueSlot></div></VisibleSlotProvider>);
  expect(registry.getSnapshot()[0]).toMatchObject({ visible: true, semanticValue: 462000 });
  screen.getByTestId('row').setAttribute('data-fit-hidden', '');
  await waitFor(() => expect(registry.getSnapshot()[0].visible).toBe(false));
  screen.getByTestId('row').removeAttribute('data-fit-hidden');
  await waitFor(() => expect(registry.getSnapshot()[0].visible).toBe(true));
});

it('registers the editable checklist and its progress in both visible scopes', () => {
  const registry = createVisibleSlotRegistry(), Detail = manualsModule.Detail!, store = createWidgetDataStore();
  // The opening checklist the widgets show: the published opening manual, its steps and how many are checked today.
  const tables = store.getSnapshot().tables;
  const manual = tables.manual.find(row => row.isPublished && row.category === 'opening' && row.section !== 'store-info')!;
  const steps = tables.manualStep.filter(step => step.manualId === manual.manualId).sort((a, b) => a.stepNo - b.stepNo);
  const checked = (stepNo: number) => tables.checklistLog.some(log => log.date === TODAY && log.manualId === manual.manualId && log.stepNo === stepNo);
  const done = steps.filter(step => checked(step.stepNo)).length;
  const next = steps.find(step => !checked(step.stepNo))!;
  renderWithKit(<VisibleSlotProvider registry={registry}><manualsModule.Panel featureId="manuals" condition={{ kind: 'default' }} width={2} height={2} shape="S" presetId="A" editing={false} host={host} /><Detail featureId="manuals" condition={{ kind: 'default' }} detailRef={{ featureId: 'manuals', itemId: manual.manualId }} host={host} /></VisibleSlotProvider>, { store });
  expect(registry.getSnapshot()).toContainEqual(expect.objectContaining({ featureId: 'manuals', scope: 'dashboard', semanticValue: `${done}/${steps.length}`, visible: true }));
  expect(registry.getSnapshot()).toContainEqual(expect.objectContaining({ featureId: 'manuals', scope: 'detail', semanticValue: `${done}/${steps.length}`, visible: true }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'raw' in next.body ? next.body.raw : '' }));
  expect(registry.getSnapshot()).toContainEqual(expect.objectContaining({ scope: 'editor', semanticValue: true, slotId: `manuals.editor.${manual.manualId}.step.${next.stepNo}`, visible: true }));
  expect(registry.getSnapshot()).toContainEqual(expect.objectContaining({ scope: 'dashboard', semanticValue: `${done + 1}/${steps.length}` }));
  expect(document.querySelector('[data-flash="true"]')).toBeNull();
});

it('keeps the tax alert meaning exact when its compact amount rounds to the same text', () => {
  const registry = createVisibleSlotRegistry(), store = createWidgetDataStore();
  renderWithKit(<VisibleSlotProvider registry={registry}><BriefingDetail featureId="briefing" condition={{ kind: 'default' }} detailRef={{ featureId: 'briefing' }} host={host} /></VisibleSlotProvider>, { store });
  const before = registry.getSnapshot().find(slot => slot.slotId === 'briefing.detail.alert.tax:sample-tax-1')!;
  expect(before).toBeDefined();
  act(() => { expect(store.dispatch({ type: 'tax.updatePayment', taxPaymentId: 'sample-tax-1', patch: { amount: 183001 } }).ok).toBe(true); });
  expect(registry.getSnapshot().find(slot => slot.slotId === before.slotId)?.semanticValue).not.toBe(before.semanticValue);
});

it('lets the app highlight at most six changed values across money and briefing screens', async () => {
  const store = createWidgetDataStore();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light' });
  renderWithKit(<ValueHighlights run={run}>
    <LedgerPanel featureId="ledger" condition={{ kind: 'default' }} width={2} height={2} shape="S" presetId="A" editing={false} host={host} />
    <LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />
    <BriefingDetail featureId="briefing" condition={{ kind: 'default' }} detailRef={{ featureId: 'briefing' }} host={host} />
  </ValueHighlights>, { store });
  fireEvent.click(screen.getByRole('tab', { name: '순이익' }));
  fireEvent.click(screen.getByRole('tab', { name: '퇴근' }));
  await act(async () => {});
  expect(document.querySelectorAll('[data-highlighted]')).toHaveLength(0);
  await act(async () => { store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 30000, evidence: 'receipt' }); });
  const highlighted = Array.from(document.querySelectorAll('[data-highlighted]'));
  expect(highlighted).toHaveLength(6);
  expect(new Set(highlighted.map(node => node.getAttribute('data-slot-id'))).size).toBe(6);
  expect(document.querySelector('[data-flash="true"]')).toBeNull();
}, 30_000);
