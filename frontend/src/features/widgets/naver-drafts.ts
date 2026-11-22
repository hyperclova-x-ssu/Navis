import { useEffect, useRef, useState } from 'react';
import { useBundle } from '../../i18n';
import { mgmtMoneyBundle } from './mgmt-money/messages';

const kinds = { grants: 'application', manuals: 'manual', 'ai-response': 'reply' } as const;
export type DraftWidget = keyof typeof kinds;

export interface ManualDraft {
  readonly title: string;
  readonly steps: readonly string[];
  readonly cautions: string;
}
type BodyDraft = { readonly body: string };
interface DraftContent {
  grants: BodyDraft;
  manuals: ManualDraft;
  'ai-response': BodyDraft;
}

const errorStatuses = {
  BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413, INVALID_REPLY: 422, RATE_LIMITED: 429, INVALID_OUTPUT: 502, SEND_FAILED: 502,
  UNAVAILABLE: 503, SEND_DISABLED: 503, TIMEOUT: 504, SEND_UNKNOWN: 504,
} as const;
type ErrorCode = keyof typeof errorStatuses;
type ApiError = { [Code in ErrorCode]: {
  readonly status: 'error';
  readonly code: Code;
  readonly httpStatus: typeof errorStatuses[Code];
  readonly retryAfterSeconds?: Code extends 'RATE_LIMITED' ? number : never;
} }[ErrorCode];
export type DraftError = ApiError
  | { readonly status: 'error'; readonly code: 'TRANSPORT' }
  | { readonly status: 'error'; readonly code: 'INVALID_RESPONSE'; readonly httpStatus: number };

type Draft<W extends DraftWidget> = {
  readonly status: 'draft';
  readonly draftId: string;
  readonly kind: typeof kinds[W];
  readonly content: DraftContent[W];
  readonly sourceLabels: readonly string[];
};
type EmptyDraft = { readonly status: 'empty' };
export type DraftResult<W extends DraftWidget> = Draft<W> | EmptyDraft | DraftError;

export interface TestTarget {
  readonly id: string;
  readonly label: string;
}
export type TargetResult = {
  readonly status: 'targets';
  readonly mode: 'off' | 'fake' | 'sens';
  readonly targets: readonly TestTarget[];
} | DraftError;
export interface ReplySendInput {
  readonly draftId: string;
  readonly targetId: string;
  readonly body: string;
}
export type SendResult =
  | { readonly status: 'simulated' | 'accepted'; readonly receiptId: string }
  | DraftError;

export type NaverDraftTransport = (path: string, init: RequestInit) => Promise<Response>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

function readError(response: Response, payload: Record<string, unknown>): DraftError | undefined {
  if (typeof payload.code !== 'string' || !Object.hasOwn(errorStatuses, payload.code)) return undefined;
  const code = payload.code as ErrorCode;
  if (errorStatuses[code] !== response.status) return undefined;
  const retryAfter = response.headers.get('Retry-After');
  const retryAfterSeconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  return {
    status: 'error', code, httpStatus: response.status,
    ...(code === 'RATE_LIMITED' && Number.isSafeInteger(retryAfterSeconds) ? { retryAfterSeconds } : {}),
  } as ApiError;
}

function readDraft<W extends DraftWidget>(widget: W, payload: Record<string, unknown>): Draft<W> | EmptyDraft | undefined {
  if (payload.status === 'empty') return { status: 'empty' };
  const { draftId, kind, content, sourceLabels } = payload;
  if (typeof draftId !== 'string' || !draftId || kind !== kinds[widget] || !isRecord(content) || !isStringList(sourceLabels)) return;
  let checked: BodyDraft | ManualDraft;
  if (kind === 'manual') {
    const { title, steps, cautions } = content;
    if (typeof title !== 'string' || !isStringList(steps) || steps.length > 5 || typeof cautions !== 'string') return;
    checked = { title, steps, cautions };
  } else {
    if (typeof content.body !== 'string') return;
    checked = { body: content.body };
  }
  return { status: 'draft', draftId, kind: kinds[widget], content: checked as DraftContent[W], sourceLabels };
}

