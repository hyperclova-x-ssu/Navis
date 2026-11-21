import type { LayoutAdapter } from '../../contracts';
import { layoutResult } from '../../layout';
import { screenPresets } from '../../layout/presets';
/** Explicit dev-only wrapper, applied by the shell only for named verification scenarios. */
export function createVerificationLayoutAdapter(base:LayoutAdapter,{delayMs=0,failOnce=false}:{delayMs?:number;failOnce?:boolean}):LayoutAdapter {
  let timer:ReturnType<typeof setTimeout>|null=null,generation=0,failed=false;
  const cancel=()=>{generation++;if(timer!==null)clearTimeout(timer);timer=null;base.cancel();};
  return {
    ready:base.ready,
    submit(request,receive){
      cancel();const current=generation;
      base.submit(request,response=>{
        if(current!==generation)return;
        const result=failOnce&&!failed?layoutResult(request.beforePanels,screenPresets[request.presetId].grid,'INTERNAL_LAYOUT_ERROR'):response.result;failed ||= failOnce;
        timer=setTimeout(()=>{timer=null;if(current===generation)receive({...response,result});},delayMs);
      });
    },
    cancel,
    dispose(){cancel();base.dispose();},
  };
}
export function rejectFirstPreview():()=>boolean {let first=true;return ()=>{if(first){first=false;return false;}return true;};}
