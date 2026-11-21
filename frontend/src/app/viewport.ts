import type { RunStore, ViewportTransform } from '../contracts';
import { fitViewport } from '../ui';

/** A single external subscription projects the whole logical canvas, including portals. */
export function createViewportSource(run:RunStore,win:Window){
    const preset=run.getState().screenPreset;
    const read=()=>{
        const layout={width:win.innerWidth,height:win.innerHeight};
        if(layout.width<=0||layout.height<=0)return layout;
        const state=run.getState();
        // Only a drawer can contain the search keyboard. Other screens retain layout fit.
        const drawer=state.overlay.type==='drawer'||state.exitingOverlay?.type==='drawer';
        const visual=drawer?win.visualViewport:null;
        return visual?{width:visual.width,height:visual.height,originX:visual.offsetLeft,originY:visual.offsetTop}:layout;
    };
    let current=fitViewport(preset,read())??fitViewport(preset,{width:preset.baselineWidth,height:preset.baselineHeight})!;
    const listeners=new Set<()=>void>();
    let stopRun:(()=>void)|undefined;
    let visual:VisualViewport|null=null;
    const measure=()=>{
        const next=fitViewport(preset,read(),current)!;
        if((Object.keys(current) as (keyof ViewportTransform)[]).every(key=>next[key]===current[key]))return;
        current=next;listeners.forEach(listener=>listener());
    };
    return {
        getSnapshot:()=>current,
        subscribe(listener:()=>void){
            listeners.add(listener);
            if(listeners.size===1){
                win.addEventListener('resize',measure);
                visual=win.visualViewport;visual?.addEventListener('resize',measure);visual?.addEventListener('scroll',measure);
                stopRun=run.subscribe(measure);measure();
            }
            return ()=>{
                listeners.delete(listener);
                if(!listeners.size){
                    win.removeEventListener('resize',measure);visual?.removeEventListener('resize',measure);visual?.removeEventListener('scroll',measure);stopRun?.();
                }
            };
        },
    };
}
