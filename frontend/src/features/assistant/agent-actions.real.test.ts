/**
 * R1-F17: the card runtime on the real data port (F00). A command bound to the port goes through `store.execute` and waits for the
 * authoritative receipt (pending -> confirmed | failed | stale | unknown outcome); a fixture command keeps the synchronous path.
 * Backend counterpart: the receipt/error shapes in `src/data/reality/00/PORT.md` §3 and §6.
 */
import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '../../catalog';
import { beginDashboard } from '../../app/test-session';
import { createRealPort, defineBinding, type DomainAdapter } from '../../data/reality/00';
import { fakeBackend, reply } from '../../data/reality/00/testing';
import type { MenuItem } from '../../data/db/types';
import { createWidgetDataStore } from '../../data/widget-data';
import { screenPresets } from '../../layout';
import { createRunStore, selectCommonNotice, type ChatReceiptNoticeRequest } from '../../state';
import { timePolicy } from '../../ui';
import { agentReceiptStatus, agentReceiptUndoSettled, applyAgentReceiptUndo, createAgentActions } from './agent-actions';
import { createProposalSession } from './navis-conversation';
import { assistantDomains } from './snapshot';
import { gateUnreadable } from './real-gate';
import { briefingAdapter } from '../../data/reality/12/adapter';
import { ackKey, briefingDay, briefingSession } from '../../data/reality/12/testing';
import { asOf, draft, frame, name, rig, undoUntil, type Mutable } from './real-card-rig';

describe('a run card over HTTP', () => {
  function briefingRig(adapter: DomainAdapter = briefingAdapter) {
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
      clock: () => 0, theme: 'light', reducedMotion: true });
    beginDashboard(run, 'cafe');
    run.actions.dismissCoach();
    run.actions.acknowledgeBriefing(); // the local arrival flag was dismissed before a write.
    const runId = run.getState().runId;
    const { backend, state } = briefingSession();
    const store = createWidgetDataStore(undefined, { runId });
    const port = createRealPort({ store, fetch: backend.fetch, adapters: [adapter], source: domain => domain === 'briefing' ? 'http' : 'fixture' });
    store.bindReal(port);
    const proposalFrame = () => ({ command: 'ui.acknowledgeBriefing' as const, args: {}, proposalId: 'wire-briefing',
      snapshotRevision: store.getSnapshot().revision, runId, layer: 'management' as const, tier: 'normal' as const });
    return { run, store, port, backend, state, proposalFrame };
  }

  it('waits for the day-specific server acknowledgement even if the arrival flag is dismissed', async () => {
    const t = briefingRig();
    const actions = createAgentActions(t.store, gateUnreadable(assistantDomains, t.store), t.run);
    expect(actions.prepare(t.proposalFrame(), {}, t.store.getSnapshot())).toMatchObject({
      kind: 'invalid', messageKey: 'data.real.error.SOURCE_UNAVAILABLE',
    });
    await t.port.load('briefing');
    const result = actions.prepare(t.proposalFrame(), {}, t.store.getSnapshot());
    if (result.kind !== 'proposal') throw new Error(`Briefing card missing: ${result.kind}`);
    expect(t.state.acknowledgement).toBeNull();
    const waiting = result.proposal.confirm(t.store);
    expect(waiting.pending).toBe(true);
    expect(result.proposal.confirm(t.store)).toBe(waiting);
    expect((await result.proposal.settled()).frame.outcome).toBe('applied');
    expect(t.backend.callsTo('POST', `/insight/briefings/${briefingDay}/ack`).map(call => call.headers.get('idempotency-key'))).toEqual([ackKey(briefingDay)]);
    expect(t.store.getSnapshot().tables.realBriefing?.acknowledgement).toEqual(t.state.acknowledgement);
    expect(actions.prepare(t.proposalFrame(), {}, t.store.getSnapshot()).kind).toBe('unchanged');
    t.run.dispose();
  });

  it('rejects a missing binding and an unrelated command under the same proposal frame', async () => {
    const t = briefingRig({ ...briefingAdapter, commands: [] });
    await t.port.load('briefing');
    const actions = createAgentActions(t.store, assistantDomains, t.run);
    expect(actions.prepare(t.proposalFrame(), {}, t.store.getSnapshot())).toMatchObject({
      kind: 'invalid', messageKey: 'data.real.error.SOURCE_UNAVAILABLE',
    });
    const execute = vi.fn();
    const wrong = createAgentActions(t.store, { ...assistantDomains,
      runCommand: () => ({ command: 'ui.acknowledgeBriefing', slots: {}, resolve: () => ({}),
        preflight: () => ({ kind: 'ready', preview: 'wrong command', execute,
          realCommand: { type: 'menu.create', name: '라테', category: 'drink', price: 4500, idempotencyKey: 'wrong' } }) }),
    }, t.run);
    expect(wrong.prepare(t.proposalFrame(), {}, t.store.getSnapshot()).kind).toBe('invalid');
    expect(execute).not.toHaveBeenCalled();
    expect(t.state.acknowledgements).toBe(0);
    t.run.dispose();
  });

  it('waits for account settlement and reports an account conflict without showing undo', async () => {
    const t = briefingRig();
    const initial = t.run.getState().theme;
    let finish!: (status: 'saved' | 'conflict') => void;
    const flush = vi.fn(() => new Promise<'saved' | 'conflict'>(resolve => { finish = resolve; }));
    const actions = createAgentActions(t.store, assistantDomains, t.run, () => ({ flush }));
    const result = actions.prepare({ ...t.proposalFrame(), command: 'settings.set_theme', args: { theme: 'dark' } }, {}, t.store.getSnapshot());
    if (result.kind !== 'proposal') throw new Error(`Theme card missing: ${result.kind}`);
    expect(flush).not.toHaveBeenCalled();
    const waiting = result.proposal.confirm(t.store);
    expect(waiting.pending).toBe(true);
    expect(waiting.undoToken).toBeUndefined();
    expect(result.proposal.confirm(t.store)).toBe(waiting);
    expect(flush).toHaveBeenCalledTimes(1);
    t.run.actions.setTheme(initial);
    finish('conflict');
    const receipt = await result.proposal.settled();
    expect(receipt.frame).toMatchObject({ outcome: 'conflict', messageKey: 'data.real.error.STALE_REVISION' });
    expect(receipt.undoToken).toBeUndefined();
    t.run.dispose();
  });

  it('flushes the inverse only from the owner’s visible undo receipt', async () => {
    const t = briefingRig();
    const flush = vi.fn<() => Promise<'saved'>>().mockResolvedValue('saved');
    const actions = createAgentActions(t.store, assistantDomains, t.run, () => ({ flush }));
    const result = actions.prepare({ ...t.proposalFrame(), command: 'settings.set_theme', args: { theme: 'dark' } }, {}, t.store.getSnapshot());
    if (result.kind !== 'proposal') throw new Error(`Theme card missing: ${result.kind}`);
    const session = createProposalSession(result.proposal, undefined, () => true, vi.fn(), '테마');
    session.confirm(t.store, result.proposal.id);
    const receipt = await result.proposal.settled();
    expect(receipt).toMatchObject({ frame: { outcome: 'applied' }, undoToken: result.proposal.id });
    await vi.waitFor(() => expect(session.getSnapshot().receiptIdentity).toBeDefined());
    const identity = session.getSnapshot().receiptIdentity!;
    t.run.actions.showNotice({ ...receipt.notice!, chatReceipt: identity } as ChatReceiptNoticeRequest);
    expect(applyAgentReceiptUndo(t.run, t.store, identity, result.proposal.id)).toBe(true);
    expect(agentReceiptStatus(t.run, receipt, identity)).toBe('undoing');
    expect(applyAgentReceiptUndo(t.run, t.store, identity, result.proposal.id)).toBe(true);
    await agentReceiptUndoSettled(identity);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(t.run.getState().theme).toBe('light');
    expect(agentReceiptStatus(t.run, receipt, identity)).toBe('undone');
    t.run.dispose();
  });
});

