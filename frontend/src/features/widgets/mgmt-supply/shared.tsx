/**
 * Shared pieces of the mgmt-supply widget group (T-049): translator, relative dates, the panel fit rule
 * (DS 11.3.3: drop S → extra rows → label, never shrink or clip), the changed-value highlight (M-27),
 * the panel state pattern (DS 11.5) and small view helpers. Kit components only; values come from tokens.
 */
import { editClashCount, keepDots } from '../mgmt-money/fit';
import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type DependencyList, type ReactNode, type RefObject } from 'react';
import type { ChangedValueSlot, FeatureId, Locale, MessageParams, WidgetHost } from '../../../contracts';
import { useBundle, type CommonKey, type Formatters } from '../../../i18n';
import { dataBundles, resolveDataText, TODAY, TOMORROW, type DataMessageKey, type DataText, type DataWidgetId } from '../../../data/widget-data';
import { Icon, PanelState, StatusBadge, useVisibleValueSlot, useUi, type PanelStateTone, type GridColumn, type GridSort } from '../../../ui';
import { mgmtSupplyBundle, type SupplyKey } from './messages';
import './mgmt-supply.css';

export type TextKey = SupplyKey | CommonKey | DataMessageKey;
export interface SupplyText {
  /** Typed keys of this group, the common bundle and the data bundle. */
  readonly t: (key: TextKey, params?: MessageParams) => string;
  /** Keys computed at run time (state message keys, notice keys, unit keys). */
  readonly tk: (key: string, params?: MessageParams) => string;
  /** Data-bundle text values (`DataText`): message keys or the owner's raw words. */
  readonly text: (value: DataText | null | undefined) => string;
  readonly format: Formatters;
  readonly locale: Locale;
}

export function useSupplyText(): SupplyText {
  const tr = useBundle(mgmtSupplyBundle, ...dataBundles);
  return useMemo(() => {
    const tk = (key: string, params?: MessageParams) => keepDots((tr.t as (k: string, p?: MessageParams) => string)(key, params));
    return { t: tk, tk, text: (value) => resolveDataText(tk, value), format: tr.format, locale: tr.locale };
  }, [tr]);
}

/** Store-local ISO date arithmetic (UTC calendar maths only; never the device clock or zone). */
export function addIsoDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
export const DAY_AFTER_TOMORROW = addIsoDays(TODAY, 2);

/** ‘오늘’·‘내일’·‘모레’, otherwise the short date; null = ‘날짜 미정’. */
export function relativeDay(x: SupplyText, iso: string | null): string {
  if (iso === null) return x.t('widget.suppliers.when.undated');
  if (iso === TODAY) return x.t('widget.suppliers.when.today');
  if (iso === TOMORROW) return x.t('widget.suppliers.when.tomorrow');
  if (iso === DAY_AFTER_TOMORROW) return x.t('widget.suppliers.when.dayAfter');
  return x.format.date(iso, 'short');
}

/** Unit words for a field suffix (‘L’, ‘개’, ‘pcs’, ‘个’) taken from the common unit template. */
export const unitLabel = (x: SupplyText, unit: string): string => x.tk(`unit.${unit}`, { n: 0 }).replace(/^0\s*/, '').trim() || unit;

/** Idempotency keys are made when a form opens (API-09 v4). A counter, not random or time based. */
let keySeq = 0;
export const newIdempotencyKey = (prefix: string): string => `${prefix}:${(keySeq += 1)}`;

/**
 * Panel fit (DS 11.3.3/11.1): children marked `data-drop="<priority>"` are hidden, highest priority first,
 * until the content fits its box; `data-row` marks list rows so a `data-more` line (‘외 n개’) can replace them.
 * Text is never shrunk, clipped or ellipsized. Without layout (tests) everything stays visible.
 */
