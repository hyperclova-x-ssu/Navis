import { CommerceStock } from './stock-grid-commerce';
import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { normalizeMenuCategory, type WidgetDetailProps } from '../../../contracts';
import type { DataCommand, DataCommandResult } from '../../../data/commands/types';
import { commandFailureText } from '../../../data/commands/failure-copy';
import { useDataDispatch, useDataExecute, useRealPort, useWidgetDataStore } from '../../../data/react';
import { deriveOpenOrders, selectStockHistory, type IngredientRow, type InventoryModel, type UnitCode } from '../../../data/widget-data';
import { unitFactor } from '../../../data/derive/common';
import { displayQuantity, type RealStockSnapshot, type StockBatchDto, type StockItemDto } from '../../../data/reality/03/stock-dto';
import { readStockForecast, realStock, stockDate } from '../../../data/reality/03/stock-projection';
import { inventoryCopy, type InventoryItemPrefill } from '../../assistant/domains/inventory';
import { useBundle } from '../../../i18n';
import { ActionButton, ChannelTransfer, ChipChoice, DataGrid, DateField, FieldFrame, Icon, InlineForm, Spinner, StatusChip, TextField, type GridColumn, type GridFocus, type GridSort, SplitBar } from '../../../ui';
import { createCommandAttemptKeys } from '../../../data/commands/attempt-keys';
import { unitLabel, useSupplyText, useTextScale, useViewMemory, sortGridRows, Flash, GridValueSlot } from './shared';
import './stock-grid.css';

const ko = {
  'supply.stock.product':'상품', 'supply.stock.products':'판매 상품', 'supply.stock.store':'매장', 'supply.stock.online':'온라인', 'supply.stock.total':'합계', 'supply.stock.sales':'최근 7일 판매량',
  'supply.stock.sku':'코드(SKU)', 'supply.stock.name':'이름', 'supply.stock.unit':'단위', 'supply.stock.current':'현재 재고', 'supply.stock.safe':'안전 재고', 'supply.stock.status':'상태', 'supply.stock.used':'오늘 사용량', 'supply.stock.delivery':'발주 보기', 'supply.stock.grid':'재료', 'supply.stock.add':'품목 추가하기', 'supply.stock.caption':'고친 재고는 변동 기록에 남아요', 'supply.stock.expand':'{name} 재고 변동 기록', 'supply.stock.delete':'{name} 지우기', 'supply.stock.block':'메뉴 레시피나 발주에 쓰는 품목이라 지울 수 없어요', 'supply.stock.numberInvalid':'0 이상의 숫자를 넣어 주세요', 'supply.stock.skuRequired':'코드(SKU)를 넣어 주세요', 'supply.stock.nameRequired':'이름을 넣어 주세요', 'supply.stock.productSearch':'상품 이름으로 찾아보세요', 'supply.stock.recheck':'재고 다시 확인하기', 'supply.stock.menus':'쓰는 메뉴', 'supply.stock.nearest':'가장 가까운 입고', 'supply.stock.history':'재고 변동 기록', 'supply.stock.today':'오늘', 'supply.stock.week':'최근 7일', 'supply.stock.balance':'남은 재고', 'supply.stock.empty':'아직 등록한 품목이 없어요', 'supply.stock.sufficient':'충분', 'supply.stock.noDelivery':'예정된 입고가 없어요', 'supply.stock.initial':'처음 수량', 'supply.stock.excess':'오늘 사용량이 재고보다 {qty} 많아요. 기록을 확인해 주세요', 'supply.stock.helpSafe':'현재 재고가 이만큼 이하로 내려가면 보충 필요로 알려요', 'supply.stock.helpUsed':'메뉴 레시피와 오늘 판매량으로 계산해요',
 'supply.stock.at':'날짜·시각', 'supply.stock.kind':'종류', 'supply.stock.qty':'수량', 'supply.stock.description':'내용', 'supply.stock.opening':'오늘 시작 재고', 'supply.stock.readOnly':'기록은 고칠 수 없어요. 현재 재고를 고치면 직접 고침으로 남아요', 'supply.stock.asOf':'오늘 {time}까지', 'supply.stock.receive':'입고', 'supply.stock.usage':'사용', 'supply.stock.adjust':'직접 고침', 'supply.stock.initialLine':'처음 등록', 'supply.stock.todayUntil':'오늘까지', 'supply.stock.noResults':'찾는 항목이 없어요','supply.stock.moveAgain':'다시 옮기기', 'supply.stock.moved':'재고를 옮겼어요','supply.stock.helpName':'{column} 설명 보기','supply.stock.usageDrink':'{menu} {count}잔','supply.stock.usageItem':'{menu} {count}개',
 'supply.stock.saving':'저장하는 중이에요', 'supply.stock.skuExists':'이미 쓰는 코드예요', 'supply.stock.deleteConfirm':'{name} 품목을 지울까요?', 'supply.stock.deleteAction':'지우기 확인',
 'supply.stock.lots':'유통기한별 재고', 'supply.stock.lotAdd':'로트 등록하기', 'supply.stock.lotEmpty':'등록한 로트가 없어요', 'supply.stock.lotLimit':'현재 재고에 들어 있는 수량을 등록해요',
 'supply.stock.lotDate':'유통기한', 'supply.stock.lotDateRequired':'유통기한을 선택해 주세요', 'supply.stock.lotDiscard':'로트 폐기', 'supply.stock.lotDiscarded':'폐기함',
 'supply.stock.lotDiscardConfirm':'이 로트의 남은 수량 {qty}을 폐기할까요?', 'supply.stock.lotDiscardAction':'폐기 확인', 'supply.stock.positive':'0보다 큰 수량을 넣어 주세요',
 'supply.stock.lotTooLarge':'로트에 등록할 수 있는 수량을 확인해 주세요', 'supply.stock.lotActive':'등록된 로트의 남은 수량보다 적게 고칠 수 없어요',
 'supply.stock.moveInsufficient':'옮길 수 있는 수량을 확인해 주세요', 'supply.stock.lotExpired':'영업일 이후의 유통기한을 선택해 주세요',
 'supply.stock.historyEmpty':'확인할 재고 기록이 없어요', 'supply.stock.correction':'판매 취소로 복구', 'supply.stock.movementTransfer':'채널 이동',
 'supply.stock.forecast':'오늘 예상 사용량 {qty}', 'supply.stock.forecastStale':'이전 예상 사용량 {qty}', 'supply.stock.forecastNone':'예상 사용량 자료가 없어요',
 'supply.stock.forecastBasis':'최근 4주 같은 요일의 평균 사용량이에요',
 'supply.stock.forecastShortage':'예상 부족량 {qty}', 'supply.stock.lotOverdue':'유통기한 지남', 'supply.stock.lotExpires':'{date}까지',
} as const;
const bundle = {
  id: 'widget.mgmt-supply.stock-grid', ko,
  en: { 'supply.stock.delivery': 'View order', 'supply.stock.saving': 'Saving', 'supply.stock.deleteConfirm': 'Delete {name}?', 'supply.stock.deleteAction': 'Confirm deletion',
    'supply.stock.lots': 'Stock by expiry', 'supply.stock.lotAdd': 'Register lot', 'supply.stock.lotEmpty': 'No lots registered', 'supply.stock.lotLimit': 'Enter a quantity from your current stock',
    'supply.stock.lotDate': 'Expiry date', 'supply.stock.lotDateRequired': 'Choose an expiry date', 'supply.stock.lotDiscard': 'Discard lot', 'supply.stock.lotDiscarded': 'Discarded',
    'supply.stock.lotDiscardConfirm': 'Discard the remaining {qty} in this lot?', 'supply.stock.lotDiscardAction': 'Confirm discard', 'supply.stock.positive': 'Enter a quantity above zero',
    'supply.stock.lotTooLarge': 'Check the quantity available for this lot', 'supply.stock.lotActive': 'Quantity cannot be lower than the remaining stock in active lots',
    'supply.stock.moveInsufficient': 'Check how much stock you can move', 'supply.stock.lotExpired': 'Choose an expiry date on or after the business date',
    'supply.stock.historyEmpty': 'No stock history available', 'supply.stock.correction': 'Restored by sale correction', 'supply.stock.movementTransfer': 'Channel transfer',
    'supply.stock.forecast': 'Expected usage today {qty}', 'supply.stock.forecastStale': 'Previous usage forecast {qty}', 'supply.stock.forecastNone': 'No usage forecast available',
    'supply.stock.forecastBasis': 'Average usage on the same weekday over the previous four weeks', 'supply.stock.skuExists': 'This code is already in use',
    'supply.stock.forecastShortage': 'Expected shortage {qty}', 'supply.stock.lotOverdue': 'Expired', 'supply.stock.lotExpires': 'Expires {date}',
  },
  'zh-Hans': { 'supply.stock.delivery': '查看采购单' },
  'zh-Hant': { 'supply.stock.delivery': '查看採購單' },
};
type StockText = ReturnType<typeof useStockText>;
// eslint-disable-next-line react-refresh/only-export-components -- the inventory detail shares these grid messages.
export function useStockText(){ return useBundle(bundle); }

