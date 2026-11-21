import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { WidgetDetailProps, WidgetPanelProps } from '../../../contracts';
import { useBundle } from '../../../i18n';
import type { MessageBundle } from '../../../i18n';
import type { CatalogItem } from '../../../../../backend/packages/contracts';
import { reloadBackendCatalog, useBackendCatalog, isHttpCatalogEnabled } from '../../../data/backend-catalog/react';
import { useKitT } from '../../../ui/kit-i18n';
import { dataBundles, resolveDataText, deriveStock, TODAY } from '../../../data/widget-data';
import { useDataDispatch, useWidgetDataStore, useWidgetView } from '../../../data/react';
import { ActionButton, DataGrid, DetailSidePanel, IconButton, InlineForm, TextField, NumberField, Textarea, StatusChip, SegmentedControl, Loading, MenuPhoto, Spinner, menuPhotos, type GridColumn, type GridFocus, type GridSort, type DataGridHandle } from '../../../ui';
import { Body, DetailState, Kpi, ListBlock, PanelFrame, Row, StatePanel, reportResult, useT } from '../mgmt-customers/shared';

import { FitMiniTable, ValueSlot, restoreGrid } from '../mgmt-customers/workspace';

import { MenuOptions } from './pos-menu';
import { MenuPhotoEditor } from './menu-photos';
import { menuError, menuPhotoBundle, menuPosKo, reportMenuResult } from './pos-menu-messages';

const id = 'menu' as const;
// Fits the café seed's longest name at 125% text, including the table's cell padding.
const menuNameWidth = 264;
const bundle: MessageBundle<string> = { id: 'widget.menu.screen', en: { 'widget.menu.actions': 'Actions' }, 'zh-Hans': { 'widget.menu.actions': '操作' }, 'zh-Hant': { 'widget.menu.actions': '操作' }, ko: {
  'widget.menu.actions': '조작',
  'widget.menu.addIngredient':'재료 추가하기', 'widget.menu.chooseIngredient':'재료 선택', 'widget.menu.insertIngredient':'재료 넣기', 'widget.menu.remove':'{name} 지우기', 'widget.menu.margin':'마진율', 'widget.menu.sold':'오늘 판매량', 'widget.menu.top':'오늘 가장 많이 팔린 메뉴 {name}', 'widget.menu.unitCost':'재료 원가', 'widget.menu.recipeUnit':'단위', 'widget.menu.historical':'오늘 판매분은 판매할 때의 원가로 계산해요', 'widget.menu.addMemo':'메모 추가하기', 'widget.menu.editMemo':'{name} 고치기', 'widget.menu.memoSave':'메모 저장하기', 'widget.menu.count': '등록한 메뉴', 'widget.menu.list': '메뉴 목록', 'widget.menu.name': '메뉴 이름', 'widget.menu.category': '분류', 'widget.menu.price': '판매가', 'widget.menu.cost': '원가', 'widget.menu.missingCost': '원가 미등록', 'widget.menu.recipe': '레시피', 'widget.menu.ingredient': '재료', 'widget.menu.quantity': '수량', 'widget.menu.usage': '오늘 사용량', 'widget.menu.memo': '메모', 'widget.menu.add': '메뉴 추가하기', 'widget.menu.save': '저장하기', 'widget.menu.delete': '메뉴 지우기', 'widget.menu.close': '닫기', 'widget.menu.new': '새 메뉴', 'widget.menu.drink': '음료', 'widget.menu.dessert': '디저트', 'widget.menu.search': '메뉴 이름으로 찾아보세요', 'widget.menu.emptyRecipe': '등록한 레시피가 없어요', 'widget.menu.none': '검색 결과가 없어요', 'widget.menu.unit': '개', 'widget.menu.won': '원', 'widget.menu.recipeSave': '레시피 저장하기',
  'widget.menu.cups': '잔', 'widget.menu.editShort': '고치기', 'widget.menu.removeShort': '지우기', 'widget.menu.marginSummary': '원가 {cost} · 마진 {margin}({rate})', 'widget.menu.subtitle': '{category} · {price}',
} };
function useText() { return useBundle(bundle, menuPhotoBundle, ...dataBundles); }
type Menu = Extract<ReturnType<typeof useWidgetView<'menu'>>, {status:'ready'}>['model']['rows'][number];
const name = (t: ReturnType<typeof useText>, row: Menu) => resolveDataText(t.t, row.name) || t.t(row.nameKey);
/** DS 6.1 / D6: the data keeps its unit codes (g, mL, pcs); the screen shows Korean words, never `pcs`. */
const unitLabel = (t: ReturnType<typeof useText>, unit: string) => unit === 'pcs' ? t.t('widget.menu.unit') : unit;
/** Drinks are counted in cups, bakery in pieces. */
const soldUnit = (t: ReturnType<typeof useText>, row: Menu) => t.t(row.category === 'dessert' ? 'widget.menu.unit' : 'widget.menu.cups');
/** A. Margin rate always shows one decimal (65.0%, 84.4%), so a column never mixes digit counts. */
const rateText = (rate: number | null) => rate === null ? '—' : `${rate.toFixed(1)}%`;

