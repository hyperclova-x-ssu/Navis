import { SupplyDetailSession } from './detail-session';
/**
 * 거래처 (F-38, SCR-30·31): deliveries due within 7 days (one per order, partial orders stay while something
 * remains), deliveries to check, undated and past orders; an order detail (`view:'order'`, itemId = order id)
 * with contact, lines, ‘입고 기록’ (QuantityStepper 1…remaining, key made when the form opens, button disabled
 * the moment it is pressed, applied once) and ‘예정일 바꾸기’ (the calendar delivery moves with it, AC-232).
 */
import { useState } from 'react';
import { OrderWorkspace, useOrderText } from './order-grid';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useRealPort, useWidgetDataStore, useWidgetView } from '../../../data/react';
import { widgetDomains } from '../../../data/reality/00';
import { supplierDetailEntry } from '../../assistant/domains/suppliers';
import { deriveOpenOrders, type OrderRow, type SuppliersModel } from '../../../data/widget-data';
import { ActionButton, Icon, MetricFit, Spinner, StatusBadge } from '../../../ui';
import { Flash, relativeDay, stateTone, SupplyPanelState, useFit, useSupplyText, SupplySurface, useTextScale, type SupplyText , supplyQuantity } from './shared';

import { OrderMiniTable, OrderPanelSummary, TALL_MINI_ROWS } from './mini-tables';
import { AddSupplier } from './purchase-grid';

const ID = 'suppliers' as const;

type DeliveryOrder = ReturnType<typeof deriveOpenOrders>['orders'][number];

export const whenText = (x: SupplyText, o: OrderRow) => `${relativeDay(x, o.dueDate)}${o.expectedTime ? ` ${x.format.time(o.expectedTime)}` : ''}`;

function useSupplierRetry(host: WidgetPanelProps['host']) {
  const port = useRealPort();
  return () => {
    if (!port || port.mode('purchase') !== 'http') { host.resetPreview(); return; }
    for (const domain of widgetDomains(ID)) {
      const state = port.state(domain);
      if (state.mode === 'http' && (state.status === 'error' || state.status === 'stale' || !state.complete)) void port.retry(domain);
    }
  };
}

/* ───────── Panel ───────── */

function SuppliersKey({ x, m, editing, shape, note }: { x: SupplyText; m: Pick<SuppliersModel, 'upcomingCount' | 'overdueCount'>; editing: boolean; shape: string; note?: string }) {
  return <div className="ms-k">
    <div className="ms-k__value" data-slot={`${ID}.metric.value`}><Flash value={m.upcomingCount}><MetricFit value={x.format.number(m.upcomingCount)} unit={x.t('widget.suppliers.incomingUnit', { count: m.upcomingCount })} longest="99" stacked={false} /></Flash></div>
    <p className="ms-label" data-slot={`${ID}.metric.label`}>{x.t('widget.suppliers.incoming')}</p>
    {note ? <p className="ms-caption" role="status">{x.tk(note)}</p> : null}
    {m.overdueCount > 0 && !(editing && shape === 'Q') ? <div className="ms-sub" data-slot={`${ID}.metric.secondary`} data-drop={900}><StatusBadge kind="needsReview" label={x.t('widget.suppliers.overdue', { count: m.overdueCount })} /></div> : null}
  </div>;
}

function DeliveryRows({ x, orders, mode, hiddenRows, offset = 0 }: { x: SupplyText; orders: readonly OrderRow[]; mode: 'compact' | 'quantity'; hiddenRows: number; offset?: number }) {
  return <ul className="ms-rows">
    {(orders as readonly DeliveryOrder[]).map((o, i) => {
      const line = o.lines.find(l => l.remaining > 0) ?? o.lines[0];
      if (!line) return null;
      const item = x.text(line.itemName ?? {key: line.itemNameKey});
      const text = mode === 'compact'
        ? x.t('widget.suppliers.deliveryRowCompact', { date: relativeDay(x, o.dueDate), item, supplier: x.text(o.supplierName ?? {key: o.supplierNameKey}) })
        : x.t('widget.suppliers.deliveryRowQuantity', { date: relativeDay(x, o.dueDate), item, quantity: supplyQuantity(x, line.remaining, line.unit) });
      return <li key={o.poId} className="ms-row" data-row="" data-drop={500 + offset + i} data-row-id={o.poId} data-slot={`${ID}.list.row`}>
        <span className="ms-row__name"><Flash value={text}>{text}</Flash></span>
        {o.overdue ? <span className="ms-mark">{x.t('widget.suppliers.group.overdue')}</span> : null}
      </li>;
    })}
    <li className="ms-row ms-row--more" data-more="" hidden>{x.t('common.moreItems', { n: hiddenRows })}</li>
  </ul>;
}

