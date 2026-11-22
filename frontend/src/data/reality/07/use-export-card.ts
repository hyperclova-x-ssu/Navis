import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRealPort } from '../../react';
import { PortError } from '../00';
import {
  exportApprovalExpired, exportOutcome, issueExportApproval, requiresSecondConfirmation, submitExport,
  type CalendarPushReceipt, type ExportCard, type ExportOperation, type WorksPushReceipt,
} from './naver';

export type ExportReceipt = CalendarPushReceipt | WorksPushReceipt;
export type ExportCardInput = Pick<ExportCard, 'operation' | 'resourceId' | 'expectedRevision' | 'expectedStaffRevision'>;
/**
 * `review` the summary is shown and nothing was recorded (after a definite failure `error` holds the reason and the inputs stay) ·
 * `confirm` a delete was pressed once and waits for the second press · `sending` · `unknown` the write left with this approval and its
 * result is unknown: the next press checks with the same key · `stale` the record changed, the owner reopens a refreshed card · `done`.
 */
export type ExportCardState =
  | { readonly phase: 'review'; readonly card: ExportCard; readonly error?: string }
  | { readonly phase: 'confirm' | 'sending' | 'unknown' | 'stale'; readonly card: ExportCard }
  | { readonly phase: 'done'; readonly card: ExportCard; readonly receipt: ExportReceipt };

const fresh = ({ operation, resourceId, expectedRevision, expectedStaffRevision }: ExportCardInput): ExportCard => ({
  operation, resourceId, expectedRevision, ...(expectedStaffRevision !== undefined ? { expectedStaffRevision } : {}),
  attemptKey: globalThis.crypto.randomUUID(),
});

/**
 * One PN11 export card. `press` is the only thing that reaches the server and runs only from the owner's button: issue (press) →
 * for a delete wait for the second press and record it (confirm) → send with the approval as the Idempotency-Key. A second press while
 * one is in flight does nothing; closing or unmounting drops late answers.
 */
export function useExportCard({ onDone }: { readonly onDone?: (receipt: ExportReceipt, operation: ExportOperation) => void } = {}) {
  const port = useRealPort();
  const [state, setState] = useState<ExportCardState>();
  const current = useRef<ExportCardState | undefined>(undefined);
  const active = useRef<AbortController | null>(null);
  const done = useRef(onDone);
  useLayoutEffect(() => { done.current = onDone; });
  const update = (next: ExportCardState | undefined) => { current.current = next; setState(next); };
  useEffect(() => () => active.current?.abort(), []);

  const open = useCallback((input: ExportCardInput) => {
    if (active.current) return;
    update({ phase: 'review', card: fresh(input) });
  }, []);
  const close = useCallback(() => {
    if (active.current) return;
    update(undefined);
  }, []);

  const press = useCallback(async () => {
    const now = current.current;
    if (!port || !now || active.current || now.phase === 'done' || now.phase === 'stale' || now.phase === 'sending') return;
    const controller = new AbortController();
    const { signal } = controller;
    active.current = controller;
    let card = now.card;
    update({ phase: 'sending', card });
    try {
      if (!card.submitted) {
        if (exportApprovalExpired(card)) throw new PortError(409, 'CONFLICT', 'APPROVAL_EXPIRED');
        const needsSecond = requiresSecondConfirmation(card.operation);
        if (!card.approvalId) {
          const approval = await issueExportApproval(port.transport, card, signal);
          if (signal.aborted) return;
          card = { ...card, ...approval };
          if (needsSecond || approval.requiresConfirmation) {
            update({ phase: 'confirm', card });
            return;
          }
        } else if ((needsSecond || card.requiresConfirmation) && !card.confirmed) {
          await issueExportApproval(port.transport, card, signal);
          if (signal.aborted) return;
          card = { ...card, confirmed: true };
        }
        card = { ...card, submitted: true };
        current.current = { phase: 'sending', card };
      }
      const receipt = await submitExport(port.transport, card, signal);
      if (signal.aborted) return;
      update({ phase: 'done', card, receipt });
      done.current?.(receipt, card.operation);
    } catch (error) {
      if (signal.aborted) return;
      const outcome = exportOutcome(error, !!card.submitted);
      if (outcome.kind === 'unknown') update({ phase: 'unknown', card });
      else if (outcome.kind === 'stale') update({ phase: 'stale', card });
      else update({ phase: 'review', card: fresh(card), error: outcome.reason });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [port]);

  return { state, open, press, close, available: !!port };
}