/** Drop number of a tall card's extra table rows: above every other part, so they are the first to go. */
const EXTRA_ROW_DROP=1000;
export function useFit<T extends HTMLElement>(deps: DependencyList): { readonly ref: RefObject<T | null>; readonly hiddenRows: number } {
  const ref = useRef<T>(null);
  const [hiddenRows, setHiddenRows] = useState(0);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const run = () => {
      type Candidate={nodes:HTMLElement[];priority:number;row:boolean};
      const more = root.querySelector<HTMLElement>('[data-more]');
      const candidates:Candidate[]=Array.from(root.querySelectorAll<HTMLElement>('[data-drop]')).map(el=>({nodes:[el],priority:Number(el.dataset.drop)||0,row:el.hasAttribute('data-row')}));
      for(const mini of root.querySelectorAll<HTMLElement>('[data-mini-columns]')){
        const priorities=(mini.dataset.miniColumns??'').split(',').map(Number);
        priorities.forEach((priority,index)=>{if(priority)candidates.push({nodes:Array.from(mini.querySelectorAll<HTMLElement>(`tr > :nth-child(${index+1})`)),priority,row:false});});
        // D-333: rows from `data-mini-extra-rows` on are the ones only a tall card adds; they go before anything the short card already showed.
        const extraFrom=Number(mini.dataset.miniExtraRows);
        Array.from(mini.querySelectorAll<HTMLElement>('tbody tr')).forEach((el,index)=>candidates.push({nodes:[el],priority:extraFrom>0&&index>=extraFrom?EXTRA_ROW_DROP+index:Number(mini.dataset.miniRowPriority)+index,row:true}));
      }
      for(const c of candidates)for(const el of c.nodes)el.hidden=false;
      if(more)more.hidden=true;
      if(root.clientHeight===0){setHiddenRows(0);return;}
      const frame=root.closest<HTMLElement>('.ui-panel-content')??root;
      const clashes=()=>editClashCount(frame);
      const over=()=>root.scrollHeight>root.clientHeight+1||root.scrollWidth>root.clientWidth+1||clashes()>0;
      const score=()=>Math.max(0,root.scrollHeight-root.clientHeight)+Math.max(0,root.scrollWidth-root.clientWidth)+1000*clashes();
      const ordered=candidates.map((c,index)=>({...c,index})).sort((a,b)=>b.priority-a.priority||b.index-a.index);
      const dropped:Candidate[]=[];
      // Two overflowing columns can keep the same total height after the first hide.
      // Follow the drop order through that plateau, then give back anything unnecessary.
      for(const c of ordered){
        if(!over())break;
        if(c.nodes.every(el=>el.hidden))continue;
        for(const el of c.nodes)el.hidden=true;
        dropped.push(c);
      }
      for(const c of [...dropped].reverse()){
        const before=score();
        for(const el of c.nodes)el.hidden=false;
        if(over()&&score()>before)for(const el of c.nodes)el.hidden=true;
      }
      const rows=dropped.filter(c=>c.row&&c.nodes[0]?.hidden).length;
      if(more&&rows>0){more.hidden=false;if(over())more.hidden=true;}
      setHiddenRows(rows);
    };
    run();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(run);
    observer?.observe(root);
    // MetricFit commits its chosen type/line stage after measuring its own width.
    // That changes content height even when this fixed-size panel has not resized.
    const sizing = typeof MutationObserver === 'undefined' ? null : new MutationObserver(run);
    sizing?.observe(root, { subtree: true, attributes: true, attributeFilter: ['data-stage'] });
    // Web fonts change line breaks without changing the box: fit again when they arrive.
    let live = true;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    const onFonts = () => { if (live) run(); };
    void fonts?.ready.then(onFonts);
    fonts?.addEventListener?.('loadingdone', onFonts);
    return () => { live = false; observer?.disconnect(); sizing?.disconnect(); fonts?.removeEventListener?.('loadingdone', onFonts); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ref, hiddenRows };
}