function useFixtureMenuSummary({ condition }: { condition: WidgetPanelProps['condition']; featureId: string }) {
  const t = useText(), view = useWidgetView(id, condition);
  return view.status === 'ready' ? `${t.t('widget.menu.count')} ${view.model.total}${t.t('widget.menu.unit')}` : t.t(view.messageKey);
}
function FixtureMenuPanel(props: WidgetPanelProps) {
 const t=useText(),base=useT(),view=useWidgetView(id,props.condition);
 if(view.status!=='ready')return <StatePanel id={id} view={view} t={base} props={props}/>;
 const rows=[...view.model.rows].sort((a,b)=>b.soldQty-a.soldQty||a.menuId.localeCompare(b.menuId));
 const money=(n:number)=>`${t.format.number(n)}${t.t('widget.menu.won')}`;
 const cols=[{id:'name',label:t.t('widget.menu.name'),render:(r:Menu)=>name(t,r)},{id:'price',label:t.t('widget.menu.price'),numeric:true,render:(r:Menu)=>money(r.price)},{id:'cost',label:t.t('widget.menu.cost'),numeric:true,render:(r:Menu)=>r.cost===null?t.t('widget.menu.missingCost'):money(r.cost)},{id:'rate',label:t.t('widget.menu.margin'),numeric:true,render:(r:Menu)=>rateText(r.rate)},{id:'sold',label:t.t('widget.menu.sold'),numeric:true,render:(r:Menu)=>`${r.soldQty}${soldUnit(t,r)}`}];
 return <PanelFrame id={id}><Body props={props} primary={<Kpi id={id} label={t.t('widget.menu.count')} value={String(view.model.total)} unit={t.t('widget.menu.unit')} sub={props.width===1&&props.height===1&&rows[0]?t.t('widget.menu.top',{name:name(t,rows[0])}):undefined}/>} list={props.width>1&&props.height>1?<FitMiniTable rows={rows} columns={cols} getRowId={r=>r.menuId} label={t.t('widget.menu.list')} dropColumns={['rate','sold','cost']}/>:<ListBlock id={id} title={t.t('widget.menu.list')}>{rows.map(row=><Row key={row.menuId} id={id} rowId={row.menuId} name={name(t,row)} value={props.height===1?`${row.soldQty}${soldUnit(t,row)}`:money(row.price)}/>)}</ListBlock>}/></PanelFrame>;
}
function MenuEditor({ row, host, close, entryView, entryFocus }: {
  row: Menu; host: WidgetDetailProps['host']; close: () => void; entryView?: string; entryFocus: (node: HTMLElement | null) => void;
}) {
  const t = useText(), dispatch = useDataDispatch(), store = useWidgetDataStore();
  const [nameDraft, setNameDraft] = useState<string>();
  const [priceDraft, setPriceDraft] = useState<number | null>();
  const [memo, setMemo] = useState('');
  const [memoOpen, setMemoOpen] = useState(false), [ingredientOpen, setIngredientOpen] = useState(false), [item, setItem] = useState('');
  const [error, setError] = useState<{ field?: 'name' | 'price'; message: string } | null>(null);
  const [focus, setFocus] = useState<GridFocus>(null);
  const [optionsOpen, setOptionsOpen] = useState(entryView === 'options');
  const lines = row.recipeLines;
  const menuName = name(t, row);
  const category = row.category === 'dessert' ? 'dessert' : 'drink';
  const memoText = resolveDataText(t.t, row.memo);

  const run = (command: Parameters<typeof dispatch>[0], field?: 'name' | 'price') => {
    const result = dispatch(command);
    setError(result.ok ? null : {
      field, message: command.type === 'menu.setSaleStatus' ? menuError(result, t.t) : t.t(result.messageKey),
    });
    if (command.type === 'menu.setSaleStatus') reportMenuResult(host, result, command, menuName, t.t);
    else if (result.ok && command.type === 'menu.delete' && t.locale === 'ko') {
      host.notify({ kind: 'success', messageKey: 'data.management.notice.menuDeleted', params: { name: menuName }, undoToken: result.undoToken });
    } else reportResult(host, result);
    return result;
  };
  const recipe = (next: typeof lines) => run({
    type: 'menu.setRecipe', menuId: row.menuId,
    lines: next.map(({ recipeLineId, itemId, quantity, unit }) => ({ recipeLineId, itemId, quantity, unit })),
  });
  const available = deriveStock(store.getSnapshot(), { date: TODAY }).rows.filter(stock => !lines.some(line => line.itemId === stock.itemId));
  type Line = typeof lines[number];
  const columns = useMemo<GridColumn<Line>[]>(() => [
    { id: 'ingredient', header: t.t('widget.menu.ingredient'), kind: 'text', value: line => resolveDataText(t.t, line.name), minWidth: 120 },
    { id: 'quantity', header: t.t('widget.menu.quantity'), kind: 'number', value: line => line.quantity, minWidth: 72, fixedWidth: true, editable: () => true, editor: 'number' },
    { id: 'unit', header: t.t('widget.menu.recipeUnit'), kind: 'text', value: line => unitLabel(t, line.unit), minWidth: 56, fixedWidth: true },
    { id: 'cost', header: t.t('widget.menu.unitCost'), kind: 'computed', value: line => line.cost === null ? '—' : t.format.number(Math.round(line.cost)), minWidth: 104, fixedWidth: true },
  ], [t]);

  return <div className="menu-editor" lang="ko">
    <section className="menu-editor-section">
      <p className="mc-caption menu-editor-subtitle" data-slot="menu.panel.subtitle">{t.t('widget.menu.subtitle', { category: t.t(category === 'dessert' ? 'widget.menu.dessert' : 'widget.menu.drink'), price: `${t.format.number(row.price)}${t.t('widget.menu.won')}` })}</p>
      <form className="menu-editor-field-form" aria-label={t.t('widget.menu.name')} onSubmit={event => {
        event.preventDefault();
        if (run({ type: 'menu.update', menuId: row.menuId, patch: { name: nameDraft ?? menuName } }, 'name').ok) setNameDraft(undefined);
      }}>
        <TextField label={t.t('widget.menu.name')} value={nameDraft ?? menuName} onValueChange={setNameDraft} error={error?.field === 'name' ? error.message : undefined} />
        <ActionButton type="submit" variant="secondary">{t.t('widget.menu.name')} {t.t('widget.menu.save')}</ActionButton>
      </form>
      <div className="menu-editor-choices">
        <div className="ui-field">
          <span className="ui-field__label">{menuPosKo.status}</span>
          <SegmentedControl label={menuPosKo.status} value={row.saleStatus}
            options={[{ value: 'selling', label: menuPosKo.selling }, { value: 'sold_out', label: menuPosKo.soldOut }]}
            onChange={status => { if (status !== row.saleStatus) run({ type: 'menu.setSaleStatus', menuId: row.menuId, status }); }} />
        </div>
        <div className="ui-field">
          <span className="ui-field__label">{t.t('widget.menu.category')}</span>
          <SegmentedControl label={t.t('widget.menu.category')} value={category}
            options={[{ value: 'drink', label: t.t('widget.menu.drink') }, { value: 'dessert', label: t.t('widget.menu.dessert') }]}
            onChange={value => { if (value !== category) run({ type: 'menu.update', menuId: row.menuId, patch: { category: value } }); }} />
        </div>
      </div>
    </section>
    <section className="menu-editor-section">
      <h4 tabIndex={entryView === 'recipe' ? -1 : undefined}
        ref={entryView === 'recipe' ? entryFocus : undefined}>{t.t('widget.menu.recipe')}</h4>
      {lines.length > 0 && <>
        <div className="menu-editor-recipe-grid" data-short-list={lines.length < 3 || undefined}>
          <DataGrid id="menu-recipe-grid" label={t.t('widget.menu.recipe')} rows={lines} columns={columns}
            getRowId={line => line.recipeLineId} getRowLabel={line => resolveDataText(t.t, line.name)}
            sort={null} onSortChange={() => {}} selectedRowId={null} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus}
            onCommit={edit => {
              const result = recipe(lines.map(line => line.recipeLineId === edit.rowId ? { ...line, quantity: Number(edit.raw) } : line));
              return result.ok ? { ok: true } : { ok: false, error: { id: edit.editToken, message: t.t(result.messageKey) } };
            }}
            getRowActions={line => [{ id: 'delete', label: t.t('widget.menu.remove', { name: resolveDataText(t.t, line.name) }), onPress: () => recipe(lines.filter(other => other.recipeLineId !== line.recipeLineId)) }]}
            emptyContent={t.t('widget.menu.missingCost')} />
        </div>
        <ul className="mc-recipe-usage mc-caption">{lines.map(line => <li key={line.recipeLineId}>
          {resolveDataText(t.t, line.name)} · {t.t('widget.menu.usage')} {t.format.number(line.usedToday, { maximumFractionDigits: 3 })}{unitLabel(t, line.inventoryUnit)} ({row.soldQty}{soldUnit(t, row)})
        </li>)}</ul>
      </>}
      {row.cost === null ? <StatusChip tone="warning">{t.t('widget.menu.missingCost')}</StatusChip>
        : <p className="menu-editor-total" data-slot="menu.panel.total">{t.t('widget.menu.marginSummary', {
          cost: `${t.format.number(row.cost)}${t.t('widget.menu.won')}`, margin: `${t.format.number(row.price - row.cost)}${t.t('widget.menu.won')}`, rate: rateText(row.rate),
        })}</p>}
      <div className="menu-editor-recipe-tools">
        <p className="mc-caption">{t.t('widget.menu.historical')}</p>
        <ActionButton variant="secondary" disabled={!available.length} onClick={() => {
          setItem(available[0]?.itemId ?? '');
          setIngredientOpen(true);
        }}>{t.t('widget.menu.addIngredient')}</ActionButton>
      </div>
      {ingredientOpen && <InlineForm title={t.t('widget.menu.addIngredient')} saveLabel={t.t('widget.menu.insertIngredient')} onClose={() => setIngredientOpen(false)} onSave={() => {
        const chosen = available.find(stock => stock.itemId === item);
        if (!chosen) return;
        const unit = chosen.unit === 'L' || chosen.unit === 'mL' ? 'mL' : chosen.unit === 'kg' || chosen.unit === 'g' ? 'g' : 'pcs';
        const next = [...lines, { recipeLineId: `recipe-${crypto.randomUUID()}`, menuId: row.menuId, itemId: item, quantity: 1, unit, name: chosen.name ?? { key: chosen.nameKey }, nameKey: chosen.nameKey, inventoryUnit: chosen.unit, cost: 0, usedToday: 0 }] as typeof lines;
        if (recipe(next).ok) setIngredientOpen(false);
      }}>
        <label className="ui-field">{t.t('widget.menu.chooseIngredient')}
          <select className="ui-text-input" value={item} onChange={event => setItem(event.target.value)}>
            {available.map(stock => <option key={stock.itemId} value={stock.itemId}>{resolveDataText(t.t, stock.name ?? { key: stock.nameKey })}</option>)}
          </select>
        </label>
      </InlineForm>}
    </section>
    <section className="menu-editor-section">
      <form className="menu-editor-field-form" aria-label={t.t('widget.menu.price')} noValidate onSubmit={event => {
        event.preventDefault();
        const price = priceDraft === undefined ? row.price : priceDraft ?? 0;
        if (run({ type: 'menu.update', menuId: row.menuId, patch: { price } }, 'price').ok) setPriceDraft(undefined);
      }}>
        <NumberField label={t.t('widget.menu.price')} value={priceDraft === undefined ? row.price : priceDraft} onValueChange={setPriceDraft}
          unit={t.t('widget.menu.won')} error={error?.field === 'price' ? error.message : undefined} />
        <ActionButton type="submit" variant="secondary">{t.t('widget.menu.price')} {t.t('widget.menu.save')}</ActionButton>
      </form>
    </section>
    <details className="menu-editor-extra" open={optionsOpen} onToggle={event => setOptionsOpen(event.currentTarget.open)}>
      <summary ref={entryView === 'options' ? entryFocus : undefined}>{menuPosKo.options}</summary>
      <MenuOptions menuId={row.menuId} name={menuName} groups={row.optionGroups} host={host} />
    </details>
    <MenuPhotoEditor menuId={row.menuId} name={menuName} photoKey={row.photoKey} customPhotoUrl={row.customPhotoUrl} host={host} />
    <section className="menu-editor-section">
      <div className="menu-editor-memo-heading">
        <h4>{t.t('widget.menu.memo')}</h4>
        <ActionButton variant="secondary" onClick={() => { setMemo(''); setMemoOpen(true); }}>{t.t('widget.menu.addMemo')}</ActionButton>
      </div>
      {row.memo && <>
        <p>{memoText}</p>
        <div className="menu-pos-actions">
          <ActionButton variant="ghost" aria-label={t.t('widget.menu.editMemo', { name: memoText.slice(0, 20) })} onClick={() => { setMemo(memoText); setMemoOpen(true); }}>{t.t('widget.menu.editShort')}</ActionButton>
          <ActionButton variant="ghost" aria-label={t.t('widget.menu.remove', { name: memoText.slice(0, 20) })} onClick={() => {
            if (run({ type: 'menu.update', menuId: row.menuId, patch: { memo: null } }).ok) setMemo('');
          }}>{t.t('widget.menu.removeShort')}</ActionButton>
        </div>
      </>}
      {memoOpen && <InlineForm title={t.t('widget.menu.memo')} saveLabel={t.t('widget.menu.memoSave')} onClose={() => setMemoOpen(false)} onSave={() => {
        if (run({ type: 'menu.update', menuId: row.menuId, patch: { memo } }).ok) setMemoOpen(false);
      }}><Textarea label={t.t('widget.menu.memo')} value={memo} onValueChange={setMemo} /></InlineForm>}
    </section>
    {error && !error.field && <p role="alert">{error.message}</p>}
    <ActionButton variant="ghost" className="menu-editor-delete" onClick={() => {
      if (run({ type: 'menu.delete', menuId: row.menuId }).ok) close();
    }}>{t.t('widget.menu.delete')}</ActionButton>
  </div>;
}
function FixtureMenuDetail({condition,host,detailRef}:WidgetDetailProps) {
 const t=useText(),base=useT(),view=useWidgetView(id,condition),dispatch=useDataDispatch();
 const prefill=detailRef.prefill?.kind==='menu.create'?detailRef.prefill:undefined;
 const [selected,setSelected]=useState<string|null>(detailRef.itemId??null),[focus,setFocus]=useState<GridFocus>(null),[sort,setSort]=useState<GridSort>({columnId:'sold',direction:'desc'}),[query,setQuery]=useState(''),[adding,setAdding]=useState(detailRef.view==='register'),[newName,setNewName]=useState(prefill?.name??''),[newPrice,setNewPrice]=useState<number|null>(prefill?.price??null),[category,setCategory]=useState<'drink'|'dessert'>(prefill?.category??'drink'),[error,setError]=useState('');
 const grid=useRef<DataGridHandle>(null);const rows=view.status==='ready'?view.model.rows.filter(r=>name(t,r).includes(query)).slice():[];
 if(sort){const value=(r:Menu)=>sort.columnId==='name'?name(t,r):sort.columnId==='price'?r.price:sort.columnId==='cost'?r.cost??-1:sort.columnId==='rate'?r.rate??-1:sort.columnId==='sold'?r.soldQty:r.category??'';rows.sort((a,b)=>{const av=value(a),bv=value(b);return (typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv)))*(sort.direction==='asc'?1:-1)||a.menuId.localeCompare(b.menuId);});}
 const previousRows=useRef(rows);
 useLayoutEffect(()=>{previousRows.current=rows;},[rows]);
 const current=rows.find(r=>r.menuId===selected);
 const editorEntryFocus = useRef<HTMLElement>(null);
 const setEditorEntryFocus = useCallback((node: HTMLElement | null) => { editorEntryFocus.current = node; }, []);
 const editorEntryView = current && detailRef.itemId === current.menuId ? detailRef.view : undefined;
 const workspace = useRef<HTMLDivElement>(null);
 const panelOpen = !!current;
 useLayoutEffect(() => {
  const root = workspace.current;
  if (!panelOpen || !root) return;
  const scroller = root.querySelector<HTMLElement>(':scope > .ui-data-grid > .ui-data-grid__scroll');
  const table = scroller?.querySelector('table');
  if (!scroller || !table) return;

  // Compare rendered edges so a reserved scrollbar gutter cannot leave a fade at the end.
  const update = () => root.toggleAttribute('data-more-columns',
    table.getBoundingClientRect().right - scroller.getBoundingClientRect().right > 1);
  update();
  scroller.addEventListener('scroll', update, { passive: true });
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
  observer?.observe(scroller);
  observer?.observe(table);
  return () => {
    observer?.disconnect();
    scroller.removeEventListener('scroll', update);
    root.removeAttribute('data-more-columns');
  };
 }, [panelOpen]);
 if(selected&&!current)setSelected(null);
 const columns=useMemo<GridColumn<Menu>[]>(()=>[
  {id:'name',header:t.t('widget.menu.name'),kind:'text',value:r=>name(t,r),minWidth:menuNameWidth,fixedWidth:true,sortable:true},
  {id:'saleStatus',header:menuPosKo.status,kind:'status',value:r=>r.saleStatus==='sold_out'?menuPosKo.soldOut:menuPosKo.selling,render:r=>r.saleStatus==='sold_out'?<StatusChip tone="danger">{menuPosKo.soldOut}</StatusChip>:<StatusChip semantic="done">{menuPosKo.selling}</StatusChip>,minWidth:136,fixedWidth:true,dropOrder:7},
  {id:'photo',header:t.t('widget.menu.photo.label'),kind:'computed',minWidth:180,fixedWidth:true,dropOrder:1,
    value:r=>menuPhotos.find(p=>p.key===r.photoKey)?.name??t.t(r.customPhotoUrl?'widget.menu.photo.custom':'widget.menu.photo.none'),
    render:r=>r.photoKey||r.customPhotoUrl ? <MenuPhoto photoKey={r.photoKey} customPhotoUrl={r.customPhotoUrl} name={name(t,r)} size="thumbnail" /> : null},
  {id:'category',header:t.t('widget.menu.category'),kind:'text',value:r=>t.t(r.category==='dessert'?'widget.menu.dessert':'widget.menu.drink'),minWidth:112,fixedWidth:true,dropOrder:6,sortable:true},
  {id:'price',header:t.t('widget.menu.price'),kind:'number',value:r=>r.price,render:r=><><ValueSlot featureId={id} scope="detail" slotId={`menu.detail.${r.menuId}.price`} value={r.price}>{t.format.number(r.price)}</ValueSlot>{t.t('widget.menu.won')}</>,minWidth:152,fixedWidth:true,sortable:true,unit:t.t('widget.menu.won')},
  {id:'cost',header:t.t('widget.menu.cost'),kind:'computed',value:r=>r.cost===null?t.t('widget.menu.missingCost'):t.format.number(r.cost),accessibleValue:r=>r.cost===null?t.t('widget.menu.missingCost'):`${t.format.number(r.cost)} ${t.t('widget.menu.won')}`,minWidth:160,fixedWidth:true,dropOrder:4,sortable:true,render:r=>r.cost===null?<StatusChip tone="warning">{t.t('widget.menu.missingCost')}</StatusChip>:<><ValueSlot featureId={id} scope="detail" slotId={`menu.detail.${r.menuId}.cost`} value={r.cost}>{t.format.number(r.cost)}</ValueSlot>{t.t('widget.menu.won')}</>},
  {id:'rate',header:t.t('widget.menu.margin'),kind:'computed',value:r=>rateText(r.rate),minWidth:120,fixedWidth:true,dropOrder:3,sortable:true},
  {id:'sold',header:t.t('widget.menu.sold'),kind:'computed',value:r=>r.soldQty,minWidth:168,fixedWidth:true,dropOrder:5,sortable:true},
 ],[t]);
 if(view.status!=='ready')return <DetailState id={id} view={view} t={base} host={host}/>;

 const close=()=>setSelected(null);
 const restoreFocus=(rowId:string)=>{
  const index=previousRows.current.findIndex(row=>row.menuId===rowId);
  const neighbor=rows[Math.min(Math.max(0,index),rows.length-1)];
  restoreGrid(grid,rowId,'name',neighbor?[neighbor.menuId]:[]);
 };
 const activateRow=(event:MouseEvent<HTMLDivElement>|KeyboardEvent<HTMLDivElement>)=>{
  const target=event.target;
  if(!(target instanceof Element)||target.closest('button,[inert]'))return;
  const row=target.closest<HTMLTableRowElement>('[data-grid-row]');
  if(!row?.dataset.gridRow||row.closest('.ui-data-grid')?.parentElement!==event.currentTarget)return;

  event.preventDefault();
  event.stopPropagation();
  target.closest<HTMLElement>('.ui-data-grid__cell')?.focus({preventScroll:true});
  const rowId=row.dataset.gridRow;
  setSelected(previous=>previous===rowId?null:rowId);
 };

 return <div ref={workspace} className="mc-detail mc-workspace menu-management" data-panel-open={panelOpen||undefined} lang="ko"
  onClickCapture={activateRow} onKeyDownCapture={event=>{if(event.key==='Enter'||event.key===' ')activateRow(event);}}>
 <DataGrid id="menu-grid" label={t.t('widget.menu.list')} rows={rows} getRowId={r=>r.menuId} getRowLabel={r=>name(t,r)} columns={columns}
  query={query} searchLabel={t.t('widget.menu.search')} searchPlaceholder={t.t('widget.menu.search')} onQueryChange={setQuery} sort={sort} onSortChange={setSort}
  selectedRowId={selected} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} ref={grid}
  rowActionsLabel={t.t('widget.menu.actions')} rowActionsDropOrder={2}
  getRowActions={row=>[
    {id:'delete',label:t.t('widget.menu.remove',{name:name(t,row)}),onPress:()=>{
      const result=dispatch({type:'menu.delete',menuId:row.menuId});
      if(result.ok&&t.locale==='ko')host.notify({kind:'success',messageKey:'data.management.notice.menuDeleted',params:{name:name(t,row)},undoToken:result.undoToken});
      else reportResult(host,result);
    }},
  ]}
  renderRowActions={(_row,actions)=>actions.map(action=><IconButton
    key={action.id}
    icon="trash"
    variant="ghost"
    label={action.label}
    title={action.disabledReason??action.label}
    aria-disabled={action.disabled||undefined}
    aria-description={action.disabledReason}
    onClick={action.onPress}
  />)}
 addAction={{id:'add',label:t.t('widget.menu.add'),onPress:()=>{setSelected(null);setAdding(true);}}} renderAddRow={()=>adding?<InlineForm title={t.t('widget.menu.new')} onClose={()=>setAdding(false)} saveLabel={t.t('widget.menu.save')} onSave={()=>{const r=dispatch({type:'menu.create',name:newName,price:newPrice??0,category,idempotencyKey:`menu-create-${crypto.randomUUID()}`});if(!r.ok){setError(t.t(r.messageKey));return;}reportResult(host,r);setAdding(false);setNewName('');setNewPrice(null);setError('');setQuery('');setSelected((r.value as {menuId:string}).menuId);}}><div className="menu-add-fields"><TextField label={t.t('widget.menu.name')} value={newName} onValueChange={setNewName}/><NumberField label={t.t('widget.menu.price')} value={newPrice} onValueChange={setNewPrice} unit={t.t('widget.menu.won')}/><label className="ui-field">{t.t('widget.menu.category')}<select className="ui-text-input" value={category} onChange={e=>setCategory(e.target.value as 'drink'|'dessert')}><option value="drink">{t.t('widget.menu.drink')}</option><option value="dessert">{t.t('widget.menu.dessert')}</option></select></label></div>{error?<p role="alert">{error}</p>:null}</InlineForm>:null} emptyContent={t.t('widget.menu.none')}/>
 <DetailSidePanel open={!!current} selectedRowId={selected} title={current?name(t,current):t.t('widget.menu.list')} onClose={close} returnFocusKey={selected??''} onRestoreFocus={restoreFocus} initialFocusRef={editorEntryFocus}>{current?<MenuEditor key={current.menuId} row={current} host={host} close={close} entryView={editorEntryView} entryFocus={setEditorEntryFocus}/>:null}</DetailSidePanel></div>;
}

