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

function setup(menuCatalog = catalog) {
  let snapshot: PosReadSnapshot = { runId: 'run', runRevision: 0, pos: createPosSeed(), posRevision: 0, posUi: { tab: 'order', approval: null, cartUndo: null }, dataRevision: 0, settings: { businessType: 'cafe', paymentStyle: 'prepaid', tableLayout: null, revision: 0 }, scenario: 'normal', data: { revision: 0, catalog: menuCatalog, dayClosed: false, closingGeneration: 0 } };
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

it('requires a choice in both required groups each time the item is added', async () => {
  const withRequiredSize = { ...pricedLatte, groups: pricedLatte.groups.map(group => group.groupId === 'test-size' ? { ...group, required: true } : group) };
  const { runtime, read } = setup({ ...catalog, items: catalog.items.map(menu => menu === pricedLatte ? withRequiredSize : menu) });
  const user = userEvent.setup();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={runtime}><Composer /></PosProvider></UiProvider>);
  const menu = screen.getByRole('button', { name: /카페라떼, 3,800원/ });
  await user.click(menu);
  const dialog = screen.getByRole('dialog', { name: '카페라떼 옵션' });
  const picker = within(dialog);
  const add = picker.getByRole('button', { name: '담기' });
  expect(add).toBeDisabled();
  expect(picker.getAllByRole('radio').every(option => option.getAttribute('aria-checked') === 'false')).toBe(true);
  expect(picker.getByRole('checkbox', { name: /샷 추가/ })).not.toBeChecked();
  expect(picker.getByText('온도를 골라 주세요')).toBeVisible();
  expect(picker.getByText('사이즈를 골라 주세요')).toBeVisible();
  await user.click(picker.getByRole('radio', { name: /HOT/ }));
  expect(picker.queryByText('온도를 골라 주세요')).not.toBeInTheDocument();
  expect(add).toBeDisabled();
  expect(read().pos.cart.lines).toHaveLength(0);
  await user.click(picker.getByRole('radio', { name: /사이즈업/ }));
  expect(add).toBeEnabled();
  await user.click(add);
  expect(read().pos.cart.lines).toHaveLength(1);
  expect(read().pos.cart.lines[0].selectedOptionIds).toEqual(expect.arrayContaining([temperature.options.find(option => option.name === 'HOT')!.optionId, 'test-size:up']));
  await user.click(menu);
  expect(within(screen.getByRole('dialog', { name: '카페라떼 옵션' })).getByRole('button', { name: '담기' })).toBeDisabled();
});

// Clear group titles, required vs optional markers, price deltas and a summary total that sits with the 담기 button.
it('titles every group, marks required vs optional without a status icon, and keeps the total beside 담기', async () => {
  const { runtime } = setup();
  const user = userEvent.setup();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={runtime}><Composer /></PosProvider></UiProvider>);
  await user.click(screen.getByRole('button', { name: /카페라떼, 3,800원/ }));
  const dialog = screen.getByRole('dialog', { name: '카페라떼 옵션' });
  const headings = within(dialog).getAllByRole('heading', { level: 3 });
  expect(headings.map(heading => heading.textContent)).toEqual(['온도필수', '사이즈선택', '추가선택']);
  const chips = Array.from(dialog.querySelectorAll('.ui-status-chip'));
  expect(chips.map(chip => chip.textContent)).toEqual(['필수', '선택', '선택']);
  expect(chips.every(chip => chip.querySelector('svg') === null)).toBe(true);
  expect(within(dialog).getByRole('checkbox', { name: /사이즈업/ })).toHaveTextContent('+500원');
  const footer = within(dialog).getByRole('group', { name: '합계' });
  expect(within(footer).getByText('3,800원')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('checkbox', { name: /사이즈업/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: /샷 추가/ }));
  expect(within(footer).getByText('4,800원')).toBeInTheDocument();
  expect(within(footer).getByText(/옵션 1,000원/)).toBeInTheDocument();
  // A group's own choices stay inside one named group, in the group's order.
  expect(within(within(dialog).getByRole('radiogroup', { name: '온도' })).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['HOT', 'ICE']);
});

// The cart line prints chosen options compactly.
it('shows the chosen options compactly on the cart line, price deltas included', async () => {
  const { runtime, read } = setup();
  const user = userEvent.setup();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={runtime}><Composer /></PosProvider></UiProvider>);
  await user.click(screen.getByRole('button', { name: /카페라떼, 3,800원/ }));
  const dialog = screen.getByRole('dialog', { name: '카페라떼 옵션' });
  await user.click(within(dialog).getByRole('radio', { name: /ICE/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: /사이즈업/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: /샷 추가/ }));
  await user.click(within(dialog).getByRole('button', { name: '담기' }));
  const line = within(screen.getByRole('region', { name: '주문 내역' })).getByRole('button', { name: '카페라떼 옵션 바꾸기' });
  expect(line).toHaveTextContent('ICE · 사이즈업 +500원 · 샷 추가 +500원');
  expect(read().pos.cart.lines[0].selectedOptionIds).toHaveLength(3);
});

