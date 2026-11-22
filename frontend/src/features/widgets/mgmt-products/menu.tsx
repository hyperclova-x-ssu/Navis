import { MenuPlace, VenuePlace } from './menu-publication';
import { useMenuPlace, type MenuPlacePorts } from './example-place';
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { MENU_CATEGORIES, normalizeMenuCategory, type MenuCategory, type WidgetDetailProps, type WidgetPanelProps } from '../../../contracts';
import { useBundle } from '../../../i18n';
import type { MessageBundle } from '../../../i18n';
import { useKitT } from '../../../ui/kit-i18n';
import { dataBundles, resolveDataText } from '../../../data/widget-data';
import { useDomainState, useRealPort, useRealRetry, useWidgetView } from '../../../data/react';
import { menuLineCost, menuPhotoFileId, type MenuCommand } from '../../../data/reality/01/menu-dto';
import { fromBase, toBase } from '../../../data/derive/common';
import { ActionButton, ChipChoice, DataGrid, DetailDialog, DetailSidePanel, DetailTabs, IconButton, InlineForm, TextField, NumberField, Textarea, StatusChip, SegmentedControl, Spinner, menuPhotos, type GridColumn, type GridFocus, type GridSort, type DataGridHandle } from '../../../ui';
import { Body, DetailState, Kpi, ListBlock, Notes, PanelFrame, Row, StatePanel, reportResult, useT } from '../mgmt-customers/shared';

import { FitMiniTable, ValueSlot, restoreGrid } from '../mgmt-customers/workspace';

import { MenuOptions } from './pos-menu';
import { MenuPhotoEditor, MenuPhotoView } from './menu-photos';
import { menuError, menuPhotoBundle, menuPosKo, reportMenuResult } from './pos-menu-messages';
import { menuGridResult, onMenuResult, useMenuCommand, useMenuIngredients } from './menu-controls';

