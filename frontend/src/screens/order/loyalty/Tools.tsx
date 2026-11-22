import { formatMaskedCustomer } from '../../../data/customer-display';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PosMemberRead, PosLoyaltyCommand, PosLoyaltyQuote, PosReadSnapshot, PosResult, PosCommandValue } from '../../../contracts/pos';
import type { ListPage } from '../../../data/reality/00/port';
import { projectMemberChoice } from '../../../data/reality/02/checkout-view';
import type { PosMemberChoice } from '../../../data/reality/02/dto';
import type { PosRemote } from '../../../data/reality/02/remote';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { dataBundles, resolveDataText } from '../../../data/widget-data';
import { findPosMembers, selectPosDiscountOptions, buildSplitPlan } from '../../../pos/loyalty';
import { ActionButton, InlineEmpty, NumberField, PosMoney, QuantityStepper, SegmentedControl, Spinner, TextField, formatPosMoney } from '../../../ui';
import { loyaltyBundle } from '../messages';

export function usePayText() { return useBundle(loyaltyBundle, posBundle, ...dataBundles); }
export const payName = (t:ReturnType<typeof usePayText>['t'], value:PosMemberRead['name']) => typeof value==='string'?value:resolveDataText(t,value);
export type LoyaltyInput = PosLoyaltyCommand extends infer C ? C extends PosLoyaltyCommand ? Omit<C, 'meta' | 'billId'> : never : never;
export type PayCommand = (input: LoyaltyInput) => PosResult<PosCommandValue>;
export function MemberSearch({ read, execute, onApplied, source }: {
  read: PosReadSnapshot; execute: PayCommand; onApplied: () => void;
  source?: { remote: PosRemote; onSelect: (member: PosMemberChoice) => void; onRegister?: () => void };
}) {
  const { t } = usePayText(), [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; page?: ListPage<PosMemberChoice> }>();
  const input = useRef<HTMLInputElement>(null);
  const key = JSON.stringify([query, cursor, reload]);
  const remote = source?.remote;
  useEffect(() => {
    if (!remote) return;
    const request = new AbortController();
    const search = query.trim(), digits = search.replace(/\D/g, '');
    void remote.members(/^[\d\s()+-]+$/.test(search) ? digits.slice(-4) : search, cursor, request.signal).then(
      page => { if (!request.signal.aborted) setLoaded({ key, page }); },
      () => { if (!request.signal.aborted) setLoaded({ key }); },
    );
    return () => request.abort();
  }, [remote, query, cursor, key]);
  const local = !source && query ? findPosMembers(read, { phoneSuffix: query }) : null;
  const current = loaded?.key === key ? loaded : undefined;
  const rows = source ? current?.page?.items.map(projectMemberChoice).map(member => ({
    id: member.memberId, label: `${member.name} · ${member.phoneMasked}`, select: () => { source.onSelect(member); onApplied(); },
  })) : local?.ok ? local.rows.map(member => ({
    id: member.memberId, label: `${formatMaskedCustomer(payName(t, member.name), member.memberId, member.memberCode)} · ${member.phone} · ${t(`pay.${member.grade}`)}`,
    select: () => { if (execute({ type: 'bill.member', memberId: member.memberId }).ok) onApplied(); },
  })) : undefined;
  return <div className="pay-tools__stack"><TextField inputRef={input} type={source ? 'search' : 'text'} name={source ? 'member-search' : 'member-phone-suffix'} label={source ? '이름 또는 전화번호 끝 네 자리' : t('pay.phoneSuffix')} value={query} onValueChange={value => { setQuery(source ? value.slice(0, 80) : value); setCursor(undefined); }} inputMode={source ? 'text' : 'numeric'} error={local && !local.ok ? t('pay.phoneInvalid') : undefined}/>
    {rows?.length ? <ul className="pay-tools__list">{rows.map(member => <li key={member.id}><ActionButton variant="secondary" onClick={member.select}>{member.label}</ActionButton></li>)}</ul> : rows ? <InlineEmpty title={t('pay.memberEmpty')}/> : null}
    {source && (!current ? <p role="status"><Spinner/> 회원을 불러오는 중이에요</p> : !current.page ? <div role="alert"><p>회원을 불러오지 못했어요</p><ActionButton variant="secondary" onClick={() => setReload(value => value + 1)}>다시 불러오기</ActionButton></div> : null)}
    {cursor && <ActionButton variant="secondary" onClick={() => setCursor(undefined)}>첫 페이지</ActionButton>}
    {current?.page?.nextCursor && <ActionButton variant="secondary" onClick={() => setCursor(current.page?.nextCursor ?? undefined)}>다음 페이지</ActionButton>}
    {source?.onRegister && <ActionButton variant="secondary" onClick={source.onRegister}>회원 등록</ActionButton>}
  </div>;
}

