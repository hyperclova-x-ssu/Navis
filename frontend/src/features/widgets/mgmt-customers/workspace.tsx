/** Widget adapters: kit tables, occlusion and safe selection return. */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../../i18n';
import { MiniTable, useVisibleValueSlot, type MiniTableColumn, type DataGridHandle } from '../../../ui';

export function FitMiniTable<R>({ rows, columns, getRowId, label, dropColumns = [] }: {rows:readonly R[];columns:readonly MiniTableColumn<R>[];getRowId:(row:R)=>string;label:string;dropColumns?:readonly string[]}) {
 const ref=useRef<HTMLDivElement>(null),t=useI18n();
 useLayoutEffect(()=>{
  const table=ref.current?.querySelector('table');if(!table)return;
  table.querySelectorAll('tbody tr').forEach((row,i)=>{(row as HTMLElement).dataset.drop=String(6+i/100);(row as HTMLElement).dataset.fitRow='true';});
  columns.forEach((col,i)=>{const rank=dropColumns.indexOf(col.id);if(rank<0)return;table.querySelectorAll<HTMLElement>(`tr > :nth-child(${i+1})`).forEach(cell=>{cell.dataset.drop=String(5+rank/100);cell.dataset.fitGroup=`${label}:${col.id}`;});});
 });
 return <div ref={ref} className="mc-mini"><MiniTable rows={rows} columns={columns} getRowId={getRowId} label={label}/><p className="mc-caption" data-more-template={t.t('common.moreItems',{n:'__COUNT__'})} hidden/></div>;
}
/** Exclude covered targets; layoutKey changes only when adapter data or table layout changes. */
export function useSideGrid(open: boolean, layoutKey = '') {
 const root = useRef<HTMLDivElement>(null);
 const [obscured, setObscured] = useState<ReadonlySet<string>>(new Set());
 useLayoutEffect(() => {
  const node = root.current;
  if (!node) return;
  const headers = () => Array.from(node.querySelectorAll<HTMLElement>('thead [data-grid-target]')).filter(target => !target.closest('.ui-detail-side-panel'));
  const publish = (covered: ReadonlySet<string>) => setObscured(old => old.size === covered.size && [...old].every(key => covered.has(key)) ? old : covered);
  const clear = () => {
   headers().forEach(target => { target.inert = false; target.removeAttribute('aria-hidden'); });
   publish(new Set());
  };
  // Closed panels need neither layout reads nor geometry subscriptions.
  if (!open) { clear(); return; }
  const measure = () => {
   const panel = node.querySelector<HTMLElement>('.ui-detail-side-panel');
   const measured = panel?.getBoundingClientRect();
   if (!measured || measured.width <= 0) { clear(); return; }
   const right = node.getBoundingClientRect().right;
   // Use the destination rectangle so the entrance transform cannot expose covered cells.
   const box = { left: right - measured.width, right, top: measured.top, bottom: measured.bottom };
   const covered = new Set<string>();
   const headerMask: { target: HTMLElement; hidden: boolean }[] = [];
   const overlaps = (column: DOMRect, row = column) => column.width > 0 && row.width > 0 && column.left < box.right && column.right > box.left && row.top < box.bottom && row.bottom > box.top;
   node.querySelectorAll<HTMLElement>('table[role="grid"]').forEach(table => {
    if (table.closest('.ui-detail-side-panel')) return;
    // The kit uses the same CSS grid tracks for every row, including sticky first columns.
    // Read each column's horizontal bounds and each row's vertical bounds just once.
    const columns = Array.from(table.querySelectorAll<HTMLElement>(':scope > thead > tr > th'), th => {
     const rect = th.getBoundingClientRect();
     th.querySelectorAll<HTMLElement>('[data-grid-target]').forEach(target => headerMask.push({ target, hidden: overlaps(rect) }));
     return rect;
    });
    table.querySelectorAll<HTMLElement>(':scope > tbody > tr[data-grid-row]').forEach(row => {
     const rect = row.getBoundingClientRect();
     Array.from(row.children).forEach((cell, index) => {
      const column = columns[index];
      if (cell instanceof HTMLElement && cell.dataset.gridRowId && cell.dataset.gridColumnId && column && overlaps(column, rect)) covered.add(`${cell.dataset.gridRowId}:${cell.dataset.gridColumnId}`);
     });
    });
   });
   // Finish all geometry reads before changing inert/ARIA or publishing the cell mask.
   headerMask.forEach(({ target, hidden }) => {
    target.inert = hidden;
    if (hidden) { target.tabIndex = -1; target.setAttribute('aria-hidden', 'true'); }
    else target.removeAttribute('aria-hidden');
   });
   const targets = Array.from(node.querySelectorAll<HTMLElement>('[data-grid-target]')).filter(el => !el.closest('.ui-detail-side-panel,[inert]'));
   if (!targets.some(el => el.tabIndex === 0)) {
    const first = targets.find(el => el.hasAttribute('data-grid-row-id') && !covered.has(`${el.dataset.gridRowId}:${el.dataset.gridColumnId}`));
    if (first) first.tabIndex = 0;
   }
   publish(covered);
  };
  const headerNavigation = (event: KeyboardEvent) => {
   const target = (event.target as HTMLElement).closest<HTMLElement>('thead [data-grid-target]');
   if (!open || !target || target.closest('.ui-detail-side-panel')) return;
   const headers = Array.from(target.closest('thead')!.querySelectorAll<HTMLElement>('[data-grid-target]')).filter(el => !el.inert);
   const index = headers.indexOf(target);
   const next = event.key === 'ArrowRight' ? headers[Math.min(index + 1, headers.length - 1)] : event.key === 'ArrowLeft' ? headers[Math.max(0, index - 1)] : event.key === 'Home' && !event.ctrlKey ? headers[0] : event.key === 'End' && !event.ctrlKey ? headers.at(-1) : undefined;
   if (next) { event.preventDefault(); event.stopPropagation(); next.focus({ preventScroll: true }); }
  };
  measure();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  observer?.observe(node);
  node.querySelectorAll<HTMLElement>('table[role="grid"],.ui-detail-side-panel').forEach(element => { if (!element.closest('.ui-detail-side-panel') || element.matches('.ui-detail-side-panel')) observer?.observe(element); });
  node.addEventListener('scroll', measure, true);
  node.addEventListener('keydown', headerNavigation, true);
  window.addEventListener('resize', measure);
  return () => {
   observer?.disconnect();
   node.removeEventListener('scroll', measure, true);
   node.removeEventListener('keydown', headerNavigation, true);
   window.removeEventListener('resize', measure);
  };
 }, [open, layoutKey]);
 return { root, obscured };
}
export function restoreGrid(grid:RefObject<DataGridHandle|null>,key:string,column:string,visible:readonly string[]) {
 if(grid.current?.focusCell(key,column))return;
 if(visible[0]&&grid.current?.focusCell(visible[0],column))return;
 grid.current?.focusFallback();
}

/** Registers semantic values only while their DOM surface is visible. */
export function ValueSlot({featureId,scope,slotId,value,children}:{featureId:import('../../../contracts').FeatureId;scope:'dashboard'|'detail'|'editor';slotId:string;value:string|number|null;children:import('react').ReactNode}) {
 const node=useRef<HTMLSpanElement>(null),[visible,setVisible]=useState(false);
 useLayoutEffect(()=>{
  const el=node.current;if(!el)return;
  const check=()=>setVisible(!el.closest('[hidden],[inert],[aria-hidden="true"]')&&el.getClientRects().length>0);
  check();const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(check);resize?.observe(el);
  const mutations=new MutationObserver(check);let ancestor:HTMLElement|null=el;while(ancestor){mutations.observe(ancestor,{attributes:true,attributeFilter:['hidden','inert','aria-hidden','style','class']});ancestor=ancestor.parentElement;}
  return()=>{resize?.disconnect();mutations.disconnect();};
 },[]);
 useVisibleValueSlot({featureId,scope,slotId,semanticValue:value,visible});
 return <span ref={node} className="ui-visible-value" data-slot-id={slotId}>{children}</span>;
}
