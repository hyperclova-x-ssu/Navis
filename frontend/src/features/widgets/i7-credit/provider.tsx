import type { ReactNode } from 'react';
import { MemberMoneyContext } from './context';
import type { CreditBinding } from './types';

/** Mount around members and credit detail so both read the same live selector result. */
export function MemberMoneyProvider({ binding, children }: { readonly binding: CreditBinding; readonly children?: ReactNode }) {
  return <MemberMoneyContext.Provider value={binding}>{children}</MemberMoneyContext.Provider>;
}