const SurfaceContext=createContext<{featureId:FeatureId;scope:'dashboard'|'detail'}>({featureId:'inventory-booking',scope:'dashboard'});
export function SupplySurface({featureId,scope,children}:{featureId:FeatureId;scope:'dashboard'|'detail';children:ReactNode}){
 const value=useMemo(()=>({featureId,scope}),[featureId,scope]);return <SurfaceContext value={value}>{children}</SurfaceContext>;
}
/** A slot remains registered while a grid replaces its display with an editor. */
export function GridValueSlot({gridId,rowId,columnId,slot,value}:{gridId:string;rowId:string;columnId:string;slot:string;value:string|number|boolean|null}){
 const surface=useContext(SurfaceContext),[node,setNode]=useState<HTMLElement|null>(null);
 useLayoutEffect(()=>{
  const table=Array.from(document.querySelectorAll<HTMLElement>('table[role="grid"]')).find(el=>el.getAttribute('aria-labelledby')===`${gridId}-label`);
  const cell=Array.from(table?.querySelectorAll<HTMLElement>('[data-grid-row-id][data-grid-column-id]')??[]).find(el=>el.dataset.gridRowId===rowId&&el.dataset.gridColumnId===columnId)??null;
  if(!cell)return;cell.dataset.slotId=slot;cell.classList.add('ui-visible-value');setNode(cell);
  return()=>{if(cell.dataset.slotId===slot)delete cell.dataset.slotId;cell.classList.remove('ui-visible-value');};
 },[gridId,rowId,columnId,slot]);
 const visible=useActualVisibility(node);
 useVisibleValueSlot({slotId:slot,featureId:surface.featureId,scope:'editor',semanticValue:value,visible});
 return null;
}
function useActualVisibility(target:HTMLElement|null|RefObject<HTMLElement|null>){
 const [visible,setVisible]=useState(false);
 useLayoutEffect(()=>{
  const node=target&&'current' in target?target.current:target;
  if(!node){setVisible(false);return;}
  const measure=()=>{
   const rect=node.getBoundingClientRect(),dialog=Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(el=>!el.closest('[hidden],[inert],[aria-hidden="true"]'));
   let shown=rect.width>0&&rect.height>0&&rect.bottom>0&&rect.right>0&&rect.top<window.innerHeight&&rect.left<window.innerWidth&&!node.closest('[hidden],[inert],[aria-hidden="true"]')&&(!dialog||dialog.contains(node));
   for(let ancestor:HTMLElement|null=node;shown&&ancestor;ancestor=ancestor.parentElement){
    const style=getComputedStyle(ancestor);
    if(style.display==='none'||style.visibility==='hidden'){shown=false;break;}
    if(/auto|scroll|hidden|clip/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)){const box=ancestor.getBoundingClientRect();shown=rect.bottom>box.top&&rect.top<box.bottom&&rect.right>box.left&&rect.left<box.right;}
   }
   setVisible(shown);
  };
  measure();const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);for(let ancestor:HTMLElement|null=node;ancestor;ancestor=ancestor.parentElement)resize?.observe(ancestor);
  const mutation=typeof MutationObserver==='undefined'?null:new MutationObserver(measure);mutation?.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','inert','aria-hidden','class','style']});
  document.addEventListener('scroll',measure,true);window.addEventListener('resize',measure);
  return()=>{resize?.disconnect();mutation?.disconnect();document.removeEventListener('scroll',measure,true);window.removeEventListener('resize',measure);};
 },[target]);
 return visible;
}
/** API-211: only the app coordinator selects and times changed-value highlights. */
export function Flash({value,children,className='',slot,scope}:{value:unknown;children:ReactNode;className?:string;slot?:string;scope?:ChangedValueSlot['scope']}){
 const surface=useContext(SurfaceContext),id=useId(),ref=useRef<HTMLSpanElement>(null);
 const semanticValue=typeof value==='number'||typeof value==='string'||typeof value==='boolean'||value===null?value:JSON.stringify(value);
 const slotId=slot??`${surface.featureId}:${surface.scope}:${id}`;
 const visible=useActualVisibility(ref);
 useVisibleValueSlot({slotId,featureId:surface.featureId,scope:scope??surface.scope,semanticValue,visible});
 return <span ref={ref} className={`ms-flash ui-visible-value ${className}`} data-slot-id={slotId}>{children}</span>;
}