// The cart line reopens the very same picker with the current choices and replaces them in place.
it('reopens the same picker from the cart line with the current choices selected', async () => {
  const { runtime, read } = setup();
  const user = userEvent.setup();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={runtime}><Composer /></PosProvider></UiProvider>);
  await user.click(screen.getByRole('button', { name: /카페라떼, 3,800원/ }));
  let dialog = screen.getByRole('dialog', { name: '카페라떼 옵션' });
  await user.click(within(dialog).getByRole('radio', { name: /ICE/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: /사이즈업/ }));
  await user.click(within(dialog).getByRole('button', { name: '담기' }));
  await user.click(screen.getByRole('button', { name: '카페라떼 옵션 바꾸기' }));
  dialog = screen.getByRole('dialog', { name: '카페라떼 옵션' });
  expect(within(dialog).getByRole('radio', { name: /ICE/ })).toHaveAttribute('aria-checked', 'true');
  expect(within(dialog).getByRole('checkbox', { name: /사이즈업/ })).toHaveAttribute('aria-checked', 'true');
  expect(within(dialog).getByRole('checkbox', { name: /샷 추가/ })).toHaveAttribute('aria-checked', 'false');
  expect(within(dialog).getByRole('textbox', { name: '요청사항' })).toBeInTheDocument();
  await user.click(within(dialog).getByRole('radio', { name: /HOT/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: /샷 추가/ }));
  await user.click(within(dialog).getByRole('button', { name: '바꾸기' }));
  expect(read().pos.cart.lines).toHaveLength(1);
  const names = read().pos.cart.lines[0].selectedOptionIds.map(id => cafeCatalog.items.flatMap(menu => menu.groups.flatMap(group => group.options)).find(option => option.optionId === id)?.name ?? catalog.items.flatMap(menu => menu.groups.flatMap(group => group.options)).find(option => option.optionId === id)?.name);
  expect(names.sort()).toEqual(['HOT', '사이즈업', '샷 추가'].sort());
});

// Keyboard: Space toggles a checkbox option, arrow keys move inside a group, Esc closes without adding.
it('keeps the picker usable from the keyboard', async () => {
  const { runtime, read } = setup();
  const user = userEvent.setup();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={runtime}><Composer /></PosProvider></UiProvider>);
  await user.click(screen.getByRole('button', { name: /카페라떼, 3,800원/ }));
  const dialog = screen.getByRole('dialog', { name: '카페라떼 옵션' });
  within(dialog).getByRole('radio', { name: /HOT/ }).focus();
  await user.keyboard('{ArrowRight}');
  expect(within(dialog).getByRole('radio', { name: /ICE/ })).toHaveAttribute('aria-checked', 'true');
  within(dialog).getByRole('checkbox', { name: /사이즈업/ }).focus();
  await user.keyboard(' ');
  expect(within(dialog).getByRole('checkbox', { name: /사이즈업/ })).toHaveAttribute('aria-checked', 'true');
  await user.keyboard('{Escape}');
  expect(read().pos.cart.lines).toHaveLength(0);
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

// D-353: five fixed tabs in this order; the legacy `drink` category is 음료, coffee and tea filter by their own key.
it('offers 전체·커피·티·음료·디저트 and files legacy drink under 음료', async () => {
  const filed = { ...cafeCatalog, items: cafeCatalog.items.map(menu => menu.menuId === latte.menuId ? { ...menu, category: 'coffee' } : menu.name === '캐모마일 티' ? { ...menu, category: 'tea' } : menu) };
  const { runtime } = setup(filed);
  const user = userEvent.setup();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={runtime}><Composer /></PosProvider></UiProvider>);
  const tabs = screen.getByRole('radiogroup', { name: '메뉴 분류' });
  expect(within(tabs).getAllByRole('radio').map(tab => tab.textContent)).toEqual(['전체', '커피', '티', '음료', '디저트']);
  await user.click(within(tabs).getByRole('radio', { name: '커피' }));
  expect(screen.getByRole('button', { name: /^카페라떼, / })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^캐모마일 티, / })).not.toBeInTheDocument();
  await user.click(within(tabs).getByRole('radio', { name: '티' }));
  expect(screen.getByRole('button', { name: /^캐모마일 티, / })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^카페라떼, / })).not.toBeInTheDocument();
  await user.click(within(tabs).getByRole('radio', { name: '음료' }));
  expect(screen.queryByRole('button', { name: /^카페라떼, / })).not.toBeInTheDocument();
  const legacyDrinks = filed.items.filter(menu => menu.category === 'drink');
  expect(legacyDrinks.length).toBeGreaterThan(0);
  for (const drink of legacyDrinks) expect(screen.getByRole('button', { name: new RegExp(`^${drink.name}, `) })).toBeInTheDocument();
});
