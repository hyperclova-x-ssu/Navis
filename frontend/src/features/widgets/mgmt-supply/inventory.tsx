import { SupplyDetailSession } from './detail-session';
/**
 * 재고관리 (F-36, SCR-30·31·32, D-54 merged with stock-sync): ingredients to restock first, products for sale
 * (store + online) after; the 1×1 number counts ingredients only (Q-24). The sell-today croissant row is shown
 * apart (‘당일 소진 · 오늘까지’) and never counts in restock or in the 248 products (SCREENS 8.13).
 * The nearest delivery opens the supplier order (‘출처 열기’ → suppliers `view:'order'`).
 */
import { useState } from 'react';
import { ProductGrid, StockGrid, NewItem, useStockText } from './stock-grid';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetView } from '../../../data/react';
import type { IngredientRow, InventoryModel } from '../../../data/widget-data';
import { ActionButton, DetailTabs, Icon, InlineForm, MetricFit, PanelState, SplitBar, StatusBadge, StatusChip, TextField } from '../../../ui';
import { Flash, notifySample, relativeDay, stateTone, SupplyPanelState, useFit, useSupplyText, SupplySurface, useTextScale, useViewMemory, WarnLine, type SupplyText } from './shared';

import { orderedStock, StockMiniTable } from './mini-tables';
import { inventoryDetailEntry } from '../../assistant/domains/inventory';

const ID = 'inventory-booking' as const;
type Tab = 'ingredients' | 'products';

const qty = (x: SupplyText, value: number | null, unit: IngredientRow['unit']) => (value === null ? '—' : x.format.quantity(value, unit));
/** ‘확인된 품목 중 보충 필요 0개’: values are missing and nothing confirmed needs restocking (DS 11.5). */
const partialZero = (m: InventoryModel) => m.reviewCount > 0 && m.restockCount === 0;


export function deliveryText(x: SupplyText, row: IngredientRow): string | null {
  const d = row.nextDelivery;
  if (!d) return null;
  return x.t('widget.inventory-booking.nextDelivery', { when: relativeDay(x, d.date), qty: x.format.quantity(d.remaining.value, d.remaining.unit), supplier: x.tk(d.supplierNameKey) });
}

/* ───────── Panel ───────── */

function InventoryKey({ x, m, editing, shape }: { x: SupplyText; m: InventoryModel; editing: boolean; shape: WidgetPanelProps['shape'] }) {
  const showS = !(editing && shape === 'Q');
  if (partialZero(m)) {
    return <div className="ms-inventory-state" data-slot={`${ID}.state.message`}>
      <PanelState tone="warning" shape={shape} message={x.t('widget.inventory-booking.partialZero')} shortMessage={x.t('widget.inventory-booking.partialZeroShort')}>
        <div data-drop={1}><StatusChip compact tone="warning"><span lang={x.locale}>{x.t('widget.inventory-booking.itemNeedsReview')}</span></StatusChip></div>
      </PanelState>
    </div>;
  }
  return <div className="ms-k">
    <div className="ms-k__value" data-slot={`${ID}.metric.value`}><Flash value={m.restockCount}><MetricFit value={x.format.number(m.restockCount)} unit={x.t('widget.inventory-booking.restockUnit', { count: m.restockCount })} longest="99" stacked={false} /></Flash></div>
    <p className="ms-label" data-slot={`${ID}.metric.label`}>{x.t('widget.inventory-booking.restockNeeded')}</p>
    {showS && m.outOfStockCount > 0 ? <WarnLine slot={`${ID}.metric.secondary`}><Flash value={m.outOfStockCount}>{x.t('widget.inventory-booking.outOfStock', { count: m.outOfStockCount })}</Flash></WarnLine> : null}
    {showS && m.outOfStockCount === 0 && m.reviewCount > 0 ? <div className="ms-sub" data-drop={900}><StatusBadge kind="needsReview" label={x.t('widget.inventory-booking.itemNeedsReview')} /></div> : null}
    {showS && m.restockCount === 0 && m.reviewCount === 0 ? <p className="ms-sub" data-slot={`${ID}.metric.secondary`} data-drop={900}>{x.t('widget.inventory-booking.noRestock')}</p> : null}
  </div>;
}

function IngredientLine({ x, row, index, area, drop, status=false }: { x: SupplyText; row: IngredientRow; index: number; area?: string; drop?: number;status?:boolean }) {
  return <li className="ms-row" data-row="" data-drop={drop ?? 500 + index} data-row-id={row.itemId} data-slot={`${ID}.list.row`}>
    {area ? <span className="ms-row__area" data-drop={960}>{area}</span> : null}
    <span className="ms-row__name">{x.text(row.name??{key:row.nameKey})}{row.outOfStock ? <span className="ms-mark" data-tone="danger">{x.t('widget.inventory-booking.outBadge')}</span> : status&&row.needsRestock?<span className="ms-mark">{x.t('widget.inventory-booking.restockNeeded')}</span>:row.trackExpiry?<span className="ms-mark">{x.t('widget.inventory-booking.expiry.badge')}</span>:null}</span>
    <span className="ms-row__value"><Flash value={row.stock}>{qty(x, row.stock, row.unit)}</Flash>{row.threshold !== null ? <span className="ms-row__caption"><Flash value={row.threshold}>{x.t('widget.inventory-booking.thresholdShort', { threshold: x.format.quantity(row.threshold, row.unit) })}</Flash></span> : null}</span>
  </li>;
}