function useStockCommand() {
  const http = useRealPort()?.mode('stock') === 'http';
  const dispatch = useDataDispatch(), execute = useDataExecute();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  function send(command: DataCommand, complete: (result: DataCommandResult) => void) {
    if (!http) { complete(dispatch(command)); return; }
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    void execute(command).then(complete).finally(() => { lock.current = false; setPending(false); });
  }
  return { http, pending, send };
}

function useStockError() {
  const x = useSupplyText(), { t } = useStockText();
  return (result: Extract<DataCommandResult, { ok: false }>) => {
    switch (result.reason) {
      case 'ACTIVE_STOCK_BATCH': return t('supply.stock.lotActive');
      case 'INSUFFICIENT_STOCK': return t(result.field === 'quantity' ? 'supply.stock.lotTooLarge' : 'supply.stock.moveInsufficient');
      case 'REFERENCED_ITEM': return t('supply.stock.block');
      case 'BATCH_ALREADY_EXPIRED': return t('supply.stock.lotExpired');
      default: return x.tk(result.messageKey);
    }
  };
}

function notifyStockResult(host: WidgetDetailProps['host'], result: Extract<DataCommandResult, { ok: true }>, fallback: string) {
  const receipt = result.value;
  const undoUntil = result.undoToken && receipt && typeof receipt === 'object' && 'undoUntil' in receipt && typeof receipt.undoUntil === 'string' ? receipt.undoUntil : undefined;
  host.notify({ kind: 'success', messageKey: result.noticeKey ?? fallback, params: result.params, undoToken: result.undoToken, undoUntil });
}

function focusCancel(button: HTMLButtonElement | null) { button?.focus(); }

