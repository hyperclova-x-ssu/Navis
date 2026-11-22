import { useState } from 'react';
import type { WidgetHost } from '../../../contracts';
import { useDomainState, useRealPort } from '../../../data/react';
import { FundingDialog, type FundingAction } from './real-funding';
import type { CreditPort, PassProduct } from './types';

export function useMemberFunding(port: CreditPort, products: readonly PassProduct[], host?: WidgetHost) {
  const real = useRealPort();
  const state = useDomainState('members');
  const [action, setAction] = useState<FundingAction | null>(null);
  if (!real || state.mode !== 'http') return { port, dialog: null };
  const routed: CreditPort = {
    ...port,
    openSettlement: (target, context) => setAction({ target, context }),
    openOriginalTransaction: (txn, context) => {
      if (txn.fundingId) setAction({ fundingId: txn.fundingId, context });
      else port.openOriginalTransaction(txn, context);
    },
  };
  return { port: routed, dialog: action && <FundingDialog action={action} real={real} products={products} close={() => setAction(null)} host={host} /> };
}
