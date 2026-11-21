import { describe, expect, it } from 'vitest';
import type { PosOptionGroup } from '../../contracts/pos';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui';
import { createSessionActions, createSessionGate } from '../../app/session-actions';
import { orderInputs } from '../../pos/status/inputs';
import { createPosSeedCatalog } from '../../pos/seed';
import { quoteCart } from '../../pos/domain';
import { createWidgetDataStore, deriveUsage, readModel, selectMenus, selectPosDataRead, TODAY } from '../widget-data';
import { POS_NOW } from '../../pos/clock';
import { seedCatalog } from '../db/generated/catalog';

function setup() {
  const gate = createSessionGate();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', sessionGate: gate });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, pos: run.getState().pos, sessionGate: gate });
  const actions = createSessionActions(run, data, gate);
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  actions.completeOnboarding(null);
  let seq = 0;
  const meta = () => ({ runId: run.getState().runId, idempotencyKey: `menu-test-${++seq}` });
  return { data, pos: actions.pos, meta };
}
const latteIce = seedCatalog.menu.find(menu => menu.menuId === 'm-cafe-latte')!.groups
  .find(group => group.name === '온도')!.options.find(option => option.name === 'ICE')!.optionId;
const syrup: PosOptionGroup = { groupId: 'latte-syrup', menuId: 'm-cafe-latte', name: '시럽', required: false,
  options: [{ optionId: 'latte-syrup-vanilla', groupId: 'latte-syrup', name: '바닐라 시럽 추가', extraPrice: 300, extraCost: null,
    extraRecipe: [{ itemId: 'i-vanilla-syrup', quantityBase: 10, unitDimension: 'mL' }] }] };

it('starts with no cafe menu art and keeps the uploaded photo available until cleared, with undo', () => {
  const data = createWidgetDataStore();
  const rows = () => selectMenus(data.getSnapshot(), {}).rows;
  const americano = () => rows().find(row => row.menuId === 'm-americano');
  expect(rows().map(row => [row.menuId, row.photoKey])).toEqual(seedCatalog.menu.map(menu => [menu.menuId, null]));

  const customPhotoUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const upload = { type: 'menu.setPhoto', menuId: 'm-americano', photoKey: null, customPhotoUrl } as const;
  const uploaded = data.dispatch(upload);
  expect(uploaded).toMatchObject({ ok: true, undoToken: expect.any(String) });
  expect(americano()).toMatchObject({ photoKey: null, customPhotoUrl });
  data.dispatch({ ...upload, photoKey: 'menu-photo-02', customPhotoUrl: undefined });
  expect(americano()).toMatchObject({ photoKey: 'menu-photo-02', customPhotoUrl });
  data.dispatch(upload);
  const cleared = data.dispatch({ type: 'menu.setPhoto', menuId: 'm-americano', photoKey: null });
  expect(americano()).toMatchObject({ photoKey: null, customPhotoUrl: null });
  if (!cleared.ok || !cleared.undoToken) throw Error('Expected undo token when clearing the photo');
  expect(data.undo(cleared.undoToken).ok).toBe(true);
  expect(americano()).toMatchObject({ photoKey: null, customPhotoUrl });

  const before = data.getSnapshot();
  expect(data.dispatch({ ...upload, customPhotoUrl: 'https://example.com/photo.png' } as never)).toMatchObject({ ok: false });
  expect(data.dispatch({ ...upload, photoKey: 'menu-photo-02' } as never)).toMatchObject({ ok: false });
  expect(data.getSnapshot()).toBe(before);
});
const groups = (data: ReturnType<typeof createWidgetDataStore>) => selectPosDataRead(data.getSnapshot()).catalog.items.find(m => m.menuId === 'm-cafe-latte')!.groups;

