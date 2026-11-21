import { createContext, useContext } from 'react';
import type { CreditBinding } from './types';

export const MemberMoneyContext = createContext<CreditBinding | null>(null);
export const useMemberMoney = () => useContext(MemberMoneyContext);
