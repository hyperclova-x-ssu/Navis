import type { Transition } from 'motion/react';
import type { TimePolicy } from '../contracts';

/** R4 DESIGN_SYSTEM/MOTION are the only product source of these values. */
export const timePolicy: TimePolicy = Object.freeze({coachFirstMs:400,coachGapMs:200,hintDelayMs:600,briefingSafeMs:1200,idleMs:30000,undoMs:6000,noticeMs:4000,completeMs:2000,existingHighlightMs:800});
export const gestureTokens = Object.freeze({longPressMs:450,slop:8,drawerStart:8,drawerHorizontalRatio:1.5,resizeHysteresis:12,edgeZone:48,edgeDwellMs:500,edgeRepeatMs:700});
export const layoutTokens = Object.freeze({margin:24,header:64,headerGap:24,gridGap:16,railWidth:88,railGap:16,drawerWidth:400,drawerRailGap:12,detailInset:64,targetMin:44,targetDefault:48,targetPrimary:56,prepareThresholdMs:300,coachGap:12,pageBar:48,pageBarGap:16,pageBarBottom:24,panelAction:44,coachFooter:44,coachFooterGap:8});
/** DS 11.6/11.10 token values that are not durations. */
export const pageTokens = Object.freeze({max:5,pageNoticeMs:4000,dotSelectedWidth:28,dotHeight:12,dotSize:12,dotHitWidth:44,dotHitHeight:48,videoFrame:Object.freeze({A:Object.freeze({width:315,height:560}),B:Object.freeze({width:428,height:760})}),videoRatio:'9 / 16'});
export const motionTokens = Object.freeze({
  ease:{out:[.23,1,.32,1] as const,inOut:[.77,0,.175,1] as const,drawer:[.32,.72,0,1] as const},
  duration:{press:120,short:160,drawerIn:240,drawerOut:200,fly:200,layout:220,snap:180,detailIn:280,detailOut:240,idleOut:240,idleIn:160,reduced:80,content:80,coachOut:120,briefingIn:240,briefingOut:160,screen:180,hint:240,page:220,band:80,dotIn:160,form:120,valueFlash:120,scene:300,onboardingStep:220,spotlight:220,scrimIn:160,scrimOut:160,sideIn:240,sideOut:200,sort:180,rowIn:120,rowOut:120,dialogFromButtonIn:240,dialogFromButtonOut:200,cartIn:120,cartOut:120,resultIn:160,check:200,posDialogIn:200,posDialogOut:160,tabContent:80,stateSwap:120,billMove:220},
  staggerStart:40,staggerRecommend:24,staggerTemplate:20,tourStartMs:400,/** DS 11.10 motion.duration.step: a text swap interval of the fake progress, not an animation, so it is outside duration (all durations <= 300). */stepMs:600,valueFlashHoldMs:800,translatePage:24,scalePress:.97,scaleLift:1.025,scaleOverlay:.98,translateLift:-6,translateDrawer:24,translateToast:8,translateHint:-32,opacityDrag:.88,
});
export const managementTokens=Object.freeze({tableColumns:9,tableRows:6,sortVisibleMax:30,spotlightPadding:8,spotlightRadius:12,spotlightRing:2,tourWidth:400,tourMaxHeight:360,tableDragSlop:8});
/** Milliseconds; the sixth panel (zero-based index 5) settles at 300ms. */
export function templateFlightTiming(index:number,reduced=false){
  const delay=reduced?0:Math.max(0,index)*motionTokens.staggerTemplate;
  const duration=reduced?motionTokens.duration.reduced:motionTokens.duration.fly;
  return {delay,duration,settledAt:delay+duration};
}
export type MotionKind = keyof typeof motionTokens.duration;
export function transitionFor(kind:MotionKind,reduced=false):Transition {
  if(reduced)return {type:'tween',duration:motionTokens.duration.reduced/1000,ease:motionTokens.ease.out};
  const duration=motionTokens.duration[kind]/1000;
  return kind==='layout'||kind==='snap'?{type:'spring',duration,bounce:0}:{type:'tween',duration,ease:kind==='drawerIn'||kind==='drawerOut'?motionTokens.ease.drawer:kind==='billMove'?motionTokens.ease.inOut:motionTokens.ease.out};
}
export const panelLayoutId=(featureId:string)=>`panel:${featureId}`;
