import type { Pool } from 'pg';
import { calendarDate, placePath, validHours } from '../../../../packages/naver/contracts/pn01/wire.ts';
import { createNaverTransport } from '../../../../packages/naver/transport/index.ts';
import { readSecret } from '../../../../packages/db/index.ts';
import { json, ownerRequest } from '../../../account/naver/wire.ts';
import { inStore } from '../../transaction.ts';
import { ownerHeaders, type Actor } from '../14/clients.ts';
import { readCoupons } from '../14/records.ts';
import { addDays, storeClock } from '../14/wire.ts';
import type { Owner } from './ports.ts';
import { NoticeError } from './wire.ts';

type DraftInput = { inquiry: string; facts: string[] };
type DraftOwner = Owner & { timezone: string; dayStart: string };
export type TalkTalkDraftPorts = {
  facts(scope: DraftOwner): Promise<string[]>;
  draft(input: DraftInput): Promise<string>;
};

const dayNames: Record<string, string> = {
  mon: '월요일', tue: '화요일', wed: '수요일', thu: '목요일', fri: '금요일', sat: '토요일', sun: '일요일',
};
const wallTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const clean = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 120) : '';
const won = new Intl.NumberFormat('ko-KR');

function privateOrigin(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href !== `${url.origin}/`) {
    throw new Error('Invalid private origin');
  }
  return url;
}

function ownerRead(url: string | undefined, tokenFile: string | undefined, service: string) {
  const base = url && tokenFile && privateOrigin(url);
  const token = base && tokenFile && readSecret(tokenFile);
  return async <T>(scope: Actor, path: string): Promise<T | undefined> => {
    if (!base || !token) return;
    const response = await fetch(new URL(`/internal/v1/${service}/stores/${scope.storeId}${path}`, base), {
      headers: ownerHeaders(token, scope), redirect: 'error', signal: AbortSignal.timeout(2200),
    });
    if (!response.ok) { await response.body?.cancel(); return; }
    return response.json() as Promise<T>;
  };
}

type Page<T> = { items: T[] };
type Closure = { date: string; storeClosure: { endDate: string } | null };
type Menu = { name: string; price: number; saleStatus: string };

