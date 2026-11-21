/** Component-test adapter: production composition owns applying atomic domain plans. */
import { createCustomOrderSeed, planCustomOrderCommand, type CustomOrderRead, type CustomPlanResult } from '../../../data/iteration7/custom-orders';
import { createLegacyCustomOrderSeed } from '../../../data/iteration7/custom-orders/seed';
import type { CustomOrderPort } from './port';

/** `cafe` (default) is the store seed the app opens with; `legacy` is the acceptance fixture of AC-1471 (CO-001 paid and finished, CO-002 waiting for the customer). */
export function createCustomTestSource(options: { readonly fixture?: 'cafe' | 'legacy' } = {}) {
  const seed = options.fixture === 'legacy' ? createLegacyCustomOrderSeed() : createCustomOrderSeed();
  let read: CustomOrderRead = { revision: 0, tables: { ...seed.tables, member: [{ memberId: 'M-0001' }] }, money: seed.money, businessDate: '2026-10-26', now: '2026-10-26T15:45:00' };
  const listeners = new Set<() => void>();
  const apply = (plan: CustomPlanResult) => {
    if (plan.ok && plan.changed) {
      read = { ...read, revision: read.revision + 1, tables: plan.tables, money: {
        settlements: [...read.money.settlements, ...plan.moneyEffects.settlements],
        payments: [...read.money.payments, ...plan.moneyEffects.payments],
        recognitions: [...read.money.recognitions, ...plan.moneyEffects.recognitions],
        corrections: [...read.money.corrections, ...plan.moneyEffects.corrections],
      } };
      listeners.forEach(listener => listener());
    }
    return plan;
  };
  const port: CustomOrderPort = {
    read: () => read, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch: command => apply(planCustomOrderCommand(read, command)),
    openSettlement: () => { throw new Error('The component test must inject its app-host boundary'); },
    openReversal: () => { throw new Error('The component test must inject its app-host boundary'); },
    members: [{ memberId: 'M-0001', label: '김○현' }],
  };
  return { port, apply };
}
