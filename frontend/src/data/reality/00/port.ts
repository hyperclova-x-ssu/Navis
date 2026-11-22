/**
 * REAL-PLAN F00 — the shared data port contract (types and constants only; implementation in the sibling files).
 *
 * UI → this port → api-gateway `/api/v1/stores/{storeId}/…` → owning service → its PostgreSQL DB.
 * Widgets keep reading selectors over the `DataSnapshot` and keep dispatching their existing command names with
 * unchanged argument shapes; a per-domain adapter fills the snapshot tables from HTTP and maps each command to a
 * request. `fixture` mode (the seed/store) stays for tests and the disposable demo reset.
 */
import type { DataCommand, DataCommandResult, DataCommandType } from '../../commands/types';
import type { DataWidgetId } from '../../conditions';
import type { DataSnapshot, DataTables } from '../../db/types';

/* ── Domains: one per R1 pair `Bnn/Fnn` (REAL_PLAN §R1 worker assignments). ── */
export const REAL_DOMAIN_PAIR = {
  account: '00', menu: '01', pos: '02', stock: '03', purchase: '04', members: '05', booking: '06', staff: '07',
  custom: '08', money: '09', cctv: '10', manuals: '11', briefing: '12', local: '13', coupons: '14', inbox: '15',
  promo: '16', navis: '17', tax: '18', groups: '19',
} as const;
export type RealDomain = keyof typeof REAL_DOMAIN_PAIR;
export const REAL_DOMAINS = Object.keys(REAL_DOMAIN_PAIR) as readonly RealDomain[];

/** The domain whose adapter serves a widget's tables (REAL_PLAN "HTTP cutover by widget"). */
export const WIDGET_DOMAIN: Readonly<Record<DataWidgetId, RealDomain>> = {
  menu: 'menu', 'custom-order': 'custom', 'inventory-booking': 'stock', suppliers: 'purchase', ledger: 'money', margin: 'money', tax: 'tax',
  'credit-receivable': 'members', members: 'members', 'customer-analysis': 'cctv', 'store-environment': 'cctv', manuals: 'manuals', grants: 'manuals',
  'staff-schedule': 'staff', calendar: 'staff', 'voice-booking': 'booking', briefing: 'briefing',
  'local-changes': 'local', 'trade-area': 'local', 'local-trends': 'local', community: 'local',
  'ai-response': 'inbox', 'notice-send': 'inbox',
  'marketing-today': 'groups', 'customer-groups': 'groups', 'marketing-performance': 'groups',
  'slot-coupon': 'coupons', 'expiry-coupon': 'coupons', 'coupon-status': 'coupons', 'promo-video': 'promo',
};

/**
 * Domains a widget's numbers also come from (REAL_PLAN "Integrated evidence prerequisites"). While any HTTP dependency is not loaded the widget
 * shows loading (or error), so rows a dependency still holds from the fixture seed never leak into it; Navis facts load them through `ensureWidgetData`.
 * A dependency in fixture mode costs nothing. Ask F00 to add an edge when a pair's projection reads another domain's tables.
 */
export const WIDGET_DEPENDENCIES: Readonly<Partial<Record<DataWidgetId, readonly RealDomain[]>>> = {
  briefing: ['staff', 'booking', 'purchase', 'custom', 'money', 'cctv', 'manuals', 'local', 'tax', 'stock', 'members', 'inbox'],
  'notice-send': ['staff', 'members'],
  'ai-response': ['staff', 'members'],
  'marketing-today': ['promo'],
  'marketing-performance': ['promo'],
  'customer-analysis': ['staff'],
  'voice-booking': ['members'],
  margin: ['menu', 'purchase', 'stock'],
  'inventory-booking': ['menu', 'purchase'],
  suppliers: ['stock', 'menu'],
  calendar: ['purchase'],
};
/** A widget's own domain first, then its dependencies (no duplicates). */
export const widgetDomains = (id: DataWidgetId): readonly RealDomain[] => [...new Set([WIDGET_DOMAIN[id], ...(WIDGET_DEPENDENCIES[id] ?? [])])];

/** `http` reads/writes the backend; `fixture` is the seed-backed store (tests, disposable demo reset). Decided per domain. */
export type RealSource = 'http' | 'fixture';

