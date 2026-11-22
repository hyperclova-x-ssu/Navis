import type { DashboardLayerId, DashboardPage, RunState } from '../../../../contracts';
import type { PresentationRunStore } from '../../../../state';
import { PortError } from '../port';
import { toPortError } from '../transport';
import type { CommandReceipt } from '../port';
import type { AccountClient, AccountRevisions, AccountSnapshot, PreferencesPatch, ProfilePatch } from './client';

const LAYERS: readonly DashboardLayerId[] = ['management', 'marketing'];
export type AccountFlushResult = 'saved' | 'unchanged' | 'conflict' | 'error';
export type AccountSyncStatus = 'idle' | 'saving' | 'error';
export interface AccountSyncState { readonly status: AccountSyncStatus; readonly error?: PortError; readonly storeName?: string; readonly stores: AccountSnapshot['stores'] }
export interface AccountSyncOptions {
  readonly client: AccountClient;
  readonly run: PresentationRunStore;
  readonly debounceMs?: number;
  /** Waits (ms) before retrying a failed save; the last value repeats. */
  readonly retryDelaysMs?: readonly number[];
  readonly uuid?: () => string;
  readonly schedule?: (callback: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  /** Another tab changed the same resource: the stored state was restored over the local one. */
  readonly onConflict?: () => void;
  /** 401/403: the session ended. Nothing is retried until a new session starts. */
  readonly onSessionEnded?: () => void;
}

/** The part of the run that is durable, as the account service sees it. */
interface Durable {
  readonly pages: Readonly<Record<DashboardLayerId, readonly DashboardPage[]>>;
  readonly profile: string;
  readonly preferences: string;
  readonly done: boolean;
}
const settingsOf = (s: RunState): ProfilePatch => ({
  businessType: s.shopSettings.businessType, paymentStyle: s.shopSettings.paymentStyle, tableLayout: s.shopSettings.tableLayout,
  ...(s.shopSettings.posPreferences ? { posPreferences: s.shopSettings.posPreferences } : {}),
  ...(s.shopSettings.cctvPosLinks ? { cctvPosLinks: s.shopSettings.cctvPosLinks } : {}),
  onboardingDone: s.onboarding.step === 'done',
});
const prefsOf = (s: RunState): PreferencesPatch => ({ theme: s.theme, textScale: s.textScale, locale: s.locale });
const durable = (s: RunState): Durable => ({
  pages: { management: s.boards.management.pages, marketing: s.boards.marketing.pages },
  profile: JSON.stringify(settingsOf(s)), preferences: JSON.stringify(prefsOf(s)), done: s.onboarding.step === 'done',
});

/**
 * Keeps the run and the account service equal (REAL-PLAN F00): `load()` restores the stored account state into the run when a session starts;
 * `attach()` writes later board, settings and preference changes back (debounced, one write at a time, each against the revision the server last confirmed).
 * A write that finds the resource changed elsewhere (409 STALE_REVISION) restores the stored state; a lost connection keeps the change and retries.
 */
export function createAccountSync(options: AccountSyncOptions) {
  const { client, run } = options;
  const debounceMs = options.debounceMs ?? 400;
  const retryDelays = options.retryDelaysMs ?? [1_000, 2_000, 5_000, 15_000];
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  const schedule = options.schedule ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state: AccountSyncState = { status: 'idle', stores: [] };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<AccountSyncState>) => { state = { ...state, ...next }; for (const listener of [...listeners]) listener(); };

  let baseline: Durable | null = null;
  let revisions: AccountRevisions = { profile: 0, preferences: 0, boards: { management: 0, marketing: 0 } };
  let timer: unknown, retry = 0, chain: Promise<AccountFlushResult> = Promise.resolve('unchanged'), stopped = false, sessionEnded = false, unsubscribe: (() => void) | undefined;
  // Retain the request body and revision with the key until the outcome is known.
  // An edit arriving during a retry belongs to a subsequent request.
  let pending: (() => Promise<void>) | undefined;
  async function save(write: (key: string) => Promise<CommandReceipt>, commit: (receipt: CommandReceipt) => void) {
    const key = uuid();
    pending = async () => {
      const receipt = await write(key);
      commit(receipt);
      pending = undefined;
    };
    await pending();
  }

  function dirty(s: RunState): { profile: boolean; preferences: boolean; boards: DashboardLayerId[] } {
    if (!baseline || s.onboarding.step !== 'done') return { profile: false, preferences: false, boards: [] };
    const now = durable(s);
    return {
      profile: now.profile !== baseline.profile || !baseline.done,
      preferences: now.preferences !== baseline.preferences,
      boards: LAYERS.filter(layer => now.pages[layer] !== baseline!.pages[layer]),
    };
  }
  const anyDirty = (s: RunState) => { const d = dirty(s); return d.profile || d.preferences || d.boards.length > 0; };