describe('a real-bound card press', () => {
  it('is pending first, shows nothing as saved, then confirms with the authoritative receipt and the real undo token', async () => {
    const t = rig();
    const before = t.names().length;
    const card = t.create();
    const pending = card.confirm(t.store);
    expect(pending).toMatchObject({ pending: true, frame: { proposalId: card.id } });
    expect(t.names()).toHaveLength(before);
    const final = await card.settled();
    expect(final.pending).toBeUndefined();
    expect(final.frame).toMatchObject({ proposalId: card.id, outcome: 'applied' });
    expect(final.undoToken).toBe('real-undo:rc-1');
    expect(final.notice).toMatchObject({ kind: 'success', messageKey: 'data.management.notice.saved', undo: { target: 'data', token: 'real-undo:rc-1' }, undoUntil: Date.parse(undoUntil) });
    expect(final.createdRecord).toEqual({ kind: 'menu', id: 'm-new' });
    expect(t.names()).toContain(name);
    expect(card.getReceipt()).toBe(final);
  });

  it('sends one request under the card key however often it is pressed', async () => {
    const t = rig();
    const card = t.create();
    const first = card.confirm(t.store);
    expect(card.confirm(t.store)).toBe(first);
    const final = await card.settled();
    expect(card.confirm(t.store)).toBe(final);
    const calls = t.backend.callsTo('POST', '/inventory/menu');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('idempotency-key')).toBe(`navis:${t.runId}:${card.id}`);
    expect(t.server.filter(item => item.menuId === 'm-new')).toHaveLength(1);
  });

  it('reports a rejected write as a failed card with the domain message and field, and no undo', async () => {
    const t = rig({ failCreate: () => reply(400, { code: 'VALIDATION', reason: 'PRICE_INVALID', field: 'price' }) });
    const card = t.create();
    card.confirm(t.store);
    const final = await card.settled();
    expect(final).toMatchObject({ frame: { outcome: 'invalid', messageKey: 'data.management.error.PRICE_INVALID' }, field: 'price' });
    expect(final.undoToken).toBeUndefined();
    expect(t.names()).not.toContain(name);
  });

  it('treats a stale revision as a conflict that needs a refreshed card, and the refreshed card carries the re-read revision', async () => {
    const t = rig();
    await t.port.load('menu');
    const card = t.statusCard();
    // Another session changed the menu after the preview, before the press.
    t.revisions.set('m-americano', 2);
    const final = await (card.confirm(t.store), card.settled());
    expect(final.frame.outcome).toBe('conflict');
    expect(t.backend.callsTo('PATCH', /m-americano/)[0].body).toMatchObject({ saleStatus: 'sold_out', expectedRevision: 1 });
    const fresh = card.refresh()!;
    expect(fresh.id).not.toBe(card.id);
    fresh.confirm(t.store);
    expect((await fresh.settled()).frame.outcome).toBe('applied');
    const [, second] = t.backend.callsTo('PATCH', /m-americano/);
    expect(second.body).toMatchObject({ expectedRevision: 2 });
    expect(second.headers.get('idempotency-key')).not.toBe(t.backend.callsTo('PATCH', /m-americano/)[0].headers.get('idempotency-key'));
  });

  it('reports a stale card as unchanged when the re-read already satisfies it', async () => {
    const t = rig();
    await t.port.load('menu');
    const card = t.statusCard();
    (t.server.find(item => item.menuId === 'm-americano') as Mutable<MenuItem>).saleStatus = 'sold_out';
    t.revisions.set('m-americano', 2);
    card.confirm(t.store);
    const final = await card.settled();
    expect(final.frame).toEqual({ proposalId: card.id, outcome: 'unchanged' });
    expect(card.refresh()).toBeNull();
  });

  it('keeps an unknown outcome unconfirmed and re-checks with the same key, never creating a second record', async () => {
    let lost = 3;
    const created = new Map<string, object>();
    const backend = fakeBackend();
    // The server applies the write on the first call, then the response is lost three times (all automatic resends fail).
    backend.on('POST', '/inventory/menu', call => {
      const key = call.headers.get('idempotency-key') ?? '';
      if (!created.has(key)) created.set(key, { resourceId: 'm-new', revision: 1, receiptId: 'rc-1', undoUntil, affectedSources: ['menu'], changed: true });
      if (lost-- > 0) throw new TypeError('network lost');
      return created.get(key);
    });
    const store = createWidgetDataStore(undefined, { runId: 'unknown-run' });
    const adapter: DomainAdapter = { domain: 'menu', sources: ['menu'], tables: ['menuItem'], async load() { return { tables: {}, asOf, sourceRevision: 1, complete: true }; },
      commands: [defineBinding({ type: 'menu.create', receiptBase: '/inventory', request: c => ({ method: 'POST', path: '/inventory/menu', body: { name: c.name } }) })] };
    store.bindReal(createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [adapter], sleep: async () => {}, reconcileDelaysMs: [0, 0] }));
    const card = createAgentActions(store).propose(frame, draft, store.getSnapshot())!;
    card.confirm(store);
    const unknown = await card.settled();
    expect(unknown).toMatchObject({ uncertain: true, recheckable: true, frame: { outcome: 'invalid' } });
    expect(unknown.undoToken).toBeUndefined();
    const rechecking = card.recheck(store);
    expect(rechecking.pending).toBe(true);
    expect(card.confirm(store)).toBe(rechecking);
    expect((await card.settled()).frame.outcome).toBe('applied');
    expect(new Set(backend.callsTo('POST', '/inventory/menu').map(call => call.headers.get('idempotency-key'))).size).toBe(1);
    expect(created.size).toBe(1);
  });

  it('keeps fixture commands synchronous and unchanged', () => {
    const store = createWidgetDataStore(undefined, { runId: 'fixture-run' });
    const card = createAgentActions(store).propose(frame, draft, store.getSnapshot())!;
    const receipt = card.confirm(store);
    expect(receipt.pending).toBeUndefined();
    expect(receipt.frame.outcome).toBe('applied');
    expect(receipt.undoToken).toMatch(/^data-undo:/);
  });

  it('does not recheck a card that never reached an unknown outcome', async () => {
    const t = rig();
    const card = t.create();
    expect(card.recheck(t.store).frame.outcome).toBe('conflict');
    card.confirm(t.store);
    await card.settled();
    expect(card.recheck(t.store).frame.outcome).toBe('applied');
    expect(t.backend.callsTo('POST', '/inventory/menu')).toHaveLength(1);
  });
});

