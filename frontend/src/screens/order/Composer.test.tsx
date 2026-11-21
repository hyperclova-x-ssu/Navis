import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import '../../ui/test-setup';
import { UiProvider } from '../../ui';
import { screenPresets } from '../../layout/presets';
import { PosProvider } from '../../pos/react';
import { createPosSeed, createPosSeedCatalog } from '../../pos/seed';
import { planPosCommand, planPosUndo } from '../../pos/domain';
import type { PosCommand, PosReadSnapshot } from '../../contracts/pos';
import type { PosRuntime } from '../../pos/runtime';
import { Composer } from './Composer';
import { POS_NOW } from '../../pos/clock';

afterEach(cleanup);

const cafeCatalog = createPosSeedCatalog();
const latte = cafeCatalog.items.find(menu => menu.menuId === 'm-cafe-latte')!;
const temperature = latte.groups.find(group => group.name === '온도')!;
// The cafe paid modifiers lack recipe costs. Add two priced groups to exercise this scenario.
const pricedLatte = { ...latte, groups: [temperature,
  { groupId: 'test-size', menuId: latte.menuId, name: '사이즈', required: false, options: [
    { optionId: 'test-size:up', groupId: 'test-size', name: '사이즈업', extraPrice: 500, extraCost: 350,
      extraRecipe: [{ itemId: 'i-milk', quantityBase: 100, unitDimension: 'mL' as const }] },
  ] },
  { groupId: 'test-extra', menuId: latte.menuId, name: '추가', required: false, options: [
    { optionId: 'test-extra:shot', groupId: 'test-extra', name: '샷 추가', extraPrice: 500, extraCost: 300,
      extraRecipe: [{ itemId: 'i-bean-house', quantityBase: 12, unitDimension: 'g' as const }] },
  ] },
] };
const catalog = { ...cafeCatalog, items: cafeCatalog.items.map(menu => menu === latte ? pricedLatte : menu) };

function setup() {
  let snapshot: PosReadSnapshot = { runId: 'run', runRevision: 0, pos: createPosSeed(), posRevision: 0, posUi: { tab: 'order', approval: null, cartUndo: null }, dataRevision: 0, settings: { businessType: 'cafe', paymentStyle: 'prepaid', tableLayout: null, revision: 0 }, scenario: 'normal', data: { revision: 0, catalog, dayClosed: false, closingGeneration: 0 } };
  const listeners = new Set<() => void>();
  const publish = (result: ReturnType<typeof planPosUndo>) => {
    if (!result.ok) return result;
    snapshot = { ...snapshot, pos: result.plan.nextPos, posRevision: result.plan.nextPos.revision, posUi: result.plan.nextUi };
    listeners.forEach(listener => listener());
    return result.plan.result;
  };
  const unused = (): never => { throw new Error('Unexpected runtime method in Composer test'); };
  const runtime: PosRuntime = { read: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, execute: (command: PosCommand) => publish(planPosCommand(snapshot, command, POS_NOW)), undo: (token: string) => publish(planPosUndo(snapshot, token)), beginApproval: unused, finishApproval: unused, dismissApproval: unused, setTab: unused, dispose: unused };
  return { runtime, read: () => snapshot, updateCatalog: (catalog: PosReadSnapshot['data']['catalog']) => {
    snapshot = { ...snapshot, data: { ...snapshot.data, catalog } };
    listeners.forEach(listener => listener());
  } };
}

it('chooses options, adds a line, and updates its quantity and quoted total', async () => {
  const { runtime, read } = setup();
  const user = userEvent.setup();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={runtime}><Composer /></PosProvider></UiProvider>);
  await user.click(screen.getByRole('button', { name: /카페라떼, 3,800원/ }));
  const dialog = screen.getByRole('dialog', { name: '카페라떼 옵션' });
  await user.click(within(dialog).getByRole('radio', { name: /ICE/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: /사이즈업/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: /샷 추가/ }));
  await user.click(within(dialog).getByRole('button', { name: '담기' }));
  expect(read().pos.cart.lines).toHaveLength(1);
  expect(read().pos.cart.lines[0].qty).toBe(1);
  await user.click(screen.getByRole('button', { name: '카페라떼 하나 더' }));
  expect(read().pos.cart.lines[0].qty).toBe(2);
  expect(within(screen.getByRole('region', { name: '주문 내역' })).getByText((_,node) => node?.textContent === '9,600원', { selector: '[aria-live]' })).toBeInTheDocument();
});

// Hiding the quote while validation fails would lose the selected 1,000원.
it('keeps the priced dialog total when a required option is missing', async () => {
  const { runtime, read } = setup();
  const user = userEvent.setup();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={runtime}><Composer /></PosProvider></UiProvider>);
  await user.click(screen.getByRole('button', { name: /카페라떼, 3,800원/ }));
  const dialog = screen.getByRole('dialog', { name: '카페라떼 옵션' });
  await user.click(within(dialog).getByRole('checkbox', { name: /사이즈업/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: /샷 추가/ }));
  expect(within(dialog).getByText('4,800원')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: '담기' }));
  expect(read().pos.cart.lines).toHaveLength(0);
  expect(within(dialog).getByText('4,800원')).toBeInTheDocument();
});

// A sale-status change must not strip paid options or the line quantity.
it('shows the full priced sold-out line and blocks payment', async () => {
  const { runtime, read, updateCatalog } = setup();
  const item = read().data.catalog.items.find(item => item.name === '카페라떼')!;
  const optionIds = item.groups.flatMap(group => group.options.filter(option => option.name !== 'HOT').map(option => option.optionId));
  runtime.execute({ type: 'cart.add', menuId: item.menuId, optionIds, qty: 2, meta: { runId: 'run', idempotencyKey: 'sold-out' } });
  updateCatalog({ ...read().data.catalog, items: read().data.catalog.items.map(menu => menu.menuId === item.menuId ? { ...menu, saleStatus: 'sold_out' } : menu) });
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={runtime}><Composer /></PosProvider></UiProvider>);
  const cart = screen.getByRole('region', { name: '주문 내역' });
  const line = within(cart).getByRole('button', { name: '카페라떼 옵션 바꾸기' }).closest('[data-line-id]')!;
  expect(within(line as HTMLElement).getByText('9,600원')).toBeInTheDocument();
  expect(within(cart).getByText((_,node) => node?.textContent === '9,600원', { selector: '[aria-live]' })).toBeInTheDocument();
  expect(within(cart).getByRole('button', { name: '결제하기' })).toHaveAttribute('aria-disabled', 'true');
});
