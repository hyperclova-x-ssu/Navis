import { campaignAudiences, type CampaignAudience, type CampaignAudiences, type CampaignSend } from '../../../packages/naver/contracts/pn07/index.ts';
import type { Provider } from './binding.ts';
import { NaverAdapterError } from './errors.ts';
import { arr, int, obj, oneOf, opt, project, str } from './schema.ts';
import { ownerText, partner, segment } from './transport.ts';

/**
 * PN07 TalkTalk marketing group send (O), run by the marketing send worker after the owner card.
 * Contract: packages/naver/contracts/pn07 · persona capability pn07.
 *
 * Sources: provider groups (혜택 알림 받기 customers, recent three-month visitors who reviewed, negative
 * reviewers excluded), monthly quota https://help.naver.com/service/30026/contents/20507 · coupon
 * attachment for marketing-message coupons, no benefit edit after sending
 * https://help.naver.com/service/30026/contents/21111.
 * Persona answers 204 on acceptance. Audience items are selectors and quota is the monthly assigned allowance.
 * Excluded: individual IDs, delivery/open claims, push guarantees, after-send edits, scheduled sends.
 */
export const audiencesShape = obj({
  items: arr(obj({ audience: oneOf(campaignAudiences) }), { max: campaignAudiences.length }),
  quota: opt(obj({ month: str({ pattern: /^\d{4}-(0[1-9]|1[0-2])$/ }), assigned: int({ min: 0 }) })),
});

/** D-331: from 21:00 to 08:00 KST Navis does not send; TalkTalk has no provider scheduling, so the card proposes 내일 8시. */
export const talkTalkNight = (now: Date) => {
  const hour = (now.getUTCHours() + 9) % 24;
  return hour >= 21 || hour < 8;
};

export function createTalkTalkMarketingPort(provider: Provider, clock: { now(): Date } = { now: () => new Date() }) {
  return {
    async audiences(signal?: AbortSignal) {
      const { json } = await partner(provider, 'pn07.audiences.list', { path: '/talktalk/marketing/audiences', signal });
      return project<CampaignAudiences>(audiencesShape, json, { strict: provider.strict });
    },

    /** The provider checks group eligibility and assigned allowance. Navis applies its own sending window. */
    async send(input: { audience: CampaignAudience; title: string; body: string; couponRef?: string; attemptKey: string; signal?: AbortSignal }) {
      if (!campaignAudiences.includes(input.audience)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'audience' });
      if (talkTalkNight(clock.now())) throw new NaverAdapterError('REJECTED', { detail: 'night-window' });
      const payload: CampaignSend = {
        audience: input.audience, title: ownerText(input.title, Infinity, 'title').trim(), body: ownerText(input.body, Infinity, 'body').trim(),
        ...(input.couponRef === undefined ? {} : { couponRef: segment(input.couponRef) }),
      };
      const { result } = await partner(provider, 'pn07.sends.create', {
        path: '/talktalk/marketing/sends', json: payload, attemptKey: input.attemptKey, signal: input.signal,
      });
      if (result.status !== 204) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: 'status' });
      return { effect: 'talktalk-marketing-accepted' as const, audience: payload.audience };
    },
  };
}