export function createTalkTalkDraftPorts(pool: Pool, env: NodeJS.ProcessEnv, now = () => new Date()): TalkTalkDraftPorts | undefined {
  const { NAVIS_TALKTALK_DRAFT_URL: draftUrl, NAVIS_TALKTALK_DRAFT_TOKEN_FILE: draftTokenFile,
    NAVIS_NAVER_VIRTUAL_ORIGIN: naverOrigin, NAVIS_NAVER_VIRTUAL_STORE_ID: naverStore,
    NAVIS_NAVER_VIRTUAL_ACCOUNT_ID: naverAccount, NAVIS_NAVER_VIRTUAL_TOKEN_FILE: naverToken } = env;
  if (!draftUrl || !draftTokenFile) return;
  const endpoint = new URL('/internal/v1/replies/talktalk-draft', privateOrigin(draftUrl));
  const token = readSecret(draftTokenFile);
  const inventory = ownerRead(env.NAVIS_MARKETING_INVENTORY_URL, env.NAVIS_MARKETING_INVENTORY_TOKEN_FILE, 'inventory');
  const customer = ownerRead(env.NAVIS_MARKETING_CUSTOMER_URL, env.NAVIS_MARKETING_CUSTOMER_READ_TOKEN_FILE, 'customer');
  const place = naverOrigin && naverToken && naverStore && naverAccount ? createNaverTransport({
    bindings: [{ operation: 'pn01.hours.read', grade: 'O', method: 'GET', route: /^\/partner-assumed\/v1\/place\/hours$/u,
      storeId: naverStore, providerAccount: naverAccount, origin: naverOrigin, privateTokenFile: naverToken, mode: 'virtual', timeoutMs: 2200 }],
  }) : undefined;
  async function readHours(scope: Owner) {
    if (!place || scope.storeId !== naverStore) return;
    const wire = await json(ownerRequest(place, scope)('pn01.hours.read', `${placePath}/hours`));
    if (validHours(wire)) return wire;
  }

  return {
    async facts(scope) {
      const at = now();
      const clock = storeClock(at, scope.timezone, scope.dayStart);
      const [hours, closures, venue, menu, booking, coupons] = await Promise.all([
        readHours(scope).catch(() => undefined),
        customer<Page<Closure>>(scope, `/calendar/events?closuresOnly=true&startDate=${clock.date}&endDate=${addDays(clock.date, 30)}&limit=100`).catch(() => undefined),
        inventory<{ address: string }>(scope, '/place/venue').catch(() => undefined),
        inventory<Page<Menu>>(scope, '/menu?limit=100').catch(() => undefined),
        customer<Page<{ name: string }>>(scope, '/booking-products?limit=20').catch(() => undefined),
        inStore(pool, scope.storeId, db => readCoupons({ ...scope, db, now: at, clock }, { status: 'active', cursor: null, limit: 20 })),
      ]);
      const sentences: string[] = [];
      for (const item of closures?.items ?? []) {
        const end = item.storeClosure?.endDate;
        if (!calendarDate(item.date) || !calendarDate(end)) continue;
        sentences.push(item.date === end ? `${end}에는 매장이 쉬어갑니다.` : `${item.date}부터 ${end}까지 매장이 쉬어갑니다.`);
      }
      for (const item of hours?.holidayHours ?? []) {
        if (!calendarDate(item.date) || item.date < clock.date) continue;
        if ('closed' in item) sentences.push(`${item.date}에는 매장이 쉬어갑니다.`);
        else if (wallTime.test(item.open) && wallTime.test(item.close)) sentences.push(`${item.date} 영업시간은 ${item.open}~${item.close}입니다.`);
      }
      for (const item of hours?.businessHours ?? []) {
        if (Object.hasOwn(dayNames, item.day) && wallTime.test(item.open) && wallTime.test(item.close)) {
          sentences.push(`${dayNames[item.day]} 영업시간은 ${item.open}~${item.close}입니다.`);
        }
      }
      const address = clean(venue?.address);
      if (address) sentences.push(`매장 주소는 ${address}입니다.`);
      for (const item of menu?.items ?? []) {
        const name = clean(item.name);
        if (name && item.saleStatus === 'selling' && Number.isSafeInteger(item.price) && item.price > 0) {
          sentences.push(`${name} 가격은 ${won.format(item.price)}원입니다.`);
        }
      }
      for (const item of booking?.items ?? []) {
        const name = clean(item.name);
        if (name) sentences.push(`예약 상품은 ${name}입니다.`);
      }
      for (const item of coupons.items) {
        const code = item.codes.find(row => row.route !== 'sms' && row.activated && !row.unpublishedAt && row.remaining > 0
          && (row.issuedTerms?.endsOn ?? item.endsOn) >= clock.businessDate);
        const name = clean(item.name);
        if (!code || !name || item.startsOn > clock.businessDate) continue;
        const { benefitType, benefitValue, endsOn } = code.issuedTerms ?? item;
        const benefit = benefitType === 'percent' ? `${benefitValue}% 할인` : benefitType === 'amount' ? `${won.format(benefitValue)}원 할인`
          : benefitType === 'set_price' ? `세트 가격 ${won.format(benefitValue)}원` : clean(item.originRef.menuName) + ' 무료 제공';
        sentences.push(`진행 중인 쿠폰 ${name}의 혜택은 ${benefit}이며 ${endsOn}까지 사용하실 수 있습니다.`);
      }
      return [...new Set(sentences)].slice(0, 140);
    },
    async draft(input) {
      if (!input.facts.length) throw new NoticeError(422, 'DRAFT_UNGROUNDED');
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(9000) });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 422) throw new NoticeError(422, 'DRAFT_UNGROUNDED');
        throw new NoticeError(503, 'PROVIDER_UNAVAILABLE');
      }
      const result = await response.json() as { text?: unknown };
      if (typeof result.text !== 'string' || !result.text.trim() || [...result.text].length > 360) throw new NoticeError(422, 'DRAFT_UNGROUNDED');
      return result.text;
    },
  };
}
