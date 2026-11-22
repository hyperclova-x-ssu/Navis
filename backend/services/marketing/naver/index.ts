import type { Provider } from './binding.ts';
import { createReplyPort } from './pn03-reply.ts';
import { createNewsPort } from './pn04-news.ts';
import { createCouponPort } from './pn05-coupons.ts';
import { createTalkTalkPort } from './pn06-talktalk.ts';
import { createTalkTalkMarketingPort } from './pn07-talktalk-marketing.ts';
import { createSearchPort } from './pn10-search.ts';
import { createClipPort } from './pn12-clips.ts';
import { createCafePort, type CafeGrant } from './pn17-cafe.ts';

export { createMarketingProvider, marketingBindings, OPERATIONS, sensSignature, signV4 } from './binding.ts';
export type { MarketingBindingOptions, Mode, NaverTransport, OperationId, Provider } from './binding.ts';
export { isAdapterError, NaverAdapterError, type AdapterCode } from './errors.ts';
export { REPLY_NOTICE } from './pn03-reply.ts';
export { parseTalkTalkEvent, registerTalkTalkInbound, talkTalkInboundPath, type InboundEvent } from './pn06-talktalk.ts';
export type { CafeGrant } from './pn17-cafe.ts';

/**
 * Marketing NAVER provider ports (PN-A2) over the PN-P0 scoped transport. The owning B13–B16/B19
 * handlers call write ports only inside their existing card command after revision, expiry and
 * extra-confirmation checks, passing their durable attempt key. This module adds no owner routes and
 * stores no state. See README.md for endpoints, sources and wiring.
 */
export function createNaverMarketing(provider: Provider, options: {
  clock?: { now(): Date };
  /** Owner OAuth grant for Café posting (account/PN-A1 `createOwnerGrantResolver`). */
  cafeGrant?: (signal?: AbortSignal) => Promise<CafeGrant | null>;
} = {}) {
  return {
    reply: createReplyPort(provider),
    news: createNewsPort(provider, options.clock),
    coupons: createCouponPort(provider, options.clock),
    talktalk: createTalkTalkPort(provider),
    talktalkMarketing: createTalkTalkMarketingPort(provider, options.clock),
    search: createSearchPort(provider, options.clock),
    clips: createClipPort(provider),
    cafe: createCafePort(provider, options.cafeGrant ?? (async () => null)),
  };
}

export type NaverMarketing = ReturnType<typeof createNaverMarketing>;
