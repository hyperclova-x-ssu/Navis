/**
 * T-083 per-run promo session (ARCHITECTURE 12.2·12.6, DATA_MODEL 10.16.2 last line, API-26 order).
 * One session per data store (WeakMap): the job watcher (polls every `making` row with a job id each 1000 ms, keeps
 * running with no window or widget mounted), the first-surface catalog sync (API-20 → `promo.syncCatalog`), the
 * estimate table and reference list caches, and the draft choices of the create window (kept for the run, cleared by
 * [새 영상 만들기]). Nothing here is React; `usePromoSession` in promo-hooks.ts subscribes to it.
 */
import type {
  DataCommandResult, PromoFailReason, PromoStage, PromoReferenceId, PromoVideo, PromoVideoInput, PromoLocale, VideoConcept, VideoMood, VideoPostRoute, WidgetDataStore,
} from '../../../data/widget-data';
import { failure, type CommandReceipt } from '../../../data/reality/00';
import type { CommandOf } from '../../../data/reality/00';
import { executePromo, saveDraftCommand } from '../../../data/reality/16/commands';
import { jobPath, openDraft, sameInput, type PromoDraftDto } from '../../../data/reality/16/dto';
import {
  downloadUrl, getCatalog, getEstimateModel, getJob, getReferences, newPromoKey, PromoHttpError, retryJob, startJob,
  type EstimateModel, type PromoJob, type ReferenceList,
} from './promo-api';

export const POLL_MS = 1000;
export const STAGES: readonly PromoStage[] = ['look', 'story', 'scenes', 'merge'];
export const MAX_NETWORK_ERRORS = 5;
export const MEMO_MAX = 100;
export const FAIL_REASONS: readonly PromoFailReason[] = ['AI_UNAVAILABLE', 'AI_TIMEOUT', 'AI_BAD_OUTPUT', 'CAPTION_TOO_LONG', 'RENDER_FAILED', 'ENCODE_FAILED', 'CODE_CHECK_FAILED', 'TOOL_MISSING', 'BUSY', 'CANCELLED_BY_RESTART'];

export type PromoTab = 0 | 1 | 2 | 3;
export interface PromoDraft {
  readonly menuIds: readonly string[];
  readonly photoIds: readonly string[];
  readonly moods: readonly VideoMood[];
  readonly concepts: readonly VideoConcept[];
  readonly memo: string;
  readonly referenceId: PromoReferenceId | null;
  /** null until the user picks ④ (no default, D-87g). */
  readonly lengthSec: 10 | 15 | 30 | null;
  readonly tab: PromoTab;
  /** Where the finished video goes (SCR-57 PlaceChoice, nothing chosen at first). */
  readonly place: VideoPostRoute | null;
  /** True after [새 영상 만들기]: the window shows the choice steps even though the latest video is posted. */
  readonly composing: boolean;
}
export const EMPTY_DRAFT: PromoDraft = Object.freeze({ menuIds: [], photoIds: [], moods: [], concepts: [], memo: '', referenceId: null, lengthSec: null, tab: 0, place: null, composing: false });

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SaveStatus = 'idle' | 'saved' | 'failed';
export interface PromoSessionState {
  readonly draft: PromoDraft;
  readonly catalog: LoadStatus;
  readonly estimate: { readonly status: LoadStatus; readonly value: EstimateModel | null };
  readonly references: { readonly status: LoadStatus; readonly value: ReferenceList | null };
  /** Local start time (ms) of each making row, for “{t} 지났어요” measured from the start. */
  readonly startedAt: Readonly<Record<string, number>>;
  /** Estimate seconds shown when the video was started (SCR-56 “예상 시간 약 {t}” keeps the start value). */
  readonly estimateAtStart: Readonly<Record<string, number | null>>;
  readonly saved: Readonly<Record<string, SaveStatus>>;
  /** The file name the browser saved (the server's `filename*`, API-25), for the caption next to 저장했어요. */
  readonly savedName: Readonly<Record<string, string>>;
  readonly writing?: 'draft' | 'generate' | 'retry';
}