function useHttpMenuSummary() {
  const t = useText();
  const kit = useKitT();
  const catalog = useBackendCatalog();
  if (catalog.status === 'ready') return `${t.t('widget.menu.count')} ${catalog.items.length}${t.t('widget.menu.unit')}`;
  if ('messageKey' in catalog) return t.t(catalog.messageKey);
  return kit.t('ui.loading');
}

function CatalogRefreshStatus() {
  const { t } = useKitT();
  return <span role="status"><Spinner /> {t('ui.loading')}</span>;
}

function HttpMenuPanel(props: WidgetPanelProps) {
  const t = useText();
  const base = useT();
  const catalog = useBackendCatalog();
  const host = { ...props.host, resetPreview: reloadBackendCatalog };

  if ('messageKey' in catalog) return <StatePanel id={id} view={catalog} t={base} props={{ ...props, host }} />;
  if (catalog.status !== 'ready') return <PanelFrame id={id}><Loading /></PanelFrame>;

  return (
    <PanelFrame id={id}>
      <Body props={props}
        primary={<Kpi id={id} label={t.t('widget.menu.count')} value={String(catalog.items.length)} unit={t.t('widget.menu.unit')}
          sub={catalog.refreshing && <CatalogRefreshStatus />} />}
        list={<ListBlock id={id} title={t.t('widget.menu.list')}>
          {catalog.items.map(row => <Row key={row.menuId} id={id} rowId={row.menuId} name={row.name}
            value={`${t.format.number(row.price)}${t.t('widget.menu.won')}`} />)}
        </ListBlock>} />
    </PanelFrame>
  );
}