describe('the proposal session around a real press', () => {
  it('publishes pending, then the confirmed receipt once, and refreshes a stale card', async () => {
    const t = rig();
    await t.port.load('menu');
    const card = t.create();
    const onApplied = vi.fn();
    const session = createProposalSession(card, card, () => true, onApplied, '메뉴');
    const settled = vi.fn();
    const first = session.confirm(t.store, card.id, false, settled);
    expect(first).toMatchObject({ pending: true });
    expect(session.getSnapshot().feedback).toBe(first);
    expect(session.isPending()).toBe(false);
    expect(session.confirm(t.store, card.id, false, settled)).toBeUndefined();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(session.getSnapshot()).toMatchObject({ receiptIdentity: { proposalId: card.id }, feedback: { frame: { outcome: 'applied' } } });
    expect(onApplied).toHaveBeenCalledOnce();
    expect(t.backend.callsTo('POST', '/inventory/menu')).toHaveLength(1);

    const sale = t.statusCard();
    const staleSession = createProposalSession(sale, undefined, () => true, vi.fn(), '메뉴');
    t.revisions.set('m-americano', 5);
    staleSession.confirm(t.store, sale.id, false);
    await vi.waitFor(() => expect(staleSession.getSnapshot().proposal.id).not.toBe(sale.id));
    expect(staleSession.getSnapshot()).toMatchObject({ reproposed: true });
    expect(staleSession.isPending()).toBe(true);
  });

  it('does not retire a card that is in flight when the chat closes', async () => {
    const t = rig();
    const card = t.create();
    const session = createProposalSession(card, card, () => true, vi.fn(), '메뉴');
    session.confirm(t.store, card.id);
    expect(session.retireForClose()).toBe(false);
    await card.settled();
    expect(session.getSnapshot().closed).toBeUndefined();
  });
});