export interface PromoSession {
  readonly store: WidgetDataStore;
  getState(): PromoSessionState;
  subscribe(listener: () => void): () => void;
  setDraft(patch: Partial<PromoDraft>): void;
  /** [새 영상 만들기]: every earlier choice is cleared (AC-347). */
  startNew(): void;
  syncCatalog(): Promise<void>;
  loadEstimate(force?: boolean): Promise<void>;
  loadReferences(force?: boolean): Promise<void>;
  /** [영상 만들기] (API-26 step 1). A second press while one is pending or making gives the data layer's BUSY / the same row. */
  make(input: PromoVideoInput, estimateSeconds: number | null, transport?: typeof startJob): DataCommandResult;
  /** [다시 만들기] (API-26 step 3): same input, a new server job. */
  retry(videoId: string, transport?: PromoRetryTransport): DataCommandResult;
  saveDraft(locale: PromoLocale): Promise<DataCommandResult>;
  addExamplePhoto(file: File, menuId: string): Promise<DataCommandResult>;
  makeConfirmed(input: PromoVideoInput, estimateSeconds: number | null): Promise<DataCommandResult>;
  retryConfirmed(videoId: string): Promise<DataCommandResult>;
  /** [저장하기] (API-25 + `video.save`). */
  save(videoId: string, fileName: string): Promise<SaveStatus>;
  /** Stops the poll timer (tests). */
  dispose(): void;
}

type PromoRetryTransport = { startJob: typeof startJob; retryJob: typeof retryJob };
const httpJobs: PromoRetryTransport = { startJob, retryJob };

/** Fixture Navis exercises job start and attachment without making a media request. */
export const offlinePromoRetry: PromoRetryTransport = {
  startJob: key => offlineJob(key),
  retryJob: (_jobId, key) => offlineJob(key),
};
async function offlineJob(key: string): Promise<PromoJob> {
  const suffix = key.slice(-12).replace(/[^0-9a-f]/gu, '0').padStart(12, '0');
  return { jobId: `pj-${suffix}`, status: 'failed', stage: 'look', stageState: 'failed', failReason: 'AI_UNAVAILABLE' };
}

const sessions = new WeakMap<WidgetDataStore, PromoSession>();
// N18: Navis cards read the owner's own draft without a store handle. The key is the run of the data snapshot.
const sessionsByRun = new Map<string, WeakRef<PromoSession>>();

/** The run's promo session for this store, created on first use (the first mkt-promo surface). */
export function promoSession(store: WidgetDataStore): PromoSession {
  let session = sessions.get(store);
  if (!session) {
    session = createSession(store); sessions.set(store, session);
    sessionsByRun.set(store.getSnapshot().runId ?? 'run', new WeakRef(session));
  }
  return session;
}

/** The session this run already has (undefined until a promo surface or a Navis card created it). Reads only. */
export function peekPromoSession(runId: string): PromoSession | undefined {
  const session = sessionsByRun.get(runId)?.deref();
  return session && (session.store.getSnapshot().runId ?? 'run') === runId ? session : undefined;
}

const rowsOf = (store: WidgetDataStore): readonly PromoVideo[] => store.getSnapshot().tables.marketing.promoVideo;
const isReason = (value: unknown): value is PromoFailReason => typeof value === 'string' && (FAIL_REASONS as readonly string[]).includes(value);
const realPort = (store: WidgetDataStore) => store.real?.mode('promo') === 'http' ? store.real : undefined;
const sessionEnded = () => failure('CONFLICT', 'SESSION_ENDED', 'data.real.error.SESSION_ENDED');
const draftRequired = () => failure('VALIDATION', 'DRAFT_REQUIRED', 'promo.real.draftRequired');
const writeBusy = () => failure('CONFLICT', 'TRANSACTION_BUSY', 'data.marketing.error.busy');

function generated(result: DataCommandResult): DataCommandResult {
  return result.ok ? { ...result, params: { videoId: (result.value as CommandReceipt).resourceId } } : result;
}

function draftInput(draft: PromoDraft, locale: PromoLocale): Partial<PromoVideoInput> {
  return { menuIds: draft.menuIds, photoIds: draft.photoIds, moods: draft.moods, concepts: draft.concepts, memo: draft.memo, locale,
    ...(draft.referenceId ? { referenceId: draft.referenceId } : {}), ...(draft.lengthSec ? { lengthSec: draft.lengthSec } : {}) };
}
/** API-26 step 1: 409 is BUSY, a missing tool is TOOL_MISSING, a network or other server error is AI_UNAVAILABLE. */
function reasonOfStartError(error: unknown): PromoFailReason {
  if (error instanceof PromoHttpError) {
    if (error.status === 409 || error.code === 'BUSY') return 'BUSY';
    if (error.code === 'TOOL_MISSING') return 'TOOL_MISSING';
  }
  return 'AI_UNAVAILABLE';
}

