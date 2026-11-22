import { readFileSync } from 'node:fs';
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TODAY, createWidgetDataStore, deriveOpenOrders, deriveSuggestions, readModel, selectCalendar, selectStockHistory } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { createVisibleSlotRegistry, VisibleSlotProvider } from '../../../ui';
import { inventoryWidget } from './inventory';
import { StockGrid } from './stock-grid';
import { Flash, SupplySurface, addIsoDays } from './shared';
import { calendarWidget } from './calendar';
import { suppliersWidget } from './suppliers';
import { createTestHost, DetailStack } from './testing';
import { BEANS, MILK, SAMPLE_EVENT, itemOf, pickDate, purchaseOf, shortDate, shortMilk, shortage, supplyWeek, withRetail, longDate } from './testing-cafe';
import { ValueHighlights } from '../../../app/value-highlights';
import { createRunStore } from '../../../state';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { timePolicy } from '../../../ui';

const supplyCss=readFileSync('src/features/widgets/mgmt-supply/mgmt-supply.css','utf8');
afterEach(cleanup);
// The cafe seed has 26 ingredients and 128 finished orders, so these screens take longer than the default 5 s on a busy machine.
vi.setConfig({testTimeout:60_000});
type Store=ReturnType<typeof createWidgetDataStore>;
const raw=(store:Store,itemId:string)=>(itemOf(store.getSnapshot().tables,itemId).name as {raw:string}).raw;
const model=(store:Store)=>readModel(store.getSnapshot(),'inventory-booking');
const ledgerName=(store:Store,itemId:string,date:string=TODAY)=>`${raw(store,itemId)} 재고 변동 기록 ${shortDate(date)}`;
const inventoryDetail=(store:Store,opts:Parameters<typeof renderWithKit>[1]={},events={})=>{
  const Detail=inventoryWidget.Detail!;
  return renderWithKit(<Detail featureId="inventory-booking" condition={{kind:'default'}} detailRef={{featureId:'inventory-booking'}} host={createTestHost('inventory-booking',events)} />,{...opts,store});
};
const suppliersDetail=(store:Store,opts:Parameters<typeof renderWithKit>[1]={},events={})=>{
  const Detail=suppliersWidget.Detail!;
  return renderWithKit(<Detail featureId="suppliers" condition={{kind:'default'}} detailRef={{featureId:'suppliers'}} host={createTestHost('suppliers',events)} />,{...opts,store});
};

it('재고 표에서 키보드로 수정하고 변동 기록과 되돌리기를 확인한다', () => {
  const store = createWidgetDataStore();
  const notify = vi.fn();
  const adjustments = store.getSnapshot().tables.stockAdjustment.length;
  inventoryDetail(store,{textScale:125,reducedMotion:true},{onNotify:notify});
  const grid = screen.getByRole('grid', {name:'재료'});
  const row = grid.querySelector(`[data-grid-row="${BEANS}"]`)!;
  const stock = within(row as HTMLElement).getByRole('gridcell', {name:/현재 재고/});
  fireEvent.keyDown(stock, {key:'Enter'});
  const input = within(row as HTMLElement).getByRole('textbox');
  // 5,688g counted → 7,688g: +2kg written as +2,000g
  fireEvent.change(input, {target:{value:'7688'}});
  fireEvent.keyDown(input, {key:'Enter'});
  expect(store.getSnapshot().tables.stockAdjustment.at(-1)?.deltaBase).toBe(2000);
  fireEvent.click(within(row as HTMLElement).getByRole('button', {name:/재고 변동 기록/}));
  expect(screen.getByRole('grid',{name:ledgerName(store,BEANS)}).querySelector('[data-grid-row^="adjust"]')).toHaveTextContent('+2,000g');
  const token = notify.mock.calls.at(-1)?.[0].undoToken;
  expect(token).toBeTruthy();
  expect(store.undo(token).ok).toBe(true);
  expect(store.getSnapshot().tables.stockAdjustment).toHaveLength(adjustments);
});

it('일정을 임의 날짜와 분류로 추가하고 분류를 꺼도 업무 원본은 유지한다', async () => {
  const store=createWidgetDataStore();
  const Detail=calendarWidget.Detail!;
  renderWithKit(<Detail featureId="calendar" condition={{kind:'default'}} detailRef={{featureId:'calendar'}} host={createTestHost('calendar')} />, {store, textScale:125, reducedMotion:true});
  fireEvent.click(screen.getByRole('button',{name:'일정 추가하기'}));
  const form=within(screen.getByRole('form'));
  fireEvent.change(form.getByLabelText('일정 제목'),{target:{value:'새해 점검'}});
  await pickDate(form,'날짜','2027-01-15');
  fireEvent.click(form.getByRole('radio',{name:'세금·행정'}));
  fireEvent.click(screen.getByRole('button',{name:'일정 저장하기'}));
  expect(store.getSnapshot().tables.calendarEvent.find(e=>'raw' in e.title&&e.title.raw==='새해 점검')).toMatchObject({date:'2027-01-15',categoryId:'tax-admin'});
  const before=store.getSnapshot().tables.calendarEvent;
  fireEvent.click(screen.getByRole('checkbox',{name:'세금·행정'}));
  expect(store.getSnapshot().tables.calendarEvent).toEqual(before);
});


