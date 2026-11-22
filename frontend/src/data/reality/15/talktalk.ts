import { useEffect, useRef, useState } from 'react';
import type { DataCommand } from '../../commands/types';
import { seedCatalog } from '../../db/cafe-fixtures';
import { TODAY } from '../../db/time';
import type { DataSnapshot, DataText } from '../../db/types';
import { benefitName } from '../../marketing/benefit';
import type { BenefitType } from '../../marketing/types';
import { useRealPort } from '../../react';
import { STORE_WEEKDAYS, storeHoursOn, storeHoursSummary } from '../../store-hours';
import { PortError, type RealPort } from '../00';
import { couponPath, type CouponDto, type CouponTermsDto } from '../14/dto';

type CouponOption = { id: string; name: DataText; benefit: DataText; endsOn: string; code: string };
type TalkTalkPreview = { readonly text: string; readonly facts: readonly string[] };
type Terms = Pick<CouponTermsDto, 'benefitType' | 'benefitValue' | 'endsOn'>;
const days = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];
const benefit = (type: BenefitType, value: number): DataText => type === 'free_item' ? { key: 'data.marketing.benefit.freeShot' }
  : benefitName({ kind: type === 'set_price' ? 'setPrice' : type, value });
const previewFromFact = (fact: string): TalkTalkPreview => ({ text: `안녕하세요.\n${fact}\n감사합니다.`, facts: [fact] });

export function exampleTalkTalkDraft(inquiry: string, snapshot: DataSnapshot, label: (value: DataText) => string) {
  const day = days.findIndex(name => inquiry.includes(name));
  if (day >= 0 && /열|문|영업|오픈|마감/u.test(inquiry)) return previewFromFact(`${days[day]} 영업시간은 ${storeHoursOn(STORE_WEEKDAYS[day]!)}입니다.`);
  if (!/\d|휴무|오늘|내일|연휴/u.test(inquiry) && /영업시간|몇 시에 열|오픈 시간/u.test(inquiry)) return previewFromFact(`영업시간은 ${storeHoursSummary()}입니다.`);
  if (/주소|위치|어디에/u.test(inquiry)) return previewFromFact(`매장 주소는 ${seedCatalog.store.address}입니다.`);
  if (/가격|얼마/u.test(inquiry)) {
    const item = snapshot.tables.menuItem.find(row => !row.deletedAt && row.saleStatus !== 'sold_out' && inquiry.includes(label(row.name ?? { key: row.nameKey })));
    if (item) return previewFromFact(`${label(item.name ?? { key: item.nameKey })} 가격은 ${item.price.toLocaleString('ko-KR')}원입니다.`);
  }
}

function option(id: string, name: DataText, code: string, { benefitType, benefitValue, endsOn }: Terms): CouponOption {
  return { id, name, code, endsOn, benefit: benefit(benefitType, benefitValue) };
}

export function exampleReplyCoupons({ tables: { marketing } }: DataSnapshot) {
  return marketing.coupon.flatMap(row => {
    if (row.status !== 'active' || row.startsOn > TODAY || row.endsOn < TODAY) return [];
    const code = marketing.couponCode.find(code => code.couponId === row.couponId && code.activatedAt && !code.unpublishedAt && code.route !== 'sms'
      && (code.issuedTerms?.endsOn ?? row.endsOn) >= TODAY && code.issueCount > (marketing.couponRedemptionAgg.find(agg => agg.codeId === code.codeId)?.used ?? 0));
    return code ? [option(row.couponId, row.name, code.code, code.issuedTerms ?? row)] : [];
  });
}

function currentCoupons(rows: readonly CouponDto[], today: string) {
  return rows.flatMap(row => {
    if (row.status !== 'active' || row.startsOn > today || row.endsOn < today) return [];
    const code = row.codes.find((code: CouponDto['codes'][number] & { remaining?: number }) => code.route !== 'sms' && code.activated && !code.unpublishedAt
      && (code.remaining ?? code.issueCount - code.used) > 0 && (code.issuedTerms?.endsOn ?? row.endsOn) >= today);
    return code ? [option(row.couponId, { raw: row.name }, code.code, code.issuedTerms ?? row)] : [];
  });
}

export function validTalkTalkDraft(draft: TalkTalkPreview | undefined): draft is TalkTalkPreview {
  if (!draft || typeof draft.text !== 'string' || !draft.text.trim() || [...draft.text].length > 360
    || !Array.isArray(draft.facts) || !draft.facts.length) return false;
  const lines = draft.text.split('\n');
  return draft.facts.every(fact => typeof fact === 'string' && lines.includes(fact));
}

export function readTalkTalkDraft(port: RealPort, threadId: string, signal: AbortSignal) {
  return port.transport.request<TalkTalkPreview>({ method: 'POST',
    path: `/marketing/inquiries/${encodeURIComponent(threadId)}/navis-draft-preview`, body: {}, signal });
}

export async function readReplyCoupons(port: RealPort, signal?: AbortSignal) {
  const read = { resource: 'coupons', path: couponPath, query: { status: 'active', limit: 200 } };
  const first = await port.reads.page<CouponDto>(read, { signal }) as { items: readonly CouponDto[]; nextCursor: string | null; businessDate?: string };
  if (!first.businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(first.businessDate)) throw new Error('Missing coupon business date');
  const listed = first.nextCursor ? await port.reads.all<CouponDto>(read, { signal }) : { items: first.items, complete: true };
  if (!listed.complete) throw new Error('Incomplete coupon list');
  return currentCoupons(listed.items, first.businessDate);
}

export function talkTalkReplyCommand(threadId: string, revision: number, body?: string, previewVariant?: string): Extract<DataCommand, { type: 'inquiry.send' }> {
  return { type: 'inquiry.send', threadId, idempotencyKey: `talktalk-reply:${threadId}:${revision}`,
    ...(body !== undefined && { body }), ...(previewVariant !== undefined && { previewVariant }) };
}

export function useTalkTalkDraft(threadId: string | null, example: boolean) {
  const port = useRealPort();
  const active = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ungrounded' | 'unavailable'>('idle');
  useEffect(() => () => active.current?.abort(), [threadId]);
  async function request(offline: () => TalkTalkPreview | undefined) {
    if (!threadId || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setStatus('loading');
    try {
      const result = example ? offline() : port && await readTalkTalkDraft(port, threadId, controller.signal);
      if (controller.signal.aborted) return;
      if (!result && example) { setStatus('ungrounded'); return; }
      if (!validTalkTalkDraft(result)) {
        setStatus('unavailable');
        return;
      }
      setStatus('idle');
      return result;
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof PortError && error.reason === 'DRAFT_UNGROUNDED' ? 'ungrounded' : 'unavailable');
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  return { status, request };
}

export function useReplyCoupons(open: boolean, example: boolean) {
  const port = useRealPort();
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; rows: CouponOption[] }>({ status: 'loading', rows: [] });
  useEffect(() => {
    if (!open || example || !port) return;
    const controller = new AbortController();
    const fetchCoupons = async () => {
      try {
        const rows = await readReplyCoupons(port, controller.signal);
        if (!controller.signal.aborted) setState({ status: 'ready', rows });
      } catch {
        if (!controller.signal.aborted) setState({ status: 'error', rows: [] });
      }
    };
    void fetchCoupons();
    return () => controller.abort();
  }, [open, example, port]);
  return { ...state, reset: () => setState({ status: 'loading', rows: [] }) };
}