function SuppliersPanelContent({ condition, width, height, shape, editing, host }: WidgetPanelProps) {
  const view = useWidgetView(ID, condition);
  const retry = useSupplierRetry(host);
  const x = useSupplyText();
  const scale = useTextScale();
  const { ref, hiddenRows } = useFit<HTMLDivElement>([view, width, height, scale, x.locale, editing]);
  if (view.status !== 'ready') {
    if (view.messageKey === 'data.real.loading') return <div ref={ref} className="ms-panel" data-shape={shape} data-widget={ID}><span role="status"><Spinner /> {x.locale === 'ko' ? '발주를 불러오는 중이에요' : x.tk(view.messageKey)}</span></div>;
    const action = view.status === 'error' ? { label: x.t('common.retry'), run: retry }
      : view.actionKey ? { label: x.tk(view.actionKey), run: () => { host.resetPreview(); host.openDetail({ featureId: ID, view: 'register', focus: 'action' }); } } : null;
    const overdue = view.status === 'empty' ? view.partial?.overdueCount ?? 0 : 0;
    return <div ref={ref} className="ms-panel" data-shape={shape} data-widget={ID} data-state={view.status}><SupplyPanelState featureId={ID} tone={stateTone(view.status)} shape={shape} message={view.status === 'error' && x.locale === 'ko' ? '발주를 불러오지 못했어요' : x.tk(view.messageKey)} actionLabel={action?.label} onAction={action?.run}>
      {overdue > 0 ? <p className="ms-sup-state-note">{x.t('widget.suppliers.overdue', { count: overdue })}</p> : null}
    </SupplyPanelState></div>;
  }
  const m = view.model;
  const note = view.notes?.find(note => note.messageKey.startsWith('data.real.'))?.messageKey;
  const undated = (m.orders as readonly DeliveryOrder[]).filter(order => order.open && !order.dueDate);
  const key = <><SuppliersKey x={x} m={{ ...m, overdueCount: m.overdueCount + undated.length }} editing={editing} shape={shape} note={note} />
    {!m.upcomingCount && <p className="ms-caption" data-drop={900}>{x.tk('data.state.suppliers.no-upcoming')}</p>}
  </>;
  const upcoming = [...m.upcoming,...m.overdue,...undated];
  if (shape === 'Q') return <div ref={ref} className="ms-panel" data-shape="Q" data-widget={ID}>{key}</div>;
  if (shape === 'W') return <div ref={ref} className="ms-panel" data-shape="W" data-wide={width>=3||undefined} data-widget={ID}>{key}<div className="ms-aside">{upcoming.length > 0 && <DeliveryRows x={x} orders={upcoming.slice(0, width >= 3 ? width : 2)} mode="compact" hiddenRows={hiddenRows} />}</div></div>;
  // UI-SMALL-3: a list title stands only over rows; with nothing due the panel keeps the key and the summary.
  const tallRows=height>=3?upcoming.slice(0,4):[...m.upcoming,...undated].slice(0,3);
  if (shape === 'T') return <div ref={ref} className="ms-panel" data-shape="T" data-widget={ID}>{key}<hr className="ms-rule" /><div className="ms-list">
    {tallRows.length>0?<p className="ms-list__title" data-slot={`${ID}.list.title`} data-drop={150}>{x.t('widget.suppliers.listTitle')}</p>:null}
    <DeliveryRows x={x} orders={tallRows} mode="quantity" hiddenRows={hiddenRows} />
  </div></div>;
  if(width>=3)return <div ref={ref} className="ms-panel" data-shape={shape} data-mini="true" data-widget={ID}>{key}<OrderMiniTable limit={height>=3?TALL_MINI_ROWS:undefined}/><p className="ms-caption" data-more="" hidden>{x.t('common.moreItems',{n:hiddenRows})}</p><OrderPanelSummary model={m}/></div>;
  return <div ref={ref} className="ms-panel" data-shape={shape} data-mini="false" data-widget={ID}>{key}<div className="ms-list">{upcoming.length>0?<p className="ms-list__title" data-drop={150}>{x.t('widget.suppliers.listTitle')}</p>:null}<DeliveryRows x={x} orders={upcoming.slice(0,shape==='S'?3:4)} mode="quantity" hiddenRows={hiddenRows}/></div><OrderPanelSummary model={m}/></div>;
}