function createSession(store: WidgetDataStore): PromoSession {
  let state: PromoSessionState = { draft: EMPTY_DRAFT, catalog: 'idle', estimate: { status: 'idle', value: null }, references: { status: 'idle', value: null }, startedAt: {}, estimateAtStart: {}, saved: {}, savedName: {} };
  const listeners = new Set<() => void>();
  const set = (next: Partial<PromoSessionState>) => { state = { ...state, ...next }; for (const listener of [...listeners]) listener(); };
  const inFlight = new Set<string>();
  const networkErrors = new Map<string, number>();
  /** Rows whose start request (API-22/24) has not answered yet; the watcher leaves them alone. */
  const starting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let scope = 0;
  let hadReadModel = false;
  let edited = false;
  let draftBase: PromoDraftDto | undefined;
  let unresolvedGeneration: CommandOf<'video.make' | 'video.retry'> | undefined;
  const readModel = () => store.getSnapshot().tables.realPromo;

  function syncDraft() {
    const model = readModel();
    if (!model && hadReadModel) {
      scope += 1;
      draftBase = undefined;
      unresolvedGeneration = undefined;
      edited = false;
      set({ draft: EMPTY_DRAFT, writing: undefined, startedAt: {}, estimateAtStart: {}, saved: {}, savedName: {} });
    }
    hadReadModel = model !== undefined;
    const next = openDraft(model);
    if (next?.draftId === draftBase?.draftId && next?.revision === draftBase?.revision) return;
    if (edited) return;
    const previous = draftBase;
    draftBase = next;
    if (next) set({ draft: { ...EMPTY_DRAFT, tab: state.draft.tab, ...next.input, composing: true } });
    if (!next && previous) set({ draft: { ...state.draft, composing: false, place: null } });
  }

  const settleFailed = (videoId: string, reason: PromoFailReason) => { store.dispatch({ type: 'video.settle', videoId, outcome: { kind: 'failed', reason } }); };

  function applyJob(videoId: string, job: PromoJob): void {
    networkErrors.delete(videoId);
    if (job.status === 'done' && job.result) {
      const r = job.result;
      store.dispatch({ type: 'video.progress', videoId, stage: 'merge', stageState: 'done' });
      store.dispatch({
        type: 'video.settle', videoId,
        outcome: { kind: 'done', result: { durationSec: r.durationSec, music: { trackId: r.music.trackId, title: r.music.title, artist: r.music.artist, licenseLabel: r.music.license }, fileUrl: r.fileUrl, sizeBytes: r.sizeBytes, madeAt: new Date().toISOString() } },
      });
      return;
    }
    if (job.status === 'failed') { settleFailed(videoId, isReason(job.failReason) ? job.failReason : 'AI_BAD_OUTPUT'); return; }
    store.dispatch({ type: 'video.progress', videoId, stage: job.stage, stageState: job.stageState, ...(typeof job.lookCount === 'number' ? { lookCount: job.lookCount } : {}) });
  }

  async function poll(row: PromoVideo): Promise<void> {
    const jobId = row.jobId;
    if (!jobId) return;
    inFlight.add(row.videoId);
    try {
      const job = await getJob(jobId);
      const now = rowsOf(store).find((v) => v.videoId === row.videoId);
      if (now?.status === 'making' && now.jobId === jobId) applyJob(row.videoId, job);
    } catch (error) {
      const now = rowsOf(store).find((v) => v.videoId === row.videoId);
      if (now?.status !== 'making' || now.jobId !== jobId) return;
      // An unknown job id means the server restarted (API-23); five network errors in a row are UNAVAILABLE.
      if (error instanceof PromoHttpError && error.status === 404) { settleFailed(row.videoId, 'CANCELLED_BY_RESTART'); return; }
      const count = (networkErrors.get(row.videoId) ?? 0) + 1;
      networkErrors.set(row.videoId, count);
      if (count >= MAX_NETWORK_ERRORS) { networkErrors.delete(row.videoId); settleFailed(row.videoId, 'AI_UNAVAILABLE'); }
    } finally {
      inFlight.delete(row.videoId);
    }
  }

  function tick(): void {
    timer = null;
    if (disposed) return;
    const port = realPort(store);
    if (port) {
      void port.load('promo', { force: true }).finally(schedule);
      return;
    }
    for (const row of rowsOf(store)) if (row.status === 'making' && row.jobId && !inFlight.has(row.videoId) && !starting.has(row.videoId)) void poll(row);
    schedule();
  }
  function schedule(): void {
    if (disposed || timer !== null) return;
    if (!rowsOf(store).some((row) => row.status === 'making')) return;
    timer = setTimeout(tick, POLL_MS);
  }
  // The watcher lives with the store: any new `making` row (from any surface) starts the 1000 ms loop.
  const unsubscribe = store.subscribe(() => {
    if (realPort(store)) syncDraft();
    schedule();
  });
  if (realPort(store)) { syncDraft(); schedule(); }

  async function persistDraft(input: Partial<PromoVideoInput>, base: PromoDraftDto | undefined): Promise<DataCommandResult> {
    if (!readModel()) return sessionEnded();
    if (base && sameInput(input, base.input)) return { ok: true, revision: store.getSnapshot().revision };
    const started = scope;
    const wasEdited = edited;
    edited = false;
    const result = await executePromo(store, saveDraftCommand(input, base));
    if (started !== scope) return sessionEnded();
    if (!result.ok) {
      if (result.reason === 'STALE_REVISION' && !edited) syncDraft();
      else edited ||= wasEdited;
    }
    return result;
  }

  async function write(kind: NonNullable<PromoSessionState['writing']>, action: () => Promise<DataCommandResult>) {
    if (state.writing) return writeBusy();
    const started = scope;
    set({ writing: kind });
    try { return await action(); }
    finally { if (started === scope) set({ writing: undefined }); }
  }

  async function requestGeneration(command: CommandOf<'video.make' | 'video.retry'>, estimateSeconds: number | null) {
    const started = scope;
    const result = await store.execute(command);
    if (started !== scope) return sessionEnded();
    unresolvedGeneration = !result.ok && result.outcomeUnknown ? command : undefined;
    if (result.ok) {
      const { resourceId } = result.value as CommandReceipt;
      set({ draft: { ...state.draft, composing: false, place: null },
        startedAt: { ...state.startedAt, [resourceId]: Date.now() }, estimateAtStart: { ...state.estimateAtStart, [resourceId]: estimateSeconds } });
    }
    return generated(result);
  }

  async function attach(videoId: string, request: Promise<PromoJob>): Promise<void> {
    starting.add(videoId);
    try {
      const job = await request;
      const attached = store.dispatch({ type: 'video.attachJob', videoId, jobId: job.jobId });
      if (!attached.ok) {
        settleFailed(videoId, 'AI_BAD_OUTPUT');
        return;
      }
      if (!state.startedAt[videoId] && job.startedAt) set({ startedAt: { ...state.startedAt, [videoId]: Date.parse(job.startedAt) || Date.now() } });
      applyJob(videoId, job);
    } catch (error) {
      settleFailed(videoId, reasonOfStartError(error));
    } finally {
      starting.delete(videoId);
      schedule();
    }
  }

  async function load<K extends 'estimate' | 'references'>(key: K, fetcher: () => Promise<NonNullable<PromoSessionState[K]['value']>>, force: boolean): Promise<void> {
    const current = state[key];
    if (current.status === 'loading' || (current.status === 'ready' && !force)) return;
    set({ [key]: { status: 'loading', value: current.value } } as Partial<PromoSessionState>);
    try {
      const value = await fetcher();
      set({ [key]: { status: 'ready', value } } as Partial<PromoSessionState>);
    } catch {
      set({ [key]: { status: 'error', value: current.value } } as Partial<PromoSessionState>);
    }
  }

  return {
    store,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setDraft(patch) {
      if (realPort(store) && Object.keys(patch).some(key => key !== 'tab' && key !== 'composing' && key !== 'place')) edited = true;
      set({ draft: { ...state.draft, ...patch } });
    },
    startNew() {
      const saved = realPort(store) ? openDraft(readModel())?.input : undefined;
      set({ draft: { ...EMPTY_DRAFT, ...saved, composing: true } });
    },
    async syncCatalog() {
      if (state.catalog === 'loading' || state.catalog === 'ready') return;
      set({ catalog: 'loading' });
      const port = realPort(store);
      if (port) {
        const outcome = await port.load('promo');
        set({ catalog: outcome.status === 'ready' || outcome.status === 'stale' ? 'ready' : 'error' });
        return;
      }
      try {
        const catalog = await getCatalog();
        const result = store.dispatch({ type: 'promo.syncCatalog', catalog });
        set({ catalog: result.ok ? 'ready' : 'error' });
      } catch (error) {
        const staticCatalog = error instanceof PromoHttpError && (error.code === 'BAD_RESPONSE' || error.status === 404);
        set({ catalog: staticCatalog ? 'ready' : 'error' });
      }
    },
    loadEstimate: (force = false) => load('estimate', getEstimateModel, force),
    loadReferences: (force = false) => load('references', getReferences, force),
    saveDraft(locale) {
      return write('draft', async () => {
        if (realPort(store)) return persistDraft(draftInput(state.draft, locale), draftBase);
        // Example drafts are already kept for the lifetime of this run by setDraft.
        return { ok: true, revision: store.getSnapshot().revision };
      });
    },
    async addExamplePhoto(file, menuId) {
      if (realPort(store)) return sessionEnded();
      const image = await createImageBitmap(file);
      const { width, height } = image;
      image.close();
      // Keep the file in the example run. The real upload and its receipts use the account port.
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(reader.error);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const { promoStore, promoMenu, promoPhoto } = store.getSnapshot().tables.marketing;
      const shop = promoStore[0];
      if (!shop || !promoMenu.some(menu => menu.menuId === menuId)) return draftRequired();
      const photoId = `own-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const photos = [...promoPhoto, { photoId, menuId, url, width, height }];
      const result = store.dispatch({ type: 'promo.syncCatalog', catalog: {
        sourceId: shop.sourceId,
        store: { ...shop, exteriorPhotoId: shop.exteriorPhotoId ?? 'example', exteriorUrl: shop.exteriorUrl ?? '/api/promo/photos/example' },
        menus: promoMenu.map(menu => ({ ...menu, photoIds: photos.filter(photo => photo.menuId === menu.menuId).map(photo => photo.photoId) })),
        photos,
      } });
      if (result.ok) set({ catalog: 'ready' });
      return result;
    },
    makeConfirmed(input, estimateSeconds) {
      return write('generate', async () => {
        if (unresolvedGeneration) {
          return unresolvedGeneration.type === 'video.make' && sameInput(input, unresolvedGeneration.input)
            ? requestGeneration(unresolvedGeneration, estimateSeconds) : writeBusy();
        }
        const base = draftBase;
        const saved = await persistDraft(input, base);
        if (!saved.ok) return saved;
        const draft = openDraft(readModel());
        if (!draft || !sameInput(input, draft.input)) return draftRequired();
        return requestGeneration({ type: 'video.make', input, idempotencyKey: `generate-${draft.draftId}-${draft.revision}` }, estimateSeconds);
      });
    },
    retryConfirmed(videoId) {
      return write('retry', async () => {
        if (unresolvedGeneration) {
          return unresolvedGeneration.type === 'video.retry' && unresolvedGeneration.videoId === videoId
            ? requestGeneration(unresolvedGeneration, null) : writeBusy();
        }
        const failed = rowsOf(store).find(row => row.videoId === videoId && row.status === 'failed');
        if (!failed) return draftRequired();
        const previous = openDraft(readModel());
        if (previous && !sameInput(failed.input, previous.input)) return draftRequired();
        const saved = await persistDraft(failed.input, previous);
        if (!saved.ok) return saved;
        const draft = openDraft(readModel());
        if (!draft) return draftRequired();
        return requestGeneration({ type: 'video.retry', videoId, idempotencyKey: `retry-${draft.draftId}-${draft.revision}` }, null);
      });
    },
    make(input, estimateSeconds, transport = startJob) {
      if (realPort(store)) return failure('VALIDATION', 'ASYNC_REQUIRED', 'data.real.error.ASYNC_REQUIRED');
      const key = newPromoKey('make');
      const result = store.dispatch({ type: 'video.make', input, idempotencyKey: key });
      if (!result.ok || result.duplicate) return result;
      const videoId = (result.value as { videoId: string }).videoId;
      set({ draft: { ...state.draft, composing: false, place: null }, startedAt: { ...state.startedAt, [videoId]: Date.now() }, estimateAtStart: { ...state.estimateAtStart, [videoId]: estimateSeconds } });
      void attach(videoId, transport(key, input));
      return result;
    },
    retry(videoId, transport = httpJobs) {
      if (realPort(store)) return failure('VALIDATION', 'ASYNC_REQUIRED', 'data.real.error.ASYNC_REQUIRED');
      const before = rowsOf(store).find((v) => v.videoId === videoId);
      const key = newPromoKey('retry');
      const result = store.dispatch({ type: 'video.retry', videoId, idempotencyKey: key });
      if (!result.ok || result.duplicate || !result.value || !before) return result;
      set({ draft: { ...state.draft, composing: false }, startedAt: { ...state.startedAt, [videoId]: Date.now() } });
      // A job the server still knows is retried with its saved input (API-24); otherwise (never attached, or the
      // server restarted and forgot it) the same input starts a new job (API-22).
      const request = before.jobId
        ? transport.retryJob(before.jobId, key).catch((error: unknown) => {
          if (error instanceof PromoHttpError && (error.status === 404 || error.status === 400)) return transport.startJob(newPromoKey('make'), before.input);
          throw error;
        })
        : transport.startJob(newPromoKey('make'), before.input);
      void attach(videoId, request);
      return result;
    },
    async save(videoId, fileName) {
      const row = rowsOf(store).find((v) => v.videoId === videoId);
      const fileUrl = row?.result?.fileUrl;
      let status: SaveStatus = 'failed';
      let name = fileName;
      const port = realPort(store);
      if (port && row?.jobId && fileUrl) {
        const started = scope;
        try {
          const content = await port.transport.request<Blob>({ method: 'GET', path: `${jobPath(row.jobId)}/video.mp4`, query: { download: 1 }, responseAs: 'blob' });
          if (started !== scope) return 'failed';
          const url = URL.createObjectURL(content);
          downloadFile(url, fileName);
          setTimeout(() => URL.revokeObjectURL(url), 1_000);
          status = 'saved';
        } catch { if (started !== scope) return 'failed'; }
        set({ saved: { ...state.saved, [videoId]: status }, savedName: { ...state.savedName, [videoId]: name } });
        return status;
      }
      if (fileUrl) {
        try {
          const head = await globalThis.fetch(downloadUrl(fileUrl), { method: 'HEAD', cache: 'no-store' });
          if (head.ok) {
            name = fileNameOf(head.headers.get('Content-Disposition')) ?? fileName;
            downloadFile(downloadUrl(fileUrl), name);
            status = store.dispatch({ type: 'video.save', videoId }).ok ? 'saved' : 'failed';
          }
        } catch {
          status = 'failed';
        }
      }
      set({ saved: { ...state.saved, [videoId]: status }, savedName: { ...state.savedName, [videoId]: name } });
      return status;
    },
    dispose() { disposed = true; if (timer !== null) clearTimeout(timer); timer = null; unsubscribe(); },
  };
}

function downloadFile(url: string, name: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

/** `filename*=UTF-8''…` (else `filename="…"`) of a Content-Disposition header. */
export function fileNameOf(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ } }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : null;
}

/** The make input from the draft (photos in catalog order, the app language at the moment of [영상 만들기]). */
export function inputOfDraft(draft: PromoDraft, photoOrder: readonly string[], locale: PromoLocale): PromoVideoInput | null {
  if (!draft.referenceId || draft.lengthSec === null) return null;
  const chosen = new Set(draft.photoIds);
  return {
    menuIds: [...draft.menuIds], photoIds: photoOrder.filter((id) => chosen.has(id)), moods: [...draft.moods], concepts: [...draft.concepts],
    memo: draft.memo, referenceId: draft.referenceId, lengthSec: draft.lengthSec, locale,
  };
}
