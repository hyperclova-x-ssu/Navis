import { useCallback, useInsertionEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { LayoutGroup, MotionConfig } from 'motion/react';
import type { ScreenPreset, Theme, ViewportTransform } from '../contracts';
import { UiContext, useSystemPreferences } from './context';
import { fitViewport, getPresetLayout } from './viewport';
import './tokens.css';
import './pos.css';
import { posCssVariables } from './pos-tokens';

export interface UiProviderProps { readonly children:ReactNode; readonly theme?:Theme; readonly textScale?:100|125; readonly reducedMotion?:boolean; readonly screenPreset:ScreenPreset; readonly transform?:ViewportTransform }
export function UiProvider({children,theme,textScale=100,reducedMotion,screenPreset,transform}:UiProviderProps){
  const keyboardFocus=useRef(false);
  const system=useSystemPreferences();const resolvedTheme=theme??system.theme;const reduce=reducedMotion??system.reducedMotion;
  const [portalContainer,setPortalContainer]=useState<HTMLDivElement|null>(null);
  const [canvasElement,setCanvasElement]=useState<HTMLDivElement|null>(null);
  const layout=useMemo(()=>getPresetLayout(screenPreset),[screenPreset]);
  const resolvedTransform=transform??fitViewport(screenPreset,{width:screenPreset.baselineWidth,height:screenPreset.baselineHeight});
  if(!resolvedTransform)throw new RangeError('A positive preset canvas is required');
  const canvasScale=resolvedTransform.scale;const canvasX=resolvedTransform.offsetX;const canvasY=resolvedTransform.offsetY;
  const transformPagePoint=useCallback((point:{x:number;y:number})=>({x:(point.x-canvasX)/canvasScale,y:(point.y-canvasY)/canvasScale}),[canvasScale,canvasX,canvasY]);
  const variables:CSSProperties={
    ...posCssVariables(screenPreset.id),
    '--canvas-width':`${screenPreset.baselineWidth}px`,'--canvas-height':`${screenPreset.baselineHeight}px`,
    '--grid-columns':screenPreset.grid.columns,'--grid-rows':screenPreset.grid.rows,
    '--grid-width':`${layout.grid.width}px`,'--grid-height':`${layout.grid.height}px`,
    '--drawer-width':`${layout.drawer.width}px`,'--drawer-max-height':`${layout.drawer.height}px`,'--drawer-x':`${layout.drawer.x}px`,'--drawer-y':`${layout.drawer.y}px`,'--detail-inset':`${layout.detailInset}px`,
    '--settings-height':`${layout.settings.height}px`,'--settings-max-height':`${screenPreset.id==='B'?1120:920}px`,
    '--briefing-width':`${layout.briefing.width}px`,'--briefing-height':`${layout.briefing.height}px`,'--briefing-max-height':`${layout.briefing.maxHeight}px`,
    '--coach-max-width':`${layout.coach.width}px`,'--coach-max-height':`${layout.coach.maxHeight}px`,
    '--question-width':`${layout.question.width}px`,'--question-height':`${layout.question.height}px`,
    '--detail-header-height':'72px',
  } as CSSProperties;
  // Keep the pre-mount document state until unmount. A scale update must not
  // temporarily restore it while descendant fitters are measuring this commit.
  useInsertionEffect(()=>{
    const root=document.documentElement;
    const previous={theme:root.getAttribute('data-theme'),reduced:root.getAttribute('data-reduced-motion'),scale:root.getAttribute('data-text-scale'),font:root.style.fontSize,colorScheme:root.style.colorScheme};
    return ()=>{
      for(const [name,value] of [['data-theme',previous.theme],['data-reduced-motion',previous.reduced],['data-text-scale',previous.scale]]){if(value===null)root.removeAttribute(name!);else root.setAttribute(name!,value!);}
      root.style.fontSize=previous.font;root.style.colorScheme=previous.colorScheme;
    };
  },[]);
  // All insertion effects finish before any descendant layout effect runs.
  useInsertionEffect(()=>{
    const root=document.documentElement;
    root.dataset.theme=resolvedTheme;root.dataset.reducedMotion=String(reduce);root.dataset.textScale=String(textScale);root.style.fontSize=textScale===125?'20px':'16px';root.style.colorScheme=resolvedTheme;
  },[resolvedTheme,reduce,textScale]);
  return <UiContext value={{theme:resolvedTheme,textScale,reducedMotion:reduce,portalContainer,canvasElement,screenPreset,transform:resolvedTransform,layout}}><MotionConfig reducedMotion={reduce?'always':'never'} transformPagePoint={transformPagePoint}><LayoutGroup><div ref={setCanvasElement} onPointerDownCapture={()=>{keyboardFocus.current=false;}} onKeyDownCapture={event=>{keyboardFocus.current=true;if(event.target instanceof HTMLElement)event.target.removeAttribute('data-pointer-heading-focus');}} onFocusCapture={event=>{const target=event.target;if(target instanceof HTMLElement&&/^H[1-6]$/.test(target.tagName)&&target.tabIndex===-1){if(keyboardFocus.current)target.removeAttribute('data-pointer-heading-focus');else target.setAttribute('data-pointer-heading-focus','');}}} className="ui-root" style={variables} data-screen-preset={screenPreset.id} data-theme={resolvedTheme} data-text-scale={textScale} data-reduced-motion={String(reduce)}>{children}<div ref={setPortalContainer} className="ui-portal-host" data-ui-portal-host=""/></div></LayoutGroup></MotionConfig></UiContext>;
}
