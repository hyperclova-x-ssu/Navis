import type { ClipPublication, ClipUpload } from '../../../packages/naver/contracts/pn12/index.ts';
import type { Provider } from './binding.ts';
import { NaverAdapterError } from './errors.ts';
import { obj, opt, project, str } from './schema.ts';
import { ownerText, PARTNER, partner, segment } from './transport.ts';

/**
 * PN12 owned Clip publication (O) for marketing B16. Channel statistics belong to insight (PN-A3).
 * Contract: packages/naver/contracts/pn12 · persona capability pn12.
 *
 * Source: Clip upload and basic information (description up to 3,000 characters, up to five hashtags,
 * category, public/private) https://help.naver.com/service/30048/bookmark/24422 · Clip analytics exclude
 * linked Blog/MYPLACE clips https://help.naver.com/service/30048/contents/25170.
 * `media` is an eligible owner media ref already registered for the account. The link is read only when
 * the provider shows one (public clips). Live fallback stays MP4, the official uploader and the
 * owner-entered link (`video.markPosted`, existing owner).
 */
export const clipPublicationShape = obj({ link: opt(str({ min: 1, max: 500 })) });
const CLIP_REF = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function clipUpload(input: ClipUpload): ClipUpload {
  const extra = Object.keys(input ?? {}).filter(key => !['media', 'caption', 'category', 'tags', 'visibility'].includes(key));
  if (extra.length) throw new NaverAdapterError('INVALID_INPUT', { detail: extra[0] });
  if (input.visibility !== 'public' && input.visibility !== 'private') throw new NaverAdapterError('INVALID_INPUT', { detail: 'visibility' });
  const upload: ClipUpload = { media: segment(input.media), visibility: input.visibility };
  if (input.caption !== undefined) upload.caption = ownerText(input.caption, 3_000, 'caption');
  if (input.category !== undefined) upload.category = ownerText(input.category, 50, 'category');
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 5 || !input.tags.every(tag => typeof tag === 'string' && /^#?[\p{L}\p{N}_]{1,50}$/u.test(tag))) {
      throw new NaverAdapterError('INVALID_INPUT', { detail: 'tags' });
    }
    upload.tags = [...input.tags];
  }
  return upload;
}

export function createClipPort(provider: Provider) {
  return {
    async read(ref: string, signal?: AbortSignal) {
      const { json } = await partner(provider, 'pn12.clip.read', { path: `/clips/${segment(ref)}`, signal });
      const publication = project<ClipPublication>(clipPublicationShape, json, { strict: provider.strict });
      return { ref, link: publication.link ?? null };
    },

    /** Publish an owned clip from an explicit owner card. */
    async publish(input: ClipUpload & { attemptKey: string; signal?: AbortSignal }) {
      const { attemptKey, signal, ...rest } = input;
      const upload = clipUpload(rest);
      const { result, json } = await partner(provider, 'pn12.clip.create', { path: '/clips', json: upload, attemptKey, signal });
      const location = result.headers.get('location') ?? '';
      const ref = location.startsWith(`${PARTNER}/clips/`) ? location.slice(`${PARTNER}/clips/`.length) : '';
      if (result.status !== 201 || !CLIP_REF.test(ref)) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: 'location' });
      const publication = project<ClipPublication>(clipPublicationShape, json, { strict: provider.strict });
      if ((publication.link !== undefined) !== (upload.visibility === 'public')) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$.link' });
      return { effect: 'clip-published' as const, ref, visibility: upload.visibility, link: publication.link ?? null };
    },
  };
}
