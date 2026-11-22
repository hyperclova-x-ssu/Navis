import { createHash, createHmac } from 'node:crypto';
import type { NaverBinding, NaverRequestScope } from '../../../packages/naver/config/index.ts';
import { createNaverTransport } from '../../../packages/naver/transport/index.ts';
import { talkTalkSources } from '../../../packages/naver/contracts/pn06/index.ts';

/**
 * Marketing NAVER operation catalog and PN-P0 bindings (PERSONA_NAVER §2–§3).
 *
 * Operation names, methods and paths are the committed naver-virtual routes. Each binding is
 * scoped to one operation and one store; the browser and model never choose one.
 * - `fake`: in-process handler (A-3, unit tests). No socket.
 * - `virtual`: private NAVER virtual service; PN-P0 adds the workload token and account headers.
 *   W operations also sign with the product's official headers using synthetic credentials.
 * - `live`: W operations only, at the official origin, with the caller's A6 `approve` check.
 *   P/O live needs a verified partner contract, which does not exist yet (§7), so it is refused here.
 */
export type Mode = 'fake' | 'virtual' | 'live';
type Grade = 'W' | 'P' | 'O';
type Method = NaverBinding['method'];
type WireAuth = 'partner' | 'api-key' | 'sens' | 'talktalk' | 'studio' | 's3' | 'oauth-header';