it('발주 표에서 우유 8L 입고는 한 번만 기록되고 재고와 지출 후보가 함께 바뀐다', () => {
  const {store,milk}=supplyWeek();
  suppliersDetail(store);
  const grid=screen.getByRole('grid',{name:'발주 내역'});
  const row=grid.querySelector(`[data-grid-row="${milk}"]`) as HTMLElement;
  expect(row).toBeTruthy();
  const stockBefore=model(store).ingredients.find(r=>r.itemId===MILK)!.stock!;
  fireEvent.click(row.querySelector('[data-grid-column-id="item"]')!);
  const amount=screen.getByRole('spinbutton',{name:/받은 수량/});
  fireEvent.change(amount,{target:{value:'8'}});
  const save=screen.getByRole('button',{name:'입고 기록하기'});
  fireEvent.click(save); fireEvent.click(save);
  const polIds=store.getSnapshot().tables.purchaseOrderLine.filter(l=>l.poId===milk).map(l=>l.polId);
  expect(store.getSnapshot().tables.receipt.filter(r=>polIds.includes(r.polId))).toHaveLength(1);
  // 8L at the milk's price is the expense candidate; 8L is 8,000mL on the shelf
  const price=purchaseOf(store.getSnapshot().tables,MILK).unitPrice;
  expect(store.getSnapshot().tables.expense.some(e=>e.amount===8*price&&e.status==='candidate')).toBe(true);
  expect(model(store).ingredients.find(r=>r.itemId===MILK)!.stock).toBe(stockBefore+8000);
});

it('발주 조건의 단가를 표에서 바꾸고 원본에 반영한다', () => {
  const store=createWidgetDataStore();
  suppliersDetail(store);
  fireEvent.click(screen.getByRole('tab',{name:'발주 품목'}));
  const grid=screen.getByRole('grid',{name:'발주 품목'});
  const milkItem=purchaseOf(store.getSnapshot().tables,MILK);
  const row=grid.querySelector(`[data-grid-row="${milkItem.purchaseItemId}"]`)!;
  // the price is per purchase unit: 2,900원/L, never per mL
  expect(row.querySelector('[data-grid-column-id="unitPrice"]')).toHaveTextContent(`${milkItem.unitPrice.toLocaleString('en-US')}원/L`);
  expect(row.querySelector('[data-grid-column-id="minimumQty"]')).toHaveTextContent('1L');
  fireEvent.click(row.querySelector('[data-grid-column-id="unitPrice"]')!);
  const input=within(row as HTMLElement).getByRole('textbox');
  fireEvent.change(input,{target:{value:'4000'}});fireEvent.keyDown(input,{key:'Enter'});
  expect(store.getSnapshot().tables.purchaseItem.find(p=>p.purchaseItemId===milkItem.purchaseItemId)?.unitPrice).toBe(4000);
});

it('판매 상품 표의 채널 이동은 전체 248개를 유지한다', () => {
  const {store,ids}=withRetail();
  inventoryDetail(store);
  fireEvent.click(screen.getByRole('tab',{name:'판매 상품'}));
  expect(screen.getByRole('grid',{name:'판매 상품'})).toBeInTheDocument();
  const total=()=>store.getSnapshot().tables.inventoryStock.filter(r=>ids.includes(r.itemId)).reduce((n,r)=>n+(r.qty??0),0);
  expect(total()).toBe(248);
  expect(store.dispatch({type:'inventory.moveChannel',itemId:ids[0]!,from:'store',to:'online',qty:20}).ok).toBe(true);
  expect(total()).toBe(248);
  expect(model(store).products.byChannel).toEqual({store:160,online:88});
});

it('시럽 사용 증가가 발주 제안과 새 발주 및 캘린더에 이어진다', () => {
  const store=createWidgetDataStore();
  const latte='m-vanilla-latte',syrup='i-vanilla-syrup';
  const recipe=store.getSnapshot().tables.recipeLine.filter(r=>r.menuId===latte).map(r=>({recipeLineId:r.recipeLineId,itemId:r.itemId,quantity:r.itemId===syrup?400:r.quantity,unit:r.unit}));
  expect(store.dispatch({type:'menu.setRecipe',menuId:latte,lines:recipe}).ok).toBe(true);
  // A vanilla latte now takes 400mL of syrup: what is left of the day no longer fits the syrup in stock, so the order screen suggests 5L
  expect(deriveSuggestions(store.getSnapshot(),{date:TODAY}).map(s=>[s.itemId,s.qty,s.unit])).toEqual([[syrup,5,'L']]);
  const orders=store.getSnapshot().tables.purchaseOrder.length;
  const deliveries=selectCalendar(store.getSnapshot(),{date:TODAY}).monthEntries.filter(e=>e.source==='delivery').length;
  suppliersDetail(store);
  expect(screen.getByText(new RegExp(`${raw(store,syrup)} 5L`))).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'발주하기'}));
  fireEvent.click(screen.getByRole('button',{name:'발주 기록하기'}));
  expect(store.getSnapshot().tables.purchaseOrder).toHaveLength(orders+1);
  expect(selectCalendar(store.getSnapshot(),{date:TODAY}).monthEntries.filter(e=>e.source==='delivery')).toHaveLength(deliveries+1);
});

