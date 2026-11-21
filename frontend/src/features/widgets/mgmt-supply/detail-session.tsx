import { createContext, useContext, useRef, useState, type ReactNode } from 'react';

const DetailMemory=createContext<Map<string,unknown>|null>(null);
/** The parent detail controller retains this tree during source/closing visits and removes it on full close. */
export function SupplyDetailSession({children}:{children:ReactNode}){
  const values=useRef(new Map<string,unknown>());
  return <DetailMemory value={values.current}>{children}</DetailMemory>;
}
/** A tab may unmount its grid. Its view state lives in the current detail session, never in the data store. */
export function useViewMemory<V>(key:string,initial:()=>V):[V,(next:V)=>void]{
  const bag=useContext(DetailMemory);
  const [value,setValue]=useState<V>(()=>bag?.has(key)?bag.get(key) as V:initial());
  return [value,next=>{bag?.set(key,next);setValue(next);}];
}
