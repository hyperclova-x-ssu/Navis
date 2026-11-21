import { describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore, selectWidget } from '../../data/widget-data';
import { createAgentActions } from './agent-actions';

const name = '캬라멜 마키야또';
const draft = { name, category: 'drink', price: 5500 } as const;
const frame = {
  command: 'menu.create',
  args: { name: { slot: 'name' }, category: 'drink', price: { slot: 'price' } },
  snapshotRevision: 0,
} as const;

function setup() {
  const store = createWidgetDataStore(undefined, { runId: 'agent-test' });
  const actions = createAgentActions(store);
  const menus = () => {
    const view = selectWidget(store.getSnapshot(), 'menu', { kind: 'default' }, 'normal');
    if (view.status !== 'ready') throw new Error('Menu fixture is missing');
    return view.model.rows;
  };
  return { store, actions, menus, proposal: () => actions.propose(frame, draft, store.getSnapshot())! };
}

describe('menu proposal receipts', () => {
  it('previews the projected menu and commits through dispatch with the normal undo token', () => {
    const { store, proposal, menus } = setup();
    const count = menus().length;
    const change = proposal();
    expect(change.preview).toMatchObject({
      before: null, after: { name, price: 5500, saleStatus: 'selling', prepMin: 3, soldQty: 0, cost: null },
      countBefore: count, countAfter: count + 1,
    });
    expect(menus()).toHaveLength(count);
    const receipt = change.confirm(store);
    expect(receipt.frame).toMatchObject({ proposalId: change.id, outcome: 'applied', revision: 1 });
    expect(menus()).toHaveLength(count + 1);
    expect(menus().at(-1)).toMatchObject({ name: { raw: name }, price: 5500 });
    expect(receipt.notice?.undo?.target).toBe('data');
    expect(store.undo(receipt.notice!.undo!.token).ok).toBe(true);
    expect(menus()).toHaveLength(count);
  });

  it('cancels before dispatch and keeps the proposal consumed', () => {
    const { store, proposal } = setup();
    const change = proposal();
    expect(change.cancel().frame.outcome).toBe('cancelled');
    expect(change.confirm(store).frame.outcome).toBe('cancelled');
    expect(store.getSnapshot().revision).toBe(0);
  });

  it('refuses a foreign store with the same run ID and revision', () => {
    const { store, proposal, actions } = setup();
    const foreign = createWidgetDataStore(undefined, { runId: store.getSnapshot().runId });
    const change = proposal();
    expect(change.confirm(foreign).frame.outcome).toBe('conflict');
    expect(actions.propose(frame, draft, foreign.getSnapshot())).toBeNull();
    expect(foreign.getSnapshot().revision).toBe(0);
    expect(store.getSnapshot().revision).toBe(0);
    expect(change.confirm(store).frame.outcome).toBe('applied');
  });

  it('refuses a superseded proposal at the executor', () => {
    const { store, proposal } = setup();
    const old = proposal();
    const latest = proposal();
    expect(old.confirm(store).frame.outcome).toBe('conflict');
    expect(store.getSnapshot().revision).toBe(0);
    expect(latest.confirm(store).frame.outcome).toBe('applied');
  });

  it('requires a fresh preview after an intervening data revision', () => {
    const { store, proposal, menus } = setup();
    const change = proposal();
    store.dispatch({ type: 'menu.create', name: '새 메뉴', category: 'dessert', price: 4000, idempotencyKey: 'other' });
    const receipt = change.confirm(store);
    expect(receipt.frame.outcome).toBe('conflict');
    expect(menus().some(menu => menu.name && 'raw' in menu.name && menu.name.raw === name)).toBe(false);
    const refreshed = change.refresh()!;
    expect(refreshed.id).not.toBe(change.id);
    expect(refreshed.preview.countBefore).toBe(menus().length);
    expect(refreshed.confirm(store).frame.outcome).toBe('applied');
  });

  it('locks before dispatch and does not reissue the write or notice after undo', () => {
    const { store, proposal } = setup();
    const change = proposal();
    const write = store.dispatch;
    const dispatch = vi.spyOn(store, 'dispatch').mockImplementation(command => {
      expect(change.confirm(store).frame.outcome).toBe('busy');
      return write(command);
    });
    const receipt = change.confirm(store);
    expect(store.undo(receipt.notice!.undo!.token).ok).toBe(true);
    expect(change.confirm(store)).toEqual({ frame: receipt.frame });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(store.getSnapshot().revision).toBe(2);
  });

  it('invalidates the first proposal on edit and requires a second confirmation', () => {
    const { store, proposal, menus } = setup();
    const change = proposal();
    const edit = change.edit()!;
    const amended = edit.preview({ ...draft, price: 6200 })!;
    expect(amended.preview.after.price).toBe(6200);
    expect(amended.id).not.toBe(change.id);
    expect(change.confirm(store).frame.outcome).toBe('cancelled');
    expect(store.getSnapshot().revision).toBe(0);
    expect(amended.confirm(store).frame.outcome).toBe('applied');
    expect(menus().at(-1)?.price).toBe(6200);
  });
});

it('requires a separate confirmation bound to the proposal ID for an extra-confirm frame', () => {
  const { actions, store } = setup();
  const proposal = actions.propose({ ...frame, tier: 'extra-confirm' }, draft, store.getSnapshot())!;
  expect(proposal.tier).toBe('extra-confirm');
  expect(proposal.confirm(store, proposal.id).requiresExtraConfirmation).toBe(true);
  expect(proposal.confirm(store, 'a-different-proposal').requiresExtraConfirmation).toBe(true);
  expect(store.getSnapshot().revision).toBe(0);
  expect(proposal.confirm(store, proposal.id).frame.outcome).toBe('applied');
  expect(store.getSnapshot().revision).toBe(1);
});
