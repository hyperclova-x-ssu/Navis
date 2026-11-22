import type { News, NewsWrite } from '../../../packages/naver/contracts/pn04/index.ts';
import type { Provider } from './binding.ts';
import { isAdapterError, NaverAdapterError } from './errors.ts';
import { arr, int, isoDate, nul, obj, opaqueRef, project, str } from './schema.ts';
import { ownerText, partner, requireSecondConfirmation, seoulDate, segment, shiftDate } from './transport.ts';

/**
 * PN04 Place news port (O) for marketing B15/B16: one owner command per Place news effect.
 * Contract: packages/naver/contracts/pn04 · persona capability pn04.
 *
 * Sources: register/edit/delete, notice order, at most five notices shown for up to 45 days
 * https://help.naver.com/service/30026/contents/20513 · title 5–40 and body 10–1,000 characters
 * https://new.smartplace.naver.com/notices/695 · owner video https://new.smartplace.naver.com/notices/922.
 * Persona routes: GET/POST /place/news, GET/PATCH/DELETE /place/news/:ref. No provider scheduling.
 * `video` is the ref of an eligible owner video already registered with Place.
 */
export const NOTICE_LIMIT = 5;
export const NOTICE_MAX_DAYS = 45;

export const newsShape = obj({
  ref: opaqueRef, title: str(), text: str(), video: nul(opaqueRef),
  pin: nul(obj({ from: isoDate, to: isoDate, order: int({ min: 1, max: NOTICE_LIMIT }) })),
});
const newsList = obj({ items: arr(newsShape, { max: 100 }) });

export type NewsPin = { to: string; order: number };

export function createNewsPort(provider: Provider, clock: { now(): Date } = { now: () => new Date() }) {
  function pinInput(value: NewsPin | null): NewsPin | null {
    if (value === null) return null;
    const today = seoulDate(clock.now());
    if (!value || typeof value.to !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.to) || value.to < today
      || value.to > shiftDate(today, NOTICE_MAX_DAYS - 1) || !Number.isSafeInteger(value.order) || value.order < 1 || value.order > NOTICE_LIMIT) {
      throw new NaverAdapterError('INVALID_INPUT', { detail: 'pin' });
    }
    return { to: value.to, order: value.order };
  }

  async function get(ref: string, signal?: AbortSignal): Promise<News | null> {
    try {
      const { json } = await partner(provider, 'pn04.news.get', { path: `/place/news/${segment(ref)}`, signal });
      return project<News>(newsShape, json, { strict: provider.strict });
    } catch (error) {
      if (isAdapterError(error, 'NOT_FOUND')) return null;
      throw error;
    }
  }

  async function readBack(ref: string, expected: (news: News | null) => boolean): Promise<'confirmed' | 'pending'> {
    try { return expected(await get(ref)) ? 'confirmed' : 'pending'; } catch { return 'pending'; }
  }

  function matches(news: News | null, write: NewsWrite) {
    return !!news && (write.title === undefined || news.title === write.title) && (write.text === undefined || news.text === write.text)
      && (write.video === undefined || news.video === write.video)
      && (write.pin === undefined || (write.pin === null ? news.pin === null : news.pin?.to === write.pin.to && news.pin.order === write.pin.order));
  }

  async function write(operation: 'pn04.news.create' | 'pn04.news.update', path: string, body: NewsWrite, attemptKey: string, signal?: AbortSignal) {
    const { json } = await partner(provider, operation, { path, json: body, attemptKey, signal });
    const news = project<News>(newsShape, json, { strict: provider.strict });
    if (!matches(news, body)) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$' });
    return { effect: operation === 'pn04.news.create' ? 'news-published' as const : 'news-updated' as const, news,
      readBack: await readBack(news.ref, current => matches(current, body)) };
  }

  return {
    get,
    async list(input: { limit?: number; offset?: number; signal?: AbortSignal } = {}) {
      const { json } = await partner(provider, 'pn04.news.list', { path: '/place/news', query: { limit: input.limit, offset: input.offset }, signal: input.signal });
      return project<{ items: News[] }>(newsList, json, { strict: provider.strict });
    },

    /** Publish one owner news post, optionally with an owner video ref and a notice (공지) slot. */
    async create(input: { title: string; text: string; video?: string | null; pin?: NewsPin | null; attemptKey: string; signal?: AbortSignal }) {
      const body: NewsWrite = { title: ownerText(input.title, 40, 'title', 5).trim(), text: ownerText(input.text, 1_000, 'text', 10).trim() };
      if (input.video !== undefined) body.video = input.video === null ? null : segment(input.video);
      if (input.pin !== undefined) body.pin = pinInput(input.pin);
      return write('pn04.news.create', '/place/news', body, input.attemptKey, input.signal);
    },

    async update(input: { ref: string; title?: string; text?: string; video?: string | null; pin?: NewsPin | null; attemptKey: string; signal?: AbortSignal }) {
      const body: NewsWrite = {};
      if (input.title !== undefined) body.title = ownerText(input.title, 40, 'title', 5).trim();
      if (input.text !== undefined) body.text = ownerText(input.text, 1_000, 'text', 10).trim();
      if (input.video !== undefined) body.video = input.video === null ? null : segment(input.video);
      if (input.pin !== undefined) body.pin = pinInput(input.pin);
      if (!Object.keys(body).length) throw new NaverAdapterError('INVALID_INPUT', { detail: 'empty' });
      return write('pn04.news.update', `/place/news/${segment(input.ref)}`, body, input.attemptKey, input.signal);
    },

    async remove(input: { ref: string; attemptKey: string; confirmation: unknown; signal?: AbortSignal }) {
      requireSecondConfirmation(input.confirmation);
      const { result } = await partner(provider, 'pn04.news.delete', {
        path: `/place/news/${segment(input.ref)}`, attemptKey: input.attemptKey, signal: input.signal,
      });
      if (result.status !== 204) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: 'status' });
      return { effect: 'news-deleted' as const, readBack: await readBack(input.ref, current => current === null) };
    },
  };
}