it('재고 펼침은 우유를 쓰는 메뉴와 당일 소진 품목의 7일 기록을 보여준다', () => {
  const store=createWidgetDataStore();
  inventoryDetail(store);
  const grid=screen.getByRole('grid',{name:'재료'});
  const milk=grid.querySelector(`[data-grid-row="${MILK}"]`) as HTMLElement;
  fireEvent.click(within(milk).getByRole('button',{name:`${raw(store,MILK)} 재고 변동 기록`}));
  expect(screen.getByRole('button',{name:/카페라떼/})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:/바닐라빈 라떼/})).toBeInTheDocument();
  const cake=grid.querySelector('[data-grid-row="i-basque-cake"]') as HTMLElement;
  fireEvent.click(within(cake).getByRole('button',{name:`${raw(store,'i-basque-cake')} 재고 변동 기록`}));
  fireEvent.click(screen.getByRole('radio',{name:'최근 7일'}));
  // the cake came in on 11/13 (30 pieces from the bakery)
  expect(screen.getByText(shortDate(addIsoDays(TODAY,-4)))).toBeInTheDocument();
  expect(screen.getByText('+30개')).toBeInTheDocument();
});

it('잘못된 재고 값은 저장하거나 다른 행으로 이동하지 않는다', () => {
 const store=createWidgetDataStore();
 inventoryDetail(store,{textScale:125,reducedMotion:true});
 const grid=screen.getByRole('grid',{name:'재료'}),row=grid.querySelector(`[data-grid-row="${BEANS}"]`) as HTMLElement;
 fireEvent.click(row.querySelector('[data-grid-column-id="stock"]')!);
 const input=within(row).getByRole('textbox');fireEvent.change(input,{target:{value:'-1'}});fireEvent.keyDown(input,{key:'Tab'});
 expect(input).toHaveAttribute('aria-invalid','true');expect(store.getSnapshot().revision).toBe(0);
 expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
 fireEvent.keyDown(input,{key:'Escape'});expect(store.getSnapshot().revision).toBe(0);
});

it('우유 이력은 다섯 열과 사용 줄, 시작·남은 재고 및 읽기 전용 설명을 제공한다', () => {
  const store=createWidgetDataStore();
  inventoryDetail(store);
  fireEvent.click(screen.getByRole('button',{name:`${raw(store,MILK)} 재고 변동 기록`}));
  const ledger=screen.getByRole('grid',{name:ledgerName(store,MILK)});
  const today=selectStockHistory(store.getSnapshot(),{itemId:MILK,period:'today'}).dayGroups[0]!;
  const usage=today.rows.filter(r=>r.kind==='usage');
  expect(within(ledger).getAllByRole('columnheader').map(c=>c.textContent)).toEqual(['날짜·시각','종류','수량','내용','남은 재고']);
  expect(ledger).toHaveTextContent('오늘 시작 재고');
  // 42,360mL at the start of the day (the unit stays mL, the thousands are separated)
  expect(ledger).toHaveTextContent(`${today.rows[0]!.balanceDisplay.toLocaleString('en-US')}mL`);
  expect(ledger.querySelectorAll('[data-grid-row]')).toHaveLength(today.rows.length+1);
  // the usage lines carry the time the day was counted up to, and one such line per menu
  expect(within(ledger).getAllByText(`오늘 ${usage[0]!.asOf}까지`)).toHaveLength(usage.length);
  expect(ledger).toHaveTextContent(`−${Math.abs(usage[0]!.delta).toLocaleString('en-US')}mL`);
  expect(ledger).toHaveTextContent('카페라떼 24잔');
  expect(ledger).toHaveTextContent('바닐라빈 라떼 19잔');
  expect(within(ledger).getAllByRole('gridcell',{name:/내용/})[0]).toHaveAccessibleDescription('기록은 고칠 수 없어요. 현재 재고를 고치면 직접 고침으로 남아요');
  fireEvent.keyDown(within(ledger).getAllByRole('gridcell')[0]!,{key:'Enter'});
  expect(within(ledger).queryByRole('textbox')).toBeNull();
});

it('원두 사용 줄과 당일 소진 품목의 전날 입고·오늘 시작·남은 수량이 이어진다', () => {
  const store=createWidgetDataStore(),cake='i-basque-cake';
  inventoryDetail(store);
  fireEvent.click(screen.getByRole('button',{name:`${raw(store,BEANS)} 재고 변동 기록`}));
  const beans=selectStockHistory(store.getSnapshot(),{itemId:BEANS,period:'today'}).dayGroups[0]!;
  expect(screen.getByRole('grid',{name:ledgerName(store,BEANS)}).querySelectorAll('[data-grid-row]')).toHaveLength(beans.rows.length+1);
  fireEvent.click(screen.getByRole('button',{name:`${raw(store,cake)} 재고 변동 기록`}));
  expect(screen.queryByRole('grid',{name:ledgerName(store,BEANS)})).toBeNull();
  fireEvent.click(screen.getByRole('radio',{name:'최근 7일'}));
  const received=screen.getByRole('grid',{name:ledgerName(store,cake,addIsoDays(TODAY,-4))});
  expect(received).toHaveTextContent('+30개');
  expect(received).toHaveTextContent('동작아티잔 베이커리공방');
  const today=screen.getByRole('grid',{name:ledgerName(store,cake)});
  expect(today).toHaveTextContent('21개');
  expect(today).toHaveTextContent('18개');
});

