import { useState } from 'react';
import { addDays } from '../../../data/db/time';
import type { NaverCouponIntent, PlaceCouponWrite, PromotionReward } from '../../../data/reality/14/naver';
import { ActionButton, Checkbox, ChipChoice, DateField, NumberField, TextField } from '../../../ui';
import { audienceNames, couponTypeNames } from './coupon-status.naver-labels';

const benefitKindNames = { amount: '금액 할인', percent: '정률 할인', gift: '증정' } as const;

const choices = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map(value => ({ value, label: labels[value] }));

type EditorProps = { readonly today: string; readonly onPreview: (intent: NaverCouponIntent) => void };

export function NaverPlaceForm({ today, onPreview }: EditorProps) {
  const [type, setType] = useState<PlaceCouponWrite['type']>('place');
  const [audience, setAudience] = useState<PlaceCouponWrite['audience']>('all');
  const [kind, setKind] = useState<PlaceCouponWrite['benefit']['type']>('amount');
  const [name, setName] = useState(''), [conditions, setConditions] = useState(''), [item, setItem] = useState('');
  const [value, setValue] = useState<number | null>(null), [quantity, setQuantity] = useState<number | null>(null);
  const [from, setFrom] = useState<string | null>(null), [to, setTo] = useState<string | null>(null);
  const hasPeriod = audience !== 'marketing-message';
  const maxBenefit = kind === 'percent' ? 100 : Number.MAX_SAFE_INTEGER;
  const review = () => {
    const benefit = kind === 'gift' ? { type: kind, item: item.trim() } as const : { type: kind, value: value! } as const;
    onPreview({ operation: 'place.create', command: { type, name: name.trim(), audience, benefit,
      ...(hasPeriod && from && to ? { displayPeriod: { from, to } } : {}),
      ...(hasPeriod && quantity !== null ? { quantity } : {}), ...(conditions.trim() ? { conditions: conditions.trim() } : {}),
    } });
  };
  const invalidBenefit = kind === 'gift' ? !item.trim() : value === null || value <= 0 || value > maxBenefit
    || kind === 'amount' && !Number.isSafeInteger(value);
  const invalidPeriod = !!from !== !!to || !!from && !!to && (from < today || from > to);
  const invalidQuantity = quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 1);
  const invalid = !name.trim() || invalidBenefit || (hasPeriod && (invalidPeriod || invalidQuantity));
  return <div className="mkt-benefit">
    <TextField label="쿠폰 이름" name="naver-coupon-name" value={name} onValueChange={setName} />
    <ChipChoice label="매장 쿠폰 종류" value={type} options={choices(couponTypeNames)} onChange={setType} />
    <ChipChoice label="받는 사람" value={audience} options={choices(audienceNames)} onChange={setAudience} />
    <ChipChoice label="쿠폰 혜택" value={kind} options={choices(benefitKindNames)} onChange={setKind} />
    {kind === 'gift' ? <TextField label="증정품" name="naver-coupon-gift" value={item} onValueChange={setItem} />
      : <NumberField label={benefitKindNames[kind]} name="naver-coupon-benefit" value={value} onValueChange={setValue}
        min={kind === 'percent' ? 0 : 1} max={maxBenefit} step={kind === 'percent' ? 0.1 : 1} unit={kind === 'percent' ? '%' : '원'} />}
    {hasPeriod ? <>
      <DateField label="표시 시작일" today={today} min={today} value={from} onValueChange={setFrom} clearable />
      <DateField label="표시 종료일" today={today} min={from ?? today} value={to} onValueChange={setTo} clearable />
      <NumberField label="발급 수량" name="naver-coupon-quantity" hint="비워 두면 수량을 정하지 않아요" value={quantity} onValueChange={setQuantity} min={1} />
    </> : null}
    <TextField label="사용 조건" name="naver-coupon-conditions" value={conditions} onValueChange={setConditions} />
    <ActionButton disabled={invalid} onClick={review}>만들 내용 확인하기</ActionButton>
  </div>;
}

type RewardDraft = { readonly id: number; readonly count: number | null; readonly name: string; readonly days: number | null;
  readonly combine: boolean; readonly standalone: boolean; readonly note: string };
