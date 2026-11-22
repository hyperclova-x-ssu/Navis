import { useState, useSyncExternalStore } from 'react';
import type { WidgetDetailProps } from '../../../contracts';
import { useWidgetDataStore } from '../../../data/react';
import type { PurchaseItem, SupplierPatch } from '../../../data/widget-data';
import { useBundle } from '../../../i18n';
import { ActionButton, DataGrid, Icon, InlineForm, Spinner, TextField, type GridColumn, type GridCommit, type GridCommitResult, type GridFocus, type GridSort } from '../../../ui';
import { notifyPurchase, useFormClose, usePurchaseCommand, usePurchaseKey, type PurchaseCommand } from './purchase-grid.commands';
import { GridValueSlot, sortGridRows, unitLabel, useSupplyText, useViewMemory } from './shared';
const ko={'supply.purchase.items':'발주 품목','supply.purchase.supplier':'발주사','supply.purchase.minimum':'최소 주문 수량','supply.purchase.price':'단가','supply.purchase.step':'주문 단위','supply.purchase.lead':'입고 예정','supply.purchase.contact':'담당','supply.purchase.phone':'연락처','supply.purchase.memo':'메모','supply.purchase.products':'공급 품목','supply.purchase.add':'발주사 추가하기','supply.purchase.delete':'{name} 지우기','supply.purchase.block':'입고 대기 주문이나 발주 품목에 쓰는 발주사라 지울 수 없어요','supply.purchase.invalid':'0 이상의 숫자를 넣어 주세요','supply.purchase.supplierRequired':'발주사 이름을 넣어 주세요','supply.purchase.noMemo':'메모 없음','supply.purchase.productsReason':'공급 품목은 발주 품목 표에서 고쳐요','supply.purchase.empty':'등록된 항목이 없어요','supply.purchase.addItem':'발주 품목 추가하기','supply.purchase.item':'품목','supply.purchase.itemBlock':'메뉴 레시피의 유일한 단가라 지울 수 없어요','supply.purchase.noResults':'찾는 항목이 없어요','supply.purchase.nextDay':'주문 다음 날','supply.purchase.afterDays':'주문 후 {n}일','supply.purchase.openBlock':'입고 대기 주문이 있는 발주사라 지울 수 없어요'} as const;
const bundle={id:'widget.mgmt-supply.purchase-v5',ko:{
 ...ko, 'supply.purchase.saving':'저장하는 중이에요', 'supply.purchase.deleteConfirm':'{name}을 지울까요?',
 'supply.purchase.deleteAction':'지우기 확인',
 },en:{'supply.purchase.saving':'Saving', 'supply.purchase.deleteConfirm':'Delete {name}?', 'supply.purchase.deleteAction':'Confirm deletion'},'zh-Hans':{},'zh-Hant':{}};
function useGridState(prefix:string,initialRowId?:string,initialColumnId='item'){const [query,setQuery]=useViewMemory(`${prefix}.query`,()=>''),[sort,setSort]=useViewMemory<GridSort>(`${prefix}.sort`,()=>null),[focus,setFocus]=useViewMemory<GridFocus>(`${prefix}.focus`,()=>initialRowId?{rowId:initialRowId,columnId:initialColumnId}:null);return {query,setQuery,sort,setSort,focus,setFocus};}

