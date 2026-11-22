import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentRequest } from '../../shared/navis-agent-schema.mjs';
import { createRecordProjection, recordSearchKey, resolveAgentTarget } from './record-projection.mjs';

const scope = { runId: 'cafe-run', snapshotRevision: 12, slots: ['name', 'otherName'] };
const lookup = { kind: 'menu', querySlot: 'name' };
const queryBinding = 'lookup-7a30';
const exact = { handle: 'match-dd6e', match: 'exact', label: '카페라테', fields: { kind: 'menu' } };
const similar = { handle: 'match-63fa', match: 'similar', label: '바닐라라테', fields: { kind: 'menu' } };
const first = { ...lookup, queryBinding, matches: [similar], nextCursor: 'cursor-02' };
const second = { ...lookup, queryBinding, cursor: 'cursor-02', matches: [exact], nextCursor: 'cursor-03' };
const third = { ...lookup, queryBinding, cursor: 'cursor-03', matches: [{ ...similar, handle: 'match-8a2e' }] };
const intent = { kind: 'read', recordKind: 'menu', querySlot: 'name', queryBinding };
const ownerKey = 'verified-store-and-session';
const project = (searches, patch) => createRecordProjection({ ...scope, ...patch, searches });

test('record lookup keeps only opaque keys and safe match fields on the tool result', () => {
  const index = project([{ ...lookup, queryBinding, matches: [exact, similar] }]);
  const turn = index.openLookup();
  assert.equal(index.searches.has(recordSearchKey(lookup)), true);
  assert.equal(turn.referencesAreScoped([{ slot: 'name' }, { handle: exact.handle, kinds: ['menu'] }]), true);
  assert.equal(turn.referencesAreScoped([{ handle: exact.handle }], { observed: true }), false);
  const { data } = turn.readRecords(lookup, intent);
  assert.deepEqual(data, { status: 'ready', matches: [exact, similar] });
  assert.deepEqual(resolveAgentTarget(data), { match: exact });
  assert.deepEqual(resolveAgentTarget({ status: 'ready', matches: [similar] }), { choices: [similar] });
  assert.deepEqual(resolveAgentTarget({ status: 'ready', matches: [exact, { ...exact, handle: 'another' }, similar] }),
    { choices: [exact, { ...exact, handle: 'another' }] });
  assert.equal(turn.referencesAreScoped([{ handle: exact.handle }], { observed: true }), true);
  assert.equal(turn.referencesAreScoped([{ handle: exact.handle, kinds: ['stock'] }], { observed: true }), false);
  assert.equal(turn.referencesAreScoped([{ handle: exact.handle, querySlot: 'otherName' }], { observed: true }), false);
  assert.equal(turn.referencesAreScoped([{ handle: exact.handle, queryBinding: 'another' }], { observed: true }), false);
  assert.equal(turn.readRecords(lookup, intent).repeated, true);
  assert.equal(turn.issueLookup(lookup), undefined);
});

test('only the requested lookup can read an issued next page in the same turn', () => {
  const turn = project([first, second, third]).openLookup();
  const cursor2 = { ...lookup, cursor: second.cursor };
  const cursor3 = { ...lookup, cursor: third.cursor };
  assert.throws(() => turn.readRecords(cursor2, intent), { reason: 'record_cursor' });
  assert.equal(turn.readRecords(lookup, intent).data.nextCursor, second.cursor);
  assert.throws(() => turn.readRecords(cursor3, intent), { reason: 'record_cursor' });
  for (const args of [{ ...cursor2, kind: 'stock' }, { ...cursor2, querySlot: 'otherName' }]) {
    assert.throws(() => turn.readRecords(args, intent), { reason: 'record_read_scope' });
    assert.throws(() => turn.readRecords(args, intent, { adapterLookup: true }), { reason: 'record_cursor' });
  }
  assert.deepEqual(turn.readRecords(cursor2, intent).data.matches, [exact]);
  assert.deepEqual(turn.readRecords(cursor3, intent).data.matches, third.matches);
});

