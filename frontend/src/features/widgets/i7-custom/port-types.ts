import type { RefObject } from 'react';
import type { DetailRef } from '../../../contracts';
import type { CustomCommandValue, CustomOrderCommand, CustomOrderRead } from '../../../data/iteration7/custom-orders';

export interface CustomReturnContext { readonly detailRef?: DetailRef; readonly selectedId: string; readonly returnFocusRef: RefObject<HTMLElement | null> }
export interface CustomUiResult { readonly ok: boolean; readonly value?: CustomCommandValue; readonly reason?: string; readonly noticeKey?: string; readonly params?: Readonly<Record<string, string | number>>; readonly undoToken?: string }
/** T-270 supplies atomic domain commands; T-271 supplies the common POS host. */
export interface CustomOrderPort {
  readonly read: () => CustomOrderRead;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (command: CustomOrderCommand) => CustomUiResult;
  readonly openSettlement: (target: { readonly purpose: 'custom_order'; readonly customOrderId: string }, context: CustomReturnContext) => void;
  readonly openReversal: (target: { readonly customOrderId: string; readonly cancelOrder: boolean }, context: CustomReturnContext) => void;
  readonly members?: readonly { readonly memberId: string; readonly label: string }[];
}