describe('undo of a real receipt', () => {
  function receiptRig() {
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
    beginDashboard(run, 'cafe');
    run.actions.dismissCoach();
    return { ...rig({ runId: run.getState().runId }), run };
  }

  it('is pending, then undone once even if pressed twice, and re-reads the dependent data', async () => {
    const t = receiptRig();
    const card = t.create();
    const session = createProposalSession(card, card, () => true, vi.fn(), '메뉴');
    session.confirm(t.store, card.id);
    const final = await card.settled();
    const identity = session.getSnapshot().receiptIdentity!;
    const receiptNotice: ChatReceiptNoticeRequest = { ...final.notice!, chatReceipt: identity };
    t.run.actions.showNotice(receiptNotice);
    expect(selectCommonNotice(t.run.getState())?.undo?.token).toBe('real-undo:rc-1');
    expect(agentReceiptStatus(t.run, final, identity)).toBe('applied');
    expect(applyAgentReceiptUndo(t.run, t.store, identity, 'real-undo:rc-1')).toBe(true);
    expect(agentReceiptStatus(t.run, final, identity)).toBe('undoing');
    expect(applyAgentReceiptUndo(t.run, t.store, identity, 'real-undo:rc-1')).toBe(true);
    await agentReceiptUndoSettled(identity);
    expect(agentReceiptStatus(t.run, final, identity)).toBe('undone');
    expect(t.undoCalls()).toBe(1);
    expect(t.names()).not.toContain(name);
    expect(selectCommonNotice(t.run.getState())).toMatchObject({ kind: 'complete' });
  });

  it('shows the reason and keeps the receipt when the server refuses the undo', async () => {
    const t = receiptRig();
    t.backend.on('POST', /^\/inventory\/receipts\/.+\/undo$/, () => reply(409, { code: 'CONFLICT', reason: 'UNDO_EXPIRED' }));
    const card = t.create();
    const session = createProposalSession(card, card, () => true, vi.fn(), '메뉴');
    session.confirm(t.store, card.id);
    const final = await card.settled();
    const identity = session.getSnapshot().receiptIdentity!;
    const receiptNotice: ChatReceiptNoticeRequest = { ...final.notice!, chatReceipt: identity };
    t.run.actions.showNotice(receiptNotice);
    applyAgentReceiptUndo(t.run, t.store, identity, 'real-undo:rc-1');
    await agentReceiptUndoSettled(identity);
    expect(agentReceiptStatus(t.run, final, identity)).not.toBe('undone');
    expect(selectCommonNotice(t.run.getState())).toMatchObject({ kind: 'error', messageKey: 'data.real.error.UNDO_EXPIRED' });
    expect(t.names()).toContain(name);
  });
});