function History({ row, host }: {row: IngredientRow; host:WidgetDetailProps['host']}) {
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const x = useSupplyText(), {t} = useStockText();
  const [period,setPeriod] = useState<'today'|'last7days'>('today');
  const history = selectStockHistory(snapshot,{itemId:row.itemId,period});
  const menus = snapshot.tables.menuItem;
  const source = realStock(snapshot);
  const item = source?.items.find(candidate => candidate.itemId === row.itemId);
  const name = x.text(row.name ?? {key:row.nameKey});
  // The real supplier DTO carries its own `supplierName` (no seed message key); fixture mode keeps `supplierNameKey` (same pattern as the order mini table).
  const next = row.nextDelivery;
  const nextOrder = next ? deriveOpenOrders(snapshot, { date: stockDate(snapshot) }).orders.find(order => order.poId === next.poId) : undefined;
  const nextSupplier = next ? x.text(nextOrder?.supplierName ?? {key:next.supplierNameKey}) : '';
  return <div className="ms-stock-expanded">
    <section><h4>{t('supply.stock.menus')}</h4>{row.usingMenus.map(menu=><p key={menu.menuId}><ActionButton variant="link" onClick={()=>host.openLinked({featureId:'menu',itemId:menu.menuId})}>{x.text(menu.name)} · {x.format.quantity(menu.quantity,menu.unit)}</ActionButton></p>)}</section>
    <section><h4>{t('supply.stock.nearest')}</h4>{row.nextDelivery?<ActionButton variant="link" onClick={()=>host.openLinked({featureId:'suppliers',view:'order',itemId:row.nextDelivery!.poId})}>{x.format.quantity(row.nextDelivery.remaining.value,row.nextDelivery.remaining.unit)} · {nextSupplier}</ActionButton>:<p>{t('supply.stock.noDelivery')}</p>}
      {source && item?.unit && <StockLots item={item} source={source} row={row} host={host}/>}
    </section>
    <section className="ms-stock-history"><h4>{t('supply.stock.history')}</h4><ChipChoice label={t('supply.stock.history')} value={period} onChange={setPeriod} options={[{value:'today',label:t('supply.stock.today')},{value:'last7days',label:t('supply.stock.week')}]}/>{history.dayGroups.map(group=><HistoryDay key={group.date} itemId={row.itemId} name={name} unit={row.unit} group={group} usingMenus={row.usingMenus} menus={menus} today={stockDate(snapshot)} http={!!source}/>)}{!history.dayGroups.length && <p>{t('supply.stock.historyEmpty')}</p>}</section>
  </div>;
}
type HistoryGroup = ReturnType<typeof selectStockHistory>['dayGroups'][number];
type MenuRecords = ReturnType<ReturnType<typeof useWidgetDataStore>['getSnapshot']>['tables']['menuItem'];
const storeTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function HistoryDay({itemId,name,unit,group,usingMenus,menus,today,http}:{itemId:string;name:string;unit:IngredientRow['unit'];group:HistoryGroup;usingMenus:IngredientRow['usingMenus'];menus:MenuRecords;today:string;http:boolean}) {
  const x=useSupplyText(),{t}=useStockText(),[focus,setFocus]=useState<GridFocus>(null);
  type Line = {rowId:string;at:string;kind:string;quantity:string;description:string;balance:number};
  const quantity=(n:number)=>x.format.quantity(Math.abs(n),unit);
  const lines:Line[] = group.rows.filter(line=>group.date===today||line.kind!=='opening').map(line=>{
    const initial=line.description && 'key' in line.description && line.description.key==='data.management.history.initial';
    const kind=initial||line.kind==='opening'?'':line.kind;
    let description=http && 'key' in line.description && line.description.key.startsWith('supply.stock.') ? t(line.description.key as keyof typeof ko) : x.text(line.description);
    if(line.kind==='usage') {
      const params='key' in line.description?line.description.params:undefined;
      const menuKey='key' in line.description?line.description.keyParams?.menu:undefined;
      const currentMenu=usingMenus.find(menu=>menu.menuId===line.sourceRef);
      const record=menus.find(menu=>menu.menuId===line.sourceRef);
      const menuName=currentMenu?x.text(currentMenu.name):http&&record?x.text(record.name??{key:record.nameKey}):menuKey?x.tk(menuKey):'';
      if (http && line.delta > 0) description = menuName ? `${t('supply.stock.correction')} · ${menuName}` : t('supply.stock.correction');
      else if (menuName) {
        const category = normalizeMenuCategory(record?.category);
        const drink = category ? category !== 'dessert' : ['data.menu.americano','data.menu.latte','data.menu.vanillaLatte'].includes(menuKey ?? '');
        description=t(drink?'supply.stock.usageDrink':'supply.stock.usageItem',{menu:menuName,count:params?.count??0});
      }
      else if (http) description=t('supply.stock.usage');
    }
    const time = !line.at ? '' : http && Number.isFinite(Date.parse(line.at)) ? storeTime.format(new Date(line.at)) : line.at.slice(11,16);
    return {rowId:line.rowId,at:http?time:line.asOf?t('supply.stock.asOf',{time:line.asOf}):`${x.locale==='ko'?x.format.date(group.date,'short'):group.date} ${time}`.trim(),kind,quantity:line.kind==='opening'?quantity(line.delta):`${line.delta<0?'−':'+'}${quantity(line.delta)}`,description:initial?t('supply.stock.initialLine'):line.kind==='opening'?t('supply.stock.opening'):description,balance:line.balanceDisplay};
  });
  lines.push({rowId:`ending:${group.date}`,at:'',kind:'',quantity:'',description:t('supply.stock.balance'),balance:group.endingDisplay});
  const reason=t('supply.stock.readOnly');
  const columns:GridColumn<Line>[]=[
    {id:'at',header:t('supply.stock.at'),kind:'computed',minWidth:160,value:r=>r.at,readOnlyReason:reason},
    {id:'kind',header:t('supply.stock.kind'),kind:'computed',minWidth:176,value:r=>r.kind==='usage'?t('supply.stock.usage'):r.kind==='receive'?t('supply.stock.receive'):r.kind==='adjust'?t('supply.stock.adjust'):'',readOnlyReason:reason,render:r=>r.kind?<StatusChip semantic={r.kind==='usage'?'none':undefined} tone={r.kind==='receive'?'success':r.kind==='adjust'?'warning':'neutral'}>{r.kind==='receive'?'+ ':r.kind==='usage'?'− ':'± '}{t(r.kind==='receive'?'supply.stock.receive':r.kind==='usage'?'supply.stock.usage':'supply.stock.adjust')}</StatusChip>:null},
    {id:'quantity',header:t('supply.stock.qty'),kind:'computed',minWidth:120,value:r=>r.quantity,readOnlyReason:reason},
    {id:'description',header:t('supply.stock.description'),kind:'computed',minWidth:200,value:r=>r.description,readOnlyReason:reason},
    {id:'balance',header:t('supply.stock.balance'),kind:'computed',minWidth:130,value:r=>x.format.quantity(r.balance,unit),readOnlyReason:reason},
  ];
  return <div className="ms-history-day" data-stock-source={http ? 'http' : undefined}><h5>{x.locale==='ko'?x.format.date(group.date,'short'):group.date}</h5><DataGrid id={`history-${itemId}-${group.date}`} label={`${name} ${t('supply.stock.history')} ${x.locale==='ko'?x.format.date(group.date,'short'):group.date}`} rows={lines} columns={columns} getRowId={r=>r.rowId} getRowLabel={r=>r.description} sort={null} onSortChange={()=>{}} focus={focus} onFocusChange={setFocus} selectedRowId={null} expandedRowIds={new Set()} emptyContent=""/></div>;
}
function BatchForm({ item, day, host, onClose }: {item: StockItemDto; day: string; host:WidgetDetailProps['host']; onClose:()=>void}) {
  const { t } = useStockText(), errorText = useStockError();
  const { send, pending } = useStockCommand();
  const [quantity, setQuantity] = useState('');
  const [expiresOn, setExpiry] = useState<string | null>(null);
  const [error, setError] = useState<{field?: string; message:string}>();
  const closed = useRef(false);
  function close() { closed.current = true; onClose(); }
  function save() {
    const amount = Number(quantity);
    if (!quantity.trim() || !Number.isFinite(amount) || amount <= 0) return setError({ field: 'quantity', message: t('supply.stock.positive') });
    if (!expiresOn) return setError({ field: 'expiresOn', message: t('supply.stock.lotDateRequired') });
    setError(undefined);
    send({ type: 'inventory.registerBatch', itemId: item.itemId, quantity: amount, expiresOn }, result => {
      if (!result.ok) { if (!closed.current) setError({ field: result.field, message: errorText(result) }); return; }
      notifyStockResult(host, result, 'data.notice.itemUpdated');
      if (!closed.current) close();
    });
  }
  return <InlineForm title={t('supply.stock.lotAdd')} saving={pending} onClose={close} onSave={save}>
    <div className="ms-form-grid">
      <TextField label={t('supply.stock.qty')} name="lot-quantity" inputMode="decimal" value={quantity} disabled={pending} onValueChange={value=>{setQuantity(value);setError(undefined);}} error={error?.field==='quantity'?error.message:undefined} hint={t('supply.stock.lotLimit')}/>
      <DateField native label={t('supply.stock.lotDate')} name="lot-expiry" value={expiresOn} today={day} min={day} disabled={pending} onValueChange={value=>{setExpiry(value);setError(undefined);}} error={error?.field==='expiresOn'?error.message:undefined}/>
    </div>
    {error && error.field!=='quantity' && error.field!=='expiresOn' ? <p role="alert">{error.message}</p> : null}
  </InlineForm>;
}

