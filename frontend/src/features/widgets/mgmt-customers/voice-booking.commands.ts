/** REAL-PLAN F06: how the booking widget runs a command — in the fixture store at once, over HTTP after the server's receipt. */
import { useEffect, useRef, useState } from 'react';
import type { WidgetHost } from '../../../contracts';
import type { DataCommand, DataCommandResult } from '../../../data/commands/types';
import { useDataDispatch, useDataExecute, useDomainState } from '../../../data/react';
import type { CommandReceipt } from '../../../data/reality/00';

/** A real receipt's undo deadline travels with the toast; a provider-side or candidate action has none (no undo is offered). */
export function receiptUndo(result: DataCommandResult): { readonly undoToken?: string; readonly undoUntil?: string } {
  if (!result.ok || !result.undoToken) return {};
  if (!result.undoToken.startsWith('real-undo:')) return { undoToken: result.undoToken };
  const undoUntil = (result.value as CommandReceipt | undefined)?.undoUntil;
  return undoUntil ? { undoToken: result.undoToken, undoUntil } : {};
}

/** `undo: false` is for an action the service says has no inverse (a NAVER cancel, `cancelUndoable: false`): the toast never offers an undo, whatever the receipt carries. */
export function notifySuccess(host: WidgetHost, messageKey: string, result: DataCommandResult, options: { readonly undo?: boolean } = {}) {
  host.notify({ kind: 'success', messageKey, ...(options.undo === false ? {} : receiptUndo(result)) });
}

export function useBookingCommand() {
  const dispatch = useDataDispatch();
  const execute = useDataExecute();
  const http = useDomainState('booking').mode === 'http';
  const active = useRef(false);
  const busy = useRef(false);
  const epoch = useRef(0);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  /** Fixture: `settled` runs synchronously. HTTP: one command at a time; `settled` runs after the receipt and the re-read, unless the owner moved on (`abandon`). */
  function run(command: DataCommand, settled: (result: DataCommandResult) => void) {
    if (busy.current) return;
    if (!http) { settled(dispatch(command)); return; }
    busy.current = true;
    setPending(true);
    const issued = epoch.current;
    void execute(command).then(result => {
      busy.current = false;
      if (!active.current) return;
      setPending(false);
      if (issued === epoch.current) settled(result);
    });
  }

  return { http, pending, run, abandon: () => { epoch.current++; } };
}