it('발주 MOQ·주문 단위는 저장을 막고 유효 주문 취소·undo는 잔량과 일정을 복원한다', () => {
  const store=createWidgetDataStore(),notify=vi.fn();
  suppliersDetail(store,{},{onNotify:notify});
  fireEvent.click(screen.getByRole('tab',{name:'발주 품목'}));
  const beansItem=purchaseOf(store.getSnapshot().tables,BEANS);
  const beans=screen.getByRole('grid',{name:'발주 품목'}).querySelector(`[data-grid-row="${beansItem.purchaseItemId}"]`) as HTMLElement;
  fireEvent.click(beans.querySelector('[data-grid-column-id="minimumQty"]')!);
  const min=within(beans).getByRole('textbox');fireEvent.change(min,{target:{value:'2'}});fireEvent.keyDown(min,{key:'Enter'});
  const orders=store.getSnapshot().tables.purchaseOrder.length;
  fireEvent.click(screen.getByRole('tab',{name:'발주 내역'}));fireEvent.click(screen.getByRole('button',{name:'발주 추가하기'}));
  const form=screen.getByRole('form',{name:'발주 추가하기'});
  fireEvent.change(within(form).getByLabelText('발주 품목'),{target:{value:beansItem.purchaseItemId}});
  const amount=within(form).getByRole('spinbutton',{name:'주문 수량'});
  fireEvent.change(amount,{target:{value:'1'}});fireEvent.click(within(form).getByRole('button',{name:'발주 기록하기'}));
  // the purchase unit is kg, not the g the stock is counted in
  expect(form).toHaveTextContent('최소 2kg부터 주문할 수 있어요');
  fireEvent.change(amount,{target:{value:'2.5'}});fireEvent.click(within(form).getByRole('button',{name:'발주 기록하기'}));
  expect(form).toHaveTextContent('1kg 단위로 주문해 주세요');
  expect(store.getSnapshot().tables.purchaseOrder).toHaveLength(orders);
  fireEvent.change(amount,{target:{value:'3'}});fireEvent.click(within(form).getByRole('button',{name:'발주 기록하기'}));
  const order=store.getSnapshot().tables.purchaseOrder.at(-1)!;
  expect(store.getSnapshot().tables.purchaseOrder).toHaveLength(orders+1);
  const row=screen.getByRole('grid',{name:'발주 내역'}).querySelector(`[data-grid-row="${order.poId}"]`)!;
  expect(row).toHaveTextContent(`${(3*beansItem.unitPrice).toLocaleString('en-US')}원`);
  expect(row).toHaveTextContent('3kg');
  fireEvent.click(row.querySelector('[data-grid-column-id="item"]')!);
  fireEvent.click(screen.getByRole('button',{name:'발주 취소하기'}));
  // Stale expectation, not a regression: the purchasing cutover made cancel a two-step action (extra confirmation, safety invariant).
  fireEvent.click(screen.getByRole('button',{name:'발주 취소 확인'}));
  expect(selectCalendar(store.getSnapshot(),{date:TODAY}).monthEntries.some(e=>e.sourceId===order.poId)).toBe(false);
  expect(store.undo(notify.mock.calls.at(-1)![0].undoToken).ok).toBe(true);
  expect(selectCalendar(store.getSnapshot(),{date:TODAY}).monthEntries.some(e=>e.sourceId===order.poId)).toBe(true);
});

it('표 검색·숫자 정렬은 selector의 업무 원본과 집계를 바꾸지 않는다', () => {
  const store=createWidgetDataStore();
  inventoryDetail(store);
  const before=store.getSnapshot(),grid=screen.getByRole('grid',{name:'재료'});
  fireEvent.click(within(grid).getByRole('button',{name:'현재 재고'}));
  const ascending=[...model(store).ingredients].sort((a,b)=>(a.stock??0)-(b.stock??0)||a.itemId.localeCompare(b.itemId)).map(r=>r.itemId);
  expect([...grid.querySelectorAll('[data-grid-row]')].map(r=>r.getAttribute('data-grid-row'))).toEqual(ascending);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'RM-001'}});
  expect(grid.querySelectorAll('[data-grid-row]')).toHaveLength(1);
  expect(grid).toHaveTextContent(raw(store,BEANS));expect(store.getSnapshot()).toBe(before);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'없는 품목'}});
  expect(screen.getByText('찾는 항목이 없어요')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:''}});
  expect(grid.querySelectorAll('[data-grid-row]')).toHaveLength(ascending.length);
});

it('2027년 임의 날짜를 월·주·일로 찾아 보고 모든 분류를 꺼도 원본 일정은 남는다', async () => {
  const store=createWidgetDataStore(),Detail=calendarWidget.Detail!;
  store.dispatch({type:'calendar.addEvent',date:'2027-01-15',title:'새해 점검',time:'10:00',categoryId:'tax-admin'});
  renderWithKit(<Detail featureId="calendar" condition={{kind:'default'}} detailRef={{featureId:'calendar'}} host={createTestHost('calendar')} />, {store});
  await pickDate(screen,'날짜','2027-01-15');
  expect(screen.getByRole('table',{name:'2027년 1월 달력'})).toBeInTheDocument();
  expect(screen.getByRole('list',{name:'오늘 일정'})).toHaveTextContent('새해 점검');
  fireEvent.click(screen.getByRole('radio',{name:'주'}));expect(document.querySelectorAll('.ms-week-grid__day')).toHaveLength(7);
  fireEvent.click(screen.getByRole('radio',{name:'일'}));expect(screen.getByRole('region',{name:'일'})).toHaveTextContent('새해 점검');
  const events=store.getSnapshot().tables.calendarEvent;
  for(const name of ['매장 운영','발주·입고','세금·행정'])fireEvent.click(screen.getByRole('checkbox',{name}));
  expect(screen.getByText('보이는 분류가 없어요. 분류를 켜 주세요')).toBeInTheDocument();
  expect(store.getSnapshot().tables.calendarEvent).toEqual(events);
});

