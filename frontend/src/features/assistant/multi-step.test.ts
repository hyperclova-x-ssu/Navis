import { describe, expect, it, vi } from 'vitest';
import type {
  AgentActionProposal, AgentActionResult, AgentIntent, AgentMultiIntent, AgentMultiStep, AgentRequest,
} from '../../../shared/navis-agent-schema.mjs';
import { createWidgetDataStore, selectMenus } from '../../data/widget-data';
import { createAgentActions } from './agent-actions';
import { startMultiStepPlan, type MultiStepRunner } from './multi-step';

const runId = 'cafe-run';
const read = (featureId: string) => ({ kind: 'read', featureId } as const);
const menuPrice: AgentIntent = {
  kind: 'command', command: 'menu.update', args: { menuId: { handle: 'cafe-latte' }, patch: { price: { slot: 'price' } } },
};
const menuStatus: AgentIntent = {
  kind: 'command', command: 'menu.setSaleStatus', args: { menuId: { handle: 'americano' }, status: 'sold_out' },
};
const menuDelete: AgentIntent = { kind: 'command', command: 'menu.delete', args: { menuId: { handle: 'vanilla' } } };
const switchLayer: AgentIntent = { kind: 'command', command: 'ui.switch_layer', args: { layer: 'marketing' } };
const step = (id: string, intent: AgentMultiIntent, dependsOn?: readonly string[]): AgentMultiStep =>
  ({ id, intent, ...(dependsOn && { dependsOn }) });
const selector = (intent: Extract<AgentIntent, { kind: 'command' }>): AgentMultiIntent => ({ kind: 'command', command: intent.command });
const start = (...steps: readonly AgentMultiStep[]) => startMultiStepPlan({ planId: 'owner-turn', runId, steps });

function request(intent: AgentIntent, snapshotRevision = 10, view: Pick<AgentRequest, 'layer' | 'page'> = { layer: 'management', page: 1 }): AgentRequest {
  return { runId, snapshotRevision, ...view, businessDate: '2026-11-21', intent, slots: ['price', 'name'], catalog: [], snapshot: [], searches: [] };
}

function proposal(input: AgentRequest, proposalId: string, tier: 'normal' | 'extra-confirm' = 'normal'): AgentActionProposal {
  if (input.intent.kind === 'menu.create') {
    return { proposalId, snapshotRevision: input.snapshotRevision, runId: input.runId, layer: input.layer, page: input.page,
      command: 'menu.create', args: { category: input.intent.category, name: { slot: 'name' }, price: { slot: 'price' } }, tier };
  }
  if (input.intent.kind !== 'command' || input.intent.command !== 'menu.update' && input.intent.command !== 'menu.setSaleStatus'
    && input.intent.command !== 'menu.delete') throw new Error('Expected menu write');
  return { proposalId, snapshotRevision: input.snapshotRevision, runId: input.runId, layer: input.layer, page: input.page,
    command: input.intent.command, args: input.intent.args ?? {}, tier };
}

const receipt = (proposalId: string, outcome: AgentActionResult['outcome'], revision?: number) =>
  ({ frame: { proposalId, outcome, ...(revision !== undefined && { revision }) } });
const project = (flow: MultiStepRunner, body: AgentRequest) =>
  flow.projectNext(() => ({ kind: 'request', request: body }));

function card(flow: MultiStepRunner, body: AgentRequest, id: string, tier: 'normal' | 'extra-confirm' = 'normal') {
  const projected = project(flow, body);
  if (!projected) throw new Error('Expected an active projection');
  const frame = proposal(body, `wire-${id}`, tier);
  expect(flow.recordTurn(projected.attempt, { outcome: 'proposal' }, frame)).toBe(true);
  expect(flow.bindCard(projected.attempt, { id, command: frame.command, snapshotRevision: body.snapshotRevision, tier })).toBe(true);
  return projected.attempt;
}