export function DiscountTools({ read, quote, execute, onApplied, onFindMember, remoteCoupon }: { read: PosReadSnapshot; quote: PosLoyaltyQuote; execute: PayCommand; onApplied: () => void; onFindMember:()=>void; remoteCoupon?: ReactNode }) {
  const { t } = usePayText(), [unit, setUnit] = useState<'won'|'percent'>('won'), [amount, setAmount] = useState<number|null>(null), [memo, setMemo] = useState('');
  const options = selectPosDiscountOptions(read, quote.billId), direct = quote.discounts.find(d => d.source === 'direct');
  const apply = (input: LoyaltyInput) => { if (execute(input).ok) onApplied(); };
  const weekdays = ['sun','mon','tue','wed','thu','fri','sat'];
  const reason = (code: string, coupon?: typeof options.coupons[number]) => {
    if (code === 'COUPON_HOURS') return t('pay.hours', { hours: coupon?.validHours?.map(h => t('pay.hourRange', { day:t(`pay.${weekdays[h.weekday]}`),start:h.startHour,end:h.endHour })).join(' · ') ?? '' });
    if (code === 'COUPON_MENU_REQUIRED') return t('pay.menuRequired', { name:read.data.catalog.items.find(i => i.menuId === coupon?.targetMenuId)?.name ?? '' });
    return t(({ MEMBER_REQUIRED:'pay.memberRequired',COUPON_MEMBER_REQUIRED:'pay.couponMember',COUPON_ENDED:'pay.couponEnded',COUPON_CODE_INACTIVE:'pay.couponInactive',COUPON_EXHAUSTED:'pay.couponExhausted',COUPON_SHOT_REQUIRED:'pay.shotRequired',PASS_MORNING_ONLY:'pay.morning',PASS_DAILY_LIMIT:'pay.usedToday',PASS_MENU_REQUIRED:'pay.passMenu',PASS_INACTIVE:'pay.passInactive' } as Record<string,string>)[code] ?? 'pay.couponInactive');
  };
  if (remoteCoupon) return <div className="pay-tools__stack"><section><h3>{t('pay.coupon')}</h3>{remoteCoupon}</section></div>;
  return <div className="pay-tools__stack">
    <section><h3>{t('pay.direct')}</h3>{direct ? <div className="pay-tools__row"><PosMoney amount={direct.amount}/><ActionButton variant="ghost" onClick={() => apply({ type:'bill.removeDiscount',discountId:direct.discountId })}>{t('pay.removeDiscount',{name:t('pay.direct')})}</ActionButton></div> : <div className="pay-tools__stack">
      <SegmentedControl label={t('pay.direct')} value={unit} onChange={setUnit} options={[{value:'won',label:t('pay.won')},{value:'percent',label:'%'}]}/>
      <NumberField label={t('pay.direct')} value={amount} onValueChange={setAmount} min={1} max={unit==='percent'?100:undefined} unit={unit==='percent'?'%':t('pay.won')}/>
      <TextField label={t('pay.memo')} value={memo} onValueChange={setMemo}/>
      <ActionButton onClick={() => apply({ type:'bill.setDiscount',discountInput:{source:'direct',...(unit==='percent'?{percent:amount??0}:{amount:amount??0}),memo} })}>{t('pay.applyDiscount')}</ActionButton>
    </div>}</section>
    <section><h3>{t('pay.coupon')}</h3>{quote.discounts.some(d => d.source==='coupon') ? <div className="pay-tools__row"><PosMoney amount={quote.discounts.find(d=>d.source==='coupon')!.amount}/><ActionButton variant="ghost" onClick={() => apply({type:'bill.removeDiscount',discountId:quote.discounts.find(d=>d.source==='coupon')!.discountId})}>{t('pay.removeDiscount',{name:t('pay.coupon')})}</ActionButton></div> : options.coupons.length ? <ul className="pay-tools__list">{options.coupons.map(c => <li key={c.couponId} data-unavailable={!c.available || undefined}><ActionButton variant="secondary" disabled={!c.available} aria-describedby={!c.available?`coupon-${c.couponId}`:undefined} onClick={() => apply({type:'bill.setDiscount',discountInput:{source:'coupon',couponId:c.couponId}})}>{payName(t,c.name)}</ActionButton>{c.available ? <PosMoney amount={c.amount} sign="minus"/> : <p id={`coupon-${c.couponId}`} className="pay-tools__reason">{reason(c.reason,c)}</p>}</li>)}</ul> : <InlineEmpty title={t('pay.noCoupons')}/>}</section>
    <section><h3>{t('pay.membership')}</h3>{options.memberRequired ? <div><p>{t('pay.memberRequired')}</p><ActionButton variant="secondary" onClick={onFindMember}>{t('pay.memberSearch')}</ActionButton></div> : quote.discounts.some(d=>d.source==='membership') ? <div className="pay-tools__row"><PosMoney amount={quote.discounts.find(d=>d.source==='membership')!.amount}/><ActionButton variant="ghost" onClick={() => apply({type:'bill.removeDiscount',discountId:quote.discounts.find(d=>d.source==='membership')!.discountId})}>{t('pay.removeDiscount',{name:t('pay.membership')})}</ActionButton></div> : options.passes.length ? <ul className="pay-tools__list">{options.passes.map(p => <li key={p.membershipId}><div className="pay-tools__row"><span>{t('pay.remainingUses',{name:t(p.nameKey),n:p.usesLeft??'—'})}</span><ActionButton variant="secondary" disabled={!p.available} aria-describedby={!p.available?`pass-${p.membershipId}`:undefined} onClick={() => apply({type:'bill.setDiscount',discountInput:{source:'membership',membershipId:p.membershipId}})}>{t('pay.useOnce')}</ActionButton></div>{!p.available ? <p id={`pass-${p.membershipId}`} className="pay-tools__reason">{reason(p.reason)}</p> : null}</li>)}</ul> : <InlineEmpty title={t('pay.noPasses')}/>}</section>
  </div>;
}