it('발주 품목 추가·삭제는 원본을 바꾸고 활성 레시피의 유일 단가는 삭제를 막는다', () => {
  const store=createWidgetDataStore();
  const created=store.dispatch({type:'inventory.createItem',sku:'RM-NEW',name:'새 재료',unit:'pcs',stock:2,threshold:1,idempotencyKey:'새재료'});
  expect(created.ok).toBe(true);
  const newItemId=store.getSnapshot().tables.inventoryItem.find(i=>i.sku==='RM-NEW')!.itemId;
  const items=store.getSnapshot().tables.purchaseItem.length;
  suppliersDetail(store);
  fireEvent.click(screen.getByRole('tab',{name:'발주 품목'}));
  fireEvent.click(screen.getByRole('button',{name:'발주 품목 추가하기'}));
  const form=screen.getByRole('form',{name:'발주 품목 추가하기'});
  fireEvent.change(within(form).getByLabelText('품목'),{target:{value:newItemId}});
  fireEvent.change(within(form).getByLabelText('발주사'),{target:{value:'s-bakery'}});
  fireEvent.change(within(form).getByLabelText('단가'),{target:{value:'1000'}});
  fireEvent.click(within(form).getByRole('button',{name:'발주 품목 저장하기'}));
  expect(store.getSnapshot().tables.purchaseItem).toHaveLength(items+1);
  const added=store.getSnapshot().tables.purchaseItem.at(-1)!;
  const row=screen.getByRole('grid',{name:'발주 품목'}).querySelector(`[data-grid-row="${added.purchaseItemId}"]`) as HTMLElement;
  fireEvent.click(within(row).getByRole('button',{name:'새 재료 지우기'}));
  // Stale expectation, not a regression: purchase-item delete now asks for an extra confirmation (the 27th row stays until it is pressed).
  fireEvent.click(screen.getByRole('button',{name:'지우기 확인'}));
  expect(store.getSnapshot().tables.purchaseItem).toHaveLength(items);
  const milkItem=purchaseOf(store.getSnapshot().tables,MILK);
  const original=screen.getByRole('grid',{name:'발주 품목'}).querySelector(`[data-grid-row="${milkItem.purchaseItemId}"]`) as HTMLElement;
  const button=within(original).getByRole('button',{name:`${raw(store,MILK)} 지우기`});
  fireEvent.click(button);
  expect(store.getSnapshot().tables.purchaseItem).toHaveLength(items);
  expect(screen.getByRole('alert')).toHaveTextContent('메뉴 레시피의 유일한 단가라 지울 수 없어요');
});

it('출처에서 돌아오면 검색·정렬·펼침·표 스크롤을 복원하고 완전 닫기 뒤에는 초기화한다', () => {
  const {store}=shortMilk();
  const view=renderWithKit(<DetailStack root={{featureId:'inventory-booking'}}/>,{store});
  const grid=screen.getByRole('grid',{name:'재료'});
  const open=`${raw(store,MILK)} 재고 변동 기록`;
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'우유'}});
  fireEvent.click(within(grid).getByRole('button',{name:'현재 재고'}));
  fireEvent.click(screen.getByRole('button',{name:open}));
  const scroll=grid.parentElement!;scroll.scrollTop=120;scroll.scrollLeft=240;
  fireEvent.click(within(grid).getByRole('button',{name:'발주 보기'}));
  expect(screen.getByRole('grid',{name:'발주 내역'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'돌아가기'}));
  const restored=screen.getByRole('grid',{name:'재료'});
  expect(screen.getByRole('searchbox')).toHaveValue('우유');
  expect(within(restored).getByRole('columnheader',{name:'현재 재고'})).toHaveAttribute('aria-sort','ascending');
  expect(screen.getByRole('button',{name:open})).toHaveAttribute('aria-expanded','true');
  expect(restored.parentElement!.scrollTop).toBe(120);expect(restored.parentElement!.scrollLeft).toBe(240);
  view.unmount();
  renderWithKit(<DetailStack root={{featureId:'inventory-booking'}}/>,{store});
  expect(screen.getByRole('searchbox')).toHaveValue('');
  expect(screen.getByRole('button',{name:open})).toHaveAttribute('aria-expanded','false');
});

it('새 품목의 빈 처음 수량은 0으로 저장하지 않고 오류와 초안을 유지한다', () => {
  const store=createWidgetDataStore(),Detail=inventoryWidget.Detail!;
  renderWithKit(<Detail featureId="inventory-booking" condition={{kind:'default'}} detailRef={{featureId:'inventory-booking',view:'register'}} host={createTestHost('inventory-booking')} />, {store});
  fireEvent.change(screen.getByLabelText('코드(SKU)'),{target:{value:'RM-NEW'}});
  fireEvent.change(screen.getByLabelText('이름'),{target:{value:'새 재료'}});
  fireEvent.change(screen.getByLabelText('처음 수량'),{target:{value:''}});
  fireEvent.click(screen.getByRole('button',{name:'품목 저장하기'}));
  expect(store.getSnapshot().revision).toBe(0);expect(screen.getByRole('alert')).toHaveTextContent('0 이상의 숫자를 넣어 주세요');
  expect(screen.getByLabelText('처음 수량')).toHaveValue('');
  expect(screen.getByLabelText('코드(SKU)')).toHaveValue('RM-NEW');
});

