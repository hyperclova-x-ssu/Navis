import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ScreenPreset, Theme, ViewportTransform } from '../contracts';
import type { PresetLayout } from './viewport';
export interface UiContextValue { readonly theme:Theme; readonly textScale:100|125; readonly reducedMotion:boolean; readonly portalContainer:HTMLElement|null; readonly canvasElement:HTMLElement|null; readonly screenPreset:ScreenPreset; readonly transform:ViewportTransform|null; readonly layout:PresetLayout }
export const UiContext=createContext<UiContextValue|null>(null);
export function useUi():UiContextValue {const value=useContext(UiContext);if(!value)throw new Error('UiProvider with an explicit screenPreset is required');return value;}
function subscribeMedia(query:string,listener:()=>void):()=>void{
  if(typeof matchMedia==='undefined')return ()=>{};
  const media=matchMedia(query);media.addEventListener('change',listener);return ()=>media.removeEventListener('change',listener);
}
const subscribeReduced=(listener:()=>void)=>subscribeMedia('(prefers-reduced-motion: reduce)',listener);
const reducedSnapshot=()=>typeof matchMedia!=='undefined'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const serverSnapshot=()=>false;
export function useSystemPreferences(){
  const reducedMotion=useSyncExternalStore(subscribeReduced,reducedSnapshot,serverSnapshot);
  return {theme:'light' as const,reducedMotion};
}
