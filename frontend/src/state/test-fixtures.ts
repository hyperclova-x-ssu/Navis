import type { BusinessType, RunStore } from '../contracts';

/** Existing board/timer regressions enter through the current onboarding contract. */
export function completeEmptyOnboarding(run:RunStore,businessType:BusinessType|null='cafe'):void {
  run.actions.chooseBusiness(businessType);
  if(!run.actions.setOnboardingAnswer({paymentStyle:'prepaid'})||!run.actions.startEmpty())throw new Error('테스트 온보딩을 완료하지 못했어요');
}

/** An isolated run's settings mirror is updated through its real transaction port. */
export function updateSettingsForTest(run:RunStore,businessType:BusinessType|null):void {
  const s=run.getState();
  const result=run.session.prepare({transactionId:`settings-${s.runRevision}`,runId:s.runId,expectedDataRevision:0,expectedRunRevision:s.runRevision,transitionToken:s.transitionToken},{type:'update-settings',settings:{...s.shopSettings,businessType,revision:s.shopSettings.revision+1}});
  if(!result.ok)throw new Error(result.reason);
  run.session.publish(result.change);run.session.flush(result.change.transactionId);
}
