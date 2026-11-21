import type { PosFailure, PosSessionCommand } from '../../../contracts/pos';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { usePosSession } from '../../../pos/react';
import type { ComposerNotice } from '../Composer';
import { tableTransferBundle } from './messages';

export type TableInput = PosSessionCommand extends infer C ? C extends PosSessionCommand ? Omit<C, 'meta'> : never : never;
let sequence = 0;
export function tableFailureKey(failure: Pick<PosFailure, 'reason'>) {
  switch (failure.reason) {
    case 'NO_DESTINATION': return 'table.noDestination';
    case 'PARTIAL_BILL_LOCKED': return 'table.partialLocked';
    case 'UNPAID_BILLS': return 'pos.settingsBlocked';
    case 'TABLE_IN_USE': return 'pos.tableInUse';
    case 'TABLE_REQUIRED': case 'INVALID_TABLE': return 'pos.pickTable';
    case 'DAY_CLOSED': return 'pos.closedHelp';
    case 'APPROVAL_BUSY': return 'pos.busyClose';
    case 'BILL_LOCKED': return 'pos.lockedBill';
    case 'DATA_UNAVAILABLE': return 'pos.dataError';
    case 'SOLD_OUT': case 'ITEM_REMOVED': case 'REQUIRED_OPTION': case 'INVALID_OPTION': return 'pos.removed';
    case 'QUOTE_CHANGED': return 'pos.quoteChanged';
    case 'STATE_CONFLICT': case 'NOT_FOUND': case 'STALE_REVISION': return 'pos.stateConflict';
    default: return 'pos.commandError';
  }
}
export function useTableCommands(onNotice: (notice: ComposerNotice) => void) {
  const runtime = usePosSession(), { t } = useBundle(posBundle, tableTransferBundle);
  return (input: TableInput, message?: string, undo = true) => {
    const result = runtime.execute({ ...input, meta: { runId: runtime.read().runId, idempotencyKey: `table-ui:${++sequence}` } } as PosSessionCommand);
    if (!result.ok) onNotice({ message: t(tableFailureKey(result)) });
    else if (!result.duplicate && (message || result.noticeKey)) onNotice({ message: message ?? t(result.noticeKey === 'order.settings.startAdjusted' ? result.noticeKey : 'pos.changed'), ...(undo && result.undoToken ? { undoToken: result.undoToken } : {}) });
    return result;
  };
}