function useSuppliersSummary({ condition }: { condition: WidgetPanelProps['condition'] }): string {
  const view = useWidgetView(ID, condition);
  const x = useSupplyText();
  if (view.status === 'error') return x.tk(view.messageKey);
  if (view.status === 'empty') {
    const overdue = view.partial?.overdueCount ?? 0;
    return overdue > 0 ? x.t('widget.suppliers.summaryOverdue', { summary: x.tk(view.messageKey), overdue }) : x.tk(view.messageKey);
  }
  const summary = x.t('widget.suppliers.summary', { count: view.model.upcomingCount });
  return view.model.overdueCount > 0 ? x.t('widget.suppliers.summaryOverdue', { summary, overdue: view.model.overdueCount }) : summary;
}

/* ───────── Detail ───────── */

function SuppliersDetailContent({ condition, detailRef, host }: WidgetDetailProps) {
  const view = useWidgetView(ID, condition);
  const x = useSupplyText();
  const store = useWidgetDataStore();
  const retry = useSupplierRetry(host);
  const entry = supplierDetailEntry(detailRef, store.getSnapshot());
  const [register, setRegister] = useState(entry.supplierForm);
  const [addOrder, setAddOrder] = useState(false);
  const { t: ot } = useOrderText();
  if (view.status !== 'ready') {
    if (view.messageKey === 'data.real.loading') return <div className="ms-detail ms-sup" data-widget={ID}><p role="status"><Spinner /> {x.locale === 'ko' ? '발주를 불러오는 중이에요' : x.tk(view.messageKey)}</p></div>;
    const isError = view.status === 'error';
    const overdue = view.status === 'empty' ? view.partial?.overdueCount ?? 0 : 0;
    return <div className="ms-detail ms-sup" data-widget={ID}>
      <div className="ms-detail-state" data-tone={stateTone(view.status)} data-slot={`${ID}.state.message`}>
        <Icon name={isError ? 'error' : 'info'} /><p role={isError ? 'alert' : undefined}>{isError && x.locale === 'ko' ? '발주를 불러오지 못했어요' : x.tk(view.messageKey)}</p>
        {overdue > 0 ? <StatusBadge kind="needsReview" label={x.t('widget.suppliers.overdue', { count: overdue })} /> : null}
        {isError ? <ActionButton variant="outline" onClick={retry}>{x.t('common.retry')}</ActionButton>
          : view.actionKey && !register ? <ActionButton variant="secondary" onClick={() => {host.resetPreview(); setRegister(true);}}>{x.tk(view.actionKey)}</ActionButton>
          : !view.actionKey ? <ActionButton variant="secondary" onClick={() => {host.resetPreview(); setAddOrder(true);}}>{ot('supply.order.add')}</ActionButton> : null}
      </div>
      {!isError && view.actionKey && register ? <AddSupplier host={host} onClose={() => setRegister(false)} /> : null}
    </div>;
  }
  const notes = view.notes?.filter(note => note.messageKey.startsWith('data.real.')) ?? [];
  return <div className="ms-detail ms-sup" data-widget={ID}>
    {notes.length ? <div><p role="status">{notes.map(note => x.tk(note.messageKey)).join(' · ')}</p><ActionButton variant="outline" onClick={retry}>{x.t('common.retry')}</ActionButton></div> : null}
    <OrderWorkspace model={view.model} host={host} initialTab={entry.tab} initialOrder={entry.orderId} initialPurchaseItem={entry.purchaseItemId} initialSupplier={entry.supplierId} initialSupplierAdd={register} initialOrderAdd={addOrder} initialOrderForm={entry.orderForm}/>
  </div>;
}

function SuppliersPanel(props:WidgetPanelProps){return <SupplySurface featureId={ID} scope="dashboard"><SuppliersPanelContent {...props}/></SupplySurface>;}
function SuppliersDetail(props:WidgetDetailProps){return <SupplyDetailSession><SupplySurface featureId={ID} scope="detail"><SuppliersDetailContent {...props}/></SupplySurface></SupplyDetailSession>;}

export const suppliersWidget: WidgetModule = { id: ID, Panel: SuppliersPanel, Detail: SuppliersDetail, useSummary: useSuppliersSummary };
