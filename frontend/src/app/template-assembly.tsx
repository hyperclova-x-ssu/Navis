import { useCallback, useSyncExternalStore } from 'react';
import type {RunStore} from '../contracts';
import type {PresentationRunStore} from '../state';
/** The last FlyInFrame owns completion: a passive-effect deadline can precede
 * Motion's first frame. Capture the identity so an old flight cannot finish a new run. */
export function useTemplateAssembly(run:RunStore){
 const state=useSyncExternalStore(run.subscribe,run.getState),applying=state.onboarding.step==='applying',applyToken=state.onboarding.applyToken,runId=state.runId,transitionToken=state.transitionToken;
 return useCallback(()=>{
  // Both publishes belong to the last landing task. A later passive-effect
  // settlement would interrupt the 400 ms notice-to-tour wait with a full render.
  if(applying&&applyToken&&run.actions.templateAssembled({runId,applyToken}))
   (run as PresentationRunStore).actions.visualSettled({runId,transitionToken});
 },[run,applying,runId,applyToken,transitionToken]);
}
