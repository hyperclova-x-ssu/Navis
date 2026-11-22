import type { RefObject } from 'react';
import type { PosBillQuote } from '../../../contracts/pos';
import { LoyaltyCheckout } from '../loyalty/Checkout';

export function BillPaymentDialog(props: {
  open:boolean; quote:PosBillQuote; summary:string; returnFocusRef:RefObject<HTMLElement|null>;
  onClose:()=>void; onComplete:(orderNo:number)=>void; onRegisterMember?: () => void;
}) {
  return <LoyaltyCheckout {...props} billId={props.quote.billId}/>;
}