it('발주 입고 예정일은 DateStepper에서 바꾸고 달력 원본과 함께 저장한다', () => {
  const {store,milk}=supplyWeek();
  suppliersDetail(store);
  const button=screen.getByRole('button',{name:`${raw(store,MILK)} 입고 예정일 바꾸기`});fireEvent.click(button);
  fireEvent.click(screen.getByRole('button',{name:'다음 날짜'}));
  fireEvent.click(screen.getByRole('button',{name:'저장하기'}));
  expect(store.getSnapshot().tables.purchaseOrder.find(o=>o.poId===milk)?.dueDate).toBe(addIsoDays(TODAY,1));
  expect(selectCalendar(store.getSnapshot(),{date:TODAY}).todayEntries.some(e=>e.sourceId===milk)).toBe(false);
});

it('재고 값은 공용 강조 coordinator에 의미값을 등록하고 자체 강조를 중복 실행하지 않는다', () => {
 const registry=createVisibleSlotRegistry(),store=createWidgetDataStore();
 const stockNow=model(store).ingredients.find(r=>r.itemId===BEANS)!.stock!;
 const Detail=inventoryWidget.Detail!;
 renderWithKit(<VisibleSlotProvider registry={registry}><Detail featureId="inventory-booking" condition={{kind:'default'}} detailRef={{featureId:'inventory-booking'}} host={createTestHost('inventory-booking')}/></VisibleSlotProvider>,{store});
 const slot=()=>registry.getSnapshot().find(s=>s.slotId===`inventory-booking:${BEANS}:stock`);
 expect(slot()?.semanticValue).toBe(stockNow);
 const row=screen.getByRole('grid',{name:'재료'}).querySelector(`[data-grid-row="${BEANS}"]`) as HTMLElement;
 fireEvent.click(row.querySelector('[data-grid-column-id="stock"]')!);
 const input=within(row).getByRole('textbox');fireEvent.change(input,{target:{value:String(stockNow+2000)}});fireEvent.keyDown(input,{key:'Enter'});
 expect(slot()?.semanticValue).toBe(stockNow+2000);expect(slot()?.scope).toBe('editor');
 expect(document.querySelectorAll('[data-flash="true"]')).toHaveLength(0);
});

it('오늘 사용량 칸을 클릭하거나 Enter로 펼쳐 메뉴별 사용을 보여준다', () => {
 const store=createWidgetDataStore();
 inventoryDetail(store);
 const row=screen.getByRole('grid',{name:'재료'}).querySelector(`[data-grid-row="${MILK}"]`) as HTMLElement;
 const used=row.querySelector('[data-grid-column-id="used"]')!;
 fireEvent.click(used);
 expect(screen.getByRole('grid',{name:ledgerName(store,MILK)})).toHaveTextContent('카페라떼 24잔');
 fireEvent.keyDown(used,{key:'Enter'});
 expect(screen.queryByRole('grid',{name:ledgerName(store,MILK)})).toBeNull();
});

it('재고 품절 상태는 중복 경고 띠 없이 표시되고 펼침 뒤에도 유지된다', () => {
 const store=createWidgetDataStore();
 store.dispatch({type:'inventory.updateItem',itemId:MILK,stock:0});
 inventoryDetail(store);
 const row=screen.getByRole('grid',{name:'재료'}).querySelector(`[data-grid-row="${MILK}"]`) as HTMLElement;
 expect(within(row).getByText('품절')).toBeInTheDocument();
 expect(row).not.toHaveAttribute('aria-describedby');
 fireEvent.click(within(row).getByRole('button',{name:`${raw(store,MILK)} 재고 변동 기록`}));
 expect(within(row).getByText('품절')).toBeInTheDocument();
});

it('입고 잔량과 발주 단가는 의미값 슬롯에 등록된다', () => {
 const registry=createVisibleSlotRegistry(),Detail=suppliersWidget.Detail!,{store,milk}=supplyWeek();
 renderWithKit(<VisibleSlotProvider registry={registry}><Detail featureId="suppliers" condition={{kind:'default'}} detailRef={{featureId:'suppliers'}} host={createTestHost('suppliers')}/></VisibleSlotProvider>,{store});
 expect(registry.getSnapshot().find(s=>s.slotId===`suppliers:order:${milk}:remaining`)?.semanticValue).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'발주 품목'}));
 expect(registry.getSnapshot().find(s=>s.slotId===`suppliers:purchase:${purchaseOf(store.getSnapshot().tables,MILK).purchaseItemId}:unitPrice`)?.semanticValue).toBeTruthy();
});

it('표 편집 중에도 이전 의미값을 유지해 저장 후 같은 칸을 강조할 수 있다', () => {
 const registry=createVisibleSlotRegistry(),Detail=inventoryWidget.Detail!,store=createWidgetDataStore();
 const stockNow=model(store).ingredients.find(r=>r.itemId===BEANS)!.stock!;
 renderWithKit(<VisibleSlotProvider registry={registry}><Detail featureId="inventory-booking" condition={{kind:'default'}} detailRef={{featureId:'inventory-booking'}} host={createTestHost('inventory-booking')}/></VisibleSlotProvider>,{store});
 const id=`inventory-booking:${BEANS}:stock`;
 const row=screen.getByRole('grid',{name:'재료'}).querySelector(`[data-grid-row="${BEANS}"]`) as HTMLElement;
 fireEvent.click(row.querySelector('[data-grid-column-id="stock"]')!);
 expect(registry.getSnapshot().find(s=>s.slotId===id)?.semanticValue).toBe(stockNow);
 expect(row.querySelector('[data-grid-column-id="stock"]')).toHaveAttribute('data-slot-id',id);
});