const noExpandedRows: ReadonlySet<string> = new Set();

function HttpMenuDetail({ host, detailRef }: WidgetDetailProps) {
  const t = useText();
  const base = useT();
  const catalog = useBackendCatalog(true);
  const [selected, setSelected] = useState<string | null>(detailRef.itemId ?? null);
  const [focus, setFocus] = useState<GridFocus>(null);
  const [sort, setSort] = useState<GridSort>(null);
  const [query, setQuery] = useState('');
  const grid = useRef<DataGridHandle>(null);

  if ('messageKey' in catalog) {
    return <DetailState id={id} view={catalog} t={base} host={{ ...host, resetPreview: reloadBackendCatalog }} />;
  }
  if (catalog.status !== 'ready') return <Loading />;

  const category = (row: CatalogItem) => t.t(row.category === 'drink' ? 'widget.menu.drink' : 'widget.menu.dessert');
  const price = (row: CatalogItem) => `${t.format.number(row.price)}${t.t('widget.menu.won')}`;
  const saleStatus = (row: CatalogItem) => row.saleStatus === 'sold_out' ? menuPosKo.soldOut : menuPosKo.selling;
  const saleChip = (row: CatalogItem) => row.saleStatus === 'sold_out'
    ? <StatusChip tone="danger">{saleStatus(row)}</StatusChip>
    : <StatusChip semantic="done">{saleStatus(row)}</StatusChip>;
  const columns: readonly GridColumn<CatalogItem>[] = [
    { id: 'name', header: t.t('widget.menu.name'), kind: 'text', value: row => row.name, minWidth: menuNameWidth, fixedWidth: true, sortable: true },
    { id: 'category', header: t.t('widget.menu.category'), kind: 'text', value: category, minWidth: 112, sortable: true },
    { id: 'price', header: t.t('widget.menu.price'), kind: 'number', value: row => row.price, render: price,
      minWidth: 152, unit: t.t('widget.menu.won'), sortable: true },
    { id: 'saleStatus', header: menuPosKo.status, kind: 'status', value: saleStatus, render: saleChip, minWidth: 136 },
  ];

  const rows = catalog.items.filter(row => row.name.includes(query));
  const sortedBy = sort && columns.find(column => column.id === sort.columnId)?.value;
  if (sort && sortedBy) {
    const direction = sort.direction === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const left = sortedBy(a);
      const right = sortedBy(b);
      return direction * (typeof left === 'number' && typeof right === 'number'
        ? left - right : String(left).localeCompare(String(right), t.locale));
    });
  }
  const current = rows.find(row => row.menuId === selected);
  const restoreFocus = (rowId: string) => restoreGrid(grid, rowId, 'name', []);

  return (
    <div className="mc-detail mc-workspace menu-management" data-panel-open={!!current || undefined}>
      {catalog.refreshing && <CatalogRefreshStatus />}
      <DataGrid id="menu-grid" label={t.t('widget.menu.list')} rows={rows} columns={columns}
        getRowId={row => row.menuId} getRowLabel={row => row.name}
        query={query} searchLabel={t.t('widget.menu.search')} searchPlaceholder={t.t('widget.menu.search')} onQueryChange={setQuery}
        sort={sort} onSortChange={setSort} selectedRowId={selected} onSelectionChange={setSelected}
        expandedRowIds={noExpandedRows} focus={focus} onFocusChange={setFocus} ref={grid}
        emptyContent={t.t('widget.menu.none')} />
      <DetailSidePanel open={!!current} selectedRowId={selected} title={current?.name ?? t.t('widget.menu.list')}
        onClose={() => setSelected(null)} returnFocusKey={selected ?? ''} onRestoreFocus={restoreFocus}>
        {current && <div className="menu-editor">
          <section className="menu-editor-section"><h4>{t.t('widget.menu.category')}</h4><p>{category(current)}</p></section>
          <section className="menu-editor-section"><h4>{t.t('widget.menu.price')}</h4><p>{price(current)}</p></section>
          <section className="menu-editor-section"><h4>{menuPosKo.status}</h4><p>{saleChip(current)}</p></section>
        </div>}
      </DetailSidePanel>
    </div>
  );
}

export const useMenuSummary = isHttpCatalogEnabled ? useHttpMenuSummary : useFixtureMenuSummary;
export const MenuPanel = isHttpCatalogEnabled ? HttpMenuPanel : FixtureMenuPanel;
export const MenuDetail = isHttpCatalogEnabled ? HttpMenuDetail : FixtureMenuDetail;