export interface OperationSpec {
  readonly grade: Grade;
  readonly method: Method;
  readonly route: RegExp;
  readonly auth: WireAuth;
  readonly write: boolean;
  readonly origin: string | null;
  readonly sources: readonly string[];
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

const HELP = 'https://help.naver.com/service';
const NCP = 'https://api.ncloud-docs.com/docs';
const REF = '[A-Za-z0-9_-]{1,100}';
const P = '/partner-assumed/v1';
const SENS = 'https://sens.apigw.ntruss.com';
const HUB = 'https://naverapihub.apigw.ntruss.com';
const exact = (pattern: string) => new RegExp(`^${pattern}$`);
const po = (grade: 'P' | 'O', method: Method, path: string, ...sources: string[]): OperationSpec =>
  ({ grade, method, route: exact(P + path), auth: 'partner', write: method !== 'GET', origin: null, sources });
const w = (method: Method, path: string, auth: WireAuth, origin: string, ...sources: string[]): OperationSpec =>
  ({ grade: 'W', method, route: exact(path), auth, write: method !== 'GET', origin, sources });

const SERVICE = '[A-Za-z0-9:_-]{1,180}';
export const OPERATIONS = {
  // PN03 · P review/reply, O NAVER AI draft (persona capability pn03).
  'pn03.reviews.get': po('P', 'GET', `/reviews/${REF}`, `${HELP}/30026/contents/20545`, 'https://smartplace.naver.com/notices/876'),
  'pn03.reply.create': po('P', 'POST', `/reviews/${REF}/reply`, `${HELP}/30026/contents/20545`),
  'pn03.reply.update': po('P', 'PATCH', `/reviews/${REF}/reply`, `${HELP}/30026/contents/20545`),
  'pn03.reply.delete': po('P', 'DELETE', `/reviews/${REF}/reply`, `${HELP}/30026/contents/20545`),
  // Draft generation writes no reply, so it carries no attempt key.
  'pn03.reply.draft': { ...po('O', 'POST', `/reviews/${REF}/reply-draft`, `${HELP}/30026/contents/25102`), write: false },
  // PN04 · O Place news.
  'pn04.news.list': po('O', 'GET', '/place/news', `${HELP}/30026/contents/20513`),
  'pn04.news.get': po('O', 'GET', `/place/news/${REF}`, `${HELP}/30026/contents/20513`),
  'pn04.news.create': po('O', 'POST', '/place/news', `${HELP}/30026/contents/20513`, 'https://new.smartplace.naver.com/notices/695', 'https://new.smartplace.naver.com/notices/922'),
  'pn04.news.update': po('O', 'PATCH', `/place/news/${REF}`, `${HELP}/30026/contents/20513`),
  'pn04.news.delete': po('O', 'DELETE', `/place/news/${REF}`, `${HELP}/30026/contents/20513`),
  // PN05 · O Place coupon / Order promotion, P named membership.
  'pn05.coupons.list': po('O', 'GET', '/place/coupons', `${HELP}/30026/contents/20833`),
  'pn05.coupons.create': po('O', 'POST', '/place/coupons', `${HELP}/30026/contents/20833`, `${HELP}/30026/contents/21111`),
  'pn05.coupons.delete': po('O', 'DELETE', `/place/coupons/${REF}`, `${HELP}/30026/contents/20837`),
  'pn05.issues.list': po('O', 'GET', `/place/coupons/${REF}/issues`, `${HELP}/30026/contents/20843`),
  'pn05.issues.update': po('O', 'PATCH', `/place/coupon-issues/${REF}/usage`, `${HELP}/30026/contents/20843`),
  'pn05.promotions.list': po('O', 'GET', '/order/promotions', `${HELP}/30026/contents/20710`),
  'pn05.promotions.create': po('O', 'POST', '/order/promotions', `${HELP}/30026/contents/20710`),
  'pn05.promotions.extend': po('O', 'POST', `/order/promotions/${REF}/extend`, `${HELP}/30026/contents/20710`),
  'pn05.promotions.end': po('O', 'POST', `/order/promotions/${REF}/end`, `${HELP}/30026/contents/20710`),
  'pn05.membership.list': po('P', 'GET', '/membership/benefits', 'https://smartplace.naver.com/notices/1100'),
  // PN06 · O retained consultations, W chatbot 보내기 API.
  'pn06.consultations.list': po('O', 'GET', '/talktalk/consultations', talkTalkSources.consultations, talkTalkSources.period, talkTalkSources.tabs),
  'pn06.consultations.get': po('O', 'GET', `/talktalk/consultations/${REF}`, talkTalkSources.consultations),
  'pn06.chatbot.send': w('POST', '/chatbot/v1/event', 'talktalk', 'https://gw.talk.naver.com', 'https://github.com/navertalk/chatbot-api/blob/master/README.md'),
  // PN07 · O TalkTalk marketing.
  'pn07.audiences.list': po('O', 'GET', '/talktalk/marketing/audiences', `${HELP}/30026/contents/20507`),
  'pn07.sends.create': po('O', 'POST', '/talktalk/marketing/sends', `${HELP}/30026/contents/20507`, `${HELP}/30026/contents/21111`),
  // PN10 · W API HUB Search / Search Trend, Maps Geocoding.
  'pn10.blog': w('GET', '/search/v1/blog', 'api-key', HUB, `${NCP}/naver-api-hub-search-blog`),
  'pn10.cafearticle': w('GET', '/search/v1/cafearticle', 'api-key', HUB, `${NCP}/naver-api-hub-search-cafearticle`),
  'pn10.local': w('GET', '/search/v1/local', 'api-key', HUB, `${NCP}/naver-api-hub-search-local`),
  'pn10.news': w('GET', '/search/v1/news', 'api-key', HUB, `${NCP}/naver-api-hub-search-news`),
  'pn10.trend': w('POST', '/search-trend/v1/search', 'api-key', HUB, `${NCP}/naver-api-hub-search-trend`),
  'pn10.geocode': w('GET', '/map-geocode/v2/geocode', 'api-key', 'https://maps.apigw.ntruss.com', `${NCP}/application-maps-geocoding`),
  // PN12 · O owned Clip publication.
  'pn12.clip.create': po('O', 'POST', '/clips', `${HELP}/30048/bookmark/24422`),
  'pn12.clip.read': po('O', 'GET', `/clips/${REF}`, `${HELP}/30048/bookmark/24422`),
  // PN13 · W SENS (marketing-worker).
  'pn13.sms.send': w('POST', `/sms/v2/services/${SERVICE}/messages`, 'sens', SENS, `${NCP}/sens-sms-send`),
  'pn13.sms.list': w('GET', `/sms/v2/services/${SERVICE}/messages`, 'sens', SENS, `${NCP}/sens-sms-list`),
  'pn13.sms.get': w('GET', `/sms/v2/services/${SERVICE}/messages/${REF}`, 'sens', SENS, `${NCP}/sens-sms-get`),
  'pn13.sms.reservation-status': w('GET', `/sms/v2/services/${SERVICE}/reservations/${REF}/reserve-status`, 'sens', SENS, `${NCP}/sens-sms-reservation-status-get`),
  'pn13.sms.reservation-delete': w('DELETE', `/sms/v2/services/${SERVICE}/reservations/${REF}`, 'sens', SENS, `${NCP}/sens-sms-reservation-delete`),
  'pn13.alimtalk.send': w('POST', `/alimtalk/v2/services/${SERVICE}/messages`, 'sens', SENS, `${NCP}/sens-alimtalk-send`),
  'pn13.alimtalk.get': w('GET', `/alimtalk/v2/services/${SERVICE}/messages/${REF}`, 'sens', SENS, `${NCP}/sens-alimtalk-get`),
  'pn13.brandmessage.send': w('POST', `/brandmessage/v2/services/${SERVICE}/messages`, 'sens', SENS, `${NCP}/sens-brandmessage-send`),
  'pn13.brandmessage.get': w('GET', `/brandmessage/v2/services/${SERVICE}/messages/${REF}`, 'sens', SENS, `${NCP}/sens-brandmessage-get`),
  'pn13.mail.send': w('POST', `/mail/v2/services/${SERVICE}/requests`, 'sens', SENS, `${NCP}/sens-mail-request-create`),
  'pn13.mail.request': w('GET', `/mail/v2/services/${SERVICE}/requests/${REF}`, 'sens', SENS, `${NCP}/sens-mail-request-get`),
  // PN14 · W CLOVA Studio v3 for promo stages (marketing-worker).
  'pn14.chat': { ...w('POST', '/v3/chat-completions/(?:HCX-005|HCX-007)', 'studio', 'https://clovastudio.stream.ntruss.com',
    `${NCP}/clovastudio-chatcompletionsv3`, `${NCP}/clovastudio-chatcompletionsv3-so`), timeoutMs: 60_000, maxRequestBytes: 20 * 1024 * 1024 },
  // PN16 · W Object Storage for promo artifacts (marketing-worker).
  'pn16.object.put': { ...w('PUT', '/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9/_.-]{1,900}', 's3', 'https://kr.object.ncloudstorage.com',
    `${NCP}/storage-objectstorage-putobject`), timeoutMs: 60_000, maxRequestBytes: 32 * 1024 * 1024 },
  'pn16.object.get': { ...w('GET', '/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9/_.-]{1,900}', 's3', 'https://kr.object.ncloudstorage.com',
    `${NCP}/storage-objectstorage-getobject`), timeoutMs: 60_000, maxResponseBytes: 32 * 1024 * 1024 },
  'pn16.object.delete': w('DELETE', '/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9/_.-]{1,900}', 's3', 'https://kr.object.ncloudstorage.com',
    `${NCP}/storage-objectstorage-deleteobject`),
  // PN17 · W authorized Café posting (OAuth Bearer from the owner's account grant).
  'pn17.article.create': w('POST', '/v1/cafe/\\d{1,12}/menu/\\d{1,12}/articles', 'oauth-header', 'https://openapi.naver.com',
    'https://developers.naver.com/docs/login/cafe-api/cafe-api.md'),
} as const satisfies Record<string, OperationSpec>;

export type OperationId = keyof typeof OPERATIONS;

/** Credential files hold JSON objects except TalkTalk, whose file holds the raw `Authorization` value. */
const credentialFields: Record<Exclude<WireAuth, 'partner' | 'oauth-header'>, readonly string[]> = {
  'api-key': ['keyId', 'key'],
  sens: ['accessKey', 'secretKey'],
  talktalk: [],
  studio: ['apiKey'],
  s3: ['accessKeyId', 'secretAccessKey'],
};

function parsed(credential: string, auth: keyof typeof credentialFields): Record<string, string> {
  if (auth === 'talktalk') return { authorization: credential.trim() };
  const value = JSON.parse(credential) as Record<string, unknown>;
  for (const key of credentialFields[auth]) if (typeof value[key] !== 'string' || !(value[key] as string)) throw new Error('Invalid NAVER credential');
  return value as Record<string, string>;
}

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();

/** SENS signature v2 (https://api.ncloud-docs.com/docs/sens-overview). */
export function sensSignature(method: string, pathAndQuery: string, timestamp: string, accessKey: string, secretKey: string) {
  return createHmac('sha256', secretKey).update(`${method} ${pathAndQuery}\n${timestamp}\n${accessKey}`).digest('base64');
}

/** AWS Signature Version 4 header for S3-compatible Object Storage, region kr-standard by default. */
export function signV4(input: {
  method: string; host: string; path: string; headers?: Record<string, string>; payloadHash: string;
  accessKey: string; secretKey: string; region?: string; date: Date;
}) {
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const region = input.region ?? 'kr-standard';
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...input.headers, host: input.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': input.payloadHash })) {
    headers[key.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  }
  const names = Object.keys(headers).sort();
  const canonical = [input.method, input.path, '', names.map(name => `${name}:${headers[name]}\n`).join(''), names.join(';'), input.payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const signature = createHmac('sha256', hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, day), region), 's3'), 'aws4_request'))
    .update(['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    amzDate,
  };
}

