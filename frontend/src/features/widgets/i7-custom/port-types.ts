import type { RefObject } from 'react';
import type { DetailRef } from '../../../contracts';
import type { CustomCommandValue, CustomOrderCommand, CustomOrderRead } from '../../../data/iteration7/custom-orders';
import type { RealPort } from '../../../data/reality/00';
import type { CustomRealCommand } from '../../../data/reality/08/commands';

export interface CustomReturnContext { readonly detailRef?: DetailRef; readonly selectedId: string; readonly returnFocusRef: RefObject<HTMLElement | null> }
export interface CustomUiResult {
  readonly ok: boolean; readonly value?: CustomCommandValue; readonly reason?: string; readonly noticeKey?: string; readonly params?: Readonly<Record<string, string | number>>;
  readonly undoToken?: string;
  /** HTTP builds: the server's own undo deadline (ISO). The toast never outlives it. */
  readonly undoUntil?: string;
  /** HTTP builds: the server could not confirm whether the write landed. The same press may be repeated; it creates nothing twice. */
  readonly outcomeUnknown?: boolean;
}
/** T-270 supplies atomic domain commands; T-271 supplies the common POS host. */
export interface CustomOrderPort {
  readonly read: () => CustomOrderRead;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (command: CustomOrderCommand) => CustomUiResult;
  /** HTTP builds: the same command, answered when the service has confirmed (or refused) it. The widget shows the write pending until then; `dispatch` is then not used. */
  readonly execute?: (command: CustomOrderCommand) => Promise<CustomUiResult>;
  readonly openSettlement: (target: { readonly purpose: 'custom_order'; readonly customOrderId: string }, context: CustomReturnContext) => void;
  readonly openReversal: (target: { readonly customOrderId: string; readonly cancelOrder: boolean }, context: CustomReturnContext) => void;
  readonly members?: readonly { readonly memberId: string; readonly label: string }[];
  /** Present only on an HTTP build (`VITE_NAVIS_DATA_SOURCE=http`): payments are recorded through the service, photos through the account files. */
  readonly real?: RealPort;
  /** HTTP builds: record the owner's terminal slip or cash (`customOrder.recordPayment` / `recordCorrection`). Resolves when the service has confirmed or refused. */
  readonly record?: (command: CustomRealCommand) => Promise<CustomUiResult>;
}
