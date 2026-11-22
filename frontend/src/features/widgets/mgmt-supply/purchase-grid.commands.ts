import { useRef, useState } from 'react';
import type { WidgetHost } from '../../../contracts';
import { useDataDispatch, useDataExecute, useRealPort } from '../../../data/react';
import type { DataCommand, DataCommandResult } from '../../../data/widget-data';
import { newIdempotencyKey } from './shared';

export type PurchaseCommand = Extract<DataCommand, { type: `suppliers.${string}` }>;
type PurchaseResult = Extract<DataCommandResult, { ok: true }>;

export function usePurchaseKey(prefix: 'order' | 'receipt' | 'supplier' | 'purchase') {
  const http = useRealPort()?.mode('purchase') === 'http';
  const [key] = useState(() => http ? crypto.randomUUID() : newIdempotencyKey(prefix));
  return key;
}

export function usePurchaseCommand() {
  const http = useRealPort()?.mode('purchase') === 'http';
  const dispatch = useDataDispatch();
  const execute = useDataExecute();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);

  function run(command: PurchaseCommand, complete: (result: DataCommandResult) => void) {
    if (!http) { complete(dispatch(command)); return; }
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    void execute(command).then(complete).finally(() => {
      lock.current = false;
      setPending(false);
    });
  }
  return { http, pending, run };
}

export function notifyPurchase(host: WidgetHost, result: PurchaseResult, fallback: string) {
  const value = result.value;
  const undoUntil = result.undoToken && value && typeof value === 'object' && 'undoUntil' in value
    && typeof value.undoUntil === 'string' ? value.undoUntil : undefined;
  host.notify({ kind: 'success', messageKey: result.noticeKey ?? fallback,
    ...(result.params ? { params: result.params } : {}),
    ...(result.undoToken ? { undoToken: result.undoToken } : {}),
    ...(undoUntil ? { undoUntil } : {}),
  });
}

/** A response may arrive after the owner has already closed this form. */
export function useFormClose(onClose: () => void) {
  const closed = useRef(false);
  return () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };
}