function useGridCommands(host: WidgetDetailProps['host']) {
 const { http, pending, run } = usePurchaseCommand();
 const x = useSupplyText();
 const { t } = useBundle(bundle);
 const store = useWidgetDataStore();
 const [error, setError] = useState('');
 const [cellError, setCellError] = useState<{rowId: string; columnId: string; error: {id: string; message: string}}>();
 const [deletion, setDeletion] = useState<{ name: string; command: PurchaseCommand; revision: number }>();

 function commit(edit: GridCommit, command: PurchaseCommand): GridCommitResult {
  if (pending) return { ok: false, error: { id: edit.editToken, message: t('supply.purchase.saving') } };
  let outcome: GridCommitResult = { ok: true };
  const errorAtCell = (message: string) => ({ id: edit.editToken, message });
  setCellError(undefined);
  run(command, result => {
   if (result.ok) { notifyPurchase(host, result, 'data.notice.itemUpdated'); return; }
   const error = errorAtCell(x.tk(result.messageKey));
   if (http) setCellError({ rowId: edit.rowId, columnId: edit.columnId, error });
   else outcome = { ok: false, error };
  });
  return outcome;
 }

 function requestDelete(name: string, command: PurchaseCommand) {
  setError('');
  setDeletion({ name, command, revision: store.getSnapshot().revision });
 }

 function confirmDelete() {
  if (!deletion) return;
  if (store.getSnapshot().revision !== deletion.revision) {
   setDeletion(undefined);
   setError(x.tk('data.real.error.STALE_REVISION'));
   return;
  }
  run(deletion.command, result => {
   setDeletion(undefined);
   if (result.ok) notifyPurchase(host, result, 'data.management.notice.deleted');
   else setError(x.tk(result.messageKey));
  });
 }

 const feedback = <>
  {pending ? <p role="status"><Spinner /> {t('supply.purchase.saving')}</p> : null}
  {error ? <p role="alert" className="ms-error">{error}</p> : null}
  {deletion ? <div role="group" aria-label={t('supply.purchase.deleteAction')}>
   <p>{t('supply.purchase.deleteConfirm', { name: deletion.name })}</p>
   <ActionButton variant="destructive" loading={pending} onClick={confirmDelete}>{t('supply.purchase.deleteAction')}</ActionButton>
   <ActionButton variant="secondary" onClick={() => setDeletion(undefined)}>{x.t('common.close')}</ActionButton>
  </div> : null}
 </>;
 return { commit, pending, requestDelete, feedback, cellError, dismissError: () => setCellError(undefined) };
}

