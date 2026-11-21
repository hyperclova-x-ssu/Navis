import type { DeliveryState } from '../../../services/marketing/sens/ledger.ts';

export type ProviderOutcome =
  | { state: 'unknown'; requestId?: string }
  | { state: 'not_sent' }
  | { state: 'accepted'; requestId: string; delivery?: Exclude<DeliveryState, 'pending'> };

type Identity = { dispatchId: string };

export interface SensSend extends Identity {
  senderNumber: string;
  number: string;
  body: string;
}

/** A definitive no-send must fence the given dispatch ID from later acceptance. */
export interface FakeSensTransport {
  readonly kind: 'fake';
  send(input: SensSend, signal: AbortSignal): Promise<ProviderOutcome>;
  reconcile(input: Identity & { requestId: string | null }, signal: AbortSignal): Promise<ProviderOutcome>;
}