test('external continuation needs an issued receipt and the original current projection', () => {
  const start = project([first]).openLookup({ ownerKey });
  assert.equal(start.issueLookup(lookup), undefined);
  start.readRecords(lookup, intent);
  const previousLookup = start.issueLookup(lookup);
  assert.ok(previousLookup);
  const next = { ...lookup, cursor: second.cursor };
  const continuation = { ...intent, reads: [{ name: 'search_records', args: next }] };
  for (const [index, externalOwner, receipt] of [
    [project([first, second]), ownerKey, {}],
    [project([first, second]), 'another-owner', previousLookup],
    [project([first, second], { runId: 'another-run' }), ownerKey, previousLookup],
    [project([first, second], { snapshotRevision: 13 }), ownerKey, previousLookup],
    [project([{ ...first, queryBinding: 'other-binding' }, { ...second, queryBinding: 'other-binding' }]), ownerKey, previousLookup],
    [project([{ ...first, matches: [{ ...similar, handle: 'unrelated-match' }] }, second]), ownerKey, previousLookup],
  ]) {
    assert.throws(() => index.openLookup({ ownerKey: externalOwner, previousLookup: receipt })
      .readRecords(next, continuation), { reason: 'record_cursor' });
  }
  const continued = project([first, second]).openLookup({ ownerKey, previousLookup });
  assert.throws(() => continued.readRecords(next, intent), { reason: 'record_cursor' });
  assert.deepEqual(continued.readRecords(next, continuation).data.matches, [exact]);
  const pageTwo = continued.issueLookup(next);
  assert.ok(pageTwo);
  const last = { ...lookup, cursor: third.cursor };
  const pageThree = project([first, third]).openLookup({ ownerKey, previousLookup: pageTwo });
  assert.deepEqual(pageThree.readRecords(last, { ...intent, cursor: last.cursor }).data.matches, third.matches);
});

test('selection is limited to a candidate on the issued page and the current original lookup', () => {
  const menu = { ...first, matches: [exact, similar] };
  const turn = project([menu]).openLookup({ ownerKey });
  turn.readRecords(lookup, intent);
  const previousLookup = turn.issueLookup(lookup);
  const selected = { ...lookup, queryBinding, handle: exact.handle };
  const continued = project([menu]).openLookup({ ownerKey, previousLookup });
  assert.deepEqual(continued.resolveSelection(selected), exact);
  for (const extra of [{ kind: 'stock' }, { querySlot: 'otherName' }, { queryBinding: 'other-query' },
    { handle: similar.handle }, { handle: 'never-issued' }]) {
    assert.equal(continued.resolveSelection({ ...selected, ...extra }), undefined);
  }
  assert.equal(project([menu], { snapshotRevision: 13 }).openLookup({ ownerKey, previousLookup }).resolveSelection(selected), undefined);
  assert.equal(project([menu]).openLookup({ ownerKey: 'another-owner', previousLookup }).resolveSelection(selected), undefined);
  assert.equal(project([menu]).openLookup({ ownerKey }).resolveSelection(selected), undefined);
  assert.throws(() => continued.readRecords(lookup, intent, { selection: { ...selected, handle: similar.handle } }),
    { reason: 'record_selection' });
  assert.deepEqual(continued.readRecords(lookup, intent, { selection: selected }).data, { status: 'ready', matches: [exact] });
  assert.equal(continued.referencesAreScoped([{ handle: similar.handle }], { observed: true }), false);
  assert.equal(continued.issueLookup(lookup), undefined);
});

test('a selection on a continuation page authorizes only that candidate for the original lookup', () => {
  const next = { ...lookup, cursor: second.cursor };
  const finalPage = { ...second, matches: [exact, { ...exact, handle: 'match-other' }], nextCursor: undefined };
  const turn = project([first, finalPage]).openLookup({ ownerKey });
  turn.readRecords(lookup, intent);
  turn.readRecords(next, intent);
  const previousLookup = turn.issueLookup(next);
  const selected = { ...lookup, queryBinding, handle: 'match-other' };
  const resumed = project([first, finalPage]).openLookup({ ownerKey, previousLookup });
  assert.deepEqual(resumed.readRecords(lookup, intent, { selection: selected }).data,
    { status: 'ready', matches: [{ ...exact, handle: 'match-other' }] });
  assert.equal(resumed.referencesAreScoped([{ handle: exact.handle }], { observed: true }), false);
  const changedPage = { ...finalPage, matches: [{ ...exact, handle: 'match-other' }] };
  assert.equal(project([first, changedPage]).openLookup({ ownerKey, previousLookup }).resolveSelection(selected), undefined);
});