export function PurchaseGrid({host,initialRowId}:{host:WidgetDetailProps['host'];initialRowId?:string}){
 const store=useWidgetDataStore(),snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot),actions=useGridCommands(host),x=useSupplyText(),{t}=useBundle(bundle),s=useGridState('purchase',initialRowId),[add,setAdd]=useState(false);
 const item=(p:PurchaseItem)=>{const i=snapshot.tables.inventoryItem.find(v=>v.itemId===p.itemId);return i?x.text(i.name??{key:i.nameKey}):'';};
 const supplier=(p:PurchaseItem)=>{const v=snapshot.tables.supplier.find(v=>v.supplierId===p.supplierId);return v?x.text(v.name??{key:v.nameKey}):'';};
 const columns:GridColumn<PurchaseItem>[]=[{id:'item',header:t('supply.purchase.items'),kind:'text',minWidth:200,value:item,sortable:true},{id:'supplierId',header:t('supply.purchase.supplier'),kind:'text',minWidth:180,value:r=>r.supplierId,render:supplier,editable:()=>true,editor:'select',options:snapshot.tables.supplier.filter(v=>!v.deletedAt).map(v=>({value:v.supplierId,label:x.text(v.name??{key:v.nameKey})}))},...(['minimumQty','unitPrice','orderStep','leadDays'] as const).map((id,i)=>({id,header:t((['supply.purchase.minimum','supply.purchase.price','supply.purchase.step','supply.purchase.lead'] as const)[i]!),kind:'number' as const,minWidth:150,value:(r:PurchaseItem)=>r[id],render:(r:PurchaseItem)=>{const stock=snapshot.tables.inventoryItem.find(v=>v.itemId===r.itemId),unit=r.purchaseUnit??stock?.unit??'pcs';return id==='unitPrice'?`${x.format.money(r[id],'full')}/${unitLabel(x,unit)}`:id==='leadDays'?t(r[id]===1?'supply.purchase.nextDay':'supply.purchase.afterDays',{n:r[id]}):x.format.quantity(r[id],unit);},editable:()=>true,sortable:true}))];
 let rows=snapshot.tables.purchaseItem.filter(p=>`${item(p)} ${supplier(p)}`.toLowerCase().includes(s.query.trim().toLowerCase()));rows=sortGridRows(rows,columns,s.sort,r=>r.purchaseItemId);
 return <>{actions.feedback}<DataGrid id="purchase-grid" label={t('supply.purchase.items')} rows={rows} columns={columns} getRowId={r=>r.purchaseItemId} getRowLabel={item} query={s.query} searchLabel={x.locale==='ko'?'품목 이름으로 찾아보세요':undefined} searchPlaceholder={x.locale==='ko'?'품목 이름으로 찾아보세요':undefined} onQueryChange={s.setQuery} sort={s.sort} onSortChange={s.setSort} focus={s.focus} onFocusChange={s.setFocus} selectedRowId={initialRowId??null} expandedRowIds={new Set()} error={actions.cellError} onErrorDismiss={actions.dismissError}
 addAction={{id:'add',label:t('supply.purchase.addItem'),onPress:()=>setAdd(true),disabled:!snapshot.tables.inventoryItem.some(i=>i.kind==='ingredient'&&!i.deletedAt)||!snapshot.tables.supplier.some(v=>!v.deletedAt)}} renderAddRow={()=>add?<AddPurchase host={host} onClose={()=>setAdd(false)}/>:null} getRowActions={r=>{
 const blocked=snapshot.tables.recipeLine.some(l=>l.itemId===r.itemId)&&snapshot.tables.purchaseItem.filter(p=>p.itemId===r.itemId).length===1;
 return [{id:'delete',label:t('supply.purchase.delete',{name:item(r)}),disabled:blocked||actions.pending,disabledReason:blocked?t('supply.purchase.itemBlock'):undefined,onPress:()=>actions.requestDelete(item(r),{type:'suppliers.deletePurchaseItem',purchaseItemId:r.purchaseItemId})}];
 }} onCommit={e=>{const v=e.raw.trim(),numeric=e.columnId!=='supplierId',n=Number(v);if(!v||(numeric&&(!Number.isFinite(n)||n<0)))return {ok:false,error:{id:e.editToken,message:t('supply.purchase.invalid')}};return actions.commit(e,{type:'suppliers.updatePurchaseItem',purchaseItemId:e.rowId,patch:{[e.columnId]:numeric?n:v}});}} noResultsContent={t('supply.purchase.noResults')} emptyContent={t('supply.purchase.empty')}/>{rows.flatMap(r=>(['supplierId','minimumQty','unitPrice','orderStep','leadDays'] as const).map(column=><GridValueSlot key={`${r.purchaseItemId}:${column}`} gridId="purchase-grid" rowId={r.purchaseItemId} columnId={column} slot={`suppliers:purchase:${r.purchaseItemId}:${column}`} value={r[column]}/>))}</>;
}
export function AddSupplier({host,onClose}:{host:WidgetDetailProps['host'];onClose:()=>void}){
 const {t}=useBundle(bundle),x=useSupplyText(),{run,pending}=usePurchaseCommand(),[name,setName]=useState(''),[contact,setContact]=useState(''),[phone,setPhone]=useState(''),[memo,setMemo]=useState(''),[error,setError]=useState('');
 const key=usePurchaseKey('supplier');
 const close=useFormClose(onClose);
 return <InlineForm title={t('supply.purchase.add')} onClose={close} closeLabel={x.t('common.close')} saveLabel={x.t('common.saveAction')} saving={pending} onSave={()=>{
  if(!name.trim()){setError(t('supply.purchase.supplierRequired'));return;}
  setError('');
  run({type:'suppliers.createSupplier',name,contact,phone,memo,idempotencyKey:key},result=>{
   if(!result.ok){setError(x.tk(result.messageKey));return;}
   notifyPurchase(host,result,'data.notice.itemUpdated');close();
  });
 }}><div className="ms-form-grid"><TextField label={t('supply.purchase.supplier')} name="supplier-name" value={name} disabled={pending} onValueChange={v=>{setName(v);setError('');}}/><TextField label={t('supply.purchase.contact')} name="contact" value={contact} disabled={pending} onValueChange={setContact}/><TextField label={t('supply.purchase.phone')} name="phone" value={phone} disabled={pending} onValueChange={setPhone}/><TextField label={t('supply.purchase.memo')} name="memo" value={memo} disabled={pending} onValueChange={setMemo}/></div>{error?<p className="ms-error" role="alert"><Icon name="error"/>{error}</p>:null}</InlineForm>;
}
export function SupplierGrid({host,initialAdd=false,initialRowId}:{host:WidgetDetailProps['host'];initialAdd?:boolean;initialRowId?:string}){
 const store=useWidgetDataStore(),snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot),actions=useGridCommands(host),x=useSupplyText(),{t}=useBundle(bundle),s=useGridState('supplier',initialRowId,'name'),[add,setAdd]=useState(initialAdd);
 type Row=(typeof snapshot.tables.supplier)[number];const name=(r:Row)=>x.text(r.name??{key:r.nameKey});
 const supplied=(r:Row)=>snapshot.tables.purchaseItem.filter(p=>p.supplierId===r.supplierId).map(p=>{const i=snapshot.tables.inventoryItem.find(i=>i.itemId===p.itemId);return i?x.text(i.name??{key:i.nameKey}):'';}).join(', ');
 const contact=(r:Row)=>x.text(r.contact??{key:r.contactKey});
 const oldPlaceholder=(r:Row)=>/^가상 담당자 [1-5]$/.test(contact(r)) && /^02-\*{4}-000[0-4]$/.test(r.phoneMask);
 const phone=(r:Row)=>oldPlaceholder(r) && !r.phone ? '' : r.phoneMask;
 const memo=(r:Row)=>{
  const value=x.text(r.memo);
  return value==='가상 거래처; 실제 연락/발주 금지' ? '' : value;
 };
 const columns: GridColumn<Row>[] = [
  {id:'name',header:t('supply.purchase.supplier'),kind:'text',minWidth:240,fixedWidth:true,value:name,editable:()=>true,sortable:true},
  {id:'contact',header:t('supply.purchase.contact'),kind:'text',minWidth:160,fixedWidth:true,value:r=>oldPlaceholder(r)?'':contact(r),editable:()=>true},
  {id:'phone',header:t('supply.purchase.phone'),kind:'text',minWidth:180,fixedWidth:true,value:r=>r.phone??phone(r),render:r=>phone(r)||'—',accessibleValue:r=>phone(r)||'—',editable:()=>true},
  {id:'products',header:t('supply.purchase.products'),kind:'text',minWidth:320,readOnlyReason:t('supply.purchase.productsReason'),value:supplied,render:r=><span className="ms-wrap">{supplied(r)}</span>},
  {id:'memo',header:t('supply.purchase.memo'),kind:'text',minWidth:240,value:memo,render:r=><span className="ms-wrap">{memo(r)||<span className="ms-muted">{t('supply.purchase.noMemo')}</span>}</span>,editable:()=>true},
 ];
 let rows=snapshot.tables.supplier.filter(r=>!r.deletedAt&&name(r).toLowerCase().includes(s.query.trim().toLowerCase()));rows=sortGridRows(rows,columns,s.sort,r=>r.supplierId);
 return <>{actions.feedback}<DataGrid id="suppliers-grid" label={t('supply.purchase.supplier')} rows={rows} columns={columns} getRowId={r=>r.supplierId} getRowLabel={name} query={s.query} searchLabel={x.locale==='ko'?'발주사 이름으로 찾아보세요':undefined} searchPlaceholder={x.locale==='ko'?'발주사 이름으로 찾아보세요':undefined} onQueryChange={s.setQuery} sort={s.sort} onSortChange={s.setSort} focus={s.focus} onFocusChange={s.setFocus} selectedRowId={initialRowId??null} expandedRowIds={new Set()} error={actions.cellError} onErrorDismiss={actions.dismissError}
 addAction={{id:'add',label:t('supply.purchase.add'),onPress:()=>setAdd(true)}} renderAddRow={()=>add?<AddSupplier host={host} onClose={()=>setAdd(false)}/>:null} getRowActions={r=>{
  const open=snapshot.tables.purchaseOrder.some(o=>o.supplierId===r.supplierId&&['scheduled','partial'].includes(o.status));
  const blocked=open||snapshot.tables.purchaseItem.some(p=>p.supplierId===r.supplierId);
  return [{id:'delete',label:t('supply.purchase.delete',{name:name(r)}),disabled:blocked||actions.pending,disabledReason:blocked?t(open?'supply.purchase.openBlock':'supply.purchase.block'):undefined,
   onPress:()=>actions.requestDelete(name(r),{type:'suppliers.deleteSupplier',supplierId:r.supplierId})}];
 }} onCommit={e=>actions.commit(e,{type:'suppliers.updateSupplier',supplierId:e.rowId,patch:{[e.columnId]:e.raw} as SupplierPatch})} noResultsContent={t('supply.purchase.noResults')} emptyContent={t('supply.purchase.empty')}/></>;
}

