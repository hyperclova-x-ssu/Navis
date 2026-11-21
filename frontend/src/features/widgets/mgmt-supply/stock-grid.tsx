import { useId, useRef, useState, useSyncExternalStore } from 'react';
import type { WidgetDetailProps } from '../../../contracts';
import { useDataDispatch, useWidgetDataStore } from '../../../data/react';
import { TODAY, selectStockHistory, type IngredientRow, type InventoryModel, type UnitCode } from '../../../data/widget-data';
import { inventoryCopy, type InventoryItemPrefill } from '../../assistant/domains/inventory';
import { useBundle } from '../../../i18n';
import { ActionButton, ChannelTransfer, ChipChoice, DataGrid, FieldFrame, Icon, InlineForm, StatusChip, TextField, type GridColumn, type GridFocus, type GridSort, SplitBar } from '../../../ui';
import { newIdempotencyKey, notifyResult, unitLabel, useSupplyText, useTextScale, useViewMemory, sortGridRows, Flash, GridValueSlot } from './shared';

const ko = {
  'supply.stock.product':'상품', 'supply.stock.products':'판매 상품', 'supply.stock.store':'매장', 'supply.stock.online':'온라인', 'supply.stock.total':'합계', 'supply.stock.sales':'최근 7일 판매량',
  'supply.stock.sku':'코드(SKU)', 'supply.stock.name':'이름', 'supply.stock.unit':'단위', 'supply.stock.current':'현재 재고', 'supply.stock.safe':'안전 재고', 'supply.stock.status':'상태', 'supply.stock.used':'오늘 사용량', 'supply.stock.delivery':'발주 보기', 'supply.stock.grid':'원자재', 'supply.stock.add':'품목 추가하기', 'supply.stock.caption':'고친 재고는 변동 기록에 남아요', 'supply.stock.expand':'{name} 재고 변동 기록', 'supply.stock.delete':'{name} 지우기', 'supply.stock.block':'메뉴 레시피나 발주에 쓰는 품목이라 지울 수 없어요', 'supply.stock.numberInvalid':'0 이상의 숫자를 넣어 주세요', 'supply.stock.skuRequired':'코드(SKU)를 넣어 주세요', 'supply.stock.nameRequired':'이름을 넣어 주세요', 'supply.stock.productSearch':'상품 이름으로 찾아보세요', 'supply.stock.recheck':'재고 다시 확인하기', 'supply.stock.menus':'쓰는 메뉴', 'supply.stock.nearest':'가장 가까운 입고', 'supply.stock.history':'재고 변동 기록', 'supply.stock.today':'오늘', 'supply.stock.week':'최근 7일', 'supply.stock.balance':'남은 재고', 'supply.stock.empty':'아직 등록한 품목이 없어요', 'supply.stock.sufficient':'충분', 'supply.stock.noDelivery':'예정된 입고가 없어요', 'supply.stock.initial':'처음 수량', 'supply.stock.excess':'오늘 사용량이 재고보다 {qty} 많아요. 기록을 확인해 주세요', 'supply.stock.helpSafe':'현재 재고가 이만큼 이하로 내려가면 보충 필요로 알려요', 'supply.stock.helpUsed':'메뉴 레시피와 오늘 판매량으로 계산해요',
 'supply.stock.at':'날짜·시각', 'supply.stock.kind':'종류', 'supply.stock.qty':'수량', 'supply.stock.description':'내용', 'supply.stock.opening':'오늘 시작 재고', 'supply.stock.readOnly':'기록은 고칠 수 없어요. 현재 재고를 고치면 직접 고침으로 남아요', 'supply.stock.asOf':'오늘 {time}까지', 'supply.stock.receive':'입고', 'supply.stock.usage':'사용', 'supply.stock.adjust':'직접 고침', 'supply.stock.initialLine':'처음 등록', 'supply.stock.todayUntil':'오늘까지', 'supply.stock.noResults':'찾는 항목이 없어요','supply.stock.moveAgain':'다시 옮기기', 'supply.stock.moved':'재고를 옮겼어요','supply.stock.helpName':'{column} 설명 보기','supply.stock.usageDrink':'{menu} {count}잔','supply.stock.usageItem':'{menu} {count}개',
} as const;
const bundle = {
  id: 'widget.mgmt-supply.stock-grid', ko,
  en: { 'supply.stock.delivery': 'View order' },
  'zh-Hans': { 'supply.stock.delivery': '查看采购单' },
  'zh-Hant': { 'supply.stock.delivery': '查看採購單' },
};
type StockText = ReturnType<typeof useStockText>;
export function useStockText(){ return useBundle(bundle); }

