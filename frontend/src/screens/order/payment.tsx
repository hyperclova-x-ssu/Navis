import { useState, type RefObject } from 'react';
import type { PosCartQuote } from '../../contracts/pos';
import { getPaymentBillId } from '../../pos/loyalty';
import { usePosSession } from '../../pos/react';
import { LoyaltyCheckout } from './loyalty/Checkout';

/** Prepaid and takeout share the M3 bill tools with postpaid checkout. */
export function PaymentDialog(props: {
  open:boolean; quote:PosCartQuote; summary:string; returnFocusRef:RefObject<HTMLElement|null>;
  onClose:()=>void; onComplete:(orderNo:number)=>void;
}) {
  const runtime=usePosSession();
  const [billId]=useState(()=>getPaymentBillId(runtime.read()));
  return <LoyaltyCheckout {...props} billId={billId}/>;
}