  async function applyStored(): Promise<AccountSnapshot> {
    const snapshot = await client.load();
    if (!run.actions.restoreAccount(snapshot.restore)) throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
    revisions = snapshot.revisions; pending = undefined; sessionEnded = false; retry = 0;
    baseline = durable(run.getState());
    publish({ storeName: snapshot.storeName, stores: snapshot.stores });
    return snapshot;
  }

  async function saveOnce(): Promise<void> {
    const s = run.getState();
    const d = dirty(s);
    // Profile first: the first save of a new store marks onboarding done before its boards exist.
    if (d.profile) {
      const patch = settingsOf(s);
      const expected = revisions.profile;
      await save(key => client.saveProfile(patch, expected, key), receipt => {
        revisions = { ...revisions, profile: receipt.revision };
        baseline = { ...baseline!, profile: JSON.stringify(patch), done: true };
      });
    }
    if (d.preferences) {
      const patch = prefsOf(s);
      const expected = revisions.preferences;
      await save(key => client.savePreferences(patch, expected, key), receipt => {
        revisions = { ...revisions, preferences: receipt.revision };
        baseline = { ...baseline!, preferences: JSON.stringify(patch) };
      });
    }
    for (const layer of d.boards) {
      const board = s.boards[layer];
      const expected = revisions.boards[layer];
      await save(key => client.saveBoard(layer, board, expected, key), receipt => {
        revisions = { ...revisions, boards: { ...revisions.boards, [layer]: receipt.revision } };
        baseline = { ...baseline!, pages: { ...baseline!.pages, [layer]: board.pages } };
      });
    }
  }

  let explicit = 0;
  function cancelTimer() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }
  function flush(background = false): Promise<AccountFlushResult> {
    if (!background) { explicit++; cancelTimer(); }
    chain = chain.then(async () => {
      if (stopped || sessionEnded || !baseline) return 'error';
      if (background && explicit || !pending && !anyDirty(run.getState())) return 'unchanged';
      publish({ status: 'saving', error: undefined });
      try {
        await pending?.();
        while (!stopped && baseline && (!background || !explicit) && anyDirty(run.getState())) await saveOnce();
        retry = 0;
        publish({ status: 'idle', error: undefined });
        return 'saved';
      } catch (caught) {
        const error = toPortError(caught, 'POST');
        if (error.code === 'CONFLICT') {
          pending = undefined;
          try { await applyStored(); publish({ status: 'idle', error: undefined }); options.onConflict?.(); return 'conflict'; }
          catch (reloadFailure) { baseline = null; publish({ status: 'error', error: toPortError(reloadFailure, 'GET') }); }
        } else if (error.code === 'UNAUTHENTICATED' || error.code === 'STORE_FORBIDDEN') {
          sessionEnded = true; publish({ status: 'error', error }); options.onSessionEnded?.();
        } else if (!background) {
          // A failed card must not become a later background write. Re-read even when
          // the write may have landed, and block saves if its outcome cannot be read.
          pending = undefined;
          try { await applyStored(); } catch { baseline = null; }
          publish({ status: 'error', error });
        } else if (error.code === 'VALIDATION' || error.code === 'INVALID_REQUEST') {
          // The server refuses this content; resending cannot help. Keep the baseline so later edits retry with new content.
          pending = undefined; publish({ status: 'error', error });
        } else {
          publish({ status: 'error', error });
          if (!stopped && unsubscribe && !explicit) { cancelTimer(); timer = schedule(() => { timer = undefined; return flush(true); }, retryDelays[Math.min(retry++, retryDelays.length - 1)]); }
        }
        return 'error';
      }
    });
    if (!background) chain = chain.finally(() => { explicit--; });
    return chain;
  }
  const kick = () => { cancelTimer(); timer = schedule(() => { timer = undefined; return flush(true); }, debounceMs); };

  return {
    /** Read the stored account state and restore it into the run. Throws a `PortError` (the caller shows the failure screen / sign-in). */
    load: applyStored,
    /** Start writing changes back. Call after `load()` has restored the run. */
    attach(): () => void {
      unsubscribe?.();
      unsubscribe = run.subscribe(s => { if (!stopped && !explicit && anyDirty(s)) kick(); });
      return () => { unsubscribe?.(); unsubscribe = undefined; };
    },
    flush,
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { stopped = true; if (timer !== undefined) cancel(timer); unsubscribe?.(); listeners.clear(); },
    /** Test and store-switch hook: forget what was stored for the previous session. */
    detach() { baseline = null; pending = undefined; },
  };
}
export type AccountSync = ReturnType<typeof createAccountSync>;