function StockLots({ item, source, row, host }: { item: StockItemDto; source: RealStockSnapshot; row: IngredientRow; host: WidgetDetailProps['host'] }) {
  const x = useSupplyText(), { t } = useStockText(), errorText = useStockError();
  const { send, pending } = useStockCommand();
  const [add, setAdd] = useState(false);
  const [discard, setDiscard] = useState<StockBatchDto>();
  const [error, setError] = useState<string>();
  const lots = source.batches.filter(batch => batch.itemId === item.itemId).sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.receivedAt.localeCompare(b.receivedAt));
  const forecast = readStockForecast(source, item);
  const factor = unitFactor(row.unit);
  const forecastQuantity = (value: number) => value > 0 && value * factor < 1
    ? `< ${x.format.quantity(1 / factor, row.unit)}`
    : x.format.quantity(Math.round(value * factor) / factor, row.unit);
  const amount = (quantity: number | null) => quantity === null ? '—' : x.format.quantity(quantity, row.unit);
  function confirmDiscard() {
    if (!discard) return;
    const current = lots.find(batch => batch.batchId === discard.batchId);
    if (current?.revision !== discard.revision) {
      setDiscard(undefined);
      setError(x.tk('data.real.error.STALE_REVISION'));
      return;
    }
    setError(undefined);
    send({ type: 'inventory.discardBatch', batchId: discard.batchId }, result => {
      setDiscard(undefined);
      if (!result.ok) { setError(errorText(result)); return; }
      notifyStockResult(host, result, 'data.notice.itemUpdated');
    });
  }
  return <section>
    <h4>{t('supply.stock.lots')}</h4>
    {lots.length ? <ul className="ms-rows">{lots.map(batch => {
      const remaining = displayQuantity(batch.remainingQuantityBase, item.unit);
      const active = !batch.discardedAt && remaining !== null && remaining > 0;
      const overdue = active && batch.expiresOn < source.businessDate;
      return <li className="ms-row" key={batch.batchId}>
        <span>{t('supply.stock.lotExpires', { date: x.format.date(batch.expiresOn, 'short') })} · {amount(remaining)}</span>
        {batch.discardedAt ? <StatusChip tone="neutral">{t('supply.stock.lotDiscarded')}</StatusChip> : null}
        {overdue ? <StatusChip tone="warning">{t('supply.stock.lotOverdue')}</StatusChip> : null}
        {active && discard?.batchId !== batch.batchId ? <ActionButton variant="secondary" disabled={pending} onClick={()=>{setDiscard(batch);setError(undefined);}}>{t('supply.stock.lotDiscard')}</ActionButton> : null}
        {discard?.batchId === batch.batchId ? <div role="group" aria-label={t('supply.stock.lotDiscard')}>
          <p>{t('supply.stock.lotDiscardConfirm', { qty: amount(displayQuantity(discard.remainingQuantityBase, item.unit)) })}</p>
          <ActionButton variant="destructive" loading={pending} onClick={confirmDiscard}>{t('supply.stock.lotDiscardAction')}</ActionButton>
          <ActionButton ref={focusCancel} variant="secondary" disabled={pending} onClick={()=>setDiscard(undefined)}>{x.t('common.close')}</ActionButton>
        </div> : null}
      </li>;
    })}</ul> : <p>{t('supply.stock.lotEmpty')}</p>}
    {error ? <p role="alert">{error}</p> : null}
    {add ? <BatchForm item={item} day={source.businessDate} host={host} onClose={()=>setAdd(false)}/>
      : <ActionButton variant="secondary" disabled={row.stock === null || row.stock <= 0} onClick={()=>setAdd(true)}>{t('supply.stock.lotAdd')}</ActionButton>}
    <p>{forecast ? t(forecast.stale ? 'supply.stock.forecastStale' : 'supply.stock.forecast', {qty:forecastQuantity(forecast.amount)}) : t('supply.stock.forecastNone')}</p>
    {forecast && <p className="ms-caption">{t('supply.stock.forecastBasis')}</p>}
    {row.projectedDeficit > 0 ? <p>{t('supply.stock.forecastShortage', { qty: forecastQuantity(row.projectedDeficit) })}</p> : null}
  </section>;
}