export function SplitTools({ quote, execute, onApplied }: { quote: PosLoyaltyQuote; execute: PayCommand; onApplied: () => void }) {
  const { t } = usePayText(), [kind,setKind] = useState<'equal'|'items'>('equal'), [n,setN] = useState(2);
  const [quantities,setQuantities] = useState<Record<string,number>>({});
  const input = kind==='equal' ? {kind,n} as const : {kind,parts:Array.from({length:n},(_,part)=>({lineQtyAllocations:quote.lines.flatMap(line=>{const qty=quantities[`${part}:${line.lineId}`]??0;return qty>0?[{allocationId:line.lineId,qty}]:[];})}))} as const;
  const preview = buildSplitPlan(quote,input);
  return <div className="pay-tools__stack"><SegmentedControl label={t('pay.split')} value={kind} onChange={setKind} options={[{value:'equal',label:t('pay.equal')},{value:'items',label:t('pay.items')}]}/>
    <QuantityStepper label={t('pay.people')} value={n} onChange={setN} min={2} max={10} unit={t('pay.personUnit')}/>
    {kind==='items' ? <div className="pay-tools__stack">{quote.lines.map(line => <section key={line.lineId}><h3>{line.name} · {line.qty}</h3>{Array.from({length:n},(_,part)=><QuantityStepper key={part} label={`${line.name} ${t('pay.shareNumber',{n:part+1})}`} value={quantities[`${part}:${line.lineId}`]??0} min={0} max={line.qty} onChange={qty=>setQuantities({...quantities,[`${part}:${line.lineId}`]:qty})}/>)}</section>)}</div> : null}
    {preview.ok ? <ul className="pay-tools__list">{preview.plan.parts.map((p,i)=><li key={p.partId}>{t('pay.share',{n:i+1,amount:formatPosMoney(p.amount)})}</li>)}</ul> : <p className="pay-tools__reason">{t('pay.quantityInvalid')}</p>}
    <ActionButton size="primary" disabled={!preview.ok} onClick={()=>{if(execute({type:'bill.split',...input}).ok)onApplied();}}>{t('pay.divide')}</ActionButton>
  </div>;
}