function AddPurchase({host,onClose}:{host:WidgetDetailProps['host'];onClose:()=>void}){
 const {t}=useBundle(bundle),x=useSupplyText(),store=useWidgetDataStore(),{run,pending}=usePurchaseCommand(),snapshot=store.getSnapshot();
 const [itemId,setItem]=useState(snapshot.tables.inventoryItem.find(i=>i.kind==='ingredient'&&!i.deletedAt)?.itemId??''),[supplierId,setSupplier]=useState(snapshot.tables.supplier.find(s=>!s.deletedAt)?.supplierId??'');
 const [minimumQty,setMinimum]=useState('1'),[unitPrice,setPrice]=useState('0'),[orderStep,setStep]=useState('1'),[leadDays,setLead]=useState('1'),[error,setError]=useState('');
 const key=usePurchaseKey('purchase');
 const close=useFormClose(onClose);
 return <InlineForm title={t('supply.purchase.addItem')} onClose={close} saveLabel={x.t('common.saveAction')} closeLabel={x.t('common.close')} saving={pending} saveDisabled={!itemId||!supplierId} onSave={()=>{
  if([minimumQty,unitPrice,orderStep,leadDays].some(v=>!v.trim()||!Number.isFinite(Number(v)))){setError(t('supply.purchase.invalid'));return;}
  setError('');
  run({type:'suppliers.createPurchaseItem',itemId,supplierId,minimumQty:Number(minimumQty),unitPrice:Number(unitPrice),orderStep:Number(orderStep),leadDays:Number(leadDays),idempotencyKey:key},result=>{
   if(!result.ok){setError(x.tk(result.messageKey));return;}
   notifyPurchase(host,result,'data.management.notice.saved');close();
  });
 }}><label>{t('supply.purchase.item')}<select value={itemId} disabled={pending} onChange={e=>setItem(e.target.value)}>{snapshot.tables.inventoryItem.filter(i=>i.kind==='ingredient'&&!i.deletedAt).map(i=><option key={i.itemId} value={i.itemId}>{x.text(i.name??{key:i.nameKey})}</option>)}</select></label>
 <label>{t('supply.purchase.supplier')}<select value={supplierId} disabled={pending} onChange={e=>setSupplier(e.target.value)}>{snapshot.tables.supplier.filter(s=>!s.deletedAt).map(s=><option key={s.supplierId} value={s.supplierId}>{x.text(s.name??{key:s.nameKey})}</option>)}</select></label>
 <div className="ms-form-grid"><TextField label={t('supply.purchase.minimum')} name="minimumQty" value={minimumQty} disabled={pending} onValueChange={setMinimum} inputMode="decimal"/><TextField label={t('supply.purchase.price')} name="unitPrice" value={unitPrice} disabled={pending} onValueChange={setPrice} inputMode="decimal"/><TextField label={t('supply.purchase.step')} name="orderStep" value={orderStep} disabled={pending} onValueChange={setStep} inputMode="decimal"/><TextField label={t('supply.purchase.lead')} name="leadDays" value={leadDays} disabled={pending} onValueChange={setLead} inputMode="numeric"/></div>{error?<p className="ms-error" role="alert"><Icon name="error"/>{error}</p>:null}</InlineForm>;
}
