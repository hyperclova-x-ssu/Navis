import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PortError, type PortTransport } from '../00/port';
import type { PublicationPreview } from '../../../../../backend/services/inventory/reality/01/publication-dto';
import { publication, type PublicationApproval, type PublicationTarget } from './publication';

export function usePublication<Input, View, Read, Receipt>(
  transport: PortTransport, { path, readPath, operation, resourceId }: PublicationTarget,
) {
  const client = useMemo(() => publication<Input, View, Read, Receipt>(transport, { path, readPath, operation, resourceId }),
    [transport, path, readPath, operation, resourceId]);
  const [data, setData] = useState<Read>();
  const [readError, setReadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState<PublicationPreview<View>>();
  const [approval, setApproval] = useState<PublicationApproval>();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [settled, setSettled] = useState<{ receipt: Receipt; preview: View }>();
  const scope = useRef<AbortController | null>(null);
  const active = useRef(false);

  const readSequence = useRef(0);
  const reload = useCallback(async (signal = scope.current?.signal) => {
    if (!signal || signal.aborted) return;
    const sequence = ++readSequence.current;
    try {
      const value = await client.read(signal);
      if (!signal.aborted && sequence === readSequence.current) { setData(value); setReadError(undefined); }
    } catch (failure) {
      if (!signal.aborted && sequence === readSequence.current) setReadError(reason(failure));
    }
  }, [client]);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    void reload(controller.signal);
    return () => { controller.abort(); scope.current = null; };
  }, [reload]);

  async function run(action: (signal: AbortSignal) => Promise<void>, sent = () => false) {
    const signal = scope.current?.signal;
    if (active.current || !signal || signal.aborted) return;
    active.current = true;
    setPending(true);
    setError(undefined);
    try { await action(signal); } catch (failure) {
      if (signal.aborted) return;
      setError(reason(failure));
      const confirming = sent();
      const unknown = confirming && failure instanceof PortError
        && (failure.outcomeUnknown || failure.reason === 'PUBLICATION_IN_PROGRESS');
      setUncertain(unknown);
      if (!unknown) {
        setAttempt(undefined);
        setApproval(undefined);
      }
      if (confirming) await reload(signal);
    } finally {
      active.current = false;
      if (!signal.aborted) setPending(false);
    }
  }

  return {
    data, readError, error, attempt, pending, receipt: settled?.receipt, confirmedPreview: settled?.preview, uncertain, awaitingConfirmation: !!approval && !uncertain, reload,
    cancel() {
      if (active.current || uncertain) return;
      setAttempt(undefined);
      setApproval(undefined);
    },
    preview(input: Input) {
      if (uncertain || attempt) return;
      void run(async signal => {
        setSettled(undefined);
        const next = await client.preview(input, signal);
        if (!signal.aborted) setAttempt(next);
      });
    },
    confirm(requireExtra = false, onConfirmed?: () => void) {
      if (!attempt) return;
      let sent = false;
      void run(async signal => {
        const authorized = approval ?? await client.press(attempt, signal);
        if (signal.aborted) return;
        setApproval(authorized);
        if (!approval && (requireExtra || authorized.requiresConfirmation)) return;
        sent = true;
        const next = await client.confirm(attempt, authorized, signal);
        if (signal.aborted) return;
        setSettled({ receipt: next, preview: attempt.diff });
        setAttempt(undefined);
        setApproval(undefined);
        setUncertain(false);
        onConfirmed?.();
        await reload(signal);
      }, () => sent);
    },
  };
}

function reason(error: unknown) {
  return error instanceof PortError ? error.reason ?? error.code : 'UNKNOWN';
}
