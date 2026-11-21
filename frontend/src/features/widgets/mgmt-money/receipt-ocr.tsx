import { useLayoutEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type { Locale } from '../../../contracts';
import { ActionButton, Icon, StatusBadge } from '../../../ui';
import { postMedia } from '../../assistant/media/media-request';
import type { T } from './shared';
import './receipt-ocr.css';

type Recognized<TValue> = { readonly value: TValue; readonly needsReview: boolean } | null;
interface ReceiptProposal {
  readonly requestId: string;
  readonly merchant: Recognized<string>;
  readonly date: Recognized<string>;
  readonly totalWon: Recognized<number>;
  readonly items: readonly {
    readonly name: Recognized<string>;
    readonly quantity: Recognized<number>;
    readonly amountWon: Recognized<number>;
  }[];
}
export type ReceiptField = 'merchant' | 'date' | 'amount' | 'memo';
const MAX_PHOTO_BYTES = 5_000_000;

const receiptCopy = {
  ko: { scan: '영수증 찍기', pick: '사진 고르기', reading: '영수증을 읽고 있어요', proposal: '읽은 내용이에요. 확인하고 저장해 주세요', review: '확인해 주세요', error: '영수증을 읽지 못했어요. 직접 입력해 주세요', retry: '다시 시도하기', retake: '다시 찍기' },
  en: { scan: 'Scan receipt', pick: 'Choose a photo', reading: 'Reading the receipt', proposal: 'Please check and save', review: 'Please check', error: "Couldn't read it. Enter it yourself", retry: 'Try again', retake: 'Scan again' },
  'zh-Hans': { scan: '拍收据', pick: '选择照片', reading: '正在识别收据', proposal: '请核对后保存', review: '请核对', error: '无法识别，请手动输入', retry: '重试', retake: '重新拍摄' },
  'zh-Hant': { scan: '拍收據', pick: '選擇照片', reading: '正在辨識收據', proposal: '請核對後儲存', review: '請核對', error: '無法辨識，請手動輸入', retry: '重試', retake: '重新拍攝' },
} satisfies Record<Locale, Record<string, string>>;

function needsReview(field: Recognized<unknown>) {
  return !field || field.needsReview;
}

function receiptFormValues(proposal: ReceiptProposal, t: T) {
  const items = proposal.items.map(item => [
    item.name?.value,
    item.quantity?.value,
    item.amountWon === null ? null : t.format.money(item.amountWon.value, 'full'),
  ].filter(value => value != null).join(' · ')).filter(Boolean).join(', ');
  return {
    date: proposal.date?.value ?? null,
    amount: proposal.totalWon?.value ?? null,
    merchant: proposal.merchant?.value ?? '',
    memo: items,
    review: {
      date: needsReview(proposal.date),
      amount: needsReview(proposal.totalWon),
      merchant: needsReview(proposal.merchant),
      memo: !items || proposal.items.some(item => needsReview(item.name) || needsReview(item.quantity) || needsReview(item.amountWon)),
    } satisfies Record<ReceiptField, boolean>,
  };
}

export function ReceiptReviewField({ review, locale, children }: { review?: boolean; locale: Locale; children: (hint?: string) => ReactNode }) {
  const hint = review ? receiptCopy[locale].review : undefined;
  return <div className="receipt-ocr-field" data-review={review || undefined}>
    {children(hint)}
    {hint && <span className="receipt-ocr-field__badge" aria-hidden="true"><StatusBadge kind="needsReview" label={hint} /></span>}
  </div>;
}

export function ReceiptScanEntry({ t, onRecognized }: { t: T; onRecognized: (values: ReturnType<typeof receiptFormValues>) => void }) {
  const words = receiptCopy[t.locale];
  const [status, setStatus] = useState<'idle' | 'reading' | 'proposal' | 'error'>('idle');
  const request = useRef<AbortController | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => () => request.current?.abort(), []);

  async function scan(event: ChangeEvent<HTMLInputElement>) {
    const field = event.currentTarget;
    const photo = field.files?.[0];
    field.value = '';
    if (!photo || request.current) return;
    if ((photo.type !== 'image/jpeg' && photo.type !== 'image/png') || photo.size === 0 || photo.size > MAX_PHOTO_BYTES) {
      setStatus('error');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setStatus('reading');
    try {
      const proposal = await postMedia<ReceiptProposal>('receipt-ocr', photo, controller.signal);
      controller.signal.throwIfAborted();
      onRecognized(receiptFormValues(proposal, t));
      setStatus('proposal');
    } catch {
      if (!controller.signal.aborted) setStatus('error');
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  return <div className="receipt-ocr">
    {status === 'idle' || status === 'reading' ? <div className="receipt-ocr__actions">
      <ActionButton variant="secondary" className="receipt-ocr__scan" onClick={() => camera.current?.click()} loading={status === 'reading'}>
        <Icon name="receipt" />{words.scan}
      </ActionButton>
      <ActionButton variant="secondary" className="receipt-ocr__picker" onClick={() => picker.current?.click()} disabled={status === 'reading'}>{words.pick}</ActionButton>
    </div> : null}
    <input ref={camera} type="file" accept="image/jpeg,image/png" capture="environment" hidden onChange={event => void scan(event)} />
    <input ref={picker} type="file" accept="image/jpeg,image/png" hidden onChange={event => void scan(event)} />
    {status === 'reading' && <p className="receipt-ocr__band" role="status">{words.reading}</p>}
    {status === 'proposal' && <div className="receipt-ocr__band" data-state="proposal">
      <p role="status">{words.proposal}</p>
      <ActionButton variant="ghost" className="receipt-ocr__retry" onClick={() => camera.current?.click()}>{words.retake}</ActionButton>
      <ActionButton variant="ghost" className="receipt-ocr__retry receipt-ocr__picker" onClick={() => picker.current?.click()}>{words.pick}</ActionButton>
    </div>}
    {status === 'error' && <div className="receipt-ocr__band" data-state="error">
      <p role="alert"><Icon name="warning" />{words.error}</p>
      <ActionButton variant="secondary" className="receipt-ocr__retry" onClick={() => camera.current?.click()}>{words.retry}</ActionButton>
      <ActionButton variant="secondary" className="receipt-ocr__retry receipt-ocr__picker" onClick={() => picker.current?.click()}>{words.pick}</ActionButton>
    </div>}
  </div>;
}