/** Official request authentication per wire, computed at send time from the scoped request. */
function authorizer(auth: keyof typeof credentialFields, now: () => Date) {
  return (request: NaverRequestScope, credential: string): HeadersInit => {
    const value = parsed(credential, auth);
    switch (auth) {
      case 'api-key':
        return { 'X-NCP-APIGW-API-KEY-ID': value.keyId, 'X-NCP-APIGW-API-KEY': value.key };
      case 'talktalk':
        return { authorization: value.authorization };
      case 'studio':
        return { authorization: `Bearer ${value.apiKey}` };
      case 'sens': {
        const timestamp = String(now().getTime());
        return {
          'x-ncp-apigw-timestamp': timestamp, 'x-ncp-iam-access-key': value.accessKey,
          'x-ncp-apigw-signature-v2': sensSignature(request.method, request.url.pathname + request.url.search, timestamp, value.accessKey, value.secretKey),
        };
      }
      case 's3': {
        const payloadHash = sha256(request.body ?? new Uint8Array());
        const signed = signV4({ method: request.method, host: request.url.host, path: request.url.pathname, payloadHash,
          accessKey: value.accessKeyId, secretKey: value.secretAccessKey, region: value.region, date: now() });
        return { authorization: signed.authorization, 'x-amz-date': signed.amzDate, 'x-amz-content-sha256': payloadHash };
      }
    }
  };
}