function ProductsLine({ x, m, area, drop }: { x: SupplyText; m: InventoryModel; area?: string; drop: number }) {
  const p = m.products;
  return <li className="ms-row" data-drop={drop} data-row-id="products" data-slot={`${ID}.list.row`}>
    {area ? <span className="ms-row__area" data-drop={960}>{area}</span> : <span className="ms-row__name">{x.t('common.inventoryTab.products')}</span>}
    {p.items.length === 0 ? <span className="ms-row__name">{x.t('data.state.inventory-booking.no-products')}</span>
      : <span className="ms-row__value"><Flash value={p.total}>{x.format.count(p.total, 'pcs')}</Flash><span className="ms-row__caption">{x.t('widget.inventory-booking.channelLine', { store: x.format.number(p.byChannel.store), online: x.format.number(p.byChannel.online) })}</span></span>}
  </li>;
}

function ProductsSplit({ x, m, drop=950 }: { x: SupplyText; m: InventoryModel;drop?:number }) {
  const p = m.products;
  // SCR-32: the products area gives way before the ingredients (the 1×1 number is always ingredients).
  if (p.items.length === 0) return <p className="ms-caption" data-drop={950}>{x.t('data.state.inventory-booking.no-products')}</p>;
  return <div className="ms-split" data-drop={drop}>
    <p className="ms-split__total">{x.t('widget.inventory-booking.productsTotal')} <Flash value={p.total}><strong>{x.format.count(p.total, 'pcs')}</strong></Flash></p>
    <SplitBar a={{ label: x.t('widget.inventory-booking.channel.store'), value: p.byChannel.store, display: x.format.count(p.byChannel.store, 'pcs') }} b={{ label: x.t('widget.inventory-booking.channel.online'), value: p.byChannel.online, display: x.format.count(p.byChannel.online, 'pcs') }} />
  </div>;
}

function InventoryPanelContent({ condition, width, height, shape, editing, host }: WidgetPanelProps) {
  const view = useWidgetView(ID, condition);
  const x = useSupplyText();
  const scale = useTextScale();
  const { ref, hiddenRows } = useFit<HTMLDivElement>([view, width, height, scale, x.locale, editing]);
  if (view.status !== 'ready') {
    const action = view.status === 'error' ? { label: x.t('common.retry'), run: () => host.resetPreview() }
      : view.actionKey ? { label: x.tk(view.actionKey), run: () => { host.resetPreview(); host.openDetail({ featureId: ID, view: 'register', focus: 'action' }); } } : null;
    return <div ref={ref} className="ms-panel" data-shape={shape} data-widget={ID} data-state={view.status}><SupplyPanelState featureId={ID} tone={stateTone(view.status)} shape={shape} message={x.tk(view.messageKey)} actionLabel={action?.label} onAction={action?.run} /></div>;
  }
  const m = view.model;
  const key = <InventoryKey x={x} m={m} editing={editing} shape={shape} />;
  const more = <li className="ms-row ms-row--more" data-more="" hidden>{x.t('common.moreItems', { n: hiddenRows })}</li>;
  const rows = orderedStock(m,x).filter(r=>r.trackRestock);
  if (shape === 'Q') return <div ref={ref} className="ms-panel" data-shape="Q" data-widget={ID}>{key}</div>;
  if (shape === 'W') return <div ref={ref} className="ms-panel" data-shape="W" data-widget={ID}>{key}<div className="ms-aside"><ul className="ms-rows" data-wide-rows={width>=3||undefined}>
    {rows.slice(0,width>=3?3:1).map((r,i)=><IngredientLine key={r.itemId} x={x} row={r} index={i} area={width===2&&i===0?x.t('common.inventoryTab.ingredients'):undefined}/>)}
    <ProductsLine x={x} m={m} drop={950}/>{more}
  </ul></div></div>;
  if (shape === 'T') return <div ref={ref} className="ms-panel" data-shape="T" data-widget={ID}>{key}<hr className="ms-rule"/><ul className="ms-rows">
    {rows.slice(0,height>=3?4:3).map((r,i)=><IngredientLine key={r.itemId} x={x} row={r} index={i}/>)}
    {height>=3?<ProductsLine x={x} m={m} drop={950}/>:null}{more}
  </ul></div>;
  const delivery=rows.map(r=>deliveryText(x,r)).find(Boolean);
  const split=<ProductsSplit x={x} m={m} drop={width>=3?400:950}/>;
  if(width>=3)return <div ref={ref} className="ms-panel" data-shape={shape} data-mini="true" data-widget={ID}>{key}<StockMiniTable model={m}/>{more}{split}</div>;
  return <div ref={ref} className="ms-panel" data-shape={shape} data-mini="false" data-widget={ID}>{key}<ul className="ms-rows">
    {(shape==='S'?rows.slice(0,3):orderedStock(m,x).slice(0,6)).map((r,i)=><IngredientLine key={r.itemId} x={x} row={r} index={i} status/>)}{more}
  </ul>{delivery?<p className="ms-caption" data-drop={920}>{delivery}</p>:null}{split}</div>;
}

