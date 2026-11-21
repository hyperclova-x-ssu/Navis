import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, selectMenus } from '../../../data/widget-data';
import { createSessionActions, createSessionGate } from '../../../app/session-actions';
import { PosProvider } from '../../../pos/react';
import { quoteCart } from '../../../pos/domain';
import { Composer } from '../../../screens/order/Composer';
import { MenuDetail } from './menu';

afterEach(cleanup);

it('edits an option in management and uses its new price in a new order', async () => {
  const gate = createSessionGate();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', sessionGate: gate });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, pos: run.getState().pos, sessionGate: gate });
  const actions = createSessionActions(run, data, gate);
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  expect(actions.completeOnboarding(null).ok).toBe(true);
  // The cafe's 카페라떼 has an optional 우유 변경 group with one option (오트 귀리우유); the order screen reads the same option rows.
  const latte = selectMenus(data.getSnapshot(), {}).rows.find(row => row.menuId === 'm-cafe-latte')!;
  const group = latte.optionGroups.find(g => !g.required && g.options.length === 1)!;
  const option = group.options[0]!;
  const latteName = (latte.name as { raw: string }).raw;
  const newExtra = option.extraPrice + 100;
  // The cafe seed's priced options carry no extra recipe, and the POS catalog hides a priced option without a cost basis, so the order
  // screen would not offer it. Give this option a recipe (oat milk) through the real command first, then edit its price in management.
  const oatMilk = { itemId: 'i-oat-milk', quantityBase: 200, unitDimension: 'mL' as const };
  expect(data.dispatch({ type: 'menu.setOptions', menuId: latte.menuId, groups: latte.optionGroups.map(g => g.groupId === group.groupId
    ? { ...g, options: g.options.map(o => o.optionId === option.optionId ? { ...o, extraRecipe: [oatMilk] } : o) } : g) }).ok).toBe(true);
  const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
  const user = userEvent.setup();
  const mounted = renderWithKit(<MenuDetail featureId="menu" condition={{ kind: 'default' }} host={host} detailRef={{ featureId: 'menu', itemId: latte.menuId }}/>, { store: data, reducedMotion: true });
  await user.click(screen.getByText('옵션', { selector: 'summary' }));
  const options = screen.getByRole('grid', { name: `${group.name} 옵션` });
  await user.click(within(options).getByRole('gridcell', { name: new RegExp(`^${option.name}, 추가 금액,`) }));
  const amount = screen.getByRole('textbox', { name: `${option.name}, 추가 금액` });
  await user.clear(amount);
  await user.type(amount, String(newExtra));
  await user.keyboard('{Enter}');
  mounted.unmount();
  renderWithKit(<PosProvider value={actions.pos}><Composer /></PosProvider>, { store: data, reducedMotion: true });
  await user.click(screen.getByRole('button', { name: new RegExp(`^${latteName}, ${latte.price.toLocaleString('ko-KR')}원`) }));
  const dialog = screen.getByRole('dialog', { name: `${latteName} 옵션` });
  await user.click(within(dialog).getByRole('radio', { name: /ICE/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: new RegExp(option.name) }));
  await user.click(within(dialog).getByRole('button', { name: '담기' }));
  expect(quoteCart(actions.pos.read())).toMatchObject({ payable: latte.price + newExtra, canSubmit: true, totalQty: 1 });
  actions.pos.dispose();
});

it('updates the order card with the locally saved menu photo and restores the photo on undo', () => {
  const gate = createSessionGate();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', sessionGate: gate });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, pos: run.getState().pos, sessionGate: gate });
  const actions = createSessionActions(run, data, gate);
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  expect(actions.completeOnboarding(null).ok).toBe(true);
  renderWithKit(<PosProvider value={actions.pos}><Composer /></PosProvider>, { store: data, reducedMotion: true });
  const card = screen.getByRole('button', { name: /^아메리카노, 3,000원/ });
  expect(card.querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^\/menu-photos\//));
  const customPhotoUrl = 'data:image/png;base64,iVBORw0KGgo=';
  act(() => {
    const saved = data.dispatch({ type: 'menu.setPhoto', menuId: 'm-americano', photoKey: null, customPhotoUrl });
    expect(saved.ok).toBe(true);
  });
  expect(card.querySelector('img')).toHaveAttribute('src', customPhotoUrl);
  let undoToken: string | undefined;
  act(() => {
    const removed = data.dispatch({ type: 'menu.setPhoto', menuId: 'm-americano', photoKey: null });
    if (removed.ok) undoToken = removed.undoToken;
  });
  expect(card.querySelector('img')).toBeNull();
  expect(undoToken).toBeTruthy();
  act(() => { data.undo(undoToken!); });
  expect(card.querySelector('img')).toHaveAttribute('src', customPhotoUrl);
  actions.pos.dispose();
});