function History({ row, host }: {row: IngredientRow; host:WidgetDetailProps['host']}) {
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const x = useSupplyText(), {t} = useStockText();
  const [period,setPeriod] = useState<'today'|'last7days'>('today');
  const history = selectStockHistory(snapshot,{itemId:row.itemId,period});
  // 잔 for a drink, 개 for anything else on the menu (the category comes from the menu table, not from a name)
  const drinks = new Set(snapshot.tables.menuItem.filter(menu=>menu.category==='drink').map(menu=>menu.menuId));
  const name = x.text(row.name ?? {key:row.nameKey});
  return <div className="ms-stock-expanded">
    <section><h4>{t('supply.stock.menus')}</h4>{row.usingMenus.map(menu=><p key={menu.menuId}><ActionButton variant="link" onClick={()=>host.openLinked({featureId:'menu',itemId:menu.menuId})}>{x.text(menu.name)} · {x.format.quantity(menu.quantity,menu.unit)}</ActionButton></p>)}</section>
    <section><h4>{t('supply.stock.nearest')}</h4>{row.nextDelivery?<ActionButton variant="link" onClick={()=>host.openLinked({featureId:'suppliers',view:'order',itemId:row.nextDelivery!.poId})}>{x.format.quantity(row.nextDelivery.remaining.value,row.nextDelivery.remaining.unit)} · {x.tk(row.nextDelivery.supplierNameKey)}</ActionButton>:<p>{t('supply.stock.noDelivery')}</p>}</section>
    <section className="ms-stock-history"><h4>{t('supply.stock.history')}</h4><ChipChoice label={t('supply.stock.history')} value={period} onChange={setPeriod} options={[{value:'today',label:t('supply.stock.today')},{value:'last7days',label:t('supply.stock.week')}]}/>{history.dayGroups.map(group=><HistoryDay key={group.date} name={name} unit={row.unit} group={group} menus={row.usingMenus} drinks={drinks}/>)}</section>
  </div>;
}
type HistoryGroup = ReturnType<typeof selectStockHistory>['dayGroups'][number];
function HistoryDay({name,unit,group,menus,drinks}:{name:string;unit:IngredientRow['unit'];group:HistoryGroup;menus:IngredientRow['usingMenus'];drinks:ReadonlySet<string>}) {
  const x=useSupplyText(),{t}=useStockText(),[focus,setFocus]=useState<GridFocus>(null);
  type Line = {rowId:string;at:string;kind:string;quantity:string;description:string;balance:number};
  const quantity=(n:number)=>x.format.quantity(Math.abs(n),unit);
  const lines:Line[] = group.rows.filter(line=>group.date===TODAY||line.kind!=='opening').map(line=>{
    const initial=line.description && 'key' in line.description && line.description.key==='data.management.history.initial';
    const kind=initial||line.kind==='opening'?'':line.kind;
    let description=x.text(line.description);
    if(line.kind==='usage') {
      // Counts and source menu come from the shared selector, including the fixed as-of time.
      const params='key' in line.description?line.description.params:undefined;
      const menuKey='key' in line.description?line.description.keyParams?.menu:undefined;
      const currentMenu=menus.find(menu=>menu.menuId===line.sourceRef);
      const menuName=currentMenu?x.text(currentMenu.name):menuKey?x.tk(menuKey):'';
      const menu=menuName?t(drinks.has(String(line.sourceRef))||['data.menu.americano','data.menu.latte','data.menu.vanillaLatte'].includes(menuKey??'')?'supply.stock.usageDrink':'supply.stock.usageItem',{menu:menuName,count:params?.count??0}):description;
      description=menu;
    }
    return {rowId:line.rowId,at:line.asOf?t('supply.stock.asOf',{time:line.asOf}):`${x.locale==='ko'?x.format.date(group.date,'short'):group.date} ${line.at.slice(11,16)}`,kind,quantity:line.kind==='opening'?quantity(line.delta):`${line.delta<0?'−':'+'}${quantity(line.delta)}`,description:initial?t('supply.stock.initialLine'):line.kind==='opening'?t('supply.stock.opening'):description,balance:line.balanceDisplay};
  });
  lines.push({rowId:`ending:${group.date}`,at:'',kind:'',quantity:'',description:t('supply.stock.balance'),balance:group.endingDisplay});
  const reason=t('supply.stock.readOnly');
  const columns:GridColumn<Line>[]=[
    {id:'at',header:t('supply.stock.at'),kind:'computed',minWidth:160,value:r=>r.at,readOnlyReason:reason},
    {id:'kind',header:t('supply.stock.kind'),kind:'computed',minWidth:176,value:r=>r.kind==='usage'?t('supply.stock.usage'):r.kind==='receive'?t('supply.stock.receive'):r.kind==='adjust'?t('supply.stock.adjust'):'',readOnlyReason:reason,render:r=>r.kind?<StatusChip tone={r.kind==='receive'?'success':r.kind==='adjust'?'warning':'neutral'}>{r.kind==='receive'?'+ ':r.kind==='usage'?'− ':'± '}{t(r.kind==='receive'?'supply.stock.receive':r.kind==='usage'?'supply.stock.usage':'supply.stock.adjust')}</StatusChip>:null},
    {id:'quantity',header:t('supply.stock.qty'),kind:'computed',minWidth:120,value:r=>r.quantity,readOnlyReason:reason},
    {id:'description',header:t('supply.stock.description'),kind:'computed',minWidth:200,value:r=>r.description,readOnlyReason:reason},
    {id:'balance',header:t('supply.stock.balance'),kind:'computed',minWidth:130,value:r=>x.format.quantity(r.balance,unit),readOnlyReason:reason},
  ];
  return <div className="ms-history-day"><h5>{x.locale==='ko'?x.format.date(group.date,'short'):group.date}</h5><DataGrid id={`history-${group.rows[0]?.itemId}-${group.date}`} label={`${name} ${t('supply.stock.history')} ${x.locale==='ko'?x.format.date(group.date,'short'):group.date}`} rows={lines} columns={columns} getRowId={r=>r.rowId} getRowLabel={r=>r.description} sort={null} onSortChange={()=>{}} focus={focus} onFocusChange={setFocus} selectedRowId={null} expandedRowIds={new Set()} emptyContent=""/></div>;
}
export function NewItem({onClose,host,t,prefill}:{onClose:()=>void;host:WidgetDetailProps['host'];t:StockText['t'];prefill?:InventoryItemPrefill}){
  const dispatch=useDataDispatch(),x=useSupplyText(),unitId=useId();
  const [sku,setSku]=useState(prefill?.sku ?? ''),[name,setName]=useState(prefill?.name ?? '');
  const [unit,setUnit]=useState<UnitCode>(prefill?.unit ?? 'pcs');
  const [stock,setStock]=useState(String(prefill?.stock ?? 0)),[threshold,setThreshold]=useState(String(prefill?.threshold ?? 0));
  const labels = inventoryCopy[x.locale];
  type Errors={sku?:string;name?:string;stock?:string;threshold?:string;form?:string};
  const [errors,setErrors]=useState<Errors>({});
  const [key]=useState(()=>newIdempotencyKey('stock'));
  const clear=(field:keyof Errors)=>setErrors(e=>e[field]?{...e,[field]:undefined}:e);
  const save=()=>{
    const s=Number(stock),v=Number(threshold),bad=(raw:string,n:number)=>!raw.trim()||!Number.isFinite(n)||n<0;
    const next:Errors={...(!sku.trim()?{sku:t('supply.stock.skuRequired')}:{}),...(!name.trim()?{name:t('supply.stock.nameRequired')}:{}),...(bad(stock,s)?{stock:t('supply.stock.numberInvalid')}:{}),...(bad(threshold,v)?{threshold:t('supply.stock.numberInvalid')}:{})};
    setErrors(next);
    if(Object.keys(next).length)return;
    const result=dispatch({type:'inventory.createItem',sku,name,unit,stock:s,threshold:v,idempotencyKey:key,
      ...(prefill?.trackRestock !== undefined ? {trackRestock:prefill.trackRestock} : {})});
    if(!result.ok){const message=x.tk(result.messageKey);setErrors(result.field==='sku'||result.field==='name'||result.field==='stock'||result.field==='threshold'?{[result.field]:message}:{form:message});return;}
    notifyResult(host,result,'data.notice.itemUpdated');onClose();
  };
  return <InlineForm title={t('supply.stock.add')} onClose={onClose} saveLabel={x.t('common.saveAction')} closeLabel={x.t('common.close')} onSave={save}>
    <div className="ms-form-grid">
      <TextField label={labels.sku} value={sku} onValueChange={v=>{setSku(v);clear('sku');}} error={errors.sku} name="sku"/>
      <TextField label={labels.name} value={name} onValueChange={v=>{setName(v);clear('name');}} error={errors.name} name="name"/>
      <FieldFrame label={labels.unit} fieldId={unitId}><select id={unitId} className="ui-text-input" value={unit} onChange={event=>setUnit(event.target.value as UnitCode)}>
        {(['pcs', 'kg', 'g', 'L', 'mL'] as const).map(option=><option key={option} value={option}>{unitLabel(x,option)}</option>)}
      </select></FieldFrame>
      <TextField label={t('supply.stock.initial')} value={stock} onValueChange={v=>{setStock(v);clear('stock');}} error={errors.stock} inputMode="decimal" name="stock"/>
      <TextField label={t('supply.stock.safe')} value={threshold} onValueChange={v=>{setThreshold(v);clear('threshold');}} error={errors.threshold} inputMode="decimal" name="threshold"/>
    </div>
    {errors.form?<p className="ms-error" role="alert"><Icon name="error"/>{errors.form}</p>:null}
  </InlineForm>;
}
export function StockGrid({model,host,initialAdd=false,initialItemId,prefill}:{model:InventoryModel;host:WidgetDetailProps['host'];initialAdd?:boolean;initialItemId?:string;prefill?:InventoryItemPrefill}){
  const store=useWidgetDataStore(),snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot),dispatch=useDataDispatch(),x=useSupplyText(),{t}=useStockText(),scale=useTextScale();
  const [query,setQuery]=useViewMemory('stock.query',()=>''),[sort,setSort]=useViewMemory<GridSort>('stock.sort',()=>null);
  const [focus,setFocus]=useViewMemory<GridFocus>('stock.focus',()=>initialItemId ? {rowId:initialItemId,columnId:'$expand'} : null);
  const [expanded,setExpanded]=useViewMemory<ReadonlySet<string>>('stock.expanded',()=>new Set(initialItemId ? [initialItemId] : []));
  const [add,setAdd]=useState(initialAdd);
  const name=(r:IngredientRow)=>x.text(r.name??{key:r.nameKey});
  const viewOrder = t('supply.stock.delivery');
  const warningFor=(r:IngredientRow)=>r.deficit>0?t('supply.stock.excess',{qty:x.format.quantity(r.deficit,r.unit)}):r.needsReview||r.stock===null||!Number.isFinite(r.stock)||r.stock<0||r.threshold!==null&&(!Number.isFinite(r.threshold)||r.threshold<0)?x.t('widget.inventory-booking.needsReview'):null;
  const amount=(field:'stock'|'threshold')=>(r:IngredientRow)=>r[field]===null?'—':x.format.quantity(r[field],r.unit);
  const columns:GridColumn<IngredientRow>[]=[
    {id:'sku',header:t('supply.stock.sku'),kind:'text',minWidth:136,fixedWidth:true,value:r=>r.sku??''},
    {id:'name',header:t('supply.stock.name'),kind:'text',minWidth:180,value:name,editable:()=>true,sortable:true},
    {id:'stock',header:t('supply.stock.current'),kind:'number',minWidth:160,fixedWidth:true,value:r=>r.stock,render:amount('stock'),accessibleValue:amount('stock'),editable:()=>true,sortable:true},
    {id:'threshold',header:t('supply.stock.safe'),kind:'number',minWidth:160,fixedWidth:true,value:r=>r.threshold,render:amount('threshold'),accessibleValue:amount('threshold'),editable:()=>true,sortable:true,help:{id:'stock-safe-help',label:t('supply.stock.helpName',{column:t('supply.stock.safe')}),content:t('supply.stock.helpSafe')}},
    // At 125%, the chip and expiry caption share a line with the cell padding.
    {id:'status',header:t('supply.stock.status'),kind:'computed',minWidth:scale===125?232:192,fixedWidth:true,value:r=>r.trackExpiry?x.t('widget.inventory-booking.expiry.badge'):r.outOfStock?x.t('widget.inventory-booking.outBadge'):r.needsRestock?x.t('widget.inventory-booking.restockNeeded'):t('supply.stock.sufficient'),render:r=><Flash value={`${r.outOfStock}:${r.needsRestock}:${r.trackExpiry}`}><StatusChip tone={r.outOfStock?'danger':r.needsRestock?'warning':r.trackExpiry?'neutral':'success'}>{r.trackExpiry?x.t('widget.inventory-booking.expiry.badge'):r.outOfStock?x.t('widget.inventory-booking.outBadge'):r.needsRestock?x.t('widget.inventory-booking.restockNeeded'):t('supply.stock.sufficient')}</StatusChip>{r.trackExpiry?<small>{t('supply.stock.todayUntil')}</small>:null}</Flash>},
    {id:'used',header:t('supply.stock.used'),kind:'computed',expandOnActivate:()=>true,minWidth:176,fixedWidth:true,value:r=>x.format.quantity(r.usedToday,r.unit),render:r=><Flash slot={`inventory-booking:${r.itemId}:used`} value={r.usedToday}>{x.format.quantity(r.usedToday,r.unit)}</Flash>,help:{id:'stock-used-help',label:t('supply.stock.helpName',{column:t('supply.stock.used')}),content:t('supply.stock.helpUsed')}},
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

  return <><p>{t('supply.stock.caption')}</p><DataGrid id="stock-grid" label={t('supply.stock.grid')} rows={rows} getRowId={r=>r.itemId} getRowLabel={name} columns={columns} getRowWarning={r=>{const message=warningFor(r);return message?{id:`stock-warning-${r.outOfStock ? "out-" : ""}${r.itemId}`,message}:null;}} query={query} onQueryChange={setQuery} sort={sort} onSortChange={setSort} focus={focus} onFocusChange={setFocus} selectedRowId={null} expandedRowIds={expanded} onExpandedChange={expandOne} getExpandAction={r=>({label:t('supply.stock.expand',{name:name(r)})})} renderExpanded={r=><History row={r} host={host}/>} getRowActions={r=>{const blocked=snapshot.tables.recipeLine.some(line=>line.itemId===r.itemId)||snapshot.tables.purchaseOrderLine.some(line=>line.itemId===r.itemId&&snapshot.tables.purchaseOrder.some(o=>o.poId===line.poId&&['scheduled','partial'].includes(o.status)));return [{id:'delete',label:t('supply.stock.delete',{name:name(r)}),disabled:blocked,disabledReason:blocked?t('supply.stock.block'):undefined,onPress:()=>{const result=dispatch({type:'inventory.deleteItem',itemId:r.itemId});if(result.ok)notifyResult(host,result,'data.notice.itemUpdated');}}];}} addAction={{id:'add',label:t('supply.stock.add'),onPress:()=>setAdd(true)}} renderAddRow={()=>add?<NewItem t={t} host={host} prefill={initialAdd ? prefill : undefined} onClose={()=>setAdd(false)}/>:null} onCommit={edit=>{const value=edit.raw.trim();const number=Number(value);if(!value||(edit.columnId!=='name'&&(!Number.isFinite(number)||number<0)))return {ok:false,error:{id:edit.editToken,message:t(edit.columnId==='name'?'supply.stock.nameRequired':'supply.stock.numberInvalid')}};const result=dispatch({type:'inventory.updateItem',itemId:edit.rowId,...(edit.columnId==='name'?{name:value}:edit.columnId==='stock'?{stock:number}:{threshold:number})});if(!result.ok)return {ok:false,error:{id:edit.editToken,message:x.tk(result.messageKey)}};notifyResult(host,result,'data.notice.itemUpdated');return {ok:true};}} noResultsContent={t('supply.stock.noResults')} emptyContent={t('supply.stock.empty')}/>{rows.flatMap(r=>(['name','stock','threshold'] as const).map(column=><GridValueSlot key={`${r.itemId}:${column}`} gridId="stock-grid" rowId={r.itemId} columnId={column} slot={`inventory-booking:${r.itemId}:${column}`} value={column==='name'?name(r):r[column]}/>))}</>;
}

