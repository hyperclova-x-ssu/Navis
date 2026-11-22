/**
 * R1-F08: the Navis custom-order cards on the real data port. The card runs the widget's own command (`customTemplate.generate`,
 * `customOrder.*`, `pickup.*`); only the press executes it, it waits for the POS service's receipt, and the undo is the receipt's.
 */
import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '../../../catalog';
import { beginDashboard } from '../../../app/test-session';
import { createWidgetDataStore } from '../../../data/widget-data';
import { selectCustomOrders, selectCustomOrderRead } from '../../../data/widget-data';
import { createRealPort } from '../../../data/reality/00';
import { customAdapter } from '../../../data/reality/08/adapter';
import { customService } from '../../../data/reality/08/testing';
import { screenPresets } from '../../../layout';
import { createRunStore, selectCommonNotice, type ChatReceiptNoticeRequest } from '../../../state';
import { timePolicy } from '../../../ui';
import { agentReceiptStatus, agentReceiptUndoSettled, applyAgentReceiptUndo, createAgentActions } from '../agent-actions';
import { createProposalSession } from '../navis-conversation';

function rig() {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const runId = run.getState().runId;
  const service = customService();
  const store = createWidgetDataStore(undefined, { runId });
  const port = createRealPort({ store, source: domain => domain === 'custom' ? 'http' : 'fixture', adapters: [customAdapter], fetch: service.backend.fetch, sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const actions = createAgentActions(store, undefined, run);
  const generateCard = () => {
    const snapshot = store.getSnapshot();
    const prepared = actions.prepare({ command: 'customTemplate.generate', args: { productKind: { slot: 'productKind' }, keywords: { slot: 'keywords' } }, snapshotRevision: snapshot.revision,
      proposalId: 'wire-custom', runId, layer: 'management', tier: 'normal' }, { productKind: '케이크', keywords: '레터링' }, snapshot, () => true, new Map(), run.getState());
    if (prepared.kind !== 'proposal') throw new Error(`The custom card did not resolve (${prepared.kind})`);
    return prepared.proposal;
  };
  return { run, store, port, service, actions, generateCard };
}

describe('a custom-order card on the real port', () => {
  it('calls nothing until pressed, then waits for the service receipt and shows the receipt only then', async () => {
    const t = rig();
    await t.port.load('custom');
    const card = t.generateCard();
    expect(t.service.backend.callsTo('POST', '/pos/custom-templates/generate')).toHaveLength(0);
    const pending = card.confirm(t.store);
    expect(pending).toMatchObject({ pending: true });
    expect(selectCustomOrders(selectCustomOrderRead(t.store.getSnapshot())).templates).toHaveLength(0);
    const final = await card.settled();
    expect(final.frame).toMatchObject({ proposalId: card.id, outcome: 'applied' });
    expect(t.service.backend.callsTo('POST', '/pos/custom-templates/generate')).toHaveLength(1);
    expect(t.service.backend.callsTo('POST', '/pos/custom-templates/generate')[0].body).toEqual({ productKind: '케이크', keywords: '레터링' });
    expect(selectCustomOrders(selectCustomOrderRead(t.store.getSnapshot())).templates.map(template => template.name)).toEqual(['케이크 주문서']);
    // Pressing again is the same press: one request, one record.
    expect(card.confirm(t.store)).toBe(final);
    expect(t.service.backend.callsTo('POST', '/pos/custom-templates/generate')).toHaveLength(1);
  });

  it('keeps the undo on the visible receipt: the real token goes through the shared receipt path, not store.undo', async () => {
    const t = rig();
    await t.port.load('custom');
    const card = t.generateCard();
    const session = createProposalSession(card, undefined, () => true, vi.fn(), '주문제작');
    session.confirm(t.store, card.id);
    const final = await card.settled();
    expect(final.undoToken).toMatch(/^real-undo:/);
    expect(final.notice).toMatchObject({ kind: 'success', undo: { target: 'data', token: final.undoToken }, undoUntil: Date.parse('2999-01-01T00:00:00Z') });
    const identity = session.getSnapshot().receiptIdentity!;
    const receiptNotice: ChatReceiptNoticeRequest = { ...final.notice!, chatReceipt: identity };
    t.run.actions.showNotice(receiptNotice);
    expect(selectCommonNotice(t.run.getState())?.undo?.token).toBe(final.undoToken);
    const undo = vi.spyOn(t.store, 'undo');
    expect(applyAgentReceiptUndo(t.run, t.store, identity, final.undoToken!)).toBe(true);
    expect(agentReceiptStatus(t.run, final, identity)).toBe('undoing');
    await agentReceiptUndoSettled(identity);
    expect(undo).not.toHaveBeenCalled();
    expect(agentReceiptStatus(t.run, final, identity)).toBe('undone');
    expect(t.service.backend.callsTo('POST', /\/pos\/custom-receipts\/receipts\/.+\/undo$/)).toHaveLength(1);
    expect(selectCustomOrders(selectCustomOrderRead(t.store.getSnapshot())).templates).toHaveLength(0);
  });
});
