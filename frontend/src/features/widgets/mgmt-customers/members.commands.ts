import { useEffect, useRef, useState } from 'react';
import type { DataCommand, DataCommandResult } from '../../../data/commands/types';
import type { WidgetHost } from '../../../contracts';
import { useDataDispatch, useDataExecute, useDomainState } from '../../../data/react';
import type { CommandReceipt } from '../../../data/reality/00';
import { reportResult } from './shared';

export function reportMemberResult(host: WidgetHost, result: DataCommandResult) {
  const receipt = result.ok && result.undoToken?.startsWith('real-undo:') ? result.value as CommandReceipt : undefined;
  if (result.ok && result.noticeKey && receipt?.undoUntil) {
    host.notify({ kind: 'success', messageKey: result.noticeKey, undoToken: result.undoToken, undoUntil: receipt.undoUntil });
  } else reportResult(host, result);
}

export function useMemberCommand() {
  const dispatch = useDataDispatch();
  const execute = useDataExecute();
  const http = useDomainState('members').mode === 'http';
  const active = useRef(false);
  const busy = useRef(false);
  const epoch = useRef(0);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  function run(command: DataCommand | (() => DataCommand), settled: (result: DataCommandResult) => void) {
    if (busy.current) return;
    const input = typeof command === 'function' ? command() : command;
    if (!http) { settled(dispatch(input)); return; }
    busy.current = true;
    setPending(true);
    const issued = epoch.current;
    void execute(input).then(result => {
      busy.current = false;
      if (!active.current) return;
      setPending(false);
      if (issued === epoch.current) settled(result);
    });
  }

  return { http, pending, run, abandon: () => { epoch.current++; } };
}
