import type { DataCommand, DataCommandResult, DataErrorCode } from '../../commands/types';
import { commandFailureReasonKey } from '../../commands/failure-copy';
import type { DataSnapshot, DataTables } from '../../db/types';
import type { WidgetDataStore } from '../../db/store';
import { createPortFiles } from './files';
import {
  PortError, REAL_UNDO_PREFIX,
  type CommandBinding, type CommandReceipt, type CommandRequest, type DomainAdapter, type DomainState, type LoadResult, type RealDomain,
  type RealPort, type RealSource,
} from './port';
import { dataSourceFor, registeredAdapters } from './registry';
import { createPortReads, createPortTransport, toPortError } from './transport';

type Failure = Extract<DataCommandResult, { readonly ok: false }>;
export interface RealPortOptions {
  readonly store: Pick<WidgetDataStore, 'getSnapshot' | 'hydrate' | 'dispatchLocal'>;
  readonly fetch?: typeof fetch;
  /** Share one browser session between ports (a restarted run keeps its session); default: a new transport over `fetch`. */
  readonly transport?: ReturnType<typeof createPortTransport>;
  /** Source mode per domain (default: build env). A domain without an adapter is always `fixture`. */
  readonly source?: (domain: RealDomain) => RealSource;
  /** Default: every adapter registered through `registerDomain`. */
  readonly adapters?: readonly DomainAdapter[];
  readonly uuid?: () => string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Waits between resends of a command whose outcome is unknown. */
  readonly reconcileDelaysMs?: readonly number[];
}

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  'STALE_REVISION', 'IDEMPOTENCY_MISMATCH', 'IDEMPOTENCY_CONFLICT', 'OUTCOME_UNKNOWN', 'SESSION_ENDED', 'SOURCE_UNAVAILABLE', 'UNDO_EXPIRED', 'UNDO_UNAVAILABLE',
  'ASYNC_REQUIRED', 'NOT_FOUND', 'VALIDATION', 'FILE_INVALID', 'BAD_RESPONSE',
]);
const SESSION_CODES: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'STORE_FORBIDDEN', 'TOKEN_EXPIRED']);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key, child]) => key !== 'baseRevision' && child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
const fingerprint = (command: DataCommand) => JSON.stringify(canonical(command));

export function failure(code: DataErrorCode, reason: string, messageKey: string, field?: string, outcomeUnknown = false): Failure {
  return { ok: false, code, reason, messageKey, ...(field ? { field } : {}), ...(outcomeUnknown ? { outcomeUnknown: true as const } : {}) };
}

/** A port error as the `DataCommandResult` the widgets already handle. */
export function errorResult(error: PortError, errorKeys: Readonly<Record<string, string>> = {}): Failure {
  const reason = error.reason ?? (SESSION_CODES.has(error.code) ? 'SESSION_ENDED' : error.outcomeUnknown ? 'OUTCOME_UNKNOWN'
    : error.code === 'NOT_FOUND' || error.code === 'CONFLICT' ? error.code : error.code === 'VALIDATION' || error.code === 'INVALID_REQUEST' ? 'VALIDATION' : 'SOURCE_UNAVAILABLE');
  const code: DataErrorCode = error.code === 'VALIDATION' || error.code === 'INVALID_REQUEST' ? 'VALIDATION' : error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT';
  const fallback = code !== 'CONFLICT' || error.code === 'CONFLICT' ? code : 'PREVIEW_FAILURE';
  const messageKey = error.outcomeUnknown ? 'data.real.error.OUTCOME_UNKNOWN' : Object.hasOwn(errorKeys, reason) ? errorKeys[reason]
    : KNOWN_REASONS.has(reason) && reason !== 'VALIDATION' ? `data.real.error.${reason}` : commandFailureReasonKey(fallback);
  return { ...failure(code, reason, messageKey, error.field, error.outcomeUnknown), ...(error.details ? { details: error.details } : {}) };
}

function checkReceipt(value: unknown): CommandReceipt {
  const receipt = value as Partial<CommandReceipt> | null;
  if (!receipt || typeof receipt.receiptId !== 'string' || typeof receipt.resourceId !== 'string' || !Number.isInteger(receipt.revision)
    || !Array.isArray(receipt.affectedSources)) throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE', undefined, true);
  return receipt as CommandReceipt;
}

interface Record_ {
  status: DomainState['status'];
  asOf?: string; sourceRevision?: number; error?: PortError;
  pending: number; refreshing: boolean; complete: boolean;
  loaded: boolean;
  inflight?: Promise<DomainState>;
  revisions: Map<string, number>;
  view: DomainState;
}
interface Sent { readonly key: string; readonly request: CommandRequest }
interface Undoable { readonly base: string; readonly path?: (receiptId: string) => string; readonly until: number | null; readonly sources: readonly string[]; readonly domain: RealDomain }