const newReward = (id: number): RewardDraft => ({ id, count: 1, name: '', days: 30, combine: false, standalone: true, note: '' });

export function NaverPromotionForm({ today, onPreview }: EditorProps) {
  const [name, setName] = useState(''), [instructions, setInstructions] = useState('');
  const [from, setFrom] = useState<string | null>(null), [to, setTo] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null), [rewards, setRewards] = useState([newReward(1)]);
  const minStart = addDays(today, 1);
  const patch = (id: number, changes: Partial<RewardDraft>) => setRewards(rows => rows.map(row => row.id === id ? { ...row, ...changes } : row));
  const validInstruction = (value: string, max: number) => !value.trim() || value.trim().length >= 5 && value.trim().length <= max;
  const invalid = name.trim().length < 2 || name.trim().length > 20 || !from || !to || from < minStart || from > to
    || !Number.isInteger(amount) || amount! < 1_000 || amount! > 99_999_999 || !validInstruction(instructions, 500)
    || rewards.some(row => row.name.trim().length < 2 || row.name.trim().length > 18 || !Number.isInteger(row.count) || row.count! < 1 || row.count! > 10
      || !Number.isInteger(row.days) || row.days! < 30 || row.days! > 999 || !validInstruction(row.note, 100));
  const review = () => {
    const coupons = rewards.map((row): PromotionReward => ({ stampCount: row.count!, name: row.name.trim(), validDays: row.days!,
      canCombine: row.combine, canUseAlone: row.standalone, ...(row.note.trim() ? { instructions: row.note.trim() } : {}),
    }));
    onPreview({ operation: 'promotion.create', command: { name: name.trim(), from: from!, to: to!, orderAmountPerStamp: amount!, coupons,
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    } });
  };
  return <div className="mkt-benefit">
    <TextField label="프로모션 이름" name="naver-promotion-name" value={name} onValueChange={setName} />
    <DateField label="시작일" today={today} value={from} onValueChange={setFrom} min={minStart} />
    <DateField label="종료일" today={today} value={to} onValueChange={setTo} min={from ?? minStart} />
    <NumberField label="스탬프당 주문 금액" name="naver-promotion-spend" value={amount} onValueChange={setAmount} min={1_000} max={99_999_999} unit="원" />
    {rewards.map((row, index) => <fieldset key={row.id} className="mkt-benefit">
      <legend>발급 쿠폰 {index + 1}</legend>
      <TextField label="쿠폰 이름" name={`naver-promotion-coupon-${row.id}`} value={row.name} onValueChange={next => patch(row.id, { name: next })} />
      <NumberField label="필요 스탬프" name={`naver-promotion-stamps-${row.id}`} value={row.count} min={1} max={10} onValueChange={next => patch(row.id, { count: next })} />
      <NumberField label="유효 일수" name={`naver-promotion-days-${row.id}`} value={row.days} min={30} max={999} onValueChange={next => patch(row.id, { days: next })} />
      <Checkbox checked={row.combine} label="다른 쿠폰과 함께 사용" onCheckedChange={next => patch(row.id, { combine: next })} />
      <Checkbox checked={row.standalone} label="단독으로 사용" onCheckedChange={next => patch(row.id, { standalone: next })} />
      <TextField label="쿠폰 사용 안내" name={`naver-promotion-note-${row.id}`} value={row.note} onValueChange={next => patch(row.id, { note: next })} />
      {rewards.length > 1 ? <ActionButton variant="secondary" onClick={() => setRewards(rows => rows.filter(value => value.id !== row.id))}>이 쿠폰 초안 빼기</ActionButton> : null}
    </fieldset>)}
    <ActionButton variant="secondary" disabled={rewards.length >= 10} onClick={() => setRewards(rows => [...rows, newReward(rows.at(-1)!.id + 1)])}>발급 쿠폰 추가</ActionButton>
    <TextField label="프로모션 안내" name="naver-promotion-instructions" value={instructions} onValueChange={setInstructions} />
    <ActionButton disabled={invalid} onClick={review}>만들 내용 확인하기</ActionButton>
  </div>;
}