/* ── HTTP request helper ───────────────────────────────────────────────────────────────────────────────────── */
export type PortMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface PortRequest {
  readonly method: PortMethod;
  /** `'/inventory/menu'` → `/api/v1/stores/{storeId}/inventory/menu`. With `scope: 'root'` the path is used as given (`/api/v1/stores`). */
  readonly path: string;
  readonly scope?: 'store' | 'root';
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** JSON body. Never put secrets, phone numbers or message bodies in query strings. */
  readonly body?: unknown;
  /** Sent as the `Idempotency-Key` header. The port generates one per logical attempt when a command has none. */
  readonly idempotencyKey?: string;
  /** Merged into the JSON body as `expectedRevision` (B01 convention); a stale value comes back as 409 `STALE_REVISION`. */
  readonly expectedRevision?: number;
  /** Raw bytes instead of JSON (file content upload). */
  readonly bytes?: Blob;
  /** Read the response as bytes instead of JSON (authorized file read). */
  readonly responseAs?: 'blob';
  readonly signal?: AbortSignal;
}

export type PortErrorCode =
  | 'INVALID_REQUEST' | 'VALIDATION' | 'UNAUTHENTICATED' | 'TOKEN_EXPIRED' | 'STORE_FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'SERVICE_UNAVAILABLE'
  | 'NETWORK' | 'TIMEOUT' | 'UNKNOWN';
/** Backend error body, e.g. `{"code":"CONFLICT","reason":"STALE_REVISION"}` or `{"code":"VALIDATION","reason":"UNIT_MISMATCH","field":"lines.0.unit"}`. */
export interface PortErrorBody { readonly code: PortErrorCode; readonly reason?: string; readonly field?: string; readonly details?: Readonly<Record<string, unknown>> }

export class PortError extends Error {
  /** `unknown` = the request may have reached the server (network error, timeout, 5xx after send): reconcile with the same key, never re-create. */
  constructor(readonly status: number, readonly code: PortErrorCode, readonly reason?: string, readonly field?: string, readonly outcomeUnknown = false,
    /** Structured, already-sanitized facts from the server (e.g. which record a duplicate collided with). Never personal data: the server decides what it sends. */
    readonly details?: Readonly<Record<string, unknown>>) {
    super(`Port request failed: ${code}${reason ? `/${reason}` : ''}`);
    this.name = 'PortError';
  }
  get retryable(): boolean { return this.code === 'SERVICE_UNAVAILABLE' || this.code === 'NETWORK' || this.code === 'TIMEOUT'; }
}

export interface PortTransport {
  /** The store this browser session is bound to (the session token's `storeId`); starts the session when needed. */
  storeId(): Promise<string>;
  /** Authenticated JSON request: bearer token, TOKEN_EXPIRED refresh once, multi-tab refresh lock, `no-store`. Throws `PortError`. */
  request<T>(request: PortRequest): Promise<T>;
  /** Forget the token and in-flight refresh (logout, store change). */
  reset(): void;
}

/* ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────── */
/** List reads are bounded: cursor, period and filters in `query`; `limit` ≤ 200. */
export interface ListPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  /** ISO time the server computed this page. */
  readonly asOf: string;
  readonly sourceRevision: number;
}

/** A scoped read: store, period, filter and resource name form the cache scope. */
export interface ReadRequest {
  /** Resource name, e.g. `menu`. Part of the cache key with the store id, path and query. */
  readonly resource: string;
  readonly path: string;
  readonly query?: PortRequest['query'];
  readonly scope?: PortRequest['scope'];
}

export interface PortReads {
  /** One page. */
  page<T>(request: ReadRequest, options?: { readonly cursor?: string; readonly signal?: AbortSignal }): Promise<ListPage<T>>;
  /** Follow `nextCursor` up to `maxPages` (default 20, page size ≤ 200). `complete:false` when the bound was hit. Never silently truncates. */
  all<T>(request: ReadRequest, options?: { readonly maxPages?: number; readonly signal?: AbortSignal }): Promise<{ readonly items: readonly T[]; readonly asOf: string; readonly sourceRevision: number; readonly complete: boolean }>;
  /** A single resource (detail). */
  one<T>(request: ReadRequest, options?: { readonly signal?: AbortSignal }): Promise<T>;
}

/** State of a cached resource or domain. `stale` keeps the last good data after a failed refresh; `error` has none. */
export type ResourceState<T> =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'ready'; readonly data: T; readonly asOf: string; readonly sourceRevision: number; readonly refreshing: boolean }
  | { readonly status: 'empty'; readonly asOf: string; readonly sourceRevision: number; readonly refreshing: boolean }
  | { readonly status: 'stale'; readonly data: T; readonly asOf: string; readonly error: PortError; readonly refreshing: boolean }
  | { readonly status: 'error'; readonly error: PortError; readonly refreshing: boolean };

