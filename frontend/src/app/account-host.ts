import type { RunStore } from '../contracts';
import type { PresentationRunStore } from '../state';
import { createAccountClient, type AccountClient, type StoreSummary } from '../data/reality/00/account/client';
import { createAccountSync, type AccountFlushResult, type AccountSyncStatus } from '../data/reality/00/account/sync';
import { appTransport } from '../data/reality/00/app-port';
import { dataSourceFor } from '../data/reality/00/registry';

/** What the UI may do with the signed-in account (REAL-PLAN F00). Absent on fixture builds. */
export interface AccountController {
  readonly storeName?: string;
  readonly stores: readonly StoreSummary[];
  readonly status: AccountSyncStatus;
  /** Save pending changes, open another store of this account and start a fresh run on it. */
  switchStore(storeId: string): Promise<void>;
  signIn(loginId: string, password: string): Promise<void>;
  /** Save pending changes, end the session and return to sign-in. */
  signOut(): Promise<void>;
}
export interface AccountHost {
  /** Restore the stored account state into the run. Rejects with a `PortError`. */
  load(): Promise<void>;
  /** Start writing changes back; returns a detach function. */
  attach(): () => void;
  /** Await account persistence after an approved action. Replay can use this without attaching background saves. */
  flush(): Promise<AccountFlushResult>;
  restartOnboarding(): Promise<AccountFlushResult>;
  dispose(): void;
  readonly client: AccountClient;
  getController(): AccountController;
  subscribe(listener: () => void): () => void;
}
const hosts = new WeakMap<RunStore, AccountHost>();

/** Resolve the persistence boundary for a confirmed card on this run. */
export function accountHostFor(run: RunStore): AccountHost | undefined {
  return hosts.get(run);
}
export type AccountHostFactory = (run: PresentationRunStore, control: { readonly restart: () => void; readonly retry: () => void }) => AccountHost | null;

/** An account host over the given transport (tests use a fake backend; the app uses the tab's shared session). */
export function buildAccountHost(run: PresentationRunStore, control: { readonly restart: () => void; readonly retry: () => void }, transport: ReturnType<typeof appTransport>): AccountHost {
  const client = createAccountClient(transport);
  const sync = createAccountSync({
    client, run,
    // Another tab changed the same board or settings: the stored state is already restored; say so.
    onConflict: () => { run.actions.showNotice({ kind: 'error', messageKey: 'data.real.error.STALE_REVISION' }); },
  });
  const uuid = () => globalThis.crypto.randomUUID();
  const controller = (): AccountController => ({
    storeName: sync.getState().storeName, stores: sync.getState().stores, status: sync.getState().status,
    async switchStore(storeId) { await sync.flush(); await client.switchStore(storeId, `store:${uuid()}`); sync.detach(); control.restart(); },
    async signIn(loginId, password) { await client.login(loginId, password); control.retry(); },
    async signOut() { await sync.flush(); sync.detach(); await client.logout(); control.restart(); },
  });
  let snapshot = controller();
  const listeners = new Set<() => void>();
  sync.subscribe(() => { snapshot = controller(); for (const listener of [...listeners]) listener(); });
  const host: AccountHost = {
    client,
    load: async () => { await sync.load(); },
    attach: () => sync.attach(),
    flush: () => sync.flush(),
    restartOnboarding: () => sync.restartOnboarding(),
    dispose() {
      if (hosts.get(run) === host) hosts.delete(run);
      sync.dispose();
      listeners.clear();
    },
    getController: () => snapshot, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  hosts.set(run, host);
  return host;
}
/** The default: an account host only when the build runs the account domain over HTTP. */
export const createAccountHost: AccountHostFactory = (run, control) => dataSourceFor('account') === 'http' ? buildAccountHost(run, control, appTransport()) : null;
export type { RunStore };
