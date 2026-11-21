import type { CSSProperties, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent, type MotionStyle } from 'motion/react';
import type { Panel } from '../../contracts';
import { useUi } from '../context';
import { motionTokens, transitionFor } from '../motion';
import { FlyInContext } from '../fly-context';

const position=(panel?:Panel):CSSProperties=>panel?{gridRow:`${panel.row+1} / span ${panel.height}`,gridColumn:`${panel.column+1} / span ${panel.width}`} : {};
export function PanelMotionFrame({ref,children,panel,layoutId,dragging=false,offset={x:0,y:0},onSettled,style,lifted=dragging,transitionKind='layout'}: {readonly ref?:Ref<HTMLDivElement>;readonly children:ReactNode;readonly panel?:Panel;readonly layoutId?:string;readonly dragging?:boolean;readonly offset?:{readonly x:number;readonly y:number};readonly onSettled?:()=>void;readonly style?:MotionStyle;readonly lifted?:boolean;readonly transitionKind?:'layout'|'snap'}){
  const {reducedMotion}=useUi();const automatic=!dragging&&!reducedMotion;
  return <motion.div ref={ref} className="ui-layout-layer" style={{...position(panel),...style}} layout={automatic} layoutDependency={panel?`${panel.row}:${panel.column}:${panel.height}:${panel.width}`:undefined} layoutId={reducedMotion?undefined:layoutId} transition={transitionFor(transitionKind,reducedMotion)} onLayoutAnimationComplete={onSettled} data-testid="ui-layout-layer" data-auto-motion={String(automatic)} data-dragging={String(dragging)}><div className="ui-drag-layer" data-testid="ui-drag-layer" style={{transform:`translate3d(${offset.x}px, ${offset.y}px, 0px)`,transition:'none',...(dragging?{opacity:motionTokens.opacityDrag}:{})}}><motion.div className="ui-lift-layer" initial={false} animate={{transform:lifted&&!reducedMotion?`translateY(${motionTokens.translateLift}px) scale(${motionTokens.scaleLift})`:'translateY(0px) scale(1)'}} transition={transitionFor('short',reducedMotion)}><motion.span className="ui-lift-shadow" aria-hidden="true" initial={false} animate={{opacity:lifted?1:0}} transition={transitionFor('short',reducedMotion)}/>{children}</motion.div></div></motion.div>;
}
export interface OverlayExitSurfaceProps {readonly token:string;readonly kind:'detail'|'fullscreen'|'settings'|'briefing'|'drawer'|'closing';readonly children:ReactNode;readonly onComplete:(token:string)=>void;readonly layoutId?:string;readonly style?:MotionStyle;readonly surfaceRef?:Ref<HTMLDivElement>}
export function OverlayExitSurface(props:OverlayExitSurfaceProps){const {portalContainer}=useUi();if(!portalContainer)return null;return createPortal(<ExitMotion key={props.token} {...props}/>,portalContainer);}
function ExitMotion({token,kind,children,onComplete,layoutId,style,surfaceRef}:OverlayExitSurfaceProps){
  const {reducedMotion}=useUi();const duration=kind==='closing'?'dialogFromButtonOut':kind==='drawer'?'drawerOut':kind==='briefing'?'briefingOut':'detailOut';
  const defaultOpacity=style?.opacity===undefined;
  const transform=reducedMotion||layoutId||style?.transform!==undefined?undefined:kind==='drawer'?`translateX(${motionTokens.translateDrawer}px)`:`scale(${motionTokens.scaleOverlay})`;
  const content=<motion.div ref={surfaceRef} className={kind==='drawer'?'ui-drawer ui-overlay-exit':`ui-dialog ui-dialog--${kind==='closing'?'detail':kind} ui-overlay-exit`} style={{...style,...(kind==='closing'?{transformOrigin:'top right'}:{}),pointerEvents:'none'}} data-testid="ui-overlay-exit" aria-hidden="true" inert layoutId={reducedMotion?undefined:layoutId} initial={defaultOpacity?{opacity:1}:{}} animate={{...(defaultOpacity?{opacity:0}:{}),...(transform?{transform}:{})}} transition={transitionFor(duration,reducedMotion)} onAnimationComplete={()=>onComplete(token)}>{children}</motion.div>;
  return kind==='drawer'?content:<div className={`ui-modal-viewport ui-overlay-exit ${kind==='fullscreen'?'ui-modal-viewport--fullscreen':''}`} aria-hidden="true" inert style={{pointerEvents:'none'}}>{content}</div>;
}
export function FirstUseHint({play,children}:{readonly play:boolean;readonly children:ReactNode}){
  const {reducedMotion}=useUi();
  return <motion.span style={{display:'inline-flex'}} animate={{transform:play&&!reducedMotion?['translateX(0px)',`translateX(${motionTokens.translateHint}px)`,'translateX(0px)']:'translateX(0px)'}} transition={play&&!reducedMotion?{...transitionFor('hint'),times:[0,.5,1]}:{duration:0}}>{children}</motion.span>;
}
export function IdleChrome({idle,children}:{readonly idle:boolean;readonly children:ReactNode}){
  const {reducedMotion}=useUi();return <motion.div aria-hidden={idle||undefined} inert={idle||undefined} style={{pointerEvents:idle?'none':undefined}} animate={{opacity:idle?0:1}} transition={transitionFor(idle?'idleOut':'idleIn',reducedMotion)}>{children}</motion.div>;
}