/* ── Domain adapter: tables in, commands out ─────────────────────────────────────────────────────────── */
export interface LoadContext {
  readonly reads: PortReads;
  readonly storeId: string;
  /** Current tables, e.g. to keep ids stable across refreshes. Do not mutate. */
  readonly snapshot: DataSnapshot;
  readonly signal: AbortSignal;
}
export interface LoadResult {
  /** Whole-table replacements for tables listed in `adapter.tables`. Rows are the existing `DataTables` row shapes. */
  readonly tables: Partial<DataTables>;
  readonly asOf: string;
  readonly sourceRevision: number;
  /** Server resource revisions by `resource:id` (e.g. `menu:<uuid>`), used as `expectedRevision` on writes. */
  readonly revisions?: Readonly<Record<string, number>>;
  /** `false` when a page bound truncated a list: the domain shows `stale` + a partial note, never a silent subset. */
  readonly complete: boolean;
}

export interface CommandRequest {
  readonly method: Exclude<PortMethod, 'GET'>;
  readonly path: string;
  readonly body?: unknown;
  /** Resource revision the command was issued against; omit for creates. */
  readonly expectedRevision?: number;
}
/** Attachments over the account service (REAL-PLAN B00 `files`): create → PUT content → complete; reads are authorized fetches. */
export interface PortFile { readonly fileId: string; readonly contentType: string; readonly size: number; readonly sha256: string }
export interface PortFiles {
  /** `POST /files {purpose,contentType,size,sha256}` (Idempotency-Key from the content hash) → `PUT /files/{id}/content` → `POST /files/{id}/complete`. */
  upload(input: { readonly purpose: string; readonly blob: Blob }): Promise<PortFile>;
  /** `data:image/png;base64,…` → `upload`. Throws `PortError(400,'VALIDATION','FILE_INVALID')` for anything else. */
  uploadDataUrl(purpose: string, dataUrl: string): Promise<PortFile>;
  /** Authorized `GET /files/{id}/content` → object URL for `<img src>`. The caller revokes it with `URL.revokeObjectURL`. */
  readUrl(fileId: string): Promise<string>;
  /** `DELETE /files/{id}` (revoke). */
  revoke(fileId: string): Promise<void>;
}

export interface CommandContext {
  readonly snapshot: DataSnapshot;
  readonly storeId: string;
  readonly files: PortFiles;
  /** F15 additive: authenticated request helper for a binding's own pre-step (e.g. the owner-card approval POST). Never a write by itself. */
  readonly request: PortTransport['request'];
  /** `resource:id` → server revision from the last load. */
  revision(key: string): number | undefined;
}
export type CommandOf<T extends DataCommandType> = Extract<DataCommand, { readonly type: T }>;

/** Success body of every command: `{resourceId,revision,receiptId,undoUntil?,affectedSources,changed?}`. A no-op has `changed:false` and no `undoUntil`. */
export interface CommandReceipt {
  readonly resourceId: string;
  readonly revision: number;
  readonly receiptId: string;
  readonly undoUntil?: string;
  readonly affectedSources: readonly string[];
  readonly changed?: boolean;
}

export interface CommandBinding<T extends DataCommandType = DataCommandType> {
  /** The widget/Navis command name. Names and input shapes are unchanged (Navis cards follow automatically). */
  readonly type: T;
  /**
   * Command → HTTP request. Throw `PortError(400,'VALIDATION',reason,field)` to reject before sending. May be async to upload
   * attachments first (`ctx.files.upload…`, idempotent by content hash); it runs once per logical attempt, never on a reconcile resend.
   */
  request(command: CommandOf<T>, context: CommandContext): CommandRequest | Promise<CommandRequest>;
  /**
   * `'local'` runs the existing fixture handler for an immediate preview that is rolled back on failure and replaced by the re-read.
   * Omit for pending-until-confirmed (money, stock, sends): the widget awaits `execute()`.
   */
  readonly optimistic?: 'local';
  /** Base of the receipt resource for undo: `POST {base}/receipts/{receiptId}/undo`. Omit when the command has no undo. */
  readonly receiptBase?: string;
  /** F15 additive: a store-relative undo path when the service does not use `{receiptBase}/receipts/{id}/undo` (e.g. `/marketing/notice-reply-receipts/{id}/undo`). Needs `receiptBase` for the undo receipt. */
  readonly undoPath?: (receiptId: string) => string;
  /** Notice shown on success (existing `data.*` message key). */
  readonly noticeKey?: string;
}

