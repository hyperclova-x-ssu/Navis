import { usePublicationText } from '../mgmt-products/menu-publication-text';
import { useState, type ReactNode } from 'react';
import type { CommerceOption, CommerceStockInput, CommerceStockView } from '../../../../../backend/services/inventory/reality/03/commerce-routes';
import type { PortTransport } from '../../../data/reality/00/port';
import { commerceStockPath } from '../../../data/reality/03/commerce-stock';
import { usePublication } from '../../../data/reality/01/use-publication';
import { useBundle, type MessageBundle } from '../../../i18n';
import { ActionButton, NumberField } from '../../../ui';
import { PublicationCard, PublicationChanges, PublicationReadState } from '../mgmt-products/menu-publication-card';

const bundle: MessageBundle<string> = {
  id: 'gap-inv.commerce',
  ko: { action: '스마트스토어 재고 바꾸기', online: '온라인', option: '옵션', note: '매장 재고는 그대로예요 · 가격과 판매 여부는 바꾸지 않아요', saved: '온라인 재고를 저장했어요', unavailable: '바꿀 수 있는 옵션이 없어요' },
  en: { action: 'Change Smart Store stock', online: 'Online stock', option: 'Option', note: 'Store stock, price and selling status stay the same.', saved: 'Online stock saved.', unavailable: 'No options are available to update.' },
  'zh-Hans': { action: '更改 Smart Store 库存', online: '线上库存', option: '选项', note: '门店库存、价格和销售状态保持不变。', saved: '线上库存已保存。', unavailable: '没有可更新的选项。' },
  'zh-Hant': { action: '變更 Smart Store 庫存', online: '線上庫存', option: '選項', note: '門市庫存、價格與銷售狀態維持不變。', saved: '線上庫存已儲存。', unavailable: '沒有可更新的選項。' },
};
type StockView = { originProductNo: number; current: CommerceOption; stockQuantity: number };

export function CommerceStock({ transport, itemId, unlinked, onSaved }: {
  transport: PortTransport; itemId: string; unlinked: ReactNode; onSaved(): void;
}) {
  const { t, locale } = useBundle(bundle);
  const cardText = usePublicationText();
  const flow = usePublication<CommerceStockInput, StockView, CommerceStockView, { receiptId: string }>(
    transport, { path: commerceStockPath(itemId), operation: 'commerce.stock.set', resourceId: itemId },
  );
  const [editing, setEditing] = useState(false);
  const [optionId, setOptionId] = useState<number>();
  const [quantity, setQuantity] = useState<number | null>();
  const current = flow.data;
  const view = flow.attempt?.diff;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const saved = flow.confirmedPreview;
  const confirmed = saved && current?.options.some(option => option.id === saved.current.id && option.stockQuantity === saved.stockQuantity);
  if (flow.readError === 'COMMERCE_ITEM_NOT_LINKED') return unlinked;
  if (!current) return <PublicationReadState failed={!!flow.readError} retry={() => void flow.reload()} />;

  const options = current.options.filter(option => option.usable);
  const option = options.find(option => option.id === optionId) ?? options[0];
  const nextQuantity = quantity === undefined ? option?.stockQuantity : quantity;
  return <section aria-label={t('online')}>
    {flow.readError ? <PublicationReadState failed retry={() => void flow.reload()} /> : <p>{t('online')} {number(current.stockQuantity)}</p>}
    {!editing && options.length > 0 && <ActionButton type="button" variant="secondary" disabled={!!flow.readError} onClick={() => setEditing(true)}>{t('action')}</ActionButton>}
    {options.length === 0 && <p>{t('unavailable')}</p>}
    {editing && option && !flow.attempt && !flow.readError && <>
      <label className="ui-field">{t('option')}
        <select className="ui-text-input" value={option.id} disabled={flow.pending}
          onChange={event => { setOptionId(Number(event.target.value)); setQuantity(undefined); }}>
          {options.map(option => <option value={option.id} key={option.id}>{option.name}</option>)}
        </select>
      </label>
      <NumberField label={t('online')} min={0} max={99_999_999} step={1} value={nextQuantity ?? null} disabled={flow.pending} onValueChange={setQuantity} />
      <ActionButton type="button" variant="secondary" disabled={flow.pending || !Number.isSafeInteger(nextQuantity) || (nextQuantity ?? -1) < 0 || (nextQuantity ?? 0) > 99_999_999}
        onClick={() => { if (typeof nextQuantity === 'number') flow.preview({ optionId: option.id, stockQuantity: nextQuantity }); }}>{cardText('preview')}</ActionButton>
    </>}
    <PublicationCard flow={{ ...flow, confirm: extra => flow.confirm(extra, onSaved) }} label={t('action')}>
      {view && <>
        <PublicationChanges changes={[{ label: view.current.name, before: number(view.current.stockQuantity), after: number(view.stockQuantity) }]} />
        <p>{t('note')}</p>
      </>}
    </PublicationCard>
    {saved && !flow.pending && !flow.readError && <p role={confirmed ? 'status' : 'alert'}>{confirmed ? t('saved') : cardText('uncertain')}</p>}
  </section>;
}