function useInventorySummary({ condition }: { condition: WidgetPanelProps['condition'] }): string {
  const view = useWidgetView(ID, condition);
  const x = useSupplyText();
  if (view.status !== 'ready') return x.tk(view.messageKey);
  const m = view.model;
  if (partialZero(m)) return x.t('widget.inventory-booking.partialZero');
  const summary = x.t('widget.inventory-booking.summary', { count: m.restockCount });
  return m.outOfStockCount > 0 ? x.t('widget.inventory-booking.summaryOut', { summary, out: m.outOfStockCount }) : summary;
}

/* ───────── Detail ───────── */

function RegisterForm({ kind, onClose, host }: { kind: 'item' | 'product'; onClose: () => void; host: WidgetDetailProps['host'] }) {
  const x = useSupplyText();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  return <InlineForm title={kind === 'item' ? x.t('widget.inventory-booking.registerItem') : x.t('widget.inventory-booking.registerProduct')} onClose={onClose} saveLabel={x.t('common.saveAction')} closeLabel={x.t('common.close')}
    onSave={() => { if (!name.trim()) { setError(x.t('data.error.titleRequired')); return; } notifySample(host, x.t(kind === 'item' ? 'widget.inventory-booking.registered' : 'widget.inventory-booking.registeredProduct')); onClose(); }}>
    <TextField label={kind === 'item' ? x.t('widget.inventory-booking.form.itemName') : x.t('widget.inventory-booking.form.productName')} value={name} onValueChange={(v) => { setName(v); setError(undefined); }} error={error} name="register-name" />
    <p className="ms-caption">{x.t('widget.inventory-booking.sampleNote')}</p>
  </InlineForm>;
}

function InventoryDetailContent({ condition, detailRef, host }: WidgetDetailProps) {
  const view = useWidgetView(ID, condition);
  const x = useSupplyText();
  const {t}=useStockText();
  const entry = inventoryDetailEntry(detailRef, view.status === 'ready' ? view.model : undefined);
  const [tab, setTab] = useViewMemory<Tab>('inventory.tab', () => entry.tab);
  const [register, setRegister] = useState(entry.register);
  if (view.status !== 'ready') {
    const isError = view.status === 'error';
    return <div className="ms-detail ms-inv" data-widget={ID}>
      <div className="ms-detail-state" data-tone={stateTone(view.status)} data-slot={`${ID}.state.message`}>
        <Icon name={isError ? 'error' : 'info'} /><p role={isError ? 'alert' : undefined}>{x.tk(view.messageKey)}</p>
        {isError ? <ActionButton variant="outline" onClick={() => host.resetPreview()}>{x.t('common.retry')}</ActionButton>
          : view.actionKey && !register ? <ActionButton variant="secondary" onClick={() => {host.resetPreview(); setRegister(true);}}>{x.tk(view.actionKey)}</ActionButton>
          : !view.actionKey ? <ActionButton variant="secondary" onClick={() => host.resetPreview()}>{t('supply.stock.recheck')}</ActionButton> : null}
      </div>
      {!isError && view.actionKey && register ? <NewItem t={t} host={host} prefill={entry.prefill} onClose={()=>setRegister(false)}/> : null}
    </div>;
  }
  const m = view.model;
  return <div className="ms-detail ms-inv" data-widget={ID}>
    <DetailTabs label={x.tk('widget.inventory-booking.title')} value={tab} onValueChange={setTab}
      tabs={[{ value: 'ingredients', label: t('supply.stock.grid') }, { value: 'products', label: x.t('common.inventoryTab.products') }]}
      panels={{ ingredients: <StockGrid model={m} host={host} initialAdd={entry.register} initialItemId={entry.itemId} prefill={entry.prefill} />, products: <><ProductGrid model={m} host={host} onRegister={()=>setRegister(true)} />{register && !entry.register?<RegisterForm kind="product" host={host} onClose={()=>setRegister(false)}/>:null}</> }} />
  </div>;
}

function InventoryPanel(props:WidgetPanelProps){return <SupplySurface featureId={ID} scope="dashboard"><InventoryPanelContent {...props}/></SupplySurface>;}
function InventoryDetail(props:WidgetDetailProps){return <SupplyDetailSession><SupplySurface featureId={ID} scope="detail"><InventoryDetailContent {...props}/></SupplySurface></SupplyDetailSession>;}

export const inventoryWidget: WidgetModule = { id: ID, Panel: InventoryPanel, Detail: InventoryDetail, useSummary: useInventorySummary };