export interface FrameRect { readonly x:number;readonly y:number;readonly width:number;readonly height:number }
/** The adapter reads rectangles once; this visual layer never measures in render. */
export function FlyInFrame({children,fromRect,toRect,index=0,stagger,onSettled}:{readonly children:ReactNode;readonly fromRect?:FrameRect;readonly toRect?:FrameRect;readonly index?:number;/** Stagger step in ms between indexes. Defaults to motionTokens.staggerStart; M-28 uses 24. */readonly stagger?:number;readonly onSettled?:()=>void}){
  const {reducedMotion}=useUi();const delay=reducedMotion?0:index*(stagger??motionTokens.staggerStart)/1000;
  const origin=fromRect&&toRect&&toRect.width>0&&toRect.height>0?`translate3d(${fromRect.x-toRect.x}px, ${fromRect.y-toRect.y}px, 0px) scale(${fromRect.width/toRect.width}, ${fromRect.height/toRect.height})`:'translate3d(0px, 0px, 0px) scale(1, 1)';
  return <FlyInContext value={reducedMotion?null:delay+(motionTokens.duration.fly-motionTokens.duration.content)/1000}><motion.div className="ui-fly-layer" style={{transformOrigin:'top left'}} initial={{opacity:reducedMotion?0:motionTokens.opacityDrag,...(!reducedMotion?{transform:origin}:{})}} animate={{opacity:1,...(!reducedMotion?{transform:'translate3d(0px, 0px, 0px) scale(1, 1)'}:{})}} transition={{...transitionFor('fly',reducedMotion),delay}} onAnimationComplete={onSettled}><div className="ui-fly-content">{children}</div></motion.div></FlyInContext>;
}
function ContentLayer({children,kind,onSettled}:{readonly children:ReactNode;readonly kind:'content'|'screen';readonly onSettled?:()=>void}){
  const present=useIsPresent();const {reducedMotion}=useUi();
  return <motion.div className="ui-content-layer" aria-hidden={!present||undefined} inert={!present||undefined} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={transitionFor(kind,reducedMotion)} onAnimationComplete={()=>{if(present)onSettled?.();}}>{children}</motion.div>;
}
export function ContentCrossfade({contentKey,children}:{readonly contentKey:string;readonly children:ReactNode}){return <div className="ui-content-stack"><AnimatePresence initial={false}><ContentLayer key={contentKey} kind="content">{children}</ContentLayer></AnimatePresence></div>;}
/** M-201 uses its own stagger; do not reuse the marketing recommendation stagger. */
export function TemplateFlyInFrame(props:Parameters<typeof FlyInFrame>[0]){return <FlyInFrame {...props} stagger={motionTokens.staggerTemplate}/>;}
export function ScreenTransition({screenKey,children,onSettled}:{readonly screenKey:string;readonly children:ReactNode;readonly onSettled?:()=>void}){return <div className="ui-content-stack"><AnimatePresence initial={false}><ContentLayer key={screenKey} kind="screen" onSettled={onSettled}>{children}</ContentLayer></AnimatePresence></div>;}
function OnboardingStepLayer({children,direction}:{children:ReactNode;direction:'forward'|'back'}){const {reducedMotion}=useUi(),present=useIsPresent();return <motion.div className="ui-content-layer ui-onboarding-step" inert={!present||undefined} aria-hidden={!present||undefined} initial={{opacity:0,...(!reducedMotion?{transform:`translateX(${(direction==='forward'?1:-1)*motionTokens.translatePage}px)`}:{})}} animate={{opacity:1,...(!reducedMotion?{transform:'translateX(0px)'}:{})}} exit={{opacity:0,transition:transitionFor('content',reducedMotion)}} transition={transitionFor('onboardingStep',reducedMotion)}>{children}</motion.div>;}
export function OnboardingStepTransition({stepKey,direction='forward',children}:{stepKey:string;direction?:'forward'|'back';children:ReactNode}){return <div className="ui-content-stack"><AnimatePresence initial={false}><OnboardingStepLayer key={stepKey} direction={direction}>{children}</OnboardingStepLayer></AnimatePresence></div>;}
export function FilterCrossfade({contentKey,children}:{contentKey:string;children:ReactNode}){const {reducedMotion}=useUi();return <motion.div key={contentKey} initial={reducedMotion?false:{opacity:0}} animate={{opacity:1}} transition={transitionFor('content',reducedMotion)}>{children}</motion.div>;}
