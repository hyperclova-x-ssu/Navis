/** F15 hooks for the inquiry and notice widgets in HTTP mode: the raw records, one command at a time, and the TalkTalk consultation read. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WidgetHost } from '../../../contracts';
import type { DataCommand, DataCommandResult } from '../../commands/types';
import { useDataExecute, useRealPort, useWidgetDataStore } from '../../react';
import type { CommandReceipt } from '../00';
import { readNotice, readReviewInsights, readSmsReservation, reviewDraftPreview } from './adapter';
import type { NoticeDetailDto, RealInbox, ReviewDraftPreviewDto, ReviewDraftSource, ReviewInsightsDto, ReviewStatsUnit, SmsReservationDto } from './dto';

export function useInboxHttp(): boolean { return useRealPort()?.mode('inbox') === 'http'; }

export function useInbox(): RealInbox | undefined {
  const store = useWidgetDataStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).tables.realInbox;
}

/** A fresh Idempotency-Key per owner press; the port keeps it across reconcile resends. */
export const pressKey = (prefix: string) => `${prefix}:${globalThis.crypto.randomUUID()}`;

/**
 * One owner press at a time. A second press while the first is pending is ignored, so a double press creates one record. The result carries the
 * receipt (state, undo deadline) and the toast uses the server's own undo deadline.
 */
export function useInboxCommand(host: Pick<WidgetHost, 'notify'>) {
  const execute = useDataExecute();
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  /** `noticeKey` replaces the binding's toast where one binding has two outcomes (an SMS reservation is not a completed notice). */
  async function send(command: DataCommand, options: { readonly noticeKey?: string } = {}): Promise<DataCommandResult | undefined> {
    if (active.current) return undefined;
    active.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await execute(command);
      // The pane that pressed may already be replaced by the re-read; the toast and its undo still belong to the owner.
      if (!result.ok) { if (mounted.current) setError(result.messageKey); return result; }
      const noticeKey = options.noticeKey ?? result.noticeKey;
      if (noticeKey) {
        const expiry = (result.value as CommandReceipt | undefined)?.undoUntil;
        host.notify({ kind: 'success', messageKey: noticeKey, ...(result.undoToken ? { undoToken: result.undoToken } : {}), ...(expiry ? { undoUntil: expiry } : {}) });
      }
      return result;
    } finally {
      active.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return { pending, error, send, clearError: () => setError(undefined) };
}

/** The clock the notice editor reads for the send window (a test replaces it). */
export const inboxClock = { now: () => new Date() };

export interface ConsultationThread { readonly ref: string; readonly status: string; readonly messages: readonly { readonly text: string | null; readonly from?: 'user' | 'partner'; readonly sentAt?: string }[] }
/** The owner-visible TalkTalk thread of an imported consultation (read through B15; never stored in the records). */
export function useConsultation(ref: string | null | undefined): { readonly status: 'idle' | 'loading' | 'ready' | 'error'; readonly thread?: ConsultationThread } {
  const port = useRealPort();
  const [state, setState] = useState<{ readonly ref?: string; readonly status: 'loading' | 'ready' | 'error'; readonly thread?: ConsultationThread }>({ status: 'loading' });
  useEffect(() => {
    if (!ref || !port) return;
    const controller = new AbortController();
    port.reads.one<ConsultationThread>({ resource: 'consultation', path: `/marketing/talktalk/consultations/${encodeURIComponent(ref)}` }, { signal: controller.signal })
      .then(thread => { if (!controller.signal.aborted) setState({ ref, status: 'ready', thread }); },
        () => { if (!controller.signal.aborted) setState({ ref, status: 'error' }); });
    return () => controller.abort();
  }, [port, ref]);
  if (!ref || !port) return { status: 'idle' };
  return state.ref === ref ? state : { status: 'loading' };
}

type Read<T> = { readonly status: 'loading' | 'ready' | 'error'; readonly data?: T };
type Reader<K, T> = (port: NonNullable<ReturnType<typeof useRealPort>>, key: K, signal: AbortSignal) => Promise<T>;
/**
 * One on-demand read per key (`read` is a module-level function). A newer key, a retry or an unmount aborts the older request, so a late
 * answer never overwrites a newer one. A retry keeps the last data on screen while it reads.
 */
function useRead<K extends string, T>(key: K | null, read: Reader<K, T>) {
  const port = useRealPort();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Read<T> & { readonly key?: K; readonly attempt?: number }>({ status: 'loading' });
  useEffect(() => {
    if (!key || !port) return;
    const controller = new AbortController();
    read(port, key, controller.signal).then(data => { if (!controller.signal.aborted) setState({ key, attempt, status: 'ready', data }); },
      () => { if (!controller.signal.aborted) setState(current => ({ key, attempt, status: 'error', ...(current.key === key && current.data !== undefined ? { data: current.data } : {}) })); });
    return () => controller.abort();
  }, [port, key, attempt, read]);
  const retry = () => setAttempt(value => value + 1);
  if (!key || !port || state.key !== key) return { status: 'loading' as const, data: undefined, retry };
  // A retry of the same key reads again while the last answer stays on screen.
  return { status: state.attempt === attempt ? state.status : 'loading' as const, data: state.data, retry };
}

const insightsReader: Reader<ReviewStatsUnit, ReviewInsightsDto> = (port, unit, signal) => readReviewInsights(port.reads, unit, signal);
/** Insight review AI statistics + the official average for the chosen period unit (GAP-INS, two-day provider lag). */
export const useReviewInsights = (unit: ReviewStatsUnit | null) => useRead(unit, insightsReader);

const noticeReader: Reader<string, NoticeDetailDto> = (port, key, signal) => readNotice(port.reads, key.split('@')[0]!, signal);
/** A saved notice's detail at a revision: whether the service can send SMS now (`smsEnabled`) and its night slot (`nextSendWindow`). */
export const useNoticeDetail = (noticeId: string | null, revision?: number) => useRead(noticeId ? `${noticeId}@${revision ?? 0}` : null, noticeReader);

const reservationReader: Reader<string, SmsReservationDto> = (port, noticeId, signal) => readSmsReservation(port.reads, noticeId, signal);
/** The provider's current status of an SMS reservation. `retry()` reads it again (the owner's press on the history row). */
export const useSmsReservation = (noticeId: string | null) => useRead(noticeId, reservationReader);

/**
 * NAVER (PN03) or Navis (PN14) draft preview for one review. A press asks once; a second press while it runs is ignored. The editor keeps
 * the owner's text on a failure. Leaving the review aborts the request so a late draft never lands in another review's editor.
 */
export function useReviewDraftPreview(reviewRef: string | null) {
  const port = useRealPort();
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ readonly status: 'idle' | 'loading' | 'error'; readonly source?: ReviewDraftSource }>({ status: 'idle' });
  useEffect(() => () => controller.current?.abort(), [reviewRef]);
  async function request(source: ReviewDraftSource): Promise<ReviewDraftPreviewDto | undefined> {
    if (!port || !reviewRef || controller.current) return undefined;
    const current = new AbortController();
    controller.current = current;
    setState({ status: 'loading', source });
    try {
      const draft = await reviewDraftPreview(port.transport, source, reviewRef, current.signal);
      if (current.signal.aborted) return undefined;
      setState({ status: 'idle' });
      return typeof draft.text === 'string' && draft.text.trim() ? { text: draft.text, source } : undefined;
    } catch {
      if (!current.signal.aborted) setState({ status: 'error', source });
      return undefined;
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }
  return { ...state, request };
}