export interface MarketingBindingOptions {
  storeId: string;
  providerAccount: string;
  mode: Mode;
  /** Restrict to the operations this workload is granted (default: every catalog operation). */
  operations?: readonly OperationId[];
  /** Persona: private origin (default http://naver-virtual:3000) and workload token file. */
  virtualOrigin?: string;
  privateTokenFile?: string;
  /** W credential files by auth kind (JSON, or the raw TalkTalk Authorization value). */
  credentialFiles?: Partial<Record<keyof typeof credentialFields, string>>;
  operationCredentialFiles?: Partial<Record<OperationId, string>>;
  /** Fake: in-process provider handler. */
  fakeHandler?: (request: NaverRequestScope) => Response | Promise<Response>;
  /** Live: current A6 approval check for each W request. */
  approve?: (request: NaverRequestScope) => boolean | Promise<boolean>;
  now?: () => Date;
}

/** Build PN-P0 bindings for the marketing operations of one store. */
export function marketingBindings(options: MarketingBindingOptions): NaverBinding[] {
  const now = options.now ?? (() => new Date());
  const selected = options.operations ?? (Object.keys(OPERATIONS) as OperationId[]);
  return selected.map((operation): NaverBinding => {
    const spec: OperationSpec = OPERATIONS[operation];
    const base = {
      operation, storeId: options.storeId, providerAccount: options.providerAccount, grade: spec.grade, method: spec.method,
      route: spec.route, timeoutMs: spec.timeoutMs, maxRequestBytes: spec.maxRequestBytes, maxResponseBytes: spec.maxResponseBytes,
    };
    const wire = spec.auth === 'partner' || spec.auth === 'oauth-header' ? null : spec.auth;
    const credential = wire ? {
      credentialFile: options.operationCredentialFiles?.[operation] ?? options.credentialFiles?.[wire],
      authorize: authorizer(wire, now),
    } : null;
    if (wire && !credential?.credentialFile && options.mode !== 'fake') throw new Error(`Missing ${wire} credential file for ${operation}`);
    if (options.mode === 'fake') {
      if (!options.fakeHandler) throw new Error('Fake NAVER bindings need an in-process handler');
      return { ...base, mode: 'fake', handler: options.fakeHandler };
    }
    if (options.mode === 'virtual') {
      if (!options.privateTokenFile) throw new Error('Persona NAVER bindings need the workload token file');
      const persona = { ...base, mode: 'virtual' as const, origin: options.virtualOrigin, privateTokenFile: options.privateTokenFile };
      return credential ? { ...persona, credentialFile: credential.credentialFile!, authorize: credential.authorize } : persona;
    }
    // Live: W only, official origin, A6 approval per request. P/O live stays refused (no verified partner).
    if (spec.grade !== 'W' || !spec.origin || !options.approve) throw new Error(`Live binding unavailable for ${operation}`);
    if (spec.auth === 'oauth-header') {
      return { ...base, mode: 'live', origin: spec.origin, allowedOrigins: [spec.origin], approve: options.approve,
        credentialFile: '', authorize: () => ({}) } as NaverBinding;
    }
    return { ...base, mode: 'live', origin: spec.origin, allowedOrigins: [spec.origin], approve: options.approve,
      credentialFile: credential!.credentialFile!, authorize: credential!.authorize };
  });
}

export type NaverTransport = ReturnType<typeof createNaverTransport>;

/** One store's marketing NAVER port context. */
export interface Provider {
  transport: NaverTransport;
  storeId: string;
  /** Strict field allowlist on responses (persona and fake). Live W tolerates added official fields. */
  strict: boolean;
}

export function createMarketingProvider(options: MarketingBindingOptions & {
  fetcher?: typeof fetch; readCredential?: (path: string) => string; fakeOnly?: boolean;
}): Provider {
  const transport = createNaverTransport({
    bindings: marketingBindings(options), fakeOnly: options.fakeOnly, fetcher: options.fetcher, readCredential: options.readCredential,
  });
  return { transport, storeId: options.storeId, strict: options.mode !== 'live' };
}