it('공용 coordinator는 재고 편집을 실제 표 칸에 강조한다', async () => {
 const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:10,y:10,left:10,top:10,right:110,bottom:50,width:100,height:40,toJSON:()=>({})});
 try {
  const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light'}),Detail=inventoryWidget.Detail!;
  renderWithKit(<ValueHighlights run={run}><Detail featureId="inventory-booking" condition={{kind:'default'}} detailRef={{featureId:'inventory-booking'}} host={createTestHost('inventory-booking')}/></ValueHighlights>);
  await act(async()=>{});
  const cell=screen.getByRole('grid',{name:'재료'}).querySelector(`[data-grid-row="${BEANS}"] [data-grid-column-id="stock"]`) as HTMLElement;
  fireEvent.click(cell);await act(async()=>{});
  const input=within(cell).getByRole('textbox');fireEvent.change(input,{target:{value:'7688'}});fireEvent.keyDown(input,{key:'Enter'});
  await waitFor(()=>expect(cell).toHaveAttribute('data-highlighted'));
  expect(document.querySelectorAll('[data-slot-id][data-highlighted]').length).toBeLessThanOrEqual(6);
 } finally {rect.mockRestore();}
});

it('일정 시각과 발주 입고 예정일은 바뀌기 전부터 의미값으로 등록된다', () => {
 const registry=createVisibleSlotRegistry(),Detail=calendarWidget.Detail!;
 renderWithKit(<VisibleSlotProvider registry={registry}><Detail featureId="calendar" condition={{kind:'default'}} detailRef={{featureId:'calendar'}} host={createTestHost('calendar')}/></VisibleSlotProvider>);
 expect(registry.getSnapshot().some(s=>s.slotId.includes(':time:')&&typeof s.semanticValue==='string')).toBe(true);
});


it('음수 사용과 누락된 안전 재고는 각 행 아래에 설명한다', () => {
 const store=createWidgetDataStore(),m=model(store);
 const ingredients=m.ingredients.map(r=>r.itemId===MILK?{...r,deficit:3.9}:r.itemId===BEANS?{...r,threshold:null,needsReview:true}:r);
 renderWithKit(<StockGrid model={{...m,ingredients}} host={createTestHost('inventory-booking')}/>,{store});
 const grid=screen.getByRole('grid',{name:'재료'});
 const milk=grid.querySelector(`[data-grid-row="${MILK}"]`)!,beans=grid.querySelector(`[data-grid-row="${BEANS}"]`)!;
 // the stock unit of the milk is mL
 expect(document.getElementById(milk.getAttribute('aria-describedby')!)).toHaveTextContent('오늘 사용량이 재고보다 3.9mL 많아요');
 expect(document.getElementById(beans.getAttribute('aria-describedby')!)).toHaveTextContent('현재 재고와 안전 재고를 확인해 주세요');
});

it('가려진 값은 실제 가시 여부가 바뀔 때 슬롯에 반영된다', async () => {
 const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:10,y:10,left:10,top:10,right:110,bottom:50,width:100,height:40,toJSON:()=>({})});
 try {
  const registry=createVisibleSlotRegistry();
  const view=renderWithKit(<VisibleSlotProvider registry={registry}><SupplySurface featureId="calendar" scope="dashboard"><div><Flash slot="test:visible" value={1}>1</Flash></div></SupplySurface></VisibleSlotProvider>);
  expect(registry.getSnapshot().find(s=>s.slotId==='test:visible')?.visible).toBe(true);
  const parent=view.getByText('1').parentElement!;
  parent.hidden=true;
  await waitFor(()=>expect(registry.getSnapshot().find(s=>s.slotId==='test:visible')?.visible).toBe(false));
  parent.hidden=false;
  await waitFor(()=>expect(registry.getSnapshot().find(s=>s.slotId==='test:visible')?.visible).toBe(true));
 } finally {rect.mockRestore();}
});

it('입고와 납기 변경 뒤 발주 표 슬롯이 같은 원본 값을 따른다', () => {
 const registry=createVisibleSlotRegistry(),Detail=suppliersWidget.Detail!,{store,milk}=supplyWeek();
 renderWithKit(<VisibleSlotProvider registry={registry}><Detail featureId="suppliers" condition={{kind:'default'}} detailRef={{featureId:'suppliers'}} host={createTestHost('suppliers')}/></VisibleSlotProvider>,{store});
 const read=(field:string)=>registry.getSnapshot().find(s=>s.slotId===`suppliers:order:${milk}:${field}`)?.semanticValue;
 expect(read('due')).toBe(TODAY);expect(read('remaining')).toBe('[[0,12]]');
 fireEvent.click(screen.getByRole('button',{name:`${raw(store,MILK)} 입고 예정일 바꾸기`}));fireEvent.click(screen.getByRole('button',{name:'다음 날짜'}));fireEvent.click(screen.getByRole('button',{name:'저장하기'}));
 expect(read('due')).toBe(addIsoDays(TODAY,1));
 const row=screen.getByRole('grid',{name:'발주 내역'}).querySelector(`[data-grid-row="${milk}"]`)!;
 fireEvent.click(row.querySelector('[data-grid-column-id="item"]')!);
 fireEvent.change(screen.getByRole('spinbutton',{name:'받은 수량'}),{target:{value:'8'}});
 fireEvent.click(screen.getByRole('button',{name:'입고 기록하기'}));
 expect(read('remaining')).toBe('[[8,4]]');expect(read('status')).toContain('partial');
});

