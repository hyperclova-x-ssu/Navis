import { useRef, useState, type ReactNode } from 'react';
import type { DetailRef } from '../../../contracts';
import { TODAY } from '../../../data/widget-data';
import { useI18n } from '../../../i18n';
import { ActionButton, ChipChoice, StatusChip } from '../../../ui';
import { memberMoneyCopy as copy } from '../mgmt-customers/iteration7-member-messages';
import { useMemberMoney } from './context';
import { creditCopy, money } from './copy';
import type { CreditPort, MemberPass, MemberReturnContext, PassProduct } from './types';
import './credit.css';

function ProductTerms({ product }: { readonly product: PassProduct }) {
  const n = product.kind === 'count' ? product.totalUses : product.validDays;
  const unit = n && n > 0 ? Math.floor(product.price / n) : null;
  const last = unit !== null && n ? product.price - unit * (n - 1) : null;
  return <p>{product.kind === 'count' ? copy.count : copy.period} · {money(product.price)} · {product.kind === 'count' ? `${product.totalUses ?? '—'}회 · ` : ''}{product.validDays}일
    {unit !== null && <> · {product.kind === 'count' ? '1회 값' : '하루'} {money(unit)} · {product.kind === 'count' ? '마지막 회차' : `${product.validDays}일째`} {money(last!)}</>}
  </p>;
}

function PassCard({ pass, port, detailRef }: { readonly pass: MemberPass; readonly port: CreditPort; readonly detailRef: DetailRef }) {
  const t = useI18n();
  const sale = useRef<HTMLButtonElement>(null), use = useRef<HTMLButtonElement>(null);
  const context = (returnFocusRef: MemberReturnContext['returnFocusRef']): MemberReturnContext => ({ detailRef, selectedId: pass.memberId, returnFocusRef });
  const canUse = pass.status === 'active' && (pass.kind === 'period' || (pass.usesRemaining ?? 0) > 0);
  const status = { active: '이용 중', expired: copy.expiry, refunded: copy.refund, exhausted: '모두 사용', canceled: '취소' }[pass.status];
  return <div className="credit-pass credit-stack" role="group" aria-label={pass.productLabel}>
    <p>{pass.productLabel} <StatusChip>{pass.kind === 'count' ? copy.count : copy.period}</StatusChip> <StatusChip>{status}</StatusChip></p>
    <ProductTerms product={{ productId: pass.membershipId, label: pass.productLabel, kind: pass.kind, price: pass.soldPrice, totalUses: pass.totalUses, validDays: pass.validDays }} />
    <p>{pass.kind === 'count' ? `남은 횟수 ${pass.usesRemaining ?? '—'}회 · ` : ''}{t.format.date(pass.startsOn, 'short')} ~ {t.format.date(pass.endsOn, 'short')}</p>
    <p>회원권 이용분 {money(pass.recognizedValue)} · 남은 몫 {money(pass.unrecognizedValue)}{pass.refundedValue > 0 && <> · {copy.refund} {money(pass.refundedValue)}</>}</p>
    <div className="credit-actions"><ActionButton ref={use} variant="secondary" disabled={!canUse} onClick={() => port.openMembershipUse(pass.memberId, pass.membershipId, context(use))}>{copy.use}</ActionButton><ActionButton ref={sale} variant="ghost" disabled={!pass.saleSettlementId} onClick={() => port.openOriginalTransaction({ settlementId: pass.saleSettlementId, membershipId: pass.membershipId }, context(sale))}>{copy.original}</ActionButton></div>
    <ul className="credit-history">{pass.uses.map(entry => <PassUse key={entry.useId} entry={entry} pass={pass} port={port} detailRef={detailRef} />)}</ul>
  </div>;
}
function PassUse({ entry, pass, port, detailRef }: { readonly entry: MemberPass['uses'][number]; readonly pass: MemberPass; readonly port: CreditPort; readonly detailRef: DetailRef }) {
  const ref = useRef<HTMLButtonElement>(null), t = useI18n();
  return <li><span>{t.format.dateTime(entry.usedAt, { today: TODAY })}{entry.canceledAt ? ' · 사용 취소됨' : ''}</span><ActionButton ref={ref} variant="ghost" onClick={() => port.openOriginalTransaction({ useId: entry.useId, membershipId: pass.membershipId, settlementId: entry.settlementId, sourceRef: entry.sourceRef ?? { kind: 'membership_use', id: entry.useId } }, { detailRef, selectedId: pass.memberId, returnFocusRef: ref })}>원거래 보기</ActionButton></li>;
}

/** Controlled extension for the existing member side panel. Never writes balances or pass uses. */
export function MemberMoneySection({ memberId, detailRef, fallback }: { readonly memberId: string; readonly detailRef: DetailRef; readonly fallback?: ReactNode }) {
  const binding = useMemberMoney();
  const [saleOpen, setSaleOpen] = useState(false), [productId, setProductId] = useState('');
  const chargeRef = useRef<HTMLButtonElement>(null), debtRef = useRef<HTMLButtonElement>(null), saleRef = useRef<HTMLButtonElement>(null);
  const member = binding?.view.status === 'ready' ? binding.view.model.members.find(row => row.memberId === memberId) : null;
  const products = binding?.products.filter(product => product.kind === 'count' || product.kind === 'period') ?? [];
  const selected = products.find(product => product.productId === productId);
  const passes = binding?.memberships.filter(pass => pass.memberId === memberId) ?? [];
  const context = (returnFocusRef: MemberReturnContext['returnFocusRef']): MemberReturnContext => ({ detailRef, selectedId: memberId, returnFocusRef });
  return <div className="credit-stack" role="group" aria-label="회원 충전금·외상·회원권" lang="ko">
    <h4>{copy.accounts}</h4>
    {member && binding ? <><div className="credit-actions"><ActionButton ref={chargeRef} variant="secondary" onClick={() => binding.port.openAccounts(memberId, context(chargeRef))}>{copy.charge} {money(member.chargeBalance)}</ActionButton><ActionButton ref={debtRef} variant="secondary" onClick={() => binding.port.openAccounts(memberId, context(debtRef))}>{copy.debt} {money(member.receivableBalance)}</ActionButton></div><p>유효기간 없음</p></> : <p role="status">{binding?.view.status === 'empty' ? creditCopy.empty : creditCopy.error}</p>}
    <h4>회원권</h4>
    {binding ? passes.length ? passes.map(pass => <PassCard key={pass.membershipId} pass={pass} port={binding.port} detailRef={detailRef} />) : <p>{copy.noPass}</p> : fallback}
    <ActionButton variant="secondary" aria-expanded={saleOpen} onClick={() => setSaleOpen(!saleOpen)}>{copy.sale}</ActionButton>
    {saleOpen && member && binding && <div className="credit-stack"><ChipChoice label={copy.choose} value={productId} onChange={setProductId} options={products.map(product => ({ value: product.productId, label: `${product.label} · ${money(product.price)}` }))} />{selected && <ProductTerms product={selected} />}<ActionButton ref={saleRef} disabled={!selected} onClick={() => { if (selected) binding.port.openSettlement({ purpose: 'membership_sale', memberId, productId: selected.productId }, context(saleRef)); }}>결제 받기</ActionButton></div>}
  </div>;
}
