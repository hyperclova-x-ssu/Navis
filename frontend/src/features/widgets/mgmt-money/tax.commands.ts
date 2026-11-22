import type { WidgetHost } from '../../../contracts';
import { useDataExecute } from '../../../data/react';
import type { DataCommand, DataCommandResult } from '../../../data/widget-data';
import type { CommandReceipt } from '../../../data/reality/00';
import { useRunCommand } from './shared';

type Notice = { messageKey: string; params?: Readonly<Record<string, string | number>> };

export function useRunTaxCommand(host: WidgetHost, real: boolean) {
  const execute = useDataExecute();
  const runFixture = useRunCommand(host);
  return async (command: DataCommand, notice?: Notice): Promise<DataCommandResult> => {
    if (!real) return runFixture(command, notice);
    const result = await execute(command);
    if (!result.ok) {
      host.notify({ kind: 'error', messageKey: result.messageKey });
    } else {
      const messageKey = notice?.messageKey ?? result.noticeKey;
      const undoUntil = (result.value as CommandReceipt | undefined)?.undoUntil;
      if (messageKey) host.notify({ kind: 'success', messageKey, params: notice?.params ?? result.params, undoToken: result.undoToken, undoUntil });
    }
    return result;
  };
}
