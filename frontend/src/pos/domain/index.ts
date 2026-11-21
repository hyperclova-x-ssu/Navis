import type { PosCommand, PosPlanningResult, PosReadSnapshot } from '../../contracts/pos';
import { planCartCommand } from './cart';
import { planBeginApproval, planFinishApproval } from './approval';
export { quoteCart, selectPosCatalog, planCartCommand, planPosUndo, validatePosSelection } from './cart';
export { planBeginApproval, planFinishApproval } from './approval';
export { allocatePosAmount, selectPosDayTotals, selectPosSalesByMenu } from './money';
export { freezePos } from './common';
export { quoteSettlement, planBeginSettlementApproval, planFinishSettlementApproval, planRecognizeCustomPickup } from '../../data/iteration7/accounting';
export { adaptPosSettlementSource, quotePosSettlement } from './iteration7';

/** Pure plan only: the coordinator is the sole owner of business publication. */
export function planPosCommand(read: PosReadSnapshot, command: PosCommand, businessNow: string): PosPlanningResult {
  if (command.type === 'approval.begin') return planBeginApproval(read, command);
  if (command.type === 'approval.finish') return planFinishApproval(read, command, businessNow);
  return planCartCommand(read, command);
}