describe('T-253 live menu editing', () => {
  it('uses management preparation times in status inputs and defaults new menus to three minutes', () => {
    const data = createWidgetDataStore();
    expect(data.dispatch({ type: 'menu.create', name: '새 음료', price: 3000, category: 'drink', idempotencyKey: 'new' }).ok).toBe(true);
    const s = data.getSnapshot();
    const catalog = selectPosDataRead(s).catalog;
    expect(catalog.items.filter(m => !m.deletedAt).map(m => m.prepMin)).toEqual([...seedCatalog.menu.map(menu => menu.prepMin), 3]);
    expect(createPosSeedCatalog().items.map(m => m.prepMin)).toEqual(seedCatalog.menu.map(menu => menu.prepMin));
    const updated = selectPosDataRead({ ...s, tables: { ...s.tables, menuItem: s.tables.menuItem.map(m => m.menuId === 'm-cafe-latte' ? { ...m, prepMin: 9 } : m) } }).catalog;
    expect(orderInputs(s.pos!.orders, updated, POS_NOW).catalog.find(m => m.menuId === 'm-cafe-latte')?.prepMin).toBe(9);
  });

  it('keeps the sold option recipe, prices and costs after live edits and archival', () => {
    const { data, pos, meta } = setup();
    const initial = groups(data);
    expect(data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: [...initial, syrup] }).ok).toBe(true);
    expect(pos.execute({ type: 'cart.add', menuId: 'm-cafe-latte', optionIds: [latteIce, 'latte-syrup-vanilla'], meta: meta() }).ok).toBe(true);
    expect(quoteCart(pos.read()).payable).toBe(4100);
    const approval = pos.beginApproval({ cartId: pos.read().pos.cart.cartId, quoteRevision: quoteCart(pos.read()).revision, splits: [{ method: 'card', amount: 4100 }], meta: meta() });
    if (!approval.ok || !('attemptId' in approval.value)) throw new Error('Approval not pending');
    const pending = pos.read().posUi.approval!;
    expect(pos.finishApproval({ attemptId: pending.attemptId, runId: pending.runId, expectedQuoteFingerprint: pending.quoteFingerprint, outcome: 'approved' }).ok).toBe(true);
    expect(deriveUsage(data.getSnapshot(), { date: TODAY }).byItem['i-vanilla-syrup']).toBe(665);
    expect(readModel(data.getSnapshot(), 'margin').cost).toBe(245746);
    const changed = { ...syrup, options: syrup.options.map(o => ({ ...o, extraPrice: 900, extraRecipe: [{ itemId: 'i-vanilla-syrup', quantityBase: 20, unitDimension: 'mL' as const }] })) };
    expect(data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: [...initial, changed] }).ok).toBe(true);
    expect(groups(data).find(group => group.groupId === syrup.groupId)?.options[0]).toMatchObject({ extraPrice: 900, extraRecipe: [{ quantityBase: 20 }] });
    expect(deriveUsage(data.getSnapshot(), { date: TODAY }).byItem['i-vanilla-syrup']).toBe(665);
    const removal = data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: initial });
    expect(removal.ok).toBe(true);
    expect(groups(data).some(g => g.groupId === syrup.groupId)).toBe(false);
    expect(deriveUsage(data.getSnapshot(), { date: TODAY }).byItem['i-vanilla-syrup']).toBe(665);
    expect(readModel(data.getSnapshot(), 'margin').cost).toBe(245746);
    expect(pos.read().pos.orders.at(-1)?.lines[0].unitPriceAtOrder).toBe(4100);
    const snapshot = data.getSnapshot();
    expect(data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: [...initial, syrup] })).toMatchObject({ ok: false });
    expect(data.getSnapshot()).toBe(snapshot);
    if (!removal.ok || !removal.undoToken) throw new Error('Missing undo');
    expect(data.undo(removal.undoToken).ok).toBe(true);
    expect(groups(data).some(g => g.groupId === syrup.groupId)).toBe(true);
    const withoutOption = { ...changed, options: [] };
    expect(data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: [...initial, withoutOption] }).ok).toBe(true);
    expect(groups(data).find(g => g.groupId === syrup.groupId)?.options).toEqual([]);
    expect(deriveUsage(data.getSnapshot(), { date: TODAY }).byItem['i-vanilla-syrup']).toBe(665);
    const tombstone = data.getSnapshot().tables.menuItem.find(m => m.menuId === 'm-cafe-latte')!.optionGroups!.find(g => g.groupId === syrup.groupId)!.options[0];
    expect(tombstone.archivedAt).toBeTruthy();
    expect(tombstone.extraRecipe[0].quantityBase).toBe(20);
    expect(readModel(data.getSnapshot(), 'margin').cost).toBe(245746);
    pos.dispose();
  });

  it('rejects invalid groups, option money, units and foreign IDs without changes', () => {
    const data = createWidgetDataStore();
    const initial = groups(data);
    const cases: readonly [PosOptionGroup, string][] = [
      [{ ...syrup, name: '' }, 'EMPTY_NAME'],
      [{ ...syrup, required: true, options: [] }, 'REQUIRED_GROUP_EMPTY'],
      [{ ...syrup, options: syrup.options.map(o => ({ ...o, name: '' })) }, 'EMPTY_NAME'],
      [{ ...syrup, options: syrup.options.map(o => ({ ...o, extraPrice: -100 })) }, 'NEGATIVE_AMOUNT'],
      [{ ...syrup, options: syrup.options.map(o => ({ ...o, extraPrice: 1.5 })) }, 'NEGATIVE_AMOUNT'],
      [{ ...syrup, options: syrup.options.map(o => ({ ...o, extraRecipe: [{ itemId: 'i-milk', quantityBase: 10, unitDimension: 'g' }] })) }, 'UNIT_MISMATCH'],
      [{ ...syrup, menuId: 'm-americano' }, 'INVALID_OPTION'],
      [{ ...syrup, options: syrup.options.map(o => ({ ...o, optionId: seedCatalog.menu.find(menu => menu.menuId === 'm-americano')!.groups[0].options[0].optionId })) }, 'INVALID_OPTION'],
      [{ ...syrup, options: [...syrup.options, ...syrup.options] }, 'INVALID_OPTION'],
      [{ ...syrup, options: syrup.options.map(o => ({ ...o, extraRecipe: [...o.extraRecipe, ...o.extraRecipe] })) }, 'INVALID_OPTION'],
    ];
    for (const [group, reason] of cases) {
      const before = data.getSnapshot();
      expect(data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: [...initial, group] })).toMatchObject({ ok: false, reason });
      expect(data.getSnapshot()).toBe(before);
    }
    const required = initial.find(g => g.required)!;
    const before = data.getSnapshot();
    expect(data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: initial.map(g => g === required ? { ...g, options: [] } : g) })).toMatchObject({ ok: false, reason: 'REQUIRED_GROUP_EMPTY' });
    expect(data.getSnapshot()).toBe(before);
    expect(data.dispatch({ type: 'menu.update', menuId: 'm-cafe-latte', patch: { soldQty: 100 } } as never)).toMatchObject({ ok: false, reason: 'READ_ONLY_FIELD' });
    expect(data.getSnapshot()).toBe(before);
  });

  it('blocks sold-out cart submission, supports undo, and accepts only the eight fixed photo keys or null', () => {
    const { data, pos, meta } = setup();
    pos.execute({ type: 'cart.add', menuId: 'm-basque-cake', optionIds: [], meta: meta() });
    const result = data.dispatch({ type: 'menu.setSaleStatus', menuId: 'm-basque-cake', status: 'sold_out' });
    expect(result.ok).toBe(true);
    expect(quoteCart(pos.read())).toMatchObject({ payable: 5200, canSubmit: false, issues: [expect.objectContaining({ reason: 'SOLD_OUT' })] });
    if (!result.ok || !result.undoToken) throw new Error('Missing undo');
    expect(data.undo(result.undoToken).ok).toBe(true);
    expect(quoteCart(pos.read()).canSubmit).toBe(true);
    pos.execute({ type: 'cart.clear', meta: meta() });
    const original = groups(data);
    expect(data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: [...original, syrup] }).ok).toBe(true);
    expect(pos.execute({ type: 'cart.add', menuId: 'm-cafe-latte', optionIds: [latteIce, syrup.options[0].optionId], meta: meta() }).ok).toBe(true);
    const removeOption = data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: original });
    expect(removeOption.ok).toBe(true);
    expect(quoteCart(pos.read())).toMatchObject({ payable: 4100, canSubmit: false, issues: [expect.objectContaining({ reason: 'INVALID_OPTION' })] });
    for (const key of ['menu-photo-01', 'menu-photo-02', 'menu-photo-03', 'menu-photo-04', 'menu-photo-05', 'menu-photo-06', 'menu-photo-07', 'menu-photo-08', null] as const) {
      expect(data.dispatch({ type: 'menu.setPhoto', menuId: 'm-cookie-choco', photoKey: key }).ok).toBe(true);
      expect(selectPosDataRead(data.getSnapshot()).catalog.items.find(m => m.menuId === 'm-cookie-choco')?.photoKey).toBe(key);
    }
    for (const photoKey of ['menu-photo-00', 'menu-photo-09', 'https://example.com/photo.png', 'menu-photo-01\n']) {
      const before = data.getSnapshot();
      expect(data.dispatch({ type: 'menu.setPhoto', menuId: 'm-cookie-choco', photoKey } as never)).toMatchObject({ ok: false, reason: 'UNKNOWN_PHOTO' });
      expect(data.getSnapshot()).toBe(before);
    }
    pos.dispose();
  });
});