/** DS 11.5 panel state: icon + message, one action at most (it never opens the panel's detail). */
export function SupplyPanelState({ featureId, tone, message, actionLabel, onAction, shape, children }: { readonly featureId: FeatureId; readonly tone: PanelStateTone; readonly message: string; readonly actionLabel?: string; readonly onAction?: () => void; readonly shape: 'Q' | 'W' | 'T' | 'S' | 'L'; readonly children?: ReactNode }) {
  const x = useSupplyText();
  return <div className="ms-state" data-slot={`${featureId}.state.message`}>
    <PanelState tone={tone} shape={shape} message={message} action={actionLabel && onAction ? { label: actionLabel, widgetName: x.tk(`widget.${featureId}.title`), onPress: onAction } : undefined}>{children}</PanelState>
  </div>;
}

/** Message keys of empty/error views come from the data bundle; error views always offer ‘다시 시도’. */
export function stateTone(status: 'empty' | 'error'): PanelStateTone { return status === 'error' ? 'error' : 'info'; }

/** A key number with its unit through the kit MetricFit (DS 11.3.4), never a smaller font. */
export { MetricFit } from '../../../ui';

/** The warning line of the S slot: icon + words, never colour alone (SCR-30). */
export function WarnLine({ children, slot, drop = 900 }: { readonly children: ReactNode; readonly slot?: string; readonly drop?: number }) {
  return <p className="ms-warn" data-slot={slot} data-drop={drop}><Icon name="warning" aria-hidden />{children}</p>;
}

export function NeedsReviewBadge({ label }: { readonly label?: string }) { return <StatusBadge kind="needsReview" label={label} />; }

export { useViewMemory } from './detail-session';

/** Notifies a data command result through the host (undo token when the data store allows it). */
export function notifyResult(host: WidgetHost, result: { readonly ok: true; readonly noticeKey?: string; readonly params?: MessageParams; readonly undoToken?: string }, fallbackKey: string) {
  host.notify({ kind: 'success', messageKey: result.noticeKey ?? fallbackKey, ...(result.params ? { params: result.params } : {}), ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
}

/** Sample-only completions (‘…했어요(예시)’): nothing in the data changes (D-63). */
export function notifySample(host: WidgetHost, text: string) {
  host.notify({ kind: 'complete', messageKey: 'common.sample', params: { text } });
}

/** Text scale of the kit (100 | 125). */
export function useTextScale(): 100 | 125 { return useUi().textScale; }

export type { DataWidgetId };

/**
 * Order list order (SCR-216 ‘입고 예정일 가까운 순’): open orders first, the overdue one before the ones still to come, then the finished
 * orders, newest first. On the cafe seed (128 finished orders) a plain ascending date would bury the open orders at the bottom.
 */
export const byNearestDue = (a: { readonly open: boolean; readonly dueDate: string | null }, b: { readonly open: boolean; readonly dueDate: string | null }): number =>
  Number(b.open) - Number(a.open) || (a.open ? (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') : (b.dueDate ?? '').localeCompare(a.dueDate ?? ''));

/** Adapters sort semantic numbers/dates, with a stable ID tie-breaker. Never mutate selector rows. */
export function sortGridRows<Row>(rows:readonly Row[], columns:readonly GridColumn<Row>[], sort:GridSort, id:(row:Row)=>string, defaultCompare?:(a:Row,b:Row)=>number):Row[] {
  const column=columns.find(c=>c.id===sort?.columnId);
  return [...rows].sort((a,b)=>{
    if(!sort||!column)return (defaultCompare?.(a,b)??0)||id(a).localeCompare(id(b));
    const av=column.value(a),bv=column.value(b);
    const comparison=typeof av==='number'&&typeof bv==='number'?av-bv:String(av??'').localeCompare(String(bv??''),'ko',{numeric:true});
    return comparison*(sort.direction==='asc'?1:-1)||id(a).localeCompare(id(b));
  });
}
