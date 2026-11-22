import type { DataCommand, DataCommandResult } from '../../commands/types';
import { useDataDispatch, useDataExecute, useRealPort } from '../../react';

/** Keep immediate fixture interactions while the operating widget waits for the server receipt. */
export function useStaffCalendarCommand() {
  const dispatch = useDataDispatch();
  const execute = useDataExecute();
  const real = useRealPort()?.state('staff').mode === 'http';
  return (command: DataCommand, settled: (result: DataCommandResult) => void) => {
    if (real) void execute(command).then(settled);
    else settled(dispatch(command));
  };
}
