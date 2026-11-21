import { createAgentActions } from '../agent-actions';
import { createWidgetDataStore } from '../../../data/widget-data';
import { expect, it, vi } from 'vitest';
import { createDomainRegistry, type DomainAdapter } from './registry';

it('dispatches only registered read and proposal adapters and rejects duplicate ownership', () => {
  const read = vi.fn();
  const adapter = { commands: [], reads: [{ kind: 'menu', search: read }] } satisfies DomainAdapter;
  const registry = createDomainRegistry([adapter]);

  expect(registry.reader('menu')?.search).toBe(read);
  expect(registry.reader('member')).toBeUndefined();
  expect(registry.command('menu.create')).toBeUndefined();
  expect(() => createDomainRegistry([adapter, adapter])).toThrow(/menu/);
});

it('resolves local slots and previews an injected command before dispatch', () => {
  const store = createWidgetDataStore(undefined, { runId: 'registry-test' });
  const todo = {
    command: 'calendar.addTodo',
    featureId: 'calendar',
    slots: { title: value => typeof value === 'string' && !!value },
    resolve(_args, slots) { return typeof slots.title === 'string' ? slots.title : undefined; },
    preflight(draft) {
      if (typeof draft !== 'string') return { kind: 'invalid' };
      return { kind: 'ready', command: { type: 'calendar.addTodo', title: draft }, preview: { before: null, after: draft } };
    },
    undoToken: result => result.undoToken,
  } satisfies DomainAdapter['commands'][number];
  const actions = createAgentActions(store, createDomainRegistry([{ commands: [todo], reads: [] }]));
  const frame = {
    command: 'calendar.addTodo', args: { title: { slot: 'title' } }, tier: 'normal',
    runId: 'registry-test', layer: 'management', snapshotRevision: 0, proposalId: 'todo',
  } as const;

  expect(actions.prepare(frame, { price: 4500 }, store.getSnapshot()).kind).toBe('invalid');
  const prepared = actions.prepare(frame, { title: '재고 확인' }, store.getSnapshot());
  expect(prepared).toMatchObject({ kind: 'proposal', proposal: { preview: { before: null, after: '재고 확인' } } });
  expect(store.getSnapshot().revision).toBe(0);
  expect(prepared.kind === 'proposal' && prepared.proposal.confirm(store).frame).toMatchObject({ outcome: 'applied', revision: 1 });
});