function readTargets(payload: Record<string, unknown>): Exclude<TargetResult, DraftError> | undefined {
  const { mode, targets } = payload;
  if ((mode !== 'off' && mode !== 'fake' && mode !== 'sens') || !Array.isArray(targets)) return;
  const aliases: TestTarget[] = [];
  for (const target of targets) {
    if (!isRecord(target) || typeof target.id !== 'string' || !target.id
      || typeof target.label !== 'string' || !/^테스트 번호 [1-9]\d{0,2}$/.test(target.label)) return;
    aliases.push({ id: target.id, label: target.label });
  }
  return { status: 'targets', mode, targets: mode === 'off' ? [] : aliases };
}

const browserFetch: NaverDraftTransport = (path, init) => globalThis.fetch(path, init);

export function createNaverDraftsClient(transport: NaverDraftTransport = browserFetch) {
  async function request<T>(
    path: string, init: RequestInit, parse: (payload: Record<string, unknown>, status: number) => T | undefined,
  ): Promise<T | DraftError> {
    let response: Response;
    try {
      response = await transport('/api/navis/' + path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    } catch {
      return { status: 'error', code: 'TRANSPORT' };
    }
    const invalid = { status: 'error', code: 'INVALID_RESPONSE', httpStatus: response.status } as const;
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload)) return invalid;
    return (response.ok ? parse(payload, response.status) : readError(response, payload)) ?? invalid;
  }

  return {
    generate<W extends DraftWidget>(widget: W, sampleId: string, signal?: AbortSignal): Promise<DraftResult<W>> {
      return request('widget-drafts', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ widget, sampleId }),
      }, (payload, status) => status === 200 ? readDraft(widget, payload) : undefined);
    },
    getTargets(signal?: AbortSignal): Promise<TargetResult> {
      return request('reply-test-targets', { method: 'GET', signal },
        (payload, status) => status === 200 ? readTargets(payload) : undefined);
    },
    send({ draftId, targetId, body }: ReplySendInput): Promise<SendResult> {
      return request('reply-test-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ draftId, targetId, body, confirmed: true }),
      }, (payload, status) => {
        if (typeof payload.receiptId !== 'string') return;
        if (status === 200 && payload.status === 'simulated') return { status: 'simulated', receiptId: payload.receiptId } as const;
        if (status === 202 && payload.status === 'accepted') return { status: 'accepted', receiptId: payload.receiptId } as const;
      });
    },
  };
}

export const naverDrafts = createNaverDraftsClient();

/** Project the widget's validated allowlist response for callers that only display its size. */
export async function readReplyTestTargetCount(signal: AbortSignal): Promise<number | undefined> {
  const result = await naverDrafts.getTargets(signal);
  return result.status === 'targets' ? result.targets.length : undefined;
}

export const useNaverDraftCopy = () => useBundle(mgmtMoneyBundle);

/** Tag generated Korean text without changing the language of translated field labels. */
export function setDraftInputLanguage(field: HTMLInputElement | HTMLTextAreaElement | null) {
  if (field) field.lang = 'ko';
}
type Generation = { readonly status: 'idle' | 'loading' | 'ready' | 'empty' } | DraftError;

/** A generation belongs to the editor it started from. The editor owns the editable fields. */
export function useNaverDraft<W extends DraftWidget>(widget: W) {
  const [generation, setGeneration] = useState<Generation>({ status: 'idle' });
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  function reset() {
    active.current?.abort();
    active.current = null;
    setGeneration({ status: 'idle' });
  }

  async function generate(sampleId: string | null, apply: (draft: Draft<W> | null) => void) {
    if (active.current) return;
    if (sampleId === null) {
      apply(null);
      setGeneration({ status: 'empty' });
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setGeneration({ status: 'loading' });
    const result = await naverDrafts.generate(widget, sampleId, controller.signal);
    if (controller.signal.aborted) return;
    active.current = null;
    if (result.status === 'draft') {
      apply(result);
      setGeneration({ status: 'ready' });
    } else {
      if (result.status === 'empty') apply(null);
      setGeneration(result);
    }
  }

  return { generation, generate, reset };
}

export function naverDraftErrorText(error: DraftError, t: (
  key: 'widget.grants.draft.failed' | 'widget.grants.draft.rateLimited' | 'widget.grants.draft.tryLater' | 'widget.grants.draft.timedOut',
  params?: { n: number },
) => string): string {
  if (error.code === 'RATE_LIMITED') return error.retryAfterSeconds === undefined
    ? t('widget.grants.draft.tryLater') : t('widget.grants.draft.rateLimited', { n: error.retryAfterSeconds });
  if (error.code === 'TIMEOUT') return t('widget.grants.draft.timedOut');
  return t('widget.grants.draft.failed');
}