const DEFAULT_DELAYS = [300, 1_000, 2_500];
const sleepFor = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** The data port (REAL-PLAN F00): per-domain loads into the store, authoritative commands with receipts, undo, reconcile. */
export function createRealPort(options: RealPortOptions): RealPort {
  const { store } = options;
  const transport = options.transport ?? createPortTransport(options.fetch ?? fetch);
  const reads = createPortReads(transport);
  const files = createPortFiles(transport);
  const adapters = new Map((options.adapters ?? registeredAdapters()).map(adapter => [adapter.domain, adapter] as const));
  const source = options.source ?? ((domain: RealDomain) => dataSourceFor(domain));
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? sleepFor;
  const delays = options.reconcileDelaysMs ?? DEFAULT_DELAYS;

  const bindings = new Map<string, { readonly domain: RealDomain; readonly binding: CommandBinding; readonly adapter: DomainAdapter }>();
  for (const adapter of adapters.values()) for (const binding of adapter.commands) bindings.set(binding.type, { domain: adapter.domain, binding, adapter });

  const listeners = new Set<() => void>();
  const failureListeners = new Set<Parameters<RealPort['onFailure']>[0]>();
  const records = new Map<RealDomain, Record_>();
  const inflight = new Map<string, { preview: DataCommandResult | undefined; settled: Promise<DataCommandResult> }>();
  const unresolved = new Map<string, Sent>();
  const undoable = new Map<string, Undoable>();
  const initialTables = store.getSnapshot().tables;
  let generation = 0;
  let sessionAbort = new AbortController();

  const mode = (domain: RealDomain): RealSource => adapters.has(domain) && source(domain) === 'http' ? 'http' : 'fixture';
  const FIXTURE: DomainState = Object.freeze({ mode: 'fixture', status: 'fixture', pending: 0, refreshing: false, complete: true });

  const viewOf = (rec: Record_): DomainState => Object.freeze({
    mode: 'http', status: rec.status, asOf: rec.asOf, sourceRevision: rec.sourceRevision, error: rec.error, pending: rec.pending, refreshing: rec.refreshing, complete: rec.complete,
  });
  function record(domain: RealDomain): Record_ {
    let rec = records.get(domain);
    if (!rec) {
      rec = { status: 'idle', pending: 0, refreshing: false, complete: true, loaded: false, revisions: new Map(), view: FIXTURE };
      rec.view = viewOf(rec);
      records.set(domain, rec);
    }
    return rec;
  }
  function publish(domain: RealDomain) {
    const rec = record(domain);
    rec.view = viewOf(rec);
    for (const listener of [...listeners]) listener();
  }
  // Pure read: safe inside render (`useSyncExternalStore`); only `publish` notifies.
  const state = (domain: RealDomain): DomainState => mode(domain) === 'fixture' ? FIXTURE : record(domain).view;

  function revision(key: string): number | undefined {
    for (const rec of records.values()) { const value = rec.revisions.get(key); if (value !== undefined) return value; }
  }
  const tablesOf = (adapter: DomainAdapter, snapshot: DataSnapshot): Partial<DataTables> =>
    Object.fromEntries(adapter.tables.map(name => [name, snapshot.tables[name]])) as Partial<DataTables>;

  function hydrate(tables: Partial<DataTables>) {
    const snapshot = store.getSnapshot();
    for (const adapter of adapters.values()) {
      if (mode(adapter.domain) === 'http' && adapter.merge) tables = adapter.merge(snapshot, tables);
    }
    store.hydrate(tables);
  }

  /** Discard old responses, retries and read models together. Transient failures keep the last confirmed rows. */
  function clearScope(error?: PortError) {
    generation += 1;
    sessionAbort.abort();
    sessionAbort = new AbortController();
    inflight.clear(); unresolved.clear(); undoable.clear();
    const snapshot = store.getSnapshot();
    const patch: Partial<DataTables> = {};
    const cleared: RealDomain[] = [];
    for (const adapter of adapters.values()) {
      if (mode(adapter.domain) !== 'http') continue;
      Object.assign(patch, Object.fromEntries(adapter.tables.map(name => [name, Array.isArray(initialTables[name]) ? [] : initialTables[name]])), adapter.clear?.(snapshot));
      const rec = record(adapter.domain);
      Object.assign(rec, { status: error ? 'error' : 'idle', error, asOf: undefined, sourceRevision: undefined,
        pending: 0, loaded: false, refreshing: false, inflight: undefined, revisions: new Map(), complete: true });
      rec.view = viewOf(rec);
      cleared.push(adapter.domain);
    }
    hydrate(patch);
    for (const domain of cleared) publish(domain);
  }
  const sessionLost = (error: PortError) => clearScope(error);
  const scopeChanged = () => new PortError(401, 'UNAUTHENTICATED', 'SESSION_ENDED');

  /* ── loads ─────────────────────────────────────────────────────────────────────────────── */
  function load(domain: RealDomain, loadOptions: { readonly force?: boolean } = {}): Promise<DomainState> {
    const adapter = adapters.get(domain);
    if (!adapter || mode(domain) !== 'http') return Promise.resolve(FIXTURE);
    const rec = record(domain);
    if (rec.inflight) {
      // A forced load asked after a commit must see that commit: run once more after the one in flight.
      const started = generation;
      return loadOptions.force ? rec.inflight.then(() => started === generation ? load(domain, { force: true }) : state(domain)) : rec.inflight;
    }
    if (!loadOptions.force && rec.loaded && rec.status !== 'error') return Promise.resolve(state(domain));
    const started = generation;
    const { signal } = sessionAbort;
    rec.refreshing = rec.loaded;
    rec.status = rec.loaded ? rec.status : 'loading';
    rec.error = undefined;
    publish(domain);
    const run = (async (): Promise<DomainState> => {
      try {
        const storeId = await transport.storeId();
        if (signal.aborted) return state(domain);
        const result: LoadResult = await adapter.load({ reads, storeId, snapshot: store.getSnapshot(), signal });
        if (started !== generation) return state(domain);
        hydrate(result.tables);
        rec.revisions = new Map(Object.entries(result.revisions ?? {}));
        Object.assign(rec, { status: 'ready', asOf: result.asOf, sourceRevision: result.sourceRevision, complete: result.complete, error: undefined, loaded: true });
      } catch (error) {
        if (started !== generation) return state(domain);
        const failed = toPortError(error, 'GET');
        if (SESSION_CODES.has(failed.code)) sessionLost(failed);
        else { rec.error = failed; rec.status = rec.loaded ? 'stale' : 'error'; }
      } finally {
        if (started === generation) {
          rec.refreshing = false;
          rec.inflight = undefined;
          publish(domain);
        }
      }
      return state(domain);
    })();
    rec.inflight = run;
    return run;
  }

  const domainsFor = (sources: readonly string[], own: RealDomain): RealDomain[] => {
    const wanted = new Set(sources);
    const result = new Set<RealDomain>([own]);
    for (const adapter of adapters.values()) {
      if (mode(adapter.domain) === 'http' && (adapter.sources ?? [adapter.domain]).some(name => wanted.has(name))) result.add(adapter.domain);
    }
    return [...result];
  };
  const reload = (domains: readonly RealDomain[]) => Promise.all(domains.map(domain => load(domain, { force: true })));

  /* ── commands ──────────────────────────────────────────────────────────────────────────── */
  async function send(sent: Sent, signal: AbortSignal): Promise<CommandReceipt> {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw scopeChanged();
      try {
        return checkReceipt(await transport.request<CommandReceipt>({
          method: sent.request.method, path: sent.request.path, body: sent.request.body, expectedRevision: sent.request.expectedRevision, idempotencyKey: sent.key, signal,
        }));
      } catch (error) {
        const failed = toPortError(error, sent.request.method);
        if (!failed.outcomeUnknown || attempt >= delays.length) throw failed;
        await sleep(delays[attempt]);
      }
    }
  }

  const commandContext = () => ({ snapshot: store.getSnapshot(), storeId: '', files, request: transport.request, revision });

  async function run(entry: NonNullable<ReturnType<typeof bindings.get>>, command: DataCommand, fp: string, before: Partial<DataTables> | undefined): Promise<DataCommandResult> {
    const { domain, binding, adapter } = entry;
    const rec = record(domain);
    const { signal } = sessionAbort;
    rec.pending += 1; publish(domain);
    let sent = unresolved.get(fp);
    try {
      if (!sent) {
        const storeId = await transport.storeId();
        if (signal.aborted) throw scopeChanged();
        const request = await binding.request(command as never, { ...commandContext(), storeId });
        sent = { key: ('idempotencyKey' in command && typeof command.idempotencyKey === 'string' && command.idempotencyKey) || uuid(), request };
      }
      const receipt = await send(sent, signal);
      if (signal.aborted) throw scopeChanged();
      unresolved.delete(fp);
      const sources = [...receipt.affectedSources];
      await reload(domainsFor(sources, domain));
      if (signal.aborted) throw scopeChanged();
      const keep = receipt.changed !== false && !!receipt.undoUntil && !!binding.receiptBase;
      if (keep) undoable.set(receipt.receiptId, { base: binding.receiptBase!, path: binding.undoPath, until: Date.parse(receipt.undoUntil!) || null, sources, domain });
      return {
        ok: true, revision: store.getSnapshot().revision, value: receipt,
        ...(keep ? { undoToken: `${REAL_UNDO_PREFIX}${receipt.receiptId}` } : {}),
        ...(binding.noticeKey ? { noticeKey: binding.noticeKey } : {}),
      };
    } catch (caught) {
      if (signal.aborted) return errorResult(scopeChanged(), adapter.errorKeys);
      const error = caught instanceof PortError ? caught : toPortError(caught, 'POST');
      if (error.outcomeUnknown && sent) {
        unresolved.set(fp, sent);
        // The write may or may not have landed: show the server's truth when it can be read.
        await load(domain, { force: true });
        return errorResult(error, adapter.errorKeys);
      }
      unresolved.delete(fp);
      if (error.code === 'CONFLICT' && error.reason === 'STALE_REVISION') await load(domain, { force: true });
      else if (before) hydrate(before);
      if (SESSION_CODES.has(error.code)) sessionLost(error);
      return errorResult(error, adapter.errorKeys);
    } finally {
      if (!signal.aborted) { rec.pending -= 1; publish(domain); }
    }
  }

  function start(command: DataCommand): { readonly preview: DataCommandResult | undefined; readonly settled: Promise<DataCommandResult> } {
    const entry = bindings.get(command.type);
    if (!entry || mode(entry.domain) !== 'http') return { preview: undefined, settled: Promise.resolve(store.dispatchLocal(command)) };
    const fp = fingerprint(command);
    const existing = inflight.get(fp);
    if (existing) return existing;
    let preview: DataCommandResult | undefined, before: Partial<DataTables> | undefined;
    if (entry.binding.optimistic === 'local' && !unresolved.has(fp)) {
      before = tablesOf(entry.adapter, store.getSnapshot());
      preview = store.dispatchLocal(command);
      if (!preview.ok) return { preview, settled: Promise.resolve(preview) };
    }
    const startedIn = generation;
    const settled = run(entry, command, fp, before).finally(() => { if (startedIn === generation) inflight.delete(fp); });
    const started = { preview, settled };
    inflight.set(fp, started);
    return started;
  }

  async function undo(token: string): Promise<DataCommandResult> {
    const id = token.startsWith(REAL_UNDO_PREFIX) ? token.slice(REAL_UNDO_PREFIX.length) : '';
    const entry = undoable.get(id);
    if (!entry) return failure('CONFLICT', 'UNDO_UNAVAILABLE', 'data.error.undoUnavailable');
    if (entry.until !== null && now() > entry.until) { undoable.delete(id); return failure('CONFLICT', 'UNDO_EXPIRED', 'data.real.error.UNDO_EXPIRED'); }
    const adapter = adapters.get(entry.domain);
    const rec = record(entry.domain);
    const { signal } = sessionAbort;
    rec.pending += 1; publish(entry.domain);
    try {
      const receipt = await send({ key: `undo:${id}`, request: { method: 'POST', path: entry.path ? entry.path(id) : `${entry.base}/receipts/${encodeURIComponent(id)}/undo`, body: {} } }, signal);
      if (signal.aborted) throw scopeChanged();
      undoable.delete(id);
      await reload(domainsFor([...entry.sources, ...receipt.affectedSources], entry.domain));
      if (signal.aborted) throw scopeChanged();
      return { ok: true, revision: store.getSnapshot().revision, noticeKey: 'data.notice.undone', value: receipt };
    } catch (caught) {
      if (signal.aborted) return errorResult(scopeChanged(), adapter?.errorKeys);
      const error = caught instanceof PortError ? caught : toPortError(caught, 'POST');
      if (SESSION_CODES.has(error.code)) sessionLost(error);
      if (error.code === 'CONFLICT' || error.code === 'NOT_FOUND') undoable.delete(id);
      return errorResult(error, adapter?.errorKeys);
    } finally {
      if (!signal.aborted) { rec.pending -= 1; publish(entry.domain); }
    }
  }

  const notifyFailure = (command: DataCommand | null, result: Failure) => { for (const listener of [...failureListeners]) listener({ command, result }); };

  return {
    transport, reads, files, mode, state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load, retry: domain => load(domain, { force: true }),
    execute: command => start(command).settled,
    begin(command) {
      const started = start(command);
      void started.settled.then(result => { if (!result.ok && started.preview) notifyFailure(command, result); });
      return started;
    },
    undo(token) {
      return undo(token).then(result => { if (!result.ok) notifyFailure(null, result); return result; });
    },
    route(command) {
      const entry = bindings.get(command.type);
      return !entry || mode(entry.domain) !== 'http' ? null : entry.binding.optimistic ? 'optimistic' : 'async';
    },
    onFailure(listener) { failureListeners.add(listener); return () => { failureListeners.delete(listener); }; },
    reset({ keepSession, error } = {}) {
      clearScope(error);
      if (!keepSession) transport.reset();
    },
  };
}
