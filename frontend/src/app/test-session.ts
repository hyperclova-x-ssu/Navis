import type { BusinessType, RunStore } from '../contracts';
import { createWidgetDataStore } from '../data/widget-data';
import { createSessionActions, sessionGateFor } from './session-actions';
/** Explicit fixture boundary: old UI regression tests begin after the new setup flow. */
export function beginDashboard(run:RunStore,businessType:BusinessType|null=null){
 run.actions.setOnboardingAnswer({businessType});
 run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});
 const data=createWidgetDataStore(undefined,{runId:run.getState().runId,sessionGate:sessionGateFor(run)});
 const result=createSessionActions(run,data).completeOnboarding(null);
 if(!result.ok)throw new Error(result.messageKey);
}
