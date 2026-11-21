import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ChangedValueSlot, RunStore } from '../contracts';
import { useWidgetDataStore } from '../data/react';
import { createVisibleSlotRegistry, motionTokens, VisibleSlotProvider } from '../ui';
const priority={editor:0,detail:1,dashboard:2};
export function changedVisibleSlots(before:readonly ChangedValueSlot[],after:readonly ChangedValueSlot[]):readonly string[]{
 const old=new Map(before.map(slot=>[slot.slotId,slot]));
 return after.filter(slot=>slot.visible&&old.get(slot.slotId)?.visible&&old.get(slot.slotId)!.semanticValue!==slot.semanticValue).sort((a,b)=>priority[a.scope]-priority[b.scope]||a.slotId.localeCompare(b.slotId)).slice(0,6).map(slot=>slot.slotId);
}
export function ValueHighlights({run,children}:{run:RunStore;children:ReactNode}){
 const [registry]=useState(createVisibleSlotRegistry),store=useWidgetDataStore(),snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot),state=useSyncExternalStore(run.subscribe,run.getState);
 const registered=useSyncExternalStore(registry.subscribe,registry.getSnapshot);
 const preview=JSON.stringify(state.preview),previous=useRef<{revision:number;preview:string;slots:readonly ChangedValueSlot[]}|null>(null),generation=useRef(0),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 useLayoutEffect(()=>{
  const current=++generation.current;
  queueMicrotask(()=>{
   if(current!==generation.current)return;
   const after=registry.getSnapshot(),before=previous.current;
   previous.current={revision:snapshot.revision,preview,slots:after};
   if(before&&before.preview!==preview){if(timer.current)clearTimeout(timer.current);for(const node of document.querySelectorAll('[data-slot-id][data-highlighted]'))node.removeAttribute('data-highlighted');return;}
   if(!before||before.revision===snapshot.revision)return;
   const selected=new Set(changedVisibleSlots(before.slots,after));
   const nodes=Array.from(document.querySelectorAll<HTMLElement>('[data-slot-id]'));
   if(timer.current)clearTimeout(timer.current);
   for(const node of nodes)node.toggleAttribute('data-highlighted',selected.has(node.dataset.slotId!));
   timer.current=setTimeout(()=>{for(const node of nodes)node.removeAttribute('data-highlighted');},motionTokens.valueFlashHoldMs);
  });
  return()=>{generation.current++;};
 },[snapshot.revision,preview,registry,state.overlay.type,registered]);
 useLayoutEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
 return <VisibleSlotProvider registry={registry}>{children}</VisibleSlotProvider>;
}