describe('N21 client step runner', () => {
  it('requires separate card receipts for two writes and retains the last eligible receipt (S8-064)', () => {
    const flow = start(step('sold-out', selector(menuStatus)), step('price', selector(menuPrice)));
    const first = card(flow, request(menuStatus), 'sale');
    const fresh = vi.fn(() => ({ kind: 'request' as const, request: request(menuPrice, 11) }));

    expect(flow.projectNext(fresh)).toBeUndefined();
    expect(fresh).not.toHaveBeenCalled();
    expect(flow.recordCard(first, receipt('wire-sale', 'applied', 11), true)).toBe(false);
    expect(flow.recordCard(first, receipt('sale', 'busy'))).toBe(true);
    expect(flow.projectNext(fresh)).toBeUndefined();
    expect(flow.recordCard(first, receipt('sale', 'applied', 11), true)).toBe(true);
    expect(flow.recordCard(first, receipt('sale', 'applied', 11), true)).toBe(false);
    expect(flow.getState().latestUndo).toEqual({ stepId: 'sold-out', proposalId: 'sale' });
    expect(project(flow, request(menuPrice, 10))).toBeUndefined();
    const second = card(flow, request(menuPrice, 11), 'price');
    expect(flow.recordCard(second, receipt('price', 'applied', 12), true)).toBe(true);
    expect(flow.getState()).toEqual({
      phase: 'complete', results: [
        { stepId: 'sold-out', proposalId: 'sale', outcome: 'applied', revision: 11 },
        { stepId: 'price', proposalId: 'price', outcome: 'applied', revision: 12 },
      ],
      latestUndo: { stepId: 'price', proposalId: 'price' },
    });
    expect(flow.clearUndo('sale')).toBe(false);
    expect(flow.clearUndo('price')).toBe(true);
    expect(flow.getState().latestUndo).toBeUndefined();
  });

  it('gets a new read projection only after the write and accepts same-revision RunStore changes', () => {
    const flow = start(step('price', selector(menuPrice)), step('read', read('margin'), ['price']));
    const first = card(flow, request(menuPrice), 'first');
    let view: Pick<AgentRequest, 'layer' | 'page'> = { layer: 'management', page: 1 };
    const projector = vi.fn(() => ({ kind: 'request' as const, request: request(read('margin'), 10, view) }));
    expect(flow.projectNext(projector)).toBeUndefined();
    view = { layer: 'management', page: 3 };
    flow.recordCard(first, receipt('first', 'applied', 10));
    const next = flow.projectNext(projector);
    expect(projector).toHaveBeenCalledOnce();
    expect(next?.projection).toMatchObject({ request: { layer: 'management', page: 3, snapshotRevision: 10 } });
    expect(flow.recordTurn(next!.attempt, { outcome: 'reply' })).toBe(true);
    expect(flow.getState().results.map(result => result.outcome)).toEqual(['applied', 'read']);
  });

  it('pauses for missing values without losing the previous undo pointer (S8-063)', () => {
    const flow = start(step('stock', selector(menuPrice)), step('order', { kind: 'command', command: 'suppliers.createOrder' }));
    const first = card(flow, request(menuPrice), 'stock');
    flow.recordCard(first, receipt('stock', 'applied', 11), true);
    const clarification = flow.projectNext(() => ({ kind: 'clarify', field: 'quantity' }));
    expect(clarification).toEqual({ projection: { kind: 'clarify', field: 'quantity' } });
    expect(flow.getState()).toMatchObject({
      phase: 'awaiting_input', step: { id: 'order' }, latestUndo: { stepId: 'stock', proposalId: 'stock' },
    });
    const idle = vi.fn();
    expect(flow.projectNext(idle)).toBeUndefined();
    expect(idle).not.toHaveBeenCalled();
    expect(flow.projectNext(() => ({ kind: 'handoff' }), { resumeStepId: 'stock' })).toBeUndefined();
    expect(flow.projectNext(() => ({ kind: 'handoff' }), { resumeStepId: 'order' })).toEqual({ projection: { kind: 'handoff' } });
    expect(flow.getState().results.map(result => result.outcome)).toEqual(['applied', 'handoff']);
  });

  it('waits for a fresh menu lookup after the legacy create receipt (S8-069)', () => {
    const flow = start(step('create', { kind: 'command', command: 'menu.create' }), step('sell', selector(menuStatus), ['create']));
    const first = card(flow, request({ kind: 'menu.create', category: 'drink' }), 'create-card');
    const handles = new Map<string, string>();
    const lookup = vi.fn(() => ({ kind: 'request' as const, request: request({
      ...menuStatus, args: { ...menuStatus.args, menuId: { handle: handles.get('created')! } },
    }, 11) }));
    expect(flow.projectNext(lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    handles.set('created', 'fresh-menu');
    expect(flow.recordCard(first, receipt('create-card', 'applied', 11), true)).toBe(true);
    const next = flow.projectNext(lookup);
    expect(next?.projection).toMatchObject({ request: { intent: { args: { menuId: { handle: 'fresh-menu' } } } } });
  });

  it('blocks dependent and transitive steps while continuing an independent read after local invalidity (S8-067)', () => {
    const flow = start(step('invalid-price', selector(menuPrice)), step('margin', read('margin'), ['invalid-price']),
      step('result', read('menu'), ['margin']), step('independent', read('ledger')));
    expect(flow.projectNext(() => ({ kind: 'invalid' }))).toEqual({ projection: { kind: 'invalid' } });
    expect(flow.getState()).toMatchObject({ step: { id: 'independent' }, results: [
      { stepId: 'invalid-price', outcome: 'invalid' },
      { stepId: 'margin', outcome: 'blocked', blockedBy: ['invalid-price'] },
      { stepId: 'result', outcome: 'blocked', blockedBy: ['margin'] },
    ] });
    const next = project(flow, request(read('ledger')))!;
    flow.recordTurn(next.attempt, { outcome: 'reply' });
    expect(flow.getState()).toMatchObject({ phase: 'complete' });
  });

  it.each(['menu.delete', 'suppliers.cancelOrder'] as const)('keeps %s pending for two real confirmations', command => {
    const intent: AgentIntent = command === 'menu.delete' ? menuDelete
      : { kind: 'command', command, args: { poId: { handle: 'order' } } };
    const flow = start(step('destructive', selector(intent)), step('read', read('menu'), ['destructive']));
    const input = request(intent);
    const projected = project(flow, input)!;
    const wire = { runId, snapshotRevision: 10, layer: 'management', page: 1,
      proposalId: 'wire', command, args: intent.args!, tier: 'extra-confirm' } as const;
    expect(flow.recordTurn(projected.attempt, { outcome: 'proposal' }, { ...wire, tier: 'normal' })).toBe(false);
    expect(flow.recordTurn(projected.attempt, { outcome: 'proposal' }, wire)).toBe(true);
    expect(flow.bindCard(projected.attempt, { id: 'local', command, snapshotRevision: 10, tier: 'normal' })).toBe(false);
    expect(flow.bindCard(projected.attempt, { id: 'local', command, snapshotRevision: 10, tier: 'extra-confirm' })).toBe(true);
    expect(flow.recordCard(projected.attempt, receipt('local', 'applied', 11))).toBe(false);
    expect(flow.recordCard(projected.attempt, { ...receipt('local', 'invalid'), requiresExtraConfirmation: true })).toBe(true);
    expect(flow.getState().phase).toBe('awaiting_card');
    expect(flow.recordCard(projected.attempt, receipt('local', 'applied', 11))).toBe(true);
    expect(flow.getState()).toMatchObject({ phase: 'ready', step: { id: 'read' } });
  });

  it('reprojects a conflict and rejects both replayed IDs and late callbacks', () => {
    const flow = start(step('price', selector(menuPrice)), step('margin', read('margin')));
    const first = card(flow, request(menuPrice), 'first');
    expect(flow.recordCard(first, receipt('first', 'conflict', 12))).toBe(true);
    expect(project(flow, request(menuPrice, 12))).toBeUndefined();
    expect(flow.projectNext(() => ({ kind: 'request', request: request(menuPrice, 11) }), { resumeStepId: 'price' })).toBeUndefined();
    const newer = request(menuPrice, 12);
    const next = flow.projectNext(() => ({ kind: 'request', request: newer }), { resumeStepId: 'price' })!;
    expect(flow.recordCard(first, receipt('first', 'applied', 13))).toBe(false);
    expect(flow.recordTurn(next.attempt, { outcome: 'proposal' }, proposal(newer, 'wire-first'))).toBe(false);
    expect(flow.recordTurn(next.attempt, { outcome: 'proposal' }, proposal(newer, 'wire-new'))).toBe(true);
    expect(flow.bindCard(next.attempt, { id: 'first', command: 'menu.update', snapshotRevision: 12, tier: 'normal' })).toBe(false);
    expect(flow.bindCard(next.attempt, { id: 'new', command: 'menu.update', snapshotRevision: 12, tier: 'normal' })).toBe(true);
    expect(flow.recordCard(next.attempt, receipt('new', 'cancelled'))).toBe(true);
  });

  it('waits for the actual navigation outcome before projecting the next layer (S8-072)', () => {
    const flow = start(step('switch', selector(switchLayer)), step('read', read('customer-groups'), ['switch']));
    const projected = project(flow, request(switchLayer))!;
    const navigation = { command: 'ui.switch_layer', args: { layer: 'marketing' }, runId,
      layer: 'management', snapshotRevision: 10, page: 1 } as const;
    expect(flow.recordTurn(projected.attempt, { outcome: 'navigate', navigation: { ...navigation, page: 2 } })).toBe(false);
    expect(flow.recordTurn(projected.attempt, { outcome: 'navigate', navigation })).toBe(true);
    expect(project(flow, request(read('customer-groups')))).toBeUndefined();
    expect(flow.recordNavigation(projected.attempt, 'busy')).toBe(true);
    expect(flow.recordNavigation(projected.attempt, 'opened')).toBe(true);
    const fresh = request(read('customer-groups'), 10, { layer: 'marketing', page: 1 });
    expect(project(flow, fresh)?.projection).toEqual({ kind: 'request', request: fresh });
  });

  it('requires a checked local already result for a navigation reply', () => {
    const flow = start(step('switch', selector(switchLayer)), step('read', read('ledger')));
    const projected = project(flow, request(switchLayer))!;
    expect(flow.recordTurn(projected.attempt, { outcome: 'reply' })).toBe(true);
    expect(flow.getState().phase).toBe('awaiting_navigation');
    expect(flow.recordNavigation(projected.attempt, 'already')).toBe(true);
    expect(flow.getState().results).toEqual([{ stepId: 'switch', outcome: 'navigated' }]);
  });

  it('rejects a foreign run, wrong selector, mismatched proposal arguments and another runner’s attempt', () => {
    const flow = start(step('price', selector(menuPrice)), step('read', read('ledger')));
    const input = request(menuPrice);
    expect(project(flow, { ...input, runId: 'other' })).toBeUndefined();
    expect(project(flow, request(menuStatus))).toBeUndefined();
    const projected = project(flow, input)!;
    const foreign = project(start(step('price', selector(menuPrice)), step('read', read('ledger'))), input)!;
    expect(flow.recordTurn(foreign.attempt, { outcome: 'proposal' }, proposal(input, 'foreign'))).toBe(false);
    expect(flow.recordTurn(projected.attempt, { outcome: 'proposal' }, {
      ...proposal(input, 'mismatch'), args: { ...menuPrice.args, menuId: { handle: 'other' } },
    } as AgentActionProposal)).toBe(false);
    expect(flow.recordTurn(projected.attempt, { outcome: 'reply' })).toBe(false);
    expect(flow.recordTurn(projected.attempt, { outcome: 'proposal' }, proposal(input, 'correct'))).toBe(true);
  });

  it('handles local preparation failures and retains prior outcomes on stopping (S8-200)', () => {
    const flow = start(step('price', selector(menuPrice)), step('status', selector(menuStatus)), step('read', read('ledger')));
    const first = card(flow, request(menuPrice), 'price');
    flow.recordCard(first, receipt('price', 'applied', 11), true);
    const next = project(flow, request(menuStatus, 11))!;
    flow.recordTurn(next.attempt, { outcome: 'proposal' }, proposal(request(menuStatus, 11), 'wire-status'));
    expect(flow.recordPreparation(next.attempt, 'busy')).toBe(true);
    expect(flow.getState().phase).toBe('awaiting_card');
    expect(flow.recordPreparation(next.attempt, 'unchanged')).toBe(true);
    expect(flow.cancelStep('price')).toBe(false);
    expect(flow.stop()).toBe(true);
    expect(flow.getState()).toMatchObject({
      phase: 'complete', results: [
        { stepId: 'price', outcome: 'applied' }, { stepId: 'status', outcome: 'unchanged' }, { stepId: 'read', outcome: 'cancelled' },
      ], latestUndo: { stepId: 'price', proposalId: 'price' },
    });
  });

  it('records a refusal or a question that ended a step locally and blocks only its dependents (B23 sequencer)', () => {
    const flow = start(step('status', selector(menuStatus)), step('price', selector(menuPrice)), step('after', read('margin'), ['status']), step('plain', read('ledger')));
    const first = project(flow, request(menuStatus))!;
    expect(flow.recordLocal(first.attempt, 'refused')).toBe(true);
    expect(flow.recordLocal(first.attempt, 'refused')).toBe(false);
    expect(flow.getState()).toMatchObject({ phase: 'ready', step: { id: 'price' }, results: [{ stepId: 'status', outcome: 'refused' }] });
    const second = project(flow, request(menuPrice))!;
    expect(flow.recordLocal(second.attempt, 'clarify')).toBe(true);
    expect(flow.getState()).toMatchObject({ phase: 'awaiting_input', step: { id: 'price' } });
    expect(flow.recordLocal(first.attempt, 'unavailable')).toBe(false);
  });

  it('requires the card cancel receipt and blocks its dependency', () => {
    const flow = start(step('price', selector(menuPrice)), step('read', read('margin'), ['price']));
    const attempt = card(flow, request(menuPrice), 'price');
    expect(flow.stop()).toBe(false);
    expect(flow.cancelStep('price')).toBe(false);
    expect(flow.recordCard(attempt, receipt('price', 'cancelled'))).toBe(true);
    expect(flow.getState()).toEqual({ phase: 'complete', results: [
      { stepId: 'price', outcome: 'cancelled', proposalId: 'price' },
      { stepId: 'read', outcome: 'blocked', blockedBy: ['price'] },
    ] });
  });

  it('reads distinct selectors in order and rejects a substituted read (S8-070/S8-071)', () => {
    const flow = start(step('stock', read('inventory-booking')), step('delivery', read('suppliers')), step('sales', read('ledger')));
    for (const feature of ['inventory-booking', 'suppliers', 'ledger']) {
      expect(project(flow, request(read('margin')))).toBeUndefined();
      const projected = project(flow, request(read(feature)))!;
      expect(flow.recordTurn(projected.attempt, { outcome: 'reply' })).toBe(true);
    }
    expect(flow.getState().results).toEqual([
      { stepId: 'stock', outcome: 'read' }, { stepId: 'delivery', outcome: 'read' }, { stepId: 'sales', outcome: 'read' },
    ]);
  });
});

it('replays both S8-064 writes with the same café store and real card receipts', () => {
  const store = createWidgetDataStore(undefined, { runId });
  const actions = createAgentActions(store);
  const flow = start(step('sale', selector(menuStatus)), step('price', selector(menuPrice)));
  const menu = (id: string) => selectMenus(store.getSnapshot(), {}).rows.find(row => row.menuId === id)!;
  const firstMenu = 'm-americano', secondMenu = 'm-cafe-latte';
  const priorPrice = menu(secondMenu).price;
  const priorStatus = menu(firstMenu).saleStatus;

  function prepare(intent: typeof menuStatus | typeof menuPrice, targetId: string, handle: string, slots: Readonly<Record<string, number>>) {
    const before = store.getSnapshot();
    const projected = project(flow, request(intent, before.revision))!;
    const frame = proposal(projected.projection.request, `wire-${projected.attempt.stepId}`);
    expect(flow.recordTurn(projected.attempt, { outcome: 'proposal' }, frame)).toBe(true);
    const result = actions.prepare(frame, slots, before, () => true, new Map([[handle, { kind: 'menu', id: targetId }]]));
    if (result.kind !== 'proposal') throw new Error(`Expected a card, got ${result.kind}`);
    const { proposal: local } = result;
    expect(flow.bindCard(projected.attempt, { id: local.id, command: frame.command, snapshotRevision: local.snapshotRevision, tier: local.tier })).toBe(true);
    expect(store.getSnapshot()).toBe(before);
    expect(project(flow, request(menuPrice, before.revision))).toBeUndefined();
    return { projected, local };
  }

  const first = prepare(menuStatus, firstMenu, 'americano', {});
  expect(menu(firstMenu).saleStatus).toBe(priorStatus);
  const firstReceipt = first.local.confirm(store);
  expect(flow.recordCard(first.projected.attempt, firstReceipt, !!firstReceipt.undoToken)).toBe(true);
  expect(menu(firstMenu).saleStatus).toBe('sold_out');
  expect(menu(secondMenu).price).toBe(priorPrice);

  const second = prepare(menuPrice, secondMenu, 'cafe-latte', { price: 5500 });
  expect(second.projected.projection.request.snapshotRevision).toBe(firstReceipt.frame.revision);
  const secondReceipt = second.local.confirm(store);
  expect(flow.recordCard(second.projected.attempt, secondReceipt, !!secondReceipt.undoToken)).toBe(true);
  expect(menu(secondMenu).price).toBe(5500);
  expect(flow.getState().latestUndo).toEqual({ stepId: 'price', proposalId: second.local.id });
  expect(store.undo(secondReceipt.undoToken!).ok).toBe(true);
  expect(flow.clearUndo(second.local.id)).toBe(true);
  expect(menu(secondMenu).price).toBe(priorPrice);
  expect(menu(firstMenu).saleStatus).toBe('sold_out');
});

it('rejects the previous step’s continuation and reprojects stale navigation', () => {
  const flow = start(step('switch', selector(switchLayer)), step('read', read('ledger'), ['switch']));
  const body = request(switchLayer);
  const first = project(flow, body)!;
  const terminal = { outcome: 'navigate', navigation: { runId, layer: 'management',
    snapshotRevision: 10, page: 1, command: 'ui.switch_layer', args: { layer: 'marketing' } } } as const;
  expect(flow.recordTurn(first.attempt, terminal)).toBe(true);
  expect(flow.recordNavigation(first.attempt, 'stale')).toBe(true);
  expect(project(flow, body)).toBeUndefined();

  const retry = flow.projectNext(() => ({ kind: 'request', request: body }), { resumeStepId: 'switch' })!;
  expect(retry.attempt).not.toBe(first.attempt);
  expect(flow.recordTurn(retry.attempt, terminal)).toBe(true);
  expect(flow.recordNavigation(first.attempt, 'opened')).toBe(false);
  expect(flow.recordNavigation(retry.attempt, 'opened')).toBe(true);
  const stale = vi.fn(() => ({ kind: 'request' as const, request: request(read('ledger')) }));
  expect(flow.projectNext(stale, { resumeStepId: 'switch' })).toBeUndefined();
  expect(stale).not.toHaveBeenCalled();
});