export function NewItem({onClose,host,t,prefill}:{onClose:()=>void;host:WidgetDetailProps['host'];t:StockText['t'];prefill?:InventoryItemPrefill}){
  const { send, pending } = useStockCommand(), x=useSupplyText(), unitId=useId();
  const [sku,setSku]=useState(prefill?.sku ?? ''),[name,setName]=useState(prefill?.name ?? '');
  const [unit,setUnit]=useState<UnitCode>(prefill?.unit ?? 'pcs');
  const [stock,setStock]=useState(String(prefill?.stock ?? 0)),[threshold,setThreshold]=useState(String(prefill?.threshold ?? 0));
  const labels = inventoryCopy[x.locale];
  type Errors={sku?:string;name?:string;stock?:string;threshold?:string;form?:string};
  const [errors,setErrors]=useState<Errors>({});
  const [keyFor]=useState(()=>createCommandAttemptKeys('stock'));
  const closed = useRef(false);
  function close() { closed.current = true; onClose(); }
  const clear=(field:keyof Errors)=>setErrors(e=>e[field]?{...e,[field]:undefined}:e);
  const save=()=>{
    if(pending)return;
    const s=Number(stock),v=Number(threshold),bad=(raw:string,n:number)=>!raw.trim()||!Number.isFinite(n)||n<0;
    const next:Errors={...(!sku.trim()?{sku:t('supply.stock.skuRequired')}:{}),...(!name.trim()?{name:t('supply.stock.nameRequired')}:{}),...(bad(stock,s)?{stock:t('supply.stock.numberInvalid')}:{}),...(bad(threshold,v)?{threshold:t('supply.stock.numberInvalid')}:{})};
    setErrors(next);
    if(Object.keys(next).length)return;
    const key=keyFor(JSON.stringify([sku.trim(),name.trim(),unit,s,v,prefill?.trackRestock]));
    send({type:'inventory.createItem',sku,name,unit,stock:s,threshold:v,idempotencyKey:key,
      ...(prefill?.trackRestock !== undefined ? {trackRestock:prefill.trackRestock} : {})}, result => {
      if (!result.ok) {
        if (closed.current) return;
        const reason = result.reason === 'SKU_EXISTS' ? t('supply.stock.skuExists') : undefined;
        const message = commandFailureText(x.tk, result, { reason });
        setErrors(result.field==='sku'||result.field==='name'||result.field==='stock'||result.field==='threshold'?{[result.field]:message}:{form:message});
        return;
      }
      notifyStockResult(host,result,'data.notice.itemUpdated');
      if (!closed.current) close();
    });
  };
  return <InlineForm title={t('supply.stock.add')} onClose={close} saveLabel={x.t('common.saveAction')} closeLabel={x.t('common.close')} onSave={save} saving={pending}>
    <div className="ms-form-grid">
      <TextField label={labels.sku} value={sku} onValueChange={v=>{setSku(v);clear('sku');}} error={errors.sku} name="sku" disabled={pending}/>
      <TextField label={labels.name} value={name} onValueChange={v=>{setName(v);clear('name');}} error={errors.name} name="name" disabled={pending}/>
      <FieldFrame label={labels.unit} fieldId={unitId}><select id={unitId} className="ui-text-input" value={unit} disabled={pending} onChange={event=>setUnit(event.target.value as UnitCode)}>
        {(['pcs', 'kg', 'g', 'L', 'mL'] as const).map(option=><option key={option} value={option}>{unitLabel(x,option)}</option>)}
      </select></FieldFrame>
      <TextField label={t('supply.stock.initial')} value={stock} onValueChange={v=>{setStock(v);clear('stock');}} error={errors.stock} inputMode="decimal" name="stock" disabled={pending}/>
      <TextField label={t('supply.stock.safe')} value={threshold} onValueChange={v=>{setThreshold(v);clear('threshold');}} error={errors.threshold} inputMode="decimal" name="threshold" disabled={pending}/>
    </div>
    {errors.form?<p className="ms-error" role="alert"><Icon name="error"/>{errors.form}</p>:null}
  </InlineForm>;
}
export function StockGrid({model,host,initialAdd=false,initialItemId,prefill}:{model:InventoryModel;host:WidgetDetailProps['host'];initialAdd?:boolean;initialItemId?:string;prefill?:InventoryItemPrefill}){
  const store=useWidgetDataStore(),snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot),dispatch=useDataDispatch(),x=useSupplyText(),{t}=useStockText(),scale=useTextScale();
  const { http, pending, send } = useStockCommand(), errorText=useStockError();
  const source = realStock(snapshot);
  const [query,setQuery]=useViewMemory('stock.query',()=>''),[sort,setSort]=useViewMemory<GridSort>('stock.sort',()=>null);
  const [focus,setFocus]=useViewMemory<GridFocus>('stock.focus',()=>initialItemId ? {rowId:initialItemId,columnId:'$expand'} : null);
  const editStart = useRef<{ rowId: string; columnId: string; value: unknown } | undefined>(undefined);
  const [expanded,setExpanded]=useViewMemory<ReadonlySet<string>>('stock.expanded',()=>new Set(initialItemId ? [initialItemId] : []));
  const [add,setAdd]=useState(initialAdd);
  const [deletion, setDeletion] = useState<StockItemDto>();
  const [error, setError] = useState<string>();
  const name=(r:IngredientRow)=>x.text(r.name??{key:r.nameKey});
  const viewOrder = t('supply.stock.delivery');
  const warningFor=(r:IngredientRow)=>r.deficit>0?t('supply.stock.excess',{qty:x.format.quantity(r.deficit,r.unit)}):r.needsReview||r.stock===null||!Number.isFinite(r.stock)||r.stock<0||r.threshold!==null&&(!Number.isFinite(r.threshold)||r.threshold<0)?x.t('widget.inventory-booking.needsReview'):null;
  const amount=(field:'stock'|'threshold')=>(r:IngredientRow)=>r[field]===null?'—':x.format.quantity(r[field],r.unit);
  const editable = (r: IngredientRow) => !pending && (!source || !!source.items.find(record => record.itemId === r.itemId)?.unit);
  const status = (r: IngredientRow) => r.trackExpiry ? x.t('widget.inventory-booking.expiry.badge') : r.outOfStock ? x.t('widget.inventory-booking.outBadge') : r.needsRestock ? x.t('widget.inventory-booking.restockNeeded') : http && r.needsReview ? x.t('widget.inventory-booking.itemNeedsReview') : t('supply.stock.sufficient');
  const expiryLabel = (r: IngredientRow) => r.expiresOn === model.asOf ? t('supply.stock.todayUntil') : r.expiresOn ? t('supply.stock.lotExpires', {date:x.format.date(r.expiresOn,'short')}) : null;
  const used = (r: IngredientRow) => http && r.stock === null ? '—' : x.format.quantity(r.usedToday, r.unit);
  const columns:GridColumn<IngredientRow>[]=[
    {id:'sku',header:t('supply.stock.sku'),kind:'text',minWidth:136,fixedWidth:true,value:r=>r.sku??''},
    {id:'name',header:t('supply.stock.name'),kind:'text',minWidth:180,value:name,editable,sortable:true},
    {id:'stock',header:t('supply.stock.current'),kind:'number',minWidth:160,fixedWidth:true,value:r=>r.stock,render:amount('stock'),accessibleValue:amount('stock'),editable,sortable:true},
    {id:'threshold',header:t('supply.stock.safe'),kind:'number',minWidth:160,fixedWidth:true,value:r=>r.threshold,render:amount('threshold'),accessibleValue:amount('threshold'),editable,sortable:true,help:{id:'stock-safe-help',label:t('supply.stock.helpName',{column:t('supply.stock.safe')}),content:t('supply.stock.helpSafe')}},
    // At 125%, the chip and expiry caption share a line with the cell padding.
    {id:'status',header:t('supply.stock.status'),kind:'computed',minWidth:scale===125?232:192,fixedWidth:true,value:status,render:r=><Flash value={status(r)}><StatusChip tone={r.outOfStock?'danger':r.needsRestock||http&&r.needsReview?'warning':r.trackExpiry?'neutral':'success'}>{status(r)}</StatusChip>{r.trackExpiry?<small>{http ? expiryLabel(r) : t('supply.stock.todayUntil')}</small>:null}</Flash>},
    {id:'used',header:t('supply.stock.used'),kind:'computed',expandOnActivate:()=>true,minWidth:176,fixedWidth:true,value:used,render:r=><Flash slot={`inventory-booking:${r.itemId}:used`} value={r.usedToday}>{used(r)}</Flash>,help:{id:'stock-used-help',label:t('supply.stock.helpName',{column:t('supply.stock.used')}),content:t('supply.stock.helpUsed')}},
    {
      id: 'delivery', header: viewOrder, kind: 'link', minWidth: 280,
      value: row => row.nextDelivery ? viewOrder : '—',
      render: ({ nextDelivery }) => nextDelivery
        ? <ActionButton variant="secondary" className="ms-stock-order"
            onClick={() => host.openLinked({ featureId: 'suppliers', view: 'order', itemId: nextDelivery.poId })}>
            {viewOrder}
          </ActionButton>
        : '—',
    },
  ];
  const q=query.trim().toLocaleLowerCase();let rows=model.ingredients.filter(r=>!q||`${name(r)} ${r.sku??''}`.toLocaleLowerCase().includes(q));
  const rank=(r:IngredientRow)=>r.trackExpiry?3:r.outOfStock?0:r.needsRestock?1:2;
  rows=sortGridRows(rows,columns,sort,r=>r.itemId,(a,b)=>rank(a)-rank(b)||(a.stock??0)/(a.threshold||Infinity)-(b.stock??0)/(b.threshold||Infinity)||name(a).localeCompare(name(b),'ko'));
  const expandOne=(ids:ReadonlySet<string>)=>{const added=[...ids].find(id=>!expanded.has(id));setExpanded(new Set(added?[added]:[...ids].slice(-1)));};

  function trackFocus(next: GridFocus) {
    // DataGrid reports the cell again when editing starts. Preserve its starting value through refreshes.
    const row = next && rows.find(row => row.itemId === next.rowId);
    const column = next && columns.find(column => column.id === next.columnId);
    editStart.current = next && row && column ? { ...next, value: column.value(row) } : undefined;
    setFocus(next);
  }

  function saveResult(result: DataCommandResult) {
    if (!result.ok) { setError(errorText(result)); return; }
    notifyStockResult(host, result, 'data.notice.itemUpdated');
  }
  function confirmDeletion() {
    if (!deletion) return;
    const current = source?.items.find(item => item.itemId === deletion.itemId);
    if (current?.revision !== deletion.revision) {
      setDeletion(undefined);
      setError(x.tk('data.real.error.STALE_REVISION'));
      return;
    }
    send({ type: 'inventory.deleteItem', itemId: deletion.itemId }, result => { setDeletion(undefined); saveResult(result); });
  }
  return <>
    <p>{t('supply.stock.caption')}</p>
    {pending ? <p role="status"><Spinner /> {t('supply.stock.saving')}</p> : null}
    {error ? <p className="ms-error" role="alert"><Icon name="error"/>{error}</p> : null}
    {deletion ? <div role="group" aria-label={t('supply.stock.deleteAction')}>
      <p>{t('supply.stock.deleteConfirm', {name:deletion.name ?? deletion.sku ?? '—'})}</p>
      <ActionButton variant="destructive" loading={pending} onClick={confirmDeletion}>{t('supply.stock.deleteAction')}</ActionButton>
      <ActionButton ref={focusCancel} variant="secondary" disabled={pending} onClick={()=>setDeletion(undefined)}>{x.t('common.close')}</ActionButton>
    </div> : null}
    <DataGrid id="stock-grid" label={t('supply.stock.grid')} rows={rows} getRowId={r=>r.itemId} getRowLabel={name} columns={columns}
      getRowWarning={r=>{const message=warningFor(r);return message?{id:`stock-warning-${r.outOfStock ? 'out-' : ''}${r.itemId}`,message}:null;}}
      query={query} onQueryChange={setQuery} sort={sort} onSortChange={setSort} focus={focus} onFocusChange={trackFocus} selectedRowId={null}
      expandedRowIds={expanded} onExpandedChange={expandOne} getExpandAction={r=>({label:t('supply.stock.expand',{name:name(r)})})} renderExpanded={r=><History row={r} host={host}/>}
      getRowActions={r=>{
        const record = source?.items.find(item => item.itemId === r.itemId);
        const blocked = record ? record.referenced : snapshot.tables.recipeLine.some(line=>line.itemId===r.itemId) || snapshot.tables.purchaseOrderLine.some(line=>line.itemId===r.itemId&&snapshot.tables.purchaseOrder.some(o=>o.poId===line.poId&&['scheduled','partial'].includes(o.status)));
        return [{id:'delete',label:t('supply.stock.delete',{name:name(r)}),disabled:blocked||pending,disabledReason:blocked?t('supply.stock.block'):undefined,onPress:()=>{
          setError(undefined);
          if (record) setDeletion(record);
          else if (!http) saveResult(dispatch({type:'inventory.deleteItem',itemId:r.itemId}));
        }}];
      }}
      addAction={{id:'add',label:t('supply.stock.add'),onPress:()=>setAdd(true)}}
      renderAddRow={()=>add?<NewItem t={t} host={host} prefill={initialAdd ? prefill : undefined} onClose={()=>setAdd(false)}/>:null}
      onCommit={edit=>{
        const value=edit.raw.trim(), number=Number(value);
        const original = editStart.current;
        if (original?.rowId !== edit.rowId || original.columnId !== edit.columnId) return {ok:true};
        if (value === String(original.value ?? '').trim() || (value !== '' && number === original.value)) return {ok:true};
        if(!value||(edit.columnId!=='name'&&(!Number.isFinite(number)||number<0)))return {ok:false,error:{id:edit.editToken,message:t(edit.columnId==='name'?'supply.stock.nameRequired':'supply.stock.numberInvalid')}};
        const command = {type:'inventory.updateItem' as const,itemId:edit.rowId,...(edit.columnId==='name'?{name:value}:edit.columnId==='stock'?{stock:number}:{threshold:number})};
        if (http) {
          setError(undefined);
          send(command, saveResult);
        } else {
          const result = dispatch(command);
          if (!result.ok) return {ok:false,error:{id:edit.editToken,message:errorText(result)}};
          saveResult(result);
        }
        return {ok:true};
      }} noResultsContent={t('supply.stock.noResults')} emptyContent={t('supply.stock.empty')}/>
    {rows.flatMap(r=>(['name','stock','threshold'] as const).map(column=><GridValueSlot key={`${r.itemId}:${column}`} gridId="stock-grid" rowId={r.itemId} columnId={column} slot={`inventory-booking:${r.itemId}:${column}`} value={column==='name'?name(r):r[column]}/>))}
  </>;
}