test('invalid page and handle membership is rejected and legacy hints cannot authorize a next page', () => {
  for (const pages of [
    [second],
    [first, { ...second, queryBinding: 'other-query' }],
    [first, { ...second, matches: [similar] }],
    [first, { ...second, nextCursor: second.cursor }],
    [first, { ...third, nextCursor: second.cursor }],
    [first, { ...first, querySlot: 'otherName' }],
    [first, { ...first, kind: 'stock', nextCursor: undefined }],
    [first, { ...second, matches: Array.from({ length: 6 }, (_, index) => ({ ...exact, handle: `match-${index}` })) }],
    [first, { ...second, matches: [], nextCursor: 'cursor-empty' }],
  ]) assert.equal(project(pages), null);
  const legacy = project([{ ...lookup, matches: [exact], nextCursor: 'legacy-more' }]).openLookup({ ownerKey });
  const legacyIntent = { kind: 'read', recordKind: 'menu', querySlot: 'name' };
  assert.deepEqual(resolveAgentTarget(legacy.readRecords(lookup, legacyIntent).data), { choices: [exact] });
  assert.equal(legacy.issueLookup(lookup), undefined);
  assert.throws(() => legacy.readRecords({ ...lookup, cursor: 'legacy-more' }, legacyIntent), { reason: 'record_cursor' });
});

test('record discriminants stay intact while handles cannot cross record kinds', () => {
  const records = [
    ['menu', [{ kind: 'menu' }, { kind: 'retail' }]],
    ['stock', [{ kind: 'ingredient' }, { kind: 'retail' }]],
    ['supplier', [{ referenced: true }]], ['purchaseItem', [{ unit: 'L', minimumQty: 4 }]], ['purchaseOrder', [{ open: true }]],
    ['member', [{ grade: 'regular' }]], ['staff', [{ scheduleCount: 1 }]],
    ['reservation', [{ kind: 'visit' }, { kind: 'pickup' }]],
  ];
  const pages = records.map(([kind, fields]) => ({ kind, querySlot: 'name', queryBinding: `query-${kind}`,
    matches: fields.map((values, index) => ({ handle: `ref-${kind}-${index}`, match: 'exact', fields: values })) }));
  const turn = project(pages).openLookup();
  for (const [kind, fields] of records) {
    const data = turn.readRecords({ kind, querySlot: 'name' }, { kind: 'read', recordKind: kind }).data;
    assert.deepEqual(data.matches.map(match => match.fields), fields);
  }
  assert.equal(turn.referencesAreScoped([{ handle: 'ref-member-0', kinds: ['staff'] }], { observed: true }), false);
  assert.equal(turn.referencesAreScoped([{ handle: 'ref-supplier-0', kinds: ['purchaseOrder'] }], { observed: true }), false);
});

test('an explicit compiled record selector supplies its own kind and query scope', () => {
  const note = { kind: 'note', querySlot: 'name', matches: [{ handle: 'note-match', match: 'exact' }] };
  const turn = project([note, first]).openLookup();
  const args = { kind: note.kind, querySlot: note.querySlot };
  const compiled = { kind: 'read', reads: [{ name: 'search_records', args }] };
  assert.throws(() => turn.readRecords(args, { kind: 'read' }), { reason: 'record_read_scope' });
  assert.throws(() => turn.readRecords(lookup, compiled), { reason: 'record_read_scope' });
  assert.deepEqual(turn.readRecords(args, compiled).data.matches, note.matches);
});

test('the request boundary admits a masked member with typed fields and rejects raw lookup data', () => {
  const args = { kind: 'member', querySlot: 'name' };
  const member = { handle: 'member-match', label: '김○현 · 010-****-0100', match: 'exact', fields: { grade: 'regular' } };
  const input = {
    ...scope, layer: 'management', businessDate: '2026-10-26', catalog: [], snapshot: [],
    intent: { kind: 'read', recordKind: 'member', querySlot: 'name' }, searches: [{ ...args, matches: [member] }],
  };
  assert.equal(validateAgentRequest(input), true);
  assert.deepEqual(createRecordProjection(input).openLookup().readRecords(args, input.intent).data,
    { status: 'ready', matches: [member] });
  assert.equal(validateAgentRequest({ ...input, searches: [{ ...args, matches: [member], query: 'private lookup' }] }), false);
  for (const patch of [{ id: 'private-row' }, { label: '김○현 · 010-1234-0100' },
    { fields: { grade: 'regular', contact: '010-1234-0100' } }, { fields: { scheduleCount: 1 } }]) {
    assert.equal(validateAgentRequest({ ...input, searches: [{ ...args, matches: [{ ...member, ...patch }] }] }), false);
  }
});
