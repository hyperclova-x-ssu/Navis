import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import type { ChangedValueSlot } from '../contracts';

export interface VisibleSlotRegistry {
  register:(slot:ChangedValueSlot)=>()=>void;
  getSnapshot:()=>readonly ChangedValueSlot[];
  subscribe:(listener:()=>void)=>()=>void;
}
/** Registration only. The app coordinator owns comparison and the six-slot policy. */
export function createVisibleSlotRegistry():VisibleSlotRegistry{
  const slots=new Map<string,{slot:ChangedValueSlot;owner:object}>(),listeners=new Set<()=>void>();
  let snapshot:readonly ChangedValueSlot[]=Object.freeze([]);
  const publish=()=>{snapshot=Object.freeze([...slots.values()].map(v=>v.slot));listeners.forEach(fn=>fn());};
  return {
    register(slot){const owner={};slots.set(slot.slotId,{slot:Object.freeze({...slot}),owner});publish();return()=>{if(slots.get(slot.slotId)?.owner===owner){slots.delete(slot.slotId);publish();}};},
    getSnapshot:()=>snapshot,
    subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},
  };
}
const SlotContext=createContext<VisibleSlotRegistry|null>(null);
export function VisibleSlotProvider({registry,children}:{registry:VisibleSlotRegistry;children:ReactNode}){return <SlotContext value={registry}>{children}</SlotContext>;}
export function useVisibleValueSlot(slot:ChangedValueSlot){
  const registry=useContext(SlotContext);
  const {slotId,featureId,scope,semanticValue,visible}=slot;
  useLayoutEffect(()=>registry?.register({slotId,featureId,scope,semanticValue,visible}),[registry,slotId,featureId,scope,semanticValue,visible]);
}
/** Highlight lifetime and selection come from the App coordinator; registration has no side effects on data. */
export function VisibleValue({slot,highlighted=false,children}:{slot:ChangedValueSlot;highlighted?:boolean;children:ReactNode}){useVisibleValueSlot(slot);return <span className="ui-visible-value" data-highlighted={highlighted||undefined} data-slot-id={slot.slotId}>{children}</span>;}
