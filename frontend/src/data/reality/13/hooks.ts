/** GAPUI-MKT hooks for the community Café tab: the owner's writable boards (read when the tab opens) and one Café card at a time. */
import { useEffect, useRef, useState } from 'react';
import { useRealPort, useRealRetry } from '../../react';
import { PortError } from '../00';
import { cardApprovalExpired, issueCardApproval, type CardApproval } from '../15/card-approval';
import { cafeIntent, readCafeBoards, submitCafePost, type CafePostInput } from './adapter';
import type { CafeBoardDto, CafePostReceipt } from './dto';

export function useCafeBoards(open: boolean) {
  const port = useRealPort();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ readonly attempt: number; readonly status: 'ready' | 'error'; readonly items?: readonly CafeBoardDto[] } | null>(null);
  useEffect(() => {
    if (!open || !port) return;
    const controller = new AbortController();
    readCafeBoards(port.reads, controller.signal).then(
      ({ items }) => { if (!controller.signal.aborted) setState({ attempt, status: 'ready', items }); },
      () => { if (!controller.signal.aborted) setState({ attempt, status: 'error' }); });
    return () => controller.abort();
  }, [open, port, attempt]);
  const retry = () => setAttempt(value => value + 1);
  if (!state || state.attempt !== attempt) return { status: 'loading' as const, items: undefined, retry };
  return { status: state.status, items: state.items, retry };
}

const REASON_KEYS: Readonly<Record<string, string>> = {
  APPROVAL_EXPIRED: 'data.real.local.cafe.expired', CAFE_BOARD_FORBIDDEN: 'data.real.local.error.CAFE_BOARD_FORBIDDEN',
  PROVIDER_UNAVAILABLE: 'data.real.local.error.PROVIDER_UNAVAILABLE', CARD_REQUIRED: 'data.real.inbox.error.CARD_REQUIRED',
  PENDING_OR_USED_APPROVAL: 'data.real.inbox.error.PENDING_OR_USED_APPROVAL', APPROVAL_CONFLICT: 'data.real.inbox.error.APPROVAL_CONFLICT',
  STALE_REVISION: 'data.real.error.STALE_REVISION', IDEMPOTENCY_CONFLICT: 'data.real.error.IDEMPOTENCY_CONFLICT',
};
const messageOf = (error: unknown) => error instanceof PortError ? REASON_KEYS[error.reason ?? error.code] ?? 'data.real.error.GENERIC' : 'data.real.error.GENERIC';

export type CafePhase = 'edit' | 'pressing' | 'confirm' | 'posting' | 'unknown';
interface Card extends CardApproval { readonly post: CafePostInput; readonly revision: number }

/**
 * The two owner presses of a Café post. [올릴 내용 확인하기] issues the card press (60 s); [카페에 글 올리기] confirms it and sends the same body
 * once. A press while one is running does nothing. An unknown outcome locks the attempt (it is never sent again) until the list is re-read.
 */
export function useCafeCard() {
  const port = useRealPort();
  const reread = useRealRetry('local');
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [phase, setPhase] = useState<CafePhase>('edit');
  const [card, setCard] = useState<Card | null>(null);
  const [receipt, setReceipt] = useState<CafePostReceipt | null>(null);
  const [error, setError] = useState<string>();
  const safe = (run: () => void) => { if (mounted.current) run(); };

  async function press(post: CafePostInput, revision: number) {
    if (!port || busy.current) return;
    busy.current = true;
    setError(undefined);
    setReceipt(null);
    setPhase('pressing');
    try {
      const approval = await issueCardApproval(input => port.transport.request(input), cafeIntent(post, revision), `cafe:${globalThis.crypto.randomUUID()}`, 'press');
      safe(() => { setCard({ ...approval, post, revision }); setPhase('confirm'); });
    } catch (failure) {
      safe(() => { setError(messageOf(failure)); setPhase('edit'); });
    } finally { busy.current = false; }
  }

  async function post(): Promise<CafePostReceipt | undefined> {
    if (!port || !card || busy.current) return undefined;
    if (cardApprovalExpired(card)) { setCard(null); setPhase('edit'); setError('data.real.local.cafe.expired'); return undefined; }
    busy.current = true;
    setError(undefined);
    setPhase('posting');
    try {
      const result = await submitCafePost(port.transport, card.post, card.revision, card.approvalId);
      safe(() => { setReceipt(result); setCard(null); setPhase(result.state === 'pending-reconciliation' ? 'unknown' : 'edit'); });
      reread();
      return result;
    } catch (failure) {
      const unknown = failure instanceof PortError && failure.outcomeUnknown;
      safe(() => {
        if (unknown) { setPhase('unknown'); return; }
        setCard(null);
        setPhase('edit');
        setError(messageOf(failure));
      });
      if (unknown) reread();
      return undefined;
    } finally { busy.current = false; }
  }

  return {
    phase, card, receipt, error, press, post,
    back: () => { if (!busy.current) { setCard(null); setPhase('edit'); } },
    /** Re-read the owner's post list after an unknown outcome; the same attempt is not sent again. */
    recheck: () => { reread(); setReceipt(null); setCard(null); setPhase('edit'); },
  };
}
