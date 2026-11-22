import { isUuid, type PromoInput } from '../../promo/contracts.ts';
import { PromoRouteError } from '../../promo/jobs.ts';

export const badRequest = () => new PromoRouteError(400, 'BAD_REQUEST');
export const notFound = () => new PromoRouteError(404, 'NOT_FOUND');
export const conflict = (code = 'REVISION_CONFLICT') => new PromoRouteError(409, code);
export const unavailable = () => new PromoRouteError(503, 'UNAVAILABLE');

export function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !fields.includes(key))) throw badRequest();
  return value as Record<string, unknown>;
}

export function id(value: unknown) {
  if (!isUuid(value)) throw badRequest();
  return value;
}

export function identifier(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw badRequest();
  return value;
}

export function revision(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw badRequest();
  return value;
}

export function text(value: unknown, max: number, min = 0) {
  if (typeof value !== 'string' || [...value].length > max || value.trim().length < min
      // eslint-disable-next-line no-control-regex -- Reject ASCII controls except permitted whitespace.
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw badRequest();
  return value;
}

function choice<T>(value: unknown, options: readonly T[]): T {
  if (!options.includes(value as T)) throw badRequest();
  return value as T;
}

function list<T>(value: unknown, max: number, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw badRequest();
  const result = value.map(item);
  if (new Set(result).size !== result.length) throw badRequest();
  return result;
}

const parsers = {
  menuIds: (value: unknown) => list(value, 20, identifier),
  photoIds: (value: unknown) => list(value, 64, identifier),
  concepts: (value: unknown) => list(value, 5, entry => choice(entry, ['review-roundup', 'behind-the-scenes', 'todays-deal', 'new-item', 'day-at-shop'] as const)),
  moods: (value: unknown) => list(value, 4, entry => choice(entry, ['warm', 'clean', 'lively', 'elegant'] as const)),
  lengthSec: (value: unknown) => choice(value, [10, 15, 30] as const),
  referenceId: (value: unknown) => choice(value, ['ref-1', 'ref-2', 'ref-3', 'ref-4', 'ref-5', 'ref-6'] as const),
  locale: (value: unknown) => choice(value, ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const),
  memo: (value: unknown) => text(value, 100),
} satisfies { [Field in keyof PromoInput]: (value: unknown) => PromoInput[Field] };

export function draftPatch(input: unknown): Partial<PromoInput> {
  const data = record(input, Object.keys(parsers));
  return Object.fromEntries(Object.entries(data).map(([key, value]) =>
    [key, parsers[key as keyof typeof parsers](value)]));
}

const linkHosts = {
  clip: ['clip.naver.com', 'm.clip.naver.com', 'naver.me'],
  'place-news': ['place.naver.com', 'm.place.naver.com', 'naver.me'],
  reels: ['instagram.com', 'www.instagram.com'],
  shorts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
} as const;

export type Channel = keyof typeof linkHosts;
export type ProviderChannel = 'place-news' | 'clip' | 'reels' | 'shorts';
export type PublishInput =
  | { channel: 'place-news'; text: string }
  | { channel: 'clip'; description: string; hashtags: string[]; category: string;
      visibility: 'public' | 'private'; aiUsed: true; sponsored: boolean; commentsAllowed: boolean }
  | { channel: 'reels' | 'shorts'; description: string };

function confirmed(value: unknown) {
  if (value !== true) throw badRequest();
}

export function postingLink(value: unknown, route: Channel) {
  const raw = text(value, 500, 1);
  let url: URL;
  try { url = new URL(raw); } catch { throw badRequest(); }
  const hosts: readonly string[] = linkHosts[route];
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !hosts.includes(url.hostname) || url.pathname === '/') throw badRequest();
  return url.href;
}

export function attestation(input: unknown) {
  const data = record(input, ['confirmed', 'extraConfirmed', 'route', 'link']);
  confirmed(data.confirmed);
  confirmed(data.extraConfirmed);
  const route = choice(data.route, ['clip', 'place-news', 'reels', 'shorts'] as const);
  return { route, link: postingLink(data.link, route) };
}

export function publicationCard(input: unknown, channel: ProviderChannel): PublishInput {
  if (channel === 'place-news') {
    const data = record(input, ['confirmed', 'text']);
    confirmed(data.confirmed);
    return { channel, text: text(data.text, 5000, 1).trim() };
  }
  if (channel !== 'clip') {
    const data = record(input, ['confirmed', 'description']);
    confirmed(data.confirmed);
    return { channel, description: text(data.description, 2200).trim() };
  }
  const data = record(input, ['confirmed', 'description', 'hashtags', 'category', 'visibility', 'aiUsed', 'sponsored', 'commentsAllowed']);
  confirmed(data.confirmed);
  confirmed(data.aiUsed);
  if (typeof data.sponsored !== 'boolean' || typeof data.commentsAllowed !== 'boolean') throw badRequest();
  return {
    channel, description: text(data.description, 3000).trim(), category: text(data.category, 50, 1).trim(),
    hashtags: list(data.hashtags, 5, value => {
      if (typeof value !== 'string' || !/^[\p{L}\p{N}_]{1,50}$/u.test(value)) throw badRequest();
      return value;
    }),
    visibility: choice(data.visibility, ['public', 'private'] as const),
    aiUsed: true, sponsored: data.sponsored, commentsAllowed: data.commentsAllowed,
  };
}