const id = 'menu' as const;
const categoryBundle: MessageBundle<string> = { id: 'widget.menu.categories',
  ko: { 'widget.menu.category': '분류', 'widget.menu.categoryFilter': '메뉴 분류', 'widget.menu.all': '전체', 'widget.menu.coffee': '커피', 'widget.menu.tea': '티', 'widget.menu.beverage': '음료', 'widget.menu.dessert': '디저트', 'widget.menu.seasonal': '시즌' },
  en: { 'widget.menu.category': 'Category', 'widget.menu.categoryFilter': 'Menu categories', 'widget.menu.all': 'All', 'widget.menu.coffee': 'Coffee', 'widget.menu.tea': 'Tea', 'widget.menu.beverage': 'Drinks', 'widget.menu.dessert': 'Desserts', 'widget.menu.seasonal': 'Seasonal' },
  'zh-Hans': { 'widget.menu.category': '分类', 'widget.menu.categoryFilter': '菜单分类', 'widget.menu.all': '全部', 'widget.menu.coffee': '咖啡', 'widget.menu.tea': '茶', 'widget.menu.beverage': '饮品', 'widget.menu.dessert': '甜点', 'widget.menu.seasonal': '时令' },
  'zh-Hant': { 'widget.menu.category': '分類', 'widget.menu.categoryFilter': '菜單分類', 'widget.menu.all': '全部', 'widget.menu.coffee': '咖啡', 'widget.menu.tea': '茶', 'widget.menu.beverage': '飲品', 'widget.menu.dessert': '甜點', 'widget.menu.seasonal': '時令' },
};
const categoryTabs = ['all', ...MENU_CATEGORIES] as const;
type MenuFilter = typeof categoryTabs[number];
// Fits the café seed's longest name at 125% text, including the table's cell padding.
const menuNameWidth = 264;
const bundle: MessageBundle<string> = { id: 'widget.menu.screen', en: { 'widget.menu.actions': 'Actions' }, 'zh-Hans': { 'widget.menu.actions': '操作' }, 'zh-Hant': { 'widget.menu.actions': '操作' }, ko: {
  'widget.menu.actions': '조작',
  'widget.menu.addIngredient':'재료 추가하기', 'widget.menu.chooseIngredient':'재료 선택', 'widget.menu.insertIngredient':'재료 넣기', 'widget.menu.remove':'{name} 지우기', 'widget.menu.margin':'마진율', 'widget.menu.sold':'오늘 판매량', 'widget.menu.top':'오늘 가장 많이 팔린 메뉴 {name}', 'widget.menu.unitCost':'재료 원가', 'widget.menu.recipeUnit':'단위', 'widget.menu.historical':'오늘 판매분은 판매할 때의 원가로 계산해요', 'widget.menu.addMemo':'메모 추가하기', 'widget.menu.editMemo':'{name} 고치기', 'widget.menu.memoSave':'메모 저장하기', 'widget.menu.count': '등록한 메뉴', 'widget.menu.list': '메뉴 목록', 'widget.menu.name': '메뉴 이름', 'widget.menu.price': '판매가', 'widget.menu.cost': '원가', 'widget.menu.missingCost': '원가 미등록', 'widget.menu.recipe': '레시피', 'widget.menu.ingredient': '재료', 'widget.menu.quantity': '수량', 'widget.menu.usage': '오늘 사용량', 'widget.menu.memo': '메모', 'widget.menu.add': '메뉴 추가하기', 'widget.menu.save': '저장하기', 'widget.menu.delete': '메뉴 지우기', 'widget.menu.close': '닫기', 'widget.menu.new': '새 메뉴', 'widget.menu.search': '메뉴 이름으로 찾아보세요', 'widget.menu.emptyRecipe': '등록한 레시피가 없어요', 'widget.menu.none': '찾는 항목이 없어요', 'widget.menu.loading': '메뉴를 불러오는 중이에요', 'widget.menu.saveNew': '메뉴 저장하기', 'widget.menu.unit': '개', 'widget.menu.won': '원', 'widget.menu.recipeSave': '레시피 저장하기',
  'widget.menu.editShort': '고치기', 'widget.menu.removeShort': '지우기', 'widget.menu.marginSummary': '원가 {cost} · 마진 {margin}({rate})', 'widget.menu.subtitle': '{category} · {price}', 'widget.menu.salesUnavailable': '판매량을 불러올 수 없어요', 'widget.menu.saving': '저장하고 있어요',
} };
function useText() { return useBundle(bundle, categoryBundle, menuPhotoBundle, ...dataBundles); }
type Menu = Extract<ReturnType<typeof useWidgetView<'menu'>>, {status:'ready'}>['model']['rows'][number];
const name = (t: ReturnType<typeof useText>, row: Menu) => resolveDataText(t.t, row.name) || t.t(row.nameKey);
const menuCategory = (row: Menu): MenuCategory => normalizeMenuCategory(row.category) ?? 'beverage';
const categoryOptions = (t: ReturnType<typeof useText>) => MENU_CATEGORIES.map(value => ({ value, label: t.t(`widget.menu.${value}`) }));
/** DS 6.1 / D6: the data keeps its unit codes (g, mL, pcs); the screen shows Korean words, never `pcs`. */
const unitLabel = (t: ReturnType<typeof useText>, unit: string) => unit === 'pcs' ? t.t('widget.menu.unit') : unit;
/** Drinks are counted in cups, bakery in pieces. */
const soldQuantity = (row: Menu) =>
  'soldToday' in row ? (typeof row.soldToday === 'number' ? row.soldToday : null) : row.soldQty;
function soldText(t: ReturnType<typeof useText>, row: Menu) {
  const quantity = soldQuantity(row);
  if (quantity === null) return '—';
  return row.category === 'dessert' ? t.format.count(quantity, 'pcs')
    : `${t.format.number(quantity)}${t.locale === 'en' ? ' ' : ''}${t.t('common.navis.agent.menuCups')}`;
}
/** What a recipe line used today: the example day's own figure, or over HTTP the number sold today times the line's quantity (the services send sales, not usage per menu). */
function usedToday(row: Menu, line: Menu['recipeLines'][number], http: boolean): number {
  if (!http) return line.usedToday;
  return fromBase(toBase(line.quantity * (soldQuantity(row) ?? 0), line.unit) ?? 0, line.inventoryUnit);
}
/** A. Margin rate always shows one decimal (65.0%, 84.4%), so a column never mixes digit counts. */
const rateText = (rate: number | null) => rate === null ? '—' : `${rate.toFixed(1)}%`;

function useMenuView(condition: WidgetPanelProps['condition']) {
  const domain = useDomainState(id);
  const retry = useRealRetry(id);
  const view = useWidgetView(id, condition);
  const http = domain.mode === 'http';
  const loading = http && (domain.status === 'idle' || domain.status === 'loading');
  return { domain, retry, view, http, loading };
}

function MenuRefresh() {
  const { t } = useKitT();
  return <span role="status"><Spinner /> {t('ui.loading')}</span>;
}

