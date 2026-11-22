import { reviewReplyNotice, type Review } from '../../../packages/naver/contracts/pn03/index.ts';
import type { Provider } from './binding.ts';
import { NaverAdapterError } from './errors.ts';
import { arr, bool, int, isoDate, nul, obj, oneOf, opaqueRef, opt, project, str } from './schema.ts';
import { ownerText, partner, requireSecondConfirmation, segment } from './transport.ts';

/**
 * PN03 owner review reply port (P review/reply, O NAVER AI draft) for marketing B15.
 * Contract: packages/naver/contracts/pn03 · persona capability pn03.
 *
 * Sources: reply create/update/delete, author notification, personal data exclusion
 * https://help.naver.com/service/30026/contents/20545 · AI reply draft (style and length)
 * https://help.naver.com/service/30026/contents/25102 · Place+ POS https://smartplace.naver.com/notices/876.
 * Persona routes under /partner-assumed/v1: GET /reviews/:ref, POST/PATCH/DELETE /reviews/:ref/reply,
 * POST /reviews/:ref/reply-draft. Writes run only after the owner presses the card.
 */
export const REPLY_NOTICE = reviewReplyNotice;
const REPLY_MAX = 2_000; // persona pn03 reply limit

/** Owner-visible review projection (contract `Review`). */
export const reviewShape = obj({
  ref: opaqueRef, text: str(), keywords: arr(str()),
  media: arr(obj({ type: oneOf(['photo', 'video']), url: str() })),
  stars: nul(int({ min: 1, max: 5 })), reply: nul(str()), hasReply: bool(),
  product: opt(str()), useDate: opt(isoDate),
});
export const replyDraftShape = obj({ text: str({ min: 1 }) });

export type ReplyEffect = {
  effect: 'reply-posted' | 'reply-updated' | 'reply-deleted';
  reply: string | null;
  readBack: 'confirmed' | 'pending';
};

const PHONE = /(?:\+?82[-.\s]?|0)(?:1[016789]|2|[3-6][1-5]|70)[-.\s]?\d{3,4}[-.\s]?\d{4}/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Navis checks for phone and email before asking the owner to publish. */
export function replyText(value: unknown): string {
  const text = ownerText(value, REPLY_MAX, 'text').trim();
  if (PHONE.test(text) || EMAIL.test(text)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'personal-details' });
  return text;
}

export function createReplyPort(provider: Provider) {
  async function readReview(reviewRef: string, signal?: AbortSignal): Promise<Review> {
    const { json } = await partner(provider, 'pn03.reviews.get', { path: `/reviews/${segment(reviewRef)}`, signal });
    const review = project<Review>(reviewShape, json, { strict: provider.strict });
    if (review.ref !== reviewRef) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$.ref' });
    return review;
  }

  async function confirm(reviewRef: string, expected: string | null): Promise<'confirmed' | 'pending'> {
    try { return (await readReview(reviewRef)).reply === expected ? 'confirmed' : 'pending'; }
    catch { return 'pending'; }
  }

  async function write(operation: 'pn03.reply.create' | 'pn03.reply.update',
    input: { reviewRef: string; text: string; attemptKey: string; signal?: AbortSignal }): Promise<ReplyEffect> {
    const text = replyText(input.text);
    const { json } = await partner(provider, operation, {
      path: `/reviews/${segment(input.reviewRef)}/reply`, json: { text }, attemptKey: input.attemptKey, signal: input.signal,
    });
    const review = project<Review>(reviewShape, json, { strict: provider.strict });
    if (review.reply !== text || !review.hasReply) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$.reply' });
    return {
      effect: operation === 'pn03.reply.create' ? 'reply-posted' : 'reply-updated', reply: review.reply,
      readBack: await confirm(input.reviewRef, text),
    };
  }

  return {
    readReview,
    /** One active reply per review; the card states REPLY_NOTICE. */
    post: (input: { reviewRef: string; text: string; attemptKey: string; signal?: AbortSignal }) => write('pn03.reply.create', input),
    update: (input: { reviewRef: string; text: string; attemptKey: string; signal?: AbortSignal }) => write('pn03.reply.update', input),

    async remove(input: { reviewRef: string; attemptKey: string; confirmation: unknown; signal?: AbortSignal }): Promise<ReplyEffect> {
      requireSecondConfirmation(input.confirmation);
      const { result } = await partner(provider, 'pn03.reply.delete', {
        path: `/reviews/${segment(input.reviewRef)}/reply`, attemptKey: input.attemptKey, signal: input.signal,
      });
      if (result.status !== 204) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: 'status' });
      return { effect: 'reply-deleted', reply: null, readBack: await confirm(input.reviewRef, null) };
    },

    /** NAVER's own AI draft (draft data only, labeled with its source; no reply is written). */
    async draft(input: { reviewRef: string; style: string; length: string; signal?: AbortSignal }) {
      const body = { style: ownerText(input.style, Infinity, 'style').trim(), length: ownerText(input.length, Infinity, 'length').trim() };
      const { json } = await partner(provider, 'pn03.reply.draft', {
        path: `/reviews/${segment(input.reviewRef)}/reply-draft`, json: body, signal: input.signal,
      });
      return { text: project<{ text: string }>(replyDraftShape, json, { strict: provider.strict }).text, source: 'naver-ai' as const };
    },

    /** After an unknown outcome: compare the exact owner-visible reply before any retry. */
    async reconcile(reviewRef: string, expectedText: string | null) {
      const review = await readReview(reviewRef);
      return { matches: review.reply === expectedText, reply: review.reply };
    },
  };
}
