const PAGE_SIZE = 5;
const lookupReceipts = new WeakMap();

export const recordSearchKey = ({ kind, querySlot, cursor }) => JSON.stringify([kind, querySlot, cursor ?? null]);

export class RecordScopeError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const sameLookup = (left, right) => left.kind === right.kind && left.querySlot === right.querySlot
  && left.queryBinding === right.queryBinding;
const pageIdentity = page => JSON.stringify([page.nextCursor ?? null, page.matches.map(({ handle, match }) => [handle, match])]);

export function resolveAgentTarget(search) {
  if (search?.status !== 'ready') return { choices: [] };
  const exact = search.matches.filter(match => match.match === 'exact');
  if (exact.length === 1 && !search.nextCursor) return { match: exact[0] };
  return { choices: exact.length ? exact : search.matches };
}

// The shared request validator checks the discriminated fields. This index
// validates how those pages, cursors and handles relate to each other.
export function createRecordProjection({ runId, snapshotRevision, slots, searches: pages }) {
  const searches = new Map();
  const handles = new Map();
  const cursorScopes = new Map();
  const cursorIssuers = new Set();
  for (const page of pages) {
    const key = recordSearchKey(page);
    if (searches.has(key) || !slots.includes(page.querySlot) || page.matches.length > PAGE_SIZE
      || page.cursor && !page.queryBinding || page.nextCursor && (page.cursor === page.nextCursor || !page.matches.length)
      || page.status && page.matches.length) return null;
    searches.set(key, page);

    for (const cursor of [page.cursor, page.nextCursor]) {
      if (!cursor) continue;
      const other = cursorScopes.get(cursor);
      if (other && !sameLookup(other, page)) return null;
      cursorScopes.set(cursor, page);
    }
    if (page.nextCursor) {
      if (cursorIssuers.has(page.nextCursor)) return null;
      cursorIssuers.add(page.nextCursor);
    }
    for (const match of page.matches) {
      if (handles.has(match.handle)) return null;
      handles.set(match.handle, [{ kind: page.kind, querySlot: page.querySlot, queryBinding: page.queryBinding,
        ...(page.kind === 'reservation' && match.fields?.origin === 'naver' && { origin: 'naver' }) }]);
    }
  }
  for (const page of pages) {
    if (!page.cursor) continue;
    const root = searches.get(recordSearchKey({ kind: page.kind, querySlot: page.querySlot }));
    if (!root || !root.nextCursor || !sameLookup(root, page)) return null;
  }

  function openLookup({ ownerKey, previousLookup } = {}) {
    const observed = new Map();
    const completed = new Map();
    const issued = new Set();
    let selected;
    const receipt = lookupReceipts.get(previousLookup);
    const previous = receipt && ownerKey === receipt.ownerKey && runId === receipt.runId
      && snapshotRevision === receipt.snapshotRevision ? receipt : undefined;

    const rootFor = ({ kind, querySlot }) => searches.get(recordSearchKey({ kind, querySlot }));
    function continuesLookup(page) {
      const root = rootFor(page);
      return previous && sameLookup(previous, page) && root && previous.rootIdentity === pageIdentity(root);
    }

    function referencesAreScoped(refs, { observed: observedOnly = false } = {}) {
      const available = observedOnly ? observed : handles;
      return refs.every(ref => ref.slot ? slots.includes(ref.slot) : available.get(ref.handle)?.some(scope =>
        (!ref.kinds || ref.kinds.includes('*') || ref.kinds.includes(scope.kind))
        && (!ref.querySlot || ref.querySlot === scope.querySlot)
        && (!ref.queryBinding || ref.queryBinding === scope.queryBinding)));
    }

    function readRecords(args, intent, { adapterLookup = false, selection } = {}) {
      const { recordKind, querySlot, queryBinding } = intent;
      const key = recordSearchKey(args);
      const search = searches.get(key);
      const compiled = intent.kind === 'read' ? intent.reads : undefined;
      const requested = compiled?.some(read => read.name === 'search_records' && recordSearchKey(read.args) === key);
      const kindAllowed = args.kind === recordKind || recordKind === 'note' && args.kind === 'member';
      const isCompanion = (intent.featureId || intent.sourceId) && !(recordKind && querySlot);
      const outsideLegacy = (querySlot && args.querySlot !== querySlot)
        || ((recordKind || args.kind === 'note') && !kindAllowed) || (isCompanion && !search);
      if (!slots.includes(args.querySlot) || !adapterLookup && (compiled ? !requested : outsideLegacy)) {
        throw new RecordScopeError('record_read_scope');
      }
      if (selection) {
        const match = !args.cursor && search && sameLookup(search, selection) && resolveSelection(selection);
        if (!match || selected && selected.match.handle !== match.handle) throw new RecordScopeError('record_selection');
        if (!selected) {
          selected = { search, match };
          for (const [handle, scopes] of observed) {
            if (scopes.some(scope => sameLookup(scope, search))) observed.delete(handle);
          }
          completed.delete(key);
        }
      }
      const pinned = selected && search && sameLookup(selected.search, search) ? selected.match : undefined;
      if (args.cursor) {
        const explicitCursor = intent.kind === 'read' && !adapterLookup && queryBinding === search?.queryBinding
          && (recordKind === args.kind && querySlot === args.querySlot && intent.cursor === args.cursor
            || requested);
        const isExternal = search && explicitCursor && continuesLookup(search) && previous.nextCursor === args.cursor;
        if (pinned || !search || !issued.has(key) && !isExternal) throw new RecordScopeError('record_cursor');
      } else if (queryBinding && queryBinding !== search?.queryBinding && !adapterLookup) {
        throw new RecordScopeError('record_read_scope');
      }
      if (completed.has(key)) return { ...completed.get(key), repeated: true };
      const nextCursor = pinned ? undefined : search?.nextCursor;
      const nextKey = nextCursor && recordSearchKey({ ...args, cursor: nextCursor });
      if (nextKey && (completed.has(nextKey) || args.cursor && continuesLookup(search) && previous.visited.has(nextKey))) {
        throw new RecordScopeError('record_cursor');
      }
      const matches = pinned ? [{ ...pinned, match: 'exact' }] : search?.matches ?? [];
      const status = search ? search.status ?? (adapterLookup || matches.length ? 'ready' : 'missing') : 'unavailable';
      const data = { status, matches, ...(nextCursor ? { nextCursor } : {}) };
      const result = { data, search };
      completed.set(key, result);
      for (const match of data.matches) observed.set(match.handle, handles.get(match.handle));
      if (nextKey && search.queryBinding) issued.add(nextKey);
      return result;
    }

    // The bridge retains this receipt only for an ambiguity it presents.
    function issueLookup(args) {
      const key = recordSearchKey(args);
      const result = completed.get(key);
      const search = result?.search;
      if (!ownerKey || !search?.queryBinding) return undefined;
      const { choices } = resolveAgentTarget(result.data);
      if (!choices?.length) return undefined;
      const visited = new Set(continuesLookup(search) ? previous.visited : []);
      for (const [readKey, { search: read }] of completed) {
        if (read && sameLookup(read, search)) visited.add(readKey);
      }
      const token = Object.freeze({});
      lookupReceipts.set(token, {
        ownerKey, runId, snapshotRevision, kind: search.kind, querySlot: search.querySlot, queryBinding: search.queryBinding,
        cursor: search.cursor, nextCursor: search.nextCursor, rootIdentity: pageIdentity(rootFor(search)),
        pageIdentity: pageIdentity(search), visited,
        choices: new Set(choices.map(({ handle }) => handle)),
      });
      return token;
    }

    function resolveSelection(selection) {
      if (!continuesLookup(selection) || !previous.choices.has(selection.handle)) return undefined;
      const current = searches.get(recordSearchKey({ ...selection, cursor: previous.cursor }));
      if (!current || previous.pageIdentity !== pageIdentity(current)) return undefined;
      return current.matches.find(match => match.handle === selection.handle);
    }

    return { readRecords, referencesAreScoped, issueLookup, resolveSelection };
  }

  return { searches, handles, openLookup };
}