// eslint-disable-next-line react-refresh/only-export-components -- The widget registry calls this summary hook.
export function useMenuSummary({ condition }: { condition: WidgetPanelProps['condition']; featureId: string }) {
  const t = useText(), kit = useKitT(), { view, loading, domain } = useMenuView(condition);
  if (loading) return kit.t('ui.loading');
  if (domain.mode === 'http' && domain.status === 'error') return t.t('data.state.menu.error');
  return view.status === 'ready' ? `${t.t('widget.menu.count')} ${view.model.total}${t.t('widget.menu.unit')}` : t.t(view.messageKey);
}
export function MenuPanel(props: WidgetPanelProps) {
 const t=useText(),base=useT(),{ view, retry, loading, http, domain }=useMenuView(props.condition);
 const stateProps=http?{...props,host:{...props.host,resetPreview:retry}}:props;
 if(loading)return <PanelFrame id={id}><p className="menu-loading" role="status"><Spinner /> {t.t('widget.menu.loading')}</p></PanelFrame>;
 if(view.status!=='ready')return <StatePanel id={id} view={view.status==='error'&&http?{...view,messageKey:'data.state.menu.error'}:view} t={base} props={stateProps}/>;
 const rows=[...view.model.rows].sort((a,b)=>(soldQuantity(b)??-1)-(soldQuantity(a)??-1)||a.menuId.localeCompare(b.menuId));
 const money=(n:number)=>`${t.format.number(n)}${t.t('widget.menu.won')}`;
 const cols=[{id:'name',label:t.t('widget.menu.name'),render:(r:Menu)=>name(t,r)},{id:'price',label:t.t('widget.menu.price'),numeric:true,render:(r:Menu)=>money(r.price)},{id:'cost',label:t.t('widget.menu.cost'),numeric:true,render:(r:Menu)=>r.cost===null?t.t('widget.menu.missingCost'):money(r.cost)},{id:'rate',label:t.t('widget.menu.margin'),numeric:true,render:(r:Menu)=>rateText(r.rate)},{id:'sold',label:t.t('widget.menu.sold'),numeric:true,render:(r:Menu)=>soldText(t,r)}];
 const top=rows[0];
 const hint=domain.refreshing?<MenuRefresh/>:props.width===1&&props.height===1&&top&&(soldQuantity(top)??0)>0?t.t('widget.menu.top',{name:name(t,top)}):undefined;
 const short = props.height === 1;
 const list = props.width > 1 && !short
   ? <FitMiniTable rows={rows} columns={cols} getRowId={r=>r.menuId} label={t.t('widget.menu.list')} dropColumns={['rate','sold','cost']}/>
   : rows.length > 0 && <ListBlock id={id} title={short ? t.t('widget.menu.sold') : t.t('widget.menu.list')}>
       {(short ? rows.slice(0, props.width >= 3 ? 4 : 2) : rows).map(row => <Row key={row.menuId} id={id} rowId={row.menuId} name={name(t,row)} value={short?soldText(t,row):money(row.price)} />)}
     </ListBlock>;
 return <PanelFrame id={id}><Body props={props} primary={<Kpi id={id} label={t.t('widget.menu.count')} value={String(view.model.total)} unit={t.t('widget.menu.unit')} sub={hint}/>} list={list}/></PanelFrame>;
}
function MenuEditor({ row, host, requestDelete, entryView, entryFocus, place }: {
  row: Menu; host: WidgetDetailProps['host']; requestDelete: () => void; entryView?: string; entryFocus: (node: HTMLElement | null) => void; place: MenuPlacePorts;
}) {
  const t = useText(), { send, pending, http } = useMenuCommand(), ingredients = useMenuIngredients();
  const [nameDraft, setNameDraft] = useState<string>();
  const [priceDraft, setPriceDraft] = useState<number | null>();
  const [memo, setMemo] = useState('');
  const [memoOpen, setMemoOpen] = useState(false), [ingredientOpen, setIngredientOpen] = useState(false), [item, setItem] = useState('');
  const [error, setError] = useState<{ field?: 'name' | 'price'; message: string } | null>(null);
  const [focus, setFocus] = useState<GridFocus>(null);
  const [optionsOpen, setOptionsOpen] = useState(entryView === 'options');
  const lines = row.recipeLines;
  const menuName = name(t, row);
  const category = menuCategory(row);
  const memoText = resolveDataText(t.t, row.memo);

  const run = (command: MenuCommand, field?: 'name' | 'price', onSaved?: () => void) => {
    const result = send(command);
    onMenuResult(result, response => {
      setError(response.ok ? null : { field, message: menuError(response, t.t) });
      if (command.type === 'menu.setSaleStatus') reportMenuResult(host, response, command, menuName, t.t);
      else reportResult(host, response);
      if (response.ok) onSaved?.();
    });
    return result;
  };
  const recipe = (next: typeof lines, onSaved?: () => void) => run({
    type: 'menu.setRecipe', menuId: row.menuId,
    lines: next.map(({ recipeLineId, itemId, quantity, unit }) => ({ recipeLineId, itemId, quantity, unit })),
  }, undefined, onSaved);
  const available = ingredients.filter(stock => !lines.some(line => line.itemId === stock.itemId));
  type Line = typeof lines[number];
  const columns = useMemo<GridColumn<Line>[]>(() => [
    { id: 'ingredient', header: t.t('widget.menu.ingredient'), kind: 'text', value: line => resolveDataText(t.t, line.name), minWidth: 120 },
    { id: 'quantity', header: t.t('widget.menu.quantity'), kind: 'number', value: line => line.quantity, minWidth: 72, fixedWidth: true, editable: () => true, editor: 'number' },
    { id: 'unit', header: t.t('widget.menu.recipeUnit'), kind: 'text', value: line => unitLabel(t, line.unit), minWidth: 56, fixedWidth: true },
    { id: 'cost', header: t.t('widget.menu.unitCost'), kind: 'computed', value: line => {
      const cost = menuLineCost(line);
      return cost === null ? '—' : t.format.number(Math.round(cost));
    }, minWidth: 104, fixedWidth: true },
  ], [t]);

  return <div className="menu-editor" lang="ko" aria-busy={pending || undefined}>
    <section className="menu-editor-section">
      <p className="mc-caption menu-editor-subtitle" data-slot="menu.panel.subtitle">{t.t('widget.menu.subtitle', { category: t.t(`widget.menu.${category}`), price: `${t.format.number(row.price)}${t.t('widget.menu.won')}` })}</p>
      <form className="menu-editor-field-form" aria-label={t.t('widget.menu.name')} onSubmit={event => {
        event.preventDefault();
        run({ type: 'menu.update', menuId: row.menuId, patch: { name: nameDraft ?? menuName } }, 'name',
          () => setNameDraft(current => current === nameDraft ? undefined : current));
      }}>
        <TextField label={t.t('widget.menu.name')} value={nameDraft ?? menuName} onValueChange={setNameDraft} error={error?.field === 'name' ? error.message : undefined} />
        <ActionButton type="submit" variant="secondary" disabled={pending}>{t.t('widget.menu.name')} {t.t('widget.menu.save')}</ActionButton>
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
          <ChipChoice label={t.t('widget.menu.category')} value={category} options={categoryOptions(t)}
            onChange={value => { if (!pending && value !== category) run({ type: 'menu.update', menuId: row.menuId, patch: { category: value } }); }} />
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
              return menuGridResult(result, edit.editToken, t.t);
            }}
            getRowActions={line => [{ id: 'delete', label: t.t('widget.menu.remove', { name: resolveDataText(t.t, line.name) }), onPress: () => recipe(lines.filter(other => other.recipeLineId !== line.recipeLineId)) }]}
            emptyContent={t.t('widget.menu.missingCost')} />
        </div>
        {(!http || soldQuantity(row) !== null) && <ul className="mc-recipe-usage mc-caption">{lines.map(line => <li key={line.recipeLineId}>
          {resolveDataText(t.t, line.name)} · {t.t('widget.menu.usage')} {t.format.number(usedToday(row, line, http), { maximumFractionDigits: 3 })}{unitLabel(t, line.inventoryUnit)} ({soldText(t, row)})
        </li>)}</ul>}
      </>}
      {row.cost === null ? <StatusChip tone="warning">{t.t('widget.menu.missingCost')}</StatusChip>
        : <p className="menu-editor-total" data-slot="menu.panel.total">{t.t('widget.menu.marginSummary', {
          cost: `${t.format.number(row.cost)}${t.t('widget.menu.won')}`, margin: `${t.format.number(row.price - row.cost)}${t.t('widget.menu.won')}`, rate: rateText(row.rate),
        })}</p>}
      <div className="menu-editor-recipe-tools">
        <p className="mc-caption">{t.t('widget.menu.historical')}</p>
        <ActionButton variant="secondary" disabled={pending || !available.length} onClick={() => {
          setItem(available[0]?.itemId ?? '');
          setIngredientOpen(true);
        }}>{t.t('widget.menu.addIngredient')}</ActionButton>
      </div>
      {ingredientOpen && <InlineForm title={t.t('widget.menu.addIngredient')} saveLabel={t.t('widget.menu.insertIngredient')} saving={pending} onClose={() => setIngredientOpen(false)} onSave={() => {
        const chosen = available.find(stock => stock.itemId === item);
        if (!chosen) return;
        const unit = chosen.unit === 'L' || chosen.unit === 'mL' ? 'mL' : chosen.unit === 'kg' || chosen.unit === 'g' ? 'g' : 'pcs';
        const next = [...lines, { recipeLineId: `recipe-${crypto.randomUUID()}`, menuId: row.menuId, itemId: item, quantity: 1, unit, name: chosen.name ?? { key: chosen.nameKey }, nameKey: chosen.nameKey, inventoryUnit: chosen.unit, cost: 0, usedToday: 0 }] as typeof lines;
        recipe(next, () => setIngredientOpen(false));
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
        run({ type: 'menu.update', menuId: row.menuId, patch: { price } }, 'price',
          () => setPriceDraft(current => current === priceDraft ? undefined : current));
      }}>
        <NumberField label={t.t('widget.menu.price')} value={priceDraft === undefined ? row.price : priceDraft} onValueChange={setPriceDraft} groupThousands
          unit={t.t('widget.menu.won')} error={error?.field === 'price' ? error.message : undefined} />
        <ActionButton type="submit" variant="secondary" disabled={pending}>{t.t('widget.menu.price')} {t.t('widget.menu.save')}</ActionButton>
      </form>
    </section>
    <details className="menu-editor-extra" open={optionsOpen} onToggle={event => setOptionsOpen(event.currentTarget.open)}>
      <summary ref={entryView === 'options' ? entryFocus : undefined}>{menuPosKo.options}</summary>
      <MenuOptions menuId={row.menuId} name={menuName} groups={row.optionGroups} host={host} />
    </details>
    <MenuPhotoEditor menuId={row.menuId} name={menuName} photoKey={row.photoKey} photoFileId={menuPhotoFileId(row)} customPhotoUrl={row.customPhotoUrl} host={host} />
    <section className="menu-editor-section">
      <div className="menu-editor-memo-heading">
        <h4>{t.t('widget.menu.memo')}</h4>
        <ActionButton variant="secondary" disabled={pending} onClick={() => { setMemo(''); setMemoOpen(true); }}>{t.t('widget.menu.addMemo')}</ActionButton>
      </div>
      {row.memo && <>
        <p>{memoText}</p>
        <div className="menu-pos-actions">
          <ActionButton variant="ghost" disabled={pending} aria-label={t.t('widget.menu.editMemo', { name: memoText.slice(0, 20) })} onClick={() => { setMemo(memoText); setMemoOpen(true); }}>{t.t('widget.menu.editShort')}</ActionButton>
          <ActionButton variant="ghost" aria-label={t.t('widget.menu.remove', { name: memoText.slice(0, 20) })} onClick={() => {
            run({ type: 'menu.update', menuId: row.menuId, patch: { memo: null } }, undefined, () => setMemo(''));
          }}>{t.t('widget.menu.removeShort')}</ActionButton>
        </div>
      </>}
      {memoOpen && <InlineForm title={t.t('widget.menu.memo')} saveLabel={t.t('widget.menu.memoSave')} saving={pending} onClose={() => setMemoOpen(false)} onSave={() => {
        run({ type: 'menu.update', menuId: row.menuId, patch: { memo } }, undefined, () => setMemoOpen(false));
      }}><Textarea label={t.t('widget.menu.memo')} value={memo} onValueChange={setMemo} /></InlineForm>}
    </section>
    <MenuPlace transport={place.transport} menuId={row.menuId} />
    {error && !error.field && <p role="alert">{error.message}</p>}
    <ActionButton variant="ghost" className="menu-editor-delete" disabled={pending} onClick={requestDelete}>{t.t('widget.menu.delete')}</ActionButton>
  </div>;
}
export function MenuDetail({condition,host,detailRef}:WidgetDetailProps) {
 const port = useRealPort();
 const t=useText(),base=useT(),{view,domain,retry,http,loading}=useMenuView(condition),{send,pending}=useMenuCommand();
 // PAR-1: the 플레이스 pages (업체 정보, 플레이스에 올리기) are in both modes: the gateway over HTTP, an in-memory listing with the example data.
 const placeMenus=useMemo(()=>view.status==='ready'?view.model.rows.map(row=>({menuId:row.menuId,name:name(t,row),price:row.price})):[],[view,t]);
 const place=useMenuPlace(http?port:undefined,placeMenus);
 const prefill=detailRef.prefill?.kind==='menu.create'?detailRef.prefill:undefined;
 const [selected,setSelected]=useState<string|null>(detailRef.itemId??null),[focus,setFocus]=useState<GridFocus>(null),[sort,setSort]=useState<GridSort>({columnId:'sold',direction:'desc'}),[query,setQuery]=useState(''),[adding,setAdding]=useState(detailRef.view==='register'),[newName,setNewName]=useState(prefill?.name??''),[newPrice,setNewPrice]=useState<number|null>(prefill?.price??null),[category,setCategory]=useState<MenuCategory>(normalizeMenuCategory(prefill?.category)??'beverage'),[error,setError]=useState('');
 const [venueOpen, setVenueOpen] = useState(false);
 const [deletion, setDeletion] = useState<Menu | null>(null);
 const [deleteError, setDeleteError] = useState('');
 const [filter, setFilter] = useState<MenuFilter>('all');
 const categoryFieldId = useId();
 const attempt=useRef<{name:string;price:number;category:MenuCategory;key:string}|null>(null);
 const addForm=useRef(0);
 const grid=useRef<DataGridHandle>(null);
 const rows=useMemo(()=>{
  if(view.status!=='ready')return [];
  const visible=view.model.rows.filter(row=>(filter==='all'||menuCategory(row)===filter)&&name(t,row).includes(query));
  if(!sort)return visible;
  const value=(row:Menu)=>sort.columnId==='name'?name(t,row):sort.columnId==='price'?row.price:sort.columnId==='cost'?row.cost??-1:sort.columnId==='rate'?row.rate??-1:sort.columnId==='sold'?soldQuantity(row)??-1:menuCategory(row);
  const direction=sort.direction==='asc'?1:-1;
  return visible.sort((a,b)=>{
   const left=value(a),right=value(b);
   const order=typeof left==='number'&&typeof right==='number'?left-right:String(left).localeCompare(String(right));
   return order*direction||a.menuId.localeCompare(b.menuId);
  });
 },[view,sort,query,t,filter]);
 const previousRows=useRef(rows);
 useLayoutEffect(()=>{previousRows.current=rows;},[rows]);
 const current=rows.find(r=>r.menuId===selected);
 const editorEntryFocus = useRef<HTMLElement>(null);
 const setEditorEntryFocus = useCallback((node: HTMLElement | null) => { editorEntryFocus.current = node; }, []);
 const editorEntryView = current && detailRef.itemId === current.menuId ? detailRef.view : undefined;
 const workspace = useRef<HTMLDivElement>(null);
 const panelOpen = !!current || venueOpen;
 useLayoutEffect(() => {
  const root = workspace.current;
  if (!panelOpen || !root) return;
  const scroller = root.querySelector<HTMLElement>(':scope > .menu-category-tabs .ui-detail-tabs__panel > .ui-data-grid > .ui-data-grid__scroll');
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
 if(selected&&!current&&view.status==='ready')setSelected(null);
 const columns=useMemo<GridColumn<Menu>[]>(()=>[
  {id:'name',header:t.t('widget.menu.name'),kind:'text',value:r=>name(t,r),minWidth:menuNameWidth,sortable:true},
  {id:'saleStatus',header:menuPosKo.status,kind:'status',value:r=>r.saleStatus==='sold_out'?menuPosKo.soldOut:menuPosKo.selling,render:r=>r.saleStatus==='sold_out'?<StatusChip tone="danger">{menuPosKo.soldOut}</StatusChip>:<StatusChip semantic="done">{menuPosKo.selling}</StatusChip>,minWidth:136,fixedWidth:true,dropOrder:7},
  {id:'photo',header:t.t('widget.menu.photo.label'),kind:'computed',minWidth:180,fixedWidth:true,dropOrder:1,
    value:r=>menuPhotos.find(p=>p.key===r.photoKey)?.name??t.t(r.customPhotoUrl||menuPhotoFileId(r)?'widget.menu.photo.custom':'widget.menu.photo.none'),
    render:r=>{
      const fileId=menuPhotoFileId(r);
      return r.photoKey||r.customPhotoUrl||fileId ? <MenuPhotoView key={fileId} photoKey={r.photoKey} photoFileId={fileId} customPhotoUrl={r.customPhotoUrl} name={name(t,r)} size="thumbnail" /> : null;
    }},
  {id:'category',header:t.t('widget.menu.category'),kind:'text',value:r=>t.t(`widget.menu.${menuCategory(r)}`),
    accessibleValue:r=>[t.t(`widget.menu.${menuCategory(r)}`), r.seasonal && t.t('widget.menu.seasonal')].filter(Boolean).join(' · '),
    render:r=><>{t.t(`widget.menu.${menuCategory(r)}`)} {r.seasonal && <StatusChip compact semantic="none">{t.t('widget.menu.seasonal')}</StatusChip>}</>,
    minWidth:112,fixedWidth:true,dropOrder:6,sortable:true},
  {id:'price',header:t.t('widget.menu.price'),kind:'number',value:r=>r.price,render:r=><><ValueSlot featureId={id} scope="detail" slotId={`menu.detail.${r.menuId}.price`} value={r.price}>{t.format.number(r.price)}</ValueSlot>{t.t('widget.menu.won')}</>,minWidth:152,fixedWidth:true,sortable:true,unit:t.t('widget.menu.won')},
  {id:'cost',header:t.t('widget.menu.cost'),kind:'computed',value:r=>r.cost===null?t.t('widget.menu.missingCost'):t.format.number(r.cost),accessibleValue:r=>r.cost===null?t.t('widget.menu.missingCost'):`${t.format.number(r.cost)} ${t.t('widget.menu.won')}`,minWidth:160,fixedWidth:true,dropOrder:4,sortable:true,render:r=>r.cost===null?<StatusChip tone="warning">{t.t('widget.menu.missingCost')}</StatusChip>:<><ValueSlot featureId={id} scope="detail" slotId={`menu.detail.${r.menuId}.cost`} value={r.cost}>{t.format.number(r.cost)}</ValueSlot>{t.t('widget.menu.won')}</>},
  {id:'rate',header:t.t('widget.menu.margin'),kind:'computed',value:r=>rateText(r.rate),minWidth:120,fixedWidth:true,dropOrder:3,sortable:true},
  {id:'sold',header:t.t('widget.menu.sold'),kind:'computed',value:r=>soldQuantity(r)??'—',render:r=>soldText(t,r),
    accessibleValue:r=>soldQuantity(r)===null?t.t('widget.menu.salesUnavailable'):soldText(t,r),minWidth:168,fixedWidth:true,dropOrder:5,sortable:true},
 ],[t]);
 if(loading)return <p className="menu-loading" role="status"><Spinner /> {t.t('widget.menu.loading')}</p>;
 if(view.status==='error'||(!http&&view.status!=='ready'))return <DetailState id={id}
  view={view.status==='error'&&http?{...view,messageKey:'data.state.menu.error'}:view} t={base} host={http?{...host,resetPreview:retry}:host}/>;

 const close=()=>setSelected(null);
 const requestDelete=(row:Menu)=>{setDeleteError('');setDeletion(row);};
 const confirmDelete=()=>{
  if(!deletion||pending)return;
  setDeleteError('');
  onMenuResult(send({type:'menu.delete',menuId:deletion.menuId}),result=>{
   if(!result.ok){setDeleteError(t.locale==='ko'?'메뉴를 지우지 못했어요. 목록을 확인한 뒤 다시 눌러 주세요':menuError(result,t.t));return;}
   setDeletion(null);
   setSelected(previous=>previous===deletion.menuId?null:previous);
   if(t.locale==='ko')host.notify({kind:'success',messageKey:'data.management.notice.menuDeleted',params:{name:name(t,deletion)},undoToken:result.undoToken});
   else reportResult(host,result);
  });
 };
 const closeAdd=()=>{addForm.current+=1;setAdding(false);};
 const create=()=>{
  if(pending)return;
  const price=newPrice??0;
  if(attempt.current?.name!==newName||attempt.current.price!==price||attempt.current.category!==category){
   attempt.current={name:newName,price,category,key:`menu-create-${crypto.randomUUID()}`};
  }
  const generation=addForm.current;
  const result=send({type:'menu.create',name:newName,price,category,idempotencyKey:attempt.current.key});
  onMenuResult(result,response=>{
   if(!response.ok){if(generation===addForm.current)setError(menuError(response,t.t));return;}
   attempt.current=null;
   reportResult(host,response);
   if(generation!==addForm.current)return;
   const receipt=response.value as {resourceId?:string;menuId?:string}|undefined;
   closeAdd();setNewName('');setNewPrice(null);setError('');setQuery('');setFilter('all');setSelected(receipt?.resourceId??receipt?.menuId??null);
  });
 };
 const restoreFocus=(rowId:string)=>{
  const index=previousRows.current.findIndex(row=>row.menuId===rowId);
  const neighbor=rows[Math.min(Math.max(0,index),rows.length-1)];
  restoreGrid(grid,rowId,'name',neighbor?[neighbor.menuId]:[]);
 };
 const activateRow=(event:MouseEvent<HTMLDivElement>|KeyboardEvent<HTMLDivElement>)=>{
  const target=event.target;
  if(!(target instanceof Element)||target.closest('button,[inert]'))return;
  const row=target.closest<HTMLTableRowElement>('[data-grid-row]');
  if(!row?.dataset.gridRow||!row.closest('.ui-data-grid')?.matches('.menu-category-tabs .ui-detail-tabs__panel > .ui-data-grid'))return;

  event.preventDefault();
  event.stopPropagation();
  target.closest<HTMLElement>('.ui-data-grid__cell')?.focus({preventScroll:true});
  const rowId=row.dataset.gridRow;
  setVenueOpen(false);
  setSelected(previous=>previous===rowId?null:rowId);
 };

 const menuGrid=<DataGrid id="menu-grid" label={t.t('widget.menu.list')} rows={rows} getRowId={r=>r.menuId} getRowLabel={r=>name(t,r)} columns={columns}
  query={query} searchLabel={t.t('widget.menu.search')} searchPlaceholder={t.t('widget.menu.search')} onQueryChange={setQuery} sort={sort} onSortChange={setSort}
  selectedRowId={selected} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} ref={grid}
  rowActionsLabel={t.t('widget.menu.actions')} rowActionsDropOrder={2}
  getRowActions={row=>[
    {id:'delete',label:t.t('widget.menu.remove',{name:name(t,row)}),onPress:()=>requestDelete(row)},
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
  addAction={{ id: 'add', label: t.t('widget.menu.add'), disabled: pending, onPress: () => { setSelected(null); setAdding(true); } }}
  renderAddRow={() => adding ? <InlineForm title={t.t('widget.menu.new')} onClose={closeAdd} closeLabel={t.locale === 'ko' ? '메뉴 추가 닫기' : undefined}
    saveLabel={t.locale === 'ko' ? t.t('widget.menu.saveNew') : t.t('widget.menu.save')} onSave={create} saving={pending}>
    <div className="menu-add-fields">
      <TextField label={t.t('widget.menu.name')} value={newName} onValueChange={setNewName} />
      <NumberField label={t.t('widget.menu.price')} value={newPrice} onValueChange={setNewPrice} unit={t.t('widget.menu.won')} groupThousands />
      <div className="ui-field">
        <label htmlFor={categoryFieldId} className="ui-field__label">{t.t('widget.menu.category')}</label>
        <select id={categoryFieldId} className="ui-text-input" value={category} onChange={event => setCategory(event.target.value as MenuCategory)}>
          {categoryOptions(t).map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
    </div>
    {error && <p role="alert">{error}</p>}
  </InlineForm> : null}
  emptyContent={t.t(view.status === 'empty' && !query ? 'data.state.menu.no-menus' : 'widget.menu.none')} />;
 const editor=<DetailSidePanel open={!!current} selectedRowId={selected} title={current?name(t,current):t.t('widget.menu.list')} onClose={close} returnFocusKey={selected??''} onRestoreFocus={restoreFocus} initialFocusRef={editorEntryFocus}>{current?<MenuEditor key={current.menuId} row={current} host={host} requestDelete={()=>requestDelete(current)} entryView={editorEntryView} entryFocus={setEditorEntryFocus} place={place}/>:null}</DetailSidePanel>;

 return <div ref={workspace} className="mc-detail mc-workspace menu-management" data-panel-open={panelOpen||undefined} lang="ko"
  onClickCapture={activateRow} onKeyDownCapture={event=>{if(event.key==='Enter'||event.key===' ')activateRow(event);}}>
 {domain.refreshing&&<MenuRefresh/>}
 {domain.pending>0&&!domain.refreshing&&<span role="status"><Spinner/> {t.t('widget.menu.saving')}</span>}
 {view.status==='ready'&&<Notes notes={view.notes} t={base}/>}
 {domain.status==='stale'&&<ActionButton variant="secondary" onClick={retry}>{t.t('data.action.retry')}</ActionButton>}
 <VenuePlace transport={place.transport} files={place.files} open={venueOpen} onOpenChange={open => {
   setVenueOpen(open);
   if (open) { setSelected(null); setAdding(false); }
 }} />
 <div className="menu-category-tabs" lang={t.locale}>
  <DetailTabs value={filter} onValueChange={value=>{setFilter(value);setSelected(null);}} label={t.t('widget.menu.categoryFilter')}
    tabs={categoryTabs.map(value=>({value,label:t.t(`widget.menu.${value}`)}))} panels={{[filter]:<>{menuGrid}{editor}</>}} />
 </div>
 {deletion&&<DetailDialog open dialogRole="alertdialog" title={t.t('widget.menu.delete')} description={name(t,deletion)} onClose={()=>{if(!pending)setDeletion(null);}}
   footer={<ActionButton variant="destructive" loading={pending} onClick={confirmDelete}>{t.t('widget.menu.removeShort')}</ActionButton>}>
  {deleteError&&<p role="alert">{deleteError}</p>}
 </DetailDialog>}
 </div>;
}
