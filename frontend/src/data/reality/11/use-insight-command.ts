import { useEffect, useRef, useState } from 'react';
import type { WidgetHost } from '../../../contracts';
import type { DataCommand, DataCommandResult } from '../../commands/types';
import { useDataDispatch, useDataExecute, useRealPort } from '../../react';
import type { CommandReceipt } from '../00';

type Success = Extract<DataCommandResult, { ok: true }>;
type Notice = Parameters<WidgetHost['notify']>[0];

export function notifyInsight(host: WidgetHost, result: Success, notice?: Pick<Notice, 'messageKey' | 'params'>) {
  const messageKey = notice?.messageKey ?? result.noticeKey;
  if (!messageKey) return;
  const receipt = result.value as Partial<CommandReceipt> | undefined;
  host.notify({ kind: 'success', messageKey, params: notice?.params ?? result.params,
    undoToken: result.undoToken, undoUntil: result.undoToken ? receipt?.undoUntil : undefined });
}

export function useInsightCommand(host: WidgetHost) {
  const dispatch = useDataDispatch();
  const execute = useDataExecute();
  const port = useRealPort();
  const http = port?.mode('manuals') === 'http';
  const active = useRef(true);
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function run(command: DataCommand, options?: { quiet?: boolean; notice?: Pick<Notice, 'messageKey' | 'params'> }) {
    if (locked.current) return;
    locked.current = true;
    if (http) setPending(true);
    try {
      const result = http ? await execute(command) : dispatch(command);
      if (!result.ok && result.reason === 'BUSINESS_DAY_CHANGED') await port?.retry('manuals');
      if (result.ok && !options?.quiet) notifyInsight(host, result, options?.notice);
      return active.current ? result : undefined;
    } finally {
      locked.current = false;
      if (http && active.current) setPending(false);
    }
  }
  return { http, pending, run };
}
