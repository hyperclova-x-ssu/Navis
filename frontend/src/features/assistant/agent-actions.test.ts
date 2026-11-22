import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '../../catalog';
import { createWidgetDataStore, selectMenus, selectWidget } from '../../data/widget-data';
import { beginDashboard } from '../../app/test-session';
import { screenPresets } from '../../layout';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui';
import { createAgentActions } from './agent-actions';
import { menuCommandAdapter } from './domains/menu';

const name = '흑임자 크림 라테';
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

  it('rechecks the compiled write at press time and requires approval for a changed preview', () => {
    const { store, proposal } = setup();
    const preflight = menuCommandAdapter.preflight;
    let changed = false;
    const spy = vi.spyOn(menuCommandAdapter, 'preflight').mockImplementation((input, context) => {
      const result = preflight(input, context);
      return changed && result.kind === 'ready' ? { ...result, preview: { ...result.preview, countAfter: result.preview.countAfter + 1 } } : result;
    });
    try {
      const first = proposal();
      changed = true;
      expect(first.confirm(store).frame.outcome).toBe('conflict');
      expect(store.getSnapshot().revision).toBe(0);
      const fresh = first.refresh()!;
      expect(fresh.id).not.toBe(first.id);
      expect(fresh.confirm(store).frame.outcome).toBe('applied');
      expect(store.getSnapshot().revision).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('locks the attempt after an uncertain dispatcher failure', () => {
    const { store, proposal } = setup();
    const change = proposal();
    const dispatch = vi.spyOn(store, 'dispatch').mockImplementation(() => { throw new Error('result missing'); });
    const first = change.confirm(store);
    expect(first).toMatchObject({ frame: { outcome: 'invalid' }, uncertain: true });
    expect(change.confirm(store)).toBe(first);
    expect(change.edit()).toBeNull();
    expect(change.refresh()).toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('locks before dispatch and does not reissue the write or notice after undo', () => {
    const { store, proposal } = setup();
    const change = proposal();
    const write = store.dispatch;
    const dispatch = vi.spyOn(store, 'dispatch').mockImplementation(command => {
      expect(change.confirm(store)).toMatchObject({ frame: { outcome: 'busy' }, retryable: true });
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

function saleStatusCard(store = createWidgetDataStore(undefined, { runId: 'agent-test' }), status: 'sold_out' | 'selling' = 'sold_out') {
  const snapshot = store.getSnapshot();
  const actions = createAgentActions(store);
  const result = actions.prepare({
    command: 'menu.setSaleStatus', args: { menuId: { handle: 'selected' }, status }, snapshotRevision: snapshot.revision,
    proposalId: 'fixture-proposal', runId: snapshot.runId ?? 'run', layer: 'management', tier: 'normal',
  }, {}, snapshot, () => true, new Map([['selected', { kind: 'menu' as const, id: 'm-americano' }]]));
  if (result.kind !== 'proposal') throw new Error(result.kind);
  return { store, proposal: result.proposal, status: () => selectMenus(store.getSnapshot(), {}).rows.find(row => row.menuId === 'm-americano')?.saleStatus };
}

describe('same-value and stale distinctions (G-021)', () => {
  it('reports a card as unchanged, without a revision, when a later change already satisfies it', () => {
    const { store, proposal, status } = saleStatusCard();
    expect(store.dispatch({ type: 'menu.setSaleStatus', menuId: 'm-americano', status: 'sold_out' }).ok).toBe(true);
    const revision = store.getSnapshot().revision;
    const receipt = proposal.confirm(store);
    expect(receipt.frame).toEqual({ proposalId: proposal.id, outcome: 'unchanged' });
    expect(receipt.frame).not.toHaveProperty('revision');
    expect(status()).toBe('sold_out');
    expect(store.getSnapshot().revision).toBe(revision);
    expect(proposal.confirm(store)).toBe(receipt);
    expect(proposal.refresh()).toBeNull();
  });

  it('keeps a stale card with a different diff as a conflict that needs a fresh preview and a fresh press', () => {
    const { store, proposal, status } = saleStatusCard();
    expect(store.dispatch({ type: 'menu.update', menuId: 'm-americano', patch: { price: 5200 } }).ok).toBe(true);
    const revision = store.getSnapshot().revision;
    expect(proposal.confirm(store).frame.outcome).toBe('conflict');
    expect(status()).toBe('selling');
    expect(store.getSnapshot().revision).toBe(revision);
    const fresh = proposal.refresh()!;
    expect(fresh.id).not.toBe(proposal.id);
    expect(fresh.confirm(store).frame).toMatchObject({ outcome: 'applied' });
    expect(status()).toBe('sold_out');
  });

  it('applies one exact diff once and returns the local identity the command reported', () => {
    const { store, actions } = setup();
    const change = actions.propose(frame, draft, store.getSnapshot())!;
    const receipt = change.confirm(store);
    expect(receipt.frame.outcome).toBe('applied');
    expect(receipt.createdRecord).toMatchObject({ kind: 'menu', id: expect.any(String) });
    expect(selectMenus(store.getSnapshot(), {}).rows.some(row => row.menuId === receipt.createdRecord?.id)).toBe(true);
    const revision = store.getSnapshot().revision;
    expect(change.confirm(store)).toEqual({ frame: receipt.frame });
    expect(store.getSnapshot().revision).toBe(revision);
  });

  it('returns no applied result on the first press of an extra-confirm card and one result on the second', () => {
    const { store, actions } = setup();
    const change = actions.propose({ ...frame, tier: 'extra-confirm' }, draft, store.getSnapshot())!;
    const first = change.confirm(store);
    expect(first).toMatchObject({ requiresExtraConfirmation: true, frame: { outcome: 'invalid' } });
    expect(first.createdRecord).toBeUndefined();
    expect(first.undoToken).toBeUndefined();
    expect(store.getSnapshot().revision).toBe(0);
    const second = change.confirm(store, change.id);
    expect(second.frame.outcome).toBe('applied');
    expect(change.confirm(store, change.id)).toEqual({ frame: second.frame });
  });
});

it('links a card to its wire proposal and keeps that link on a refreshed card', () => {
  const { store, proposal } = saleStatusCard();
  expect(proposal.wireProposalId).toBe('fixture-proposal');
  expect(store.dispatch({ type: 'menu.update', menuId: 'm-americano', patch: { price: 5300 } }).ok).toBe(true);
  expect(proposal.confirm(store).frame.outcome).toBe('conflict');
  expect(proposal.refresh()?.wireProposalId).toBe('fixture-proposal');
});

describe('run-scoped proposals (G-021)', () => {
  function runCard(options: { layer?: 'management' | 'marketing'; page?: number } = {}) {
    const store = createWidgetDataStore(undefined, { runId: 'agent-run' });
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
    beginDashboard(run, 'cafe');
    run.actions.dismissCoach();
    const runId = run.getState().runId;
    const live = createWidgetDataStore(undefined, { runId });
    const snapshot = live.getSnapshot();
    const result = createAgentActions(live, undefined, run).prepare({
      command: 'settings.set_text_scale', args: { scale: 125 }, snapshotRevision: snapshot.revision, proposalId: 'fixture-proposal',
      runId, layer: options.layer ?? 'management', page: options.page ?? 1, tier: 'normal',
    }, {}, snapshot, () => true);
    return { run, store: live, result, dispose: () => { run.dispose(); store.getSnapshot(); } };
  }

  it('prepares a card for the visible layer and page', () => {
    const { result, dispose } = runCard();
    try { expect(result.kind).toBe('proposal'); } finally { dispose(); }
  });

  it('retires a pending run card when the owner leaves its layer before the press', () => {
    const { run, store, result, dispose } = runCard();
    try {
      if (result.kind !== 'proposal') throw new Error(result.kind);
      expect(result.proposal.isCurrent()).toBe(true);
      run.actions.switchLayer('marketing');
      expect(result.proposal.isCurrent()).toBe(false);
      expect(result.proposal.confirm(store).frame.outcome).toBe('conflict');
      expect(run.getState().textScale).toBe(100);
    } finally { dispose(); }
  });

  it('retires a pending run card when the owner changes the viewed page before the press', () => {
    const { run, store, result, dispose } = runCard();
    try {
      if (result.kind !== 'proposal') throw new Error(result.kind);
      run.actions.addPage();
      if (run.getState().boards.management.currentPage === 0) run.actions.goToPage(1);
      expect(run.getState().boards.management.currentPage).toBe(1);
      expect(result.proposal.isCurrent()).toBe(false);
      expect(result.proposal.confirm(store).frame.outcome).toBe('conflict');
      expect(run.getState().textScale).toBe(100);
    } finally { dispose(); }
  });
});
