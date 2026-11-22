import { cafeArticleForm } from '../../../packages/naver/contracts/pn17/index.ts';
import type { Provider } from './binding.ts';
import { NaverAdapterError } from './errors.ts';
import { int, obj, oneOf, project, str } from './schema.ts';
import { attemptKeyPattern, call, parseJson } from './transport.ts';

/**
 * PN17 authorized Café posting (W) for marketing B13 community, text-only flow.
 * Contract: packages/naver/contracts/pn17 · persona capability pn17.
 *
 * Source: https://developers.naver.com/docs/login/cafe-api/cafe-api.md (read 2026-11-21 KST) ·
 * `POST /v1/cafe/{clubid}/menu/{menuid}/articles`, OAuth 2.0 `Authorization: Bearer`, form `subject`
 * and `content` encoded twice, HTML allowed in `content` (`<br>` for line breaks), product boards refused.
 * The official example wraps the response fields in `message`.
 *
 * The OAuth token and the already permitted boards come from the account grant (PN-A1/PN11). Navis
 * never joins, harvests or reads boards. Partnership offers stay in the Navis community ledger.
 */
const envelope = { '@type': oneOf(['response']), '@service': oneOf(['korea.naverkoreaservice.community.cafe']), '@version': str(), status: str() };
export const cafeResultShape = obj({ ...envelope, result: obj({ msg: str(), cafeUrl: str(), articleId: int({ min: 0 }), articleUrl: str() }) });

export interface CafeGrant {
  /** OAuth access token for the owner's NAVER account with Café write consent. */
  accessToken: string;
  /** Boards the owner already may post to, selected in the account grant. */
  boards: readonly { clubid: string; menuid: string }[];
}

const SUBJECT_MAX = 200; // Navis bounds; the provider applies its own rules.
const CONTENT_MAX = 10_000;
const ID = /^\d{1,12}$/;
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Owner text is posted as text: HTML is escaped and line breaks become `<br>`. */
export const cafeContent = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');

export function createCafePort(provider: Provider, grantFor: (signal?: AbortSignal) => Promise<CafeGrant | null>) {
  return {
    /** `attemptKey` binds the Navis attempt at persona (private metadata; the official wire has no key). */
    async post(input: { clubid: string; menuid: string; subject: string; text: string; attemptKey: string; signal?: AbortSignal }) {
      if (!ID.test(input.clubid) || !ID.test(input.menuid)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'board' });
      if (typeof input.attemptKey !== 'string' || !attemptKeyPattern.test(input.attemptKey)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'attemptKey' });
      if (typeof input.subject !== 'string' || !input.subject.trim() || Array.from(input.subject).length > SUBJECT_MAX) throw new NaverAdapterError('INVALID_INPUT', { detail: 'subject' });
      if (typeof input.text !== 'string' || !input.text.trim() || Array.from(input.text).length > CONTENT_MAX) throw new NaverAdapterError('INVALID_INPUT', { detail: 'text' });
      const grant = await grantFor(input.signal);
      if (!grant?.accessToken) throw new NaverAdapterError('FORBIDDEN', { detail: 'grant' });
      if (!grant.boards.some(board => board.clubid === input.clubid && board.menuid === input.menuid)) throw new NaverAdapterError('FORBIDDEN', { detail: 'board' });
      const result = await call(provider, 'pn17.article.create', `/v1/cafe/${input.clubid}/menu/${input.menuid}/articles`, {
        signal: input.signal,
        headers: {
          authorization: `Bearer ${grant.accessToken}`, 'content-type': 'application/x-www-form-urlencoded',
          ...(provider.strict && { 'idempotency-key': input.attemptKey }),
        },
        body: cafeArticleForm({ subject: escapeHtml(input.subject), content: cafeContent(input.text) }).toString(),
      });
      if (result.status >= 500) throw new NaverAdapterError('UNKNOWN_OUTCOME', { providerStatus: result.status });
      let body: Record<string, unknown> | null = null;
      try { body = parseJson(result) as Record<string, unknown> | null; } catch { /* error body may not be JSON */ }
      const wrapped = body && typeof body.message === 'object' && body.message !== null ? body.message as Record<string, unknown> : null;
      if (result.status !== 200) {
        const nested = (wrapped?.error ?? wrapped?.result) as { code?: unknown } | undefined;
        const code = [nested?.code, body?.errorCode, body?.code].find(value => typeof value === 'string') as string | undefined;
        const info = { providerStatus: result.status, providerCode: code?.slice(0, 16) };
        const forbidden = result.status === 401 || result.status === 403;
        throw new NaverAdapterError(forbidden ? 'FORBIDDEN' : 'REJECTED', info);
      }
      const { message: article } = project<{ message: { status: string; result: { articleId: number; articleUrl: string } } }>(
        obj({ message: cafeResultShape }), body, { strict: provider.strict },
      );
      if (article.status !== '200') throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$.status' });
      // The returned URL is a display reference only (PERSONA_NAVER §3).
      return { effect: 'cafe-article-posted' as const, articleId: article.result.articleId, articleUrl: article.result.articleUrl };
    },
  };
}