it('일정 편집 시 기존 시간 슬롯의 의미값을 갱신한다', () => {
 const registry=createVisibleSlotRegistry(),Detail=calendarWidget.Detail!;
 renderWithKit(<VisibleSlotProvider registry={registry}><Detail featureId="calendar" condition={{kind:'default'}} detailRef={{featureId:'calendar'}} host={createTestHost('calendar')}/></VisibleSlotProvider>);
 const button=screen.getByRole('button',{name:new RegExp(SAMPLE_EVENT.title)});
 const time=button.querySelector('[data-slot-id*="calendar:detail:time:"]')!;
 const id=time.getAttribute('data-slot-id')!;
 fireEvent.click(button);fireEvent.click(screen.getByRole('button',{name:`${SAMPLE_EVENT.title} 고치기`}));
 fireEvent.change(screen.getByLabelText('시각'),{target:{value:'17:30'}});fireEvent.click(screen.getByRole('button',{name:'일정 저장하기'}));
 expect(registry.getSnapshot().find(s=>s.slotId===id)?.semanticValue).toBe('17:30');
});

it('오늘 이미 지난 시각으로 고칠 때 지난 기록으로 남기기를 눌러야 저장한다', () => {
 const Detail=calendarWidget.Detail!,store=createWidgetDataStore();
 renderWithKit(<Detail featureId="calendar" condition={{kind:'default'}} detailRef={{featureId:'calendar'}} host={createTestHost('calendar')}/>,{store});
 const before=store.getSnapshot();
 fireEvent.click(screen.getByRole('button',{name:new RegExp(SAMPLE_EVENT.title)}));
 fireEvent.click(screen.getByRole('button',{name:`${SAMPLE_EVENT.title} 고치기`}));
 fireEvent.change(screen.getByLabelText('시각'),{target:{value:'11:30'}});
 fireEvent.click(screen.getByRole('button',{name:'일정 저장하기'}));
 expect(store.getSnapshot()).toBe(before);
 fireEvent.click(screen.getByRole('button',{name:'지난 기록으로 남기기'}));
 expect(store.getSnapshot().tables.calendarEvent.find(row=>row.eventId==='sample-calendar-1')?.time).toBe('11:30');
});

it.each([
  ['inventory-booking','재료',['재료','판매 상품']],
  ['suppliers','발주 내역',['발주 내역','발주 품목','발주사']],
] as const)('%s 상세의 각 표는 남은 높이를 받는 탭 패널 안에 있다',(id,initialGrid,tabs)=>{
  const Detail=id==='suppliers'?suppliersWidget.Detail!:inventoryWidget.Detail!;
  renderWithKit(<><style>{supplyCss}</style><Detail featureId={id} condition={{kind:'default'}} detailRef={{featureId:id}} host={createTestHost(id)}/></>);
  const root=document.querySelector<HTMLElement>('.ms-detail')!;
  expect(getComputedStyle(root).height).toBe('100%');
  expect(getComputedStyle(root).minHeight).toBe('0');
  expect(getComputedStyle(root).flexDirection).toBe('column');
  expect(screen.getByRole('grid',{name:initialGrid})).toBeInTheDocument();
  for(const tab of tabs){
    fireEvent.click(screen.getByRole('tab',{name:tab}));
    if (tab === '판매 상품') {
      expect(screen.getByText('아직 등록한 판매 상품이 없어요')).toBeVisible();
      continue;
    }
    const grid=screen.getByRole('grid',{name:tab});
    const panel=grid.closest<HTMLElement>('.ui-detail-tabs__panel')!;
    const tabRoot=panel.parentElement!;
    expect(getComputedStyle(tabRoot).display).toBe('flex');
    expect(getComputedStyle(panel).display).toBe('flex');
    expect(getComputedStyle(panel).minHeight).toBe('0');
    expect(getComputedStyle(grid.closest<HTMLElement>('.ui-data-grid')!).flex).toBe('1 1 0px');
  }
});

it('보충 필요 품목이 이미 발주된 경우 입고 대기 건수를 알린다', () => {
 const {store}=shortMilk();
 const waiting=deriveOpenOrders(store.getSnapshot(),{date:TODAY}).open.length;
 suppliersDetail(store);
 expect(screen.getByText(/모자란 품목은 이미 발주했어요/)).toBeInTheDocument();
 expect(screen.getByText(new RegExp(`입고 대기 ${waiting}건`))).toBeInTheDocument();
});

it('보충이 모자라고 아직 발주하지 않은 품목은 발주 제안 카드에 구매 단위로 보인다', () => {
 const {store}=shortage(withRetail().store);
 suppliersDetail(store);
 const suggestions=screen.getByRole('heading',{name:'발주 제안'}).closest('section')!;
 // beans are counted in g and bought in kg, cups in pieces: 6kg and 1,000개
 expect(suggestions).toHaveTextContent(`${raw(store,BEANS)} 6kg`);
 expect(suggestions).toHaveTextContent('1,000개');
 expect(suggestions).not.toHaveTextContent(raw(store,MILK));
 expect(within(suggestions).getAllByRole('button',{name:'발주하기'})).toHaveLength(2);
 expect(longDate(TODAY)).toBe('11월 17일 화요일');
});