export function ProductGrid({model,host,onRegister}:{model:InventoryModel;host:WidgetDetailProps['host'];onRegister:()=>void}){
 const x=useSupplyText(),{t}=useStockText(),dispatch=useDataDispatch();
 const [query,setQuery]=useViewMemory('product.query',()=>''),[sort,setSort]=useViewMemory<GridSort>('product.sort',()=>null),[focus,setFocus]=useViewMemory<GridFocus>('product.focus',()=>null),[expanded,setExpanded]=useViewMemory<ReadonlySet<string>>('product.expanded',()=>new Set());
 type Product=InventoryModel['products']['items'][number];
 const columns:GridColumn<Product>[]=[{id:'name',header:t('supply.stock.product'),kind:'text',minWidth:200,value:r=>x.tk(r.nameKey),sortable:true},{id:'store',header:t('supply.stock.store'),kind:'computed',minWidth:150,value:r=>r.store,render:r=><Flash slot={`inventory-booking:${r.itemId}:store`} value={r.store}>{x.format.number(r.store)}</Flash>},{id:'online',header:t('supply.stock.online'),kind:'computed',minWidth:150,value:r=>r.online,render:r=><Flash slot={`inventory-booking:${r.itemId}:online`} value={r.online}>{x.format.number(r.online)}</Flash>},{id:'total',header:t('supply.stock.total'),kind:'computed',minWidth:150,value:r=>r.total,render:r=><Flash slot={`inventory-booking:${r.itemId}:total`} value={r.total}>{x.format.number(r.total)}</Flash>},{id:'sales',header:t('supply.stock.sales'),kind:'computed',minWidth:180,value:r=>r.sales7d.total},{id:'status',header:t('supply.stock.status'),kind:'status',minWidth:176,value:r=>r.total===0?x.t('widget.inventory-booking.outBadge'):r.lowChannels.length?x.t('widget.inventory-booking.lowInChannel'):t('supply.stock.sufficient'),render:r=><StatusChip tone={r.total===0?'danger':r.lowChannels.length?'warning':'success'}>{r.total===0?x.t('widget.inventory-booking.outBadge'):r.lowChannels.length?x.t('widget.inventory-booking.lowInChannel'):t('supply.stock.sufficient')}</StatusChip>}];
 let rows=model.products.items.filter(r=>x.tk(r.nameKey).toLowerCase().includes(query.trim().toLowerCase()));rows=sortGridRows(rows,columns,sort,r=>r.itemId);
 return <><div className="ms-products__summary"><p>{x.t('widget.inventory-booking.productsTotal')} <strong>{x.format.count(model.products.total,'pcs')}</strong></p><SplitBar a={{label:x.t('widget.inventory-booking.channel.store'),value:model.products.byChannel.store,display:x.format.count(model.products.byChannel.store,'pcs')}} b={{label:x.t('widget.inventory-booking.channel.online'),value:model.products.byChannel.online,display:x.format.count(model.products.byChannel.online,'pcs')}}/><p>{x.t('widget.inventory-booking.products.note')}</p></div><DataGrid id="product-grid" label={t('supply.stock.products')} rows={rows} columns={columns} getRowId={r=>r.itemId} getRowLabel={r=>x.tk(r.nameKey)} query={query} searchLabel={x.locale==='ko'?t('supply.stock.productSearch'):undefined} searchPlaceholder={x.locale==='ko'?t('supply.stock.productSearch'):undefined} onQueryChange={setQuery} sort={sort} onSortChange={setSort} focus={focus} onFocusChange={setFocus} selectedRowId={[...expanded][0]??null} expandedRowIds={expanded} onSelectionChange={id=>setExpanded(id?new Set([id]):new Set())} renderExpanded={r=><ProductTransfer key={r.itemId} row={r} onTransfer={(from,qty)=>{const result=dispatch({type:'inventory.moveChannel',itemId:r.itemId,from,to:from==='store'?'online':'store',qty});if(result.ok)notifyResult(host,result,'data.notice.channelMoved');return result.ok;}}/>} emptyContent={<div>{x.t('data.state.inventory-booking.no-products')}<ActionButton onClick={onRegister}>{x.t('widget.inventory-booking.registerProduct')}</ActionButton></div>}/></>;
}
function ProductTransfer({row,onTransfer}:{row:InventoryModel['products']['items'][number];onTransfer:(from:'store'|'online',qty:number)=>boolean}){
 const x=useSupplyText(),{t}=useStockText(),pressed=useRef(false),[done,setDone]=useState(false);
 return done?<div role="status">{t('supply.stock.moved')}<ActionButton variant="secondary" onClick={()=>{pressed.current=false;setDone(false);}}>{t('supply.stock.moveAgain')}</ActionButton></div>:<ChannelTransfer store={row.store} online={row.online} unit={unitLabel(x,'pcs')} format={n=>x.format.number(n)} onTransfer={v=>{if(pressed.current)return;pressed.current=true;if(onTransfer(v.from,v.amount))setDone(true);else pressed.current=false;}}/>;
}