export interface DomainAdapter {
  readonly domain: RealDomain;
  /** Names this domain reads, matched against `receipt.affectedSources` to re-read after a commit in another domain. Default `[domain]`. */
  readonly sources?: readonly string[];
  /** `DataTables` keys this adapter fills from HTTP; their fixture rows are dropped in http mode. */
  readonly tables: readonly (keyof DataTables)[];
  /** Erase store-scoped fields in shared tables when access ends. Other owned keys reset to their initial shape with arrays emptied. */
  clear?(snapshot: DataSnapshot): Partial<DataTables>;
  /** Overlay fields of a shared table on the latest snapshot at commit time. */
  merge?(snapshot: DataSnapshot, tables: Partial<DataTables>): Partial<DataTables>;
  /** Backend `reason` → message key for this domain's own error codes (e.g. `UNIT_MISMATCH`). Unmapped rejections use shared copy. */
  readonly errorKeys?: Readonly<Record<string, string>>;
  load(context: LoadContext): Promise<LoadResult>;
  readonly commands: readonly CommandBinding[];
}

/** Type helper: keeps `type`-specific `request()` typing while allowing a heterogeneous `commands` list. */
export const defineBinding = <T extends DataCommandType>(binding: CommandBinding<T>): CommandBinding => binding as unknown as CommandBinding;

/* ── Port surface used by the store, hooks and Navis ──────────────────────────────────────────────────── */
export interface DomainState {
  readonly mode: RealSource;
  /** `fixture` (no HTTP), or the HTTP lifecycle. Pending writes are counted separately. */
  readonly status: 'fixture' | 'idle' | 'loading' | 'ready' | 'stale' | 'error';
  readonly asOf?: string;
  readonly sourceRevision?: number;
  readonly error?: PortError;
  /** Commands sent and not yet confirmed (show financial/stock/send actions as pending). */
  readonly pending: number;
  readonly refreshing: boolean;
  readonly complete: boolean;
}

export interface RealPort {
  readonly transport: PortTransport;
  readonly reads: PortReads;
  readonly files: PortFiles;
  /** Source mode of a domain right now. */
  mode(domain: RealDomain): RealSource;
  state(domain: RealDomain): DomainState;
  subscribe(listener: () => void): () => void;
  /** Load (or re-read) a domain into the store. Concurrent calls share one request. */
  load(domain: RealDomain, options?: { readonly force?: boolean }): Promise<DomainState>;
  /** Re-read after a failure; same as `load(domain, {force:true})`. */
  retry(domain: RealDomain): Promise<DomainState>;
  /**
   * Authoritative command: resolves after the server receipt AND the dependent re-read. Duplicate presses while pending return the same
   * promise; an unknown outcome is reconciled by resending with the same Idempotency-Key. Fixture-mode commands go to the local store.
   */
  execute(command: DataCommand): Promise<DataCommandResult>;
  /** `real-undo:{receiptId}` tokens from `execute()` results. Checks the receipt's `undoUntil`, then POSTs the undo. */
  undo(token: string): Promise<DataCommandResult>;
  /** How the sync `dispatch` treats a command: `optimistic` (local preview + background execute), `async` (must use `execute`), or `null` (fixture). */
  route(command: DataCommand): 'optimistic' | 'async' | null;
  /** The optimistic path: `preview` is the immediate local result, `settled` the authoritative one. */
  begin(command: DataCommand): { readonly preview: DataCommandResult | undefined; readonly settled: Promise<DataCommandResult> };
  /** Background failures of optimistic commands and undos (the host shows a notice and the rolled-back state). */
  onFailure(listener: (event: { readonly command: DataCommand | null; readonly result: Extract<DataCommandResult, { readonly ok: false }> }) => void): () => void;
  /** Remove hydrated rows and revisions. Keep the transport when it already holds the next explicitly selected session. */
  reset(options?: { readonly keepSession?: boolean; readonly error?: PortError }): void;
}

/** Undo tokens of real commands carry this prefix so the store can tell them from fixture tokens. */
export const REAL_UNDO_PREFIX = 'real-undo:';