type Product = InventoryModel['products']['items'][number];

export function ProductGrid({ model, host }: { model: InventoryModel; host: WidgetDetailProps['host'] }) {
  const x = useSupplyText(), { t } = useStockText();
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const source = realStock(snapshot);
  const port = useRealPort();
  const httpPort = port?.mode('stock') === 'http' ? port : undefined;
  const products = model.products;
  const [query, setQuery] = useViewMemory('product.query', () => '');
  const [sort, setSort] = useViewMemory<GridSort>('product.sort', () => null);
  const [focus, setFocus] = useViewMemory<GridFocus>('product.focus', () => null);
  const [expanded, setExpanded] = useViewMemory<ReadonlySet<string>>('product.expanded', () => new Set());
  const itemRecord = new Map(source?.items.map(item => [item.itemId, item]));
  const onlineByItem = new Map(snapshot.tables.inventoryStock.filter(row => row.channel === 'online').map(row => [row.itemId, row.qty]));
  const name = (product: Product) => itemRecord.get(product.itemId)?.name ?? x.tk(product.nameKey);
  const quantity = (product: Product, field: 'store' | 'online' | 'total'): number | null => {
    if (!source) return product[field];
    const item = itemRecord.get(product.itemId);
    const unit = item?.unit ?? null;
    const store = displayQuantity(item?.stock?.availableQuantityBase, unit);
    const online = onlineByItem.get(product.itemId) ?? null;
    return field === 'store' ? store : field === 'online' ? online : store === null || online === null ? null : store + online;
  };
  const quantityColumn = (field: 'store' | 'online' | 'total'): GridColumn<Product> => ({
    id: field, header: t(`supply.stock.${field}`), kind: 'computed', minWidth: 150, value: row => quantity(row, field),
    render: row => {
      const value = quantity(row, field);
      return <Flash slot={`inventory-booking:${row.itemId}:${field}`} value={value}>{value === null ? '—' : x.format.number(value)}</Flash>;
    },
  });
  const status = (row: Product) => quantity(row, 'total') === null ? x.t('widget.inventory-booking.itemNeedsReview')
    : quantity(row, 'total') === 0 ? x.t('widget.inventory-booking.outBadge') : row.lowChannels.length ? x.t('widget.inventory-booking.lowInChannel') : t('supply.stock.sufficient');
  const columns: GridColumn<Product>[] = [
    { id: 'name', header: t('supply.stock.product'), kind: 'text', minWidth: 200, value: name, sortable: true },
    quantityColumn('store'), quantityColumn('online'), quantityColumn('total'),
    { id: 'sales', header: t('supply.stock.sales'), kind: 'computed', minWidth: 180, value: row => source ? '—' : row.sales7d.total },
    { id: 'status', header: t('supply.stock.status'), kind: 'status', minWidth: 176, value: status,
      render: row => <StatusChip tone={quantity(row, 'total') === null ? 'warning' : quantity(row, 'total') === 0 ? 'danger' : row.lowChannels.length ? 'warning' : 'success'}>{status(row)}</StatusChip> },
  ];
  const rows = sortGridRows(products.items.filter(row => name(row).toLowerCase().includes(query.trim().toLowerCase())), columns, sort, row => row.itemId);
  const transfer = (row: Product) => quantity(row, 'total') === null ? <p>{x.tk('data.real.partial')}</p> : <ProductTransfer key={row.itemId} row={row} host={host}/>;
  const known = products.items.every(row => quantity(row, 'total') !== null);
  const combined = (field: 'total' | 'store' | 'online') => products.items.reduce((sum, row) => sum + (quantity(row, field) ?? 0), 0);
  if (!products.items.length) return <p>{x.t('data.state.inventory-booking.no-products')}</p>;
  return <>
    <div className="ms-products__summary">
      {known ? <><p>{x.t('widget.inventory-booking.productsTotal')} <strong>{x.format.count(combined('total'),'pcs')}</strong></p>
        {combined('total') > 0 && <SplitBar a={{label:x.t('widget.inventory-booking.channel.store'),value:combined('store'),display:x.format.count(combined('store'),'pcs')}} b={{label:x.t('widget.inventory-booking.channel.online'),value:combined('online'),display:x.format.count(combined('online'),'pcs')}}/>}</>
        : <p>{x.tk('data.real.partial')}</p>}
      <p>{x.t('widget.inventory-booking.products.note')}</p>
    </div>
    <DataGrid id="product-grid" label={t('supply.stock.products')} rows={rows} columns={columns} getRowId={row=>row.itemId} getRowLabel={name}
      query={query} searchLabel={x.locale==='ko'?t('supply.stock.productSearch'):undefined} searchPlaceholder={x.locale==='ko'?t('supply.stock.productSearch'):undefined}
      onQueryChange={setQuery} sort={sort} onSortChange={setSort} focus={focus} onFocusChange={setFocus} selectedRowId={[...expanded][0]??null}
      expandedRowIds={expanded} onSelectionChange={id=>setExpanded(id?new Set([id]):new Set())}
      renderExpanded={row=>httpPort
        ? <CommerceStock key={row.itemId} transport={httpPort.transport} itemId={row.itemId} unlinked={transfer(row)}
            onSaved={() => { void httpPort.retry('stock'); }} />
        : transfer(row)}
      emptyContent={t('supply.stock.noResults')}/>
  </>;
}

function ProductTransfer({ row, host }: { row: Product; host: WidgetDetailProps['host'] }) {
  const x = useSupplyText(), { t } = useStockText(), errorText = useStockError();
  const { pending, send } = useStockCommand();
  const pressed = useRef(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  return done ? <div role="status">{t('supply.stock.moved')}<ActionButton variant="secondary" onClick={()=>{pressed.current=false;setDone(false);}}>{t('supply.stock.moveAgain')}</ActionButton></div>
    : <>
      <div inert={pending || undefined}><ChannelTransfer store={row.store} online={row.online} unit={unitLabel(x,'pcs')} format={n=>x.format.number(n)} onTransfer={({from, amount})=>{
        if (pressed.current) return;
        pressed.current = true;
        setError(undefined);
        send({type:'inventory.moveChannel',itemId:row.itemId,from,to:from==='store'?'online':'store',qty:amount}, result => {
          if (!result.ok) { pressed.current = false; setError(errorText(result)); return; }
          notifyStockResult(host, result, 'data.notice.channelMoved');
          setDone(true);
        });
      }}/></div>
      {pending ? <p role="status"><Spinner /> {t('supply.stock.saving')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>;
}
