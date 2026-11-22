import type { ReactNode, RefObject, Ref } from 'react';
import { useKitT } from '../kit-i18n';
import { ActionButton } from './controls';
import { CoachMark } from './overlays';
import { Icon } from '../icons';
import type { CloseReason } from '../dismiss';

/** DS 11.4 HelpButton: 48x48 hit, 24px line icon. Pointer, click and key events never reach the panel (no detail opening).
 * Esc is the one key that must keep travelling: the popover and the window around the button close on it (K-B, DS 12.2 Esc order),
 * and focus rests on this button after a mouse click or Enter. */
export function HelpButton({name,onPress,hidden=false,className='',ref}:{readonly name:string;readonly onPress:()=>void;/** Editing panels hide it. */readonly hidden?:boolean;readonly className?:string;readonly ref?:Ref<HTMLButtonElement>}){
  const {t}=useKitT();
  if(hidden)return null;
  return <ActionButton ref={ref} variant="ghost" size="icon" className={`ui-help-button ${className}`} aria-label={t('help.about',{name})}
    onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>{if(event.key!=='Escape')event.stopPropagation();}} onClick={event=>{event.stopPropagation();onPress();}}><Icon name="help"/></ActionButton>;
}
export interface CoachFooterProps {
  readonly current:number;readonly total:number;readonly onSkipAll:()=>void;
  /** Primary button of a walkable tour: moves on to the next tip (the caller dismisses the visible one). */
  readonly onNext?:()=>void;
  /** Name of that button while more tips follow; comes from the caller's own language bundle. */
  readonly nextLabel?:string;
  /** The final tip: nothing is left to skip, and the same button reads "OK" (common.ok). */
  readonly last?:boolean;
}
/** DS 11.9.4 CoachFooter: only when two or more tips are in the queue. Counter on the left, skip-all link and the primary button on the right. */
export function CoachFooter({current,total,onSkipAll,onNext,nextLabel,last=false}:CoachFooterProps){
  const {t}=useKitT();
  if(total<2)return null;
  const label=last?t('common.ok'):nextLabel;
  return <div className="ui-coach-footer"><span className="ui-coach-footer__count">{t('ui.coach.progress',{current,total})}</span>
    <div className="ui-coach-footer__actions">{last?null:<ActionButton variant="link" className="ui-coach-footer__skip" onClick={onSkipAll}>{t('ui.coach.skipAll')}</ActionButton>}{onNext&&label?<ActionButton className="ui-coach-footer__next" onClick={onNext}>{label}</ActionButton>:null}</div></div>;
}
export interface WidgetCoachProps { readonly open:boolean;readonly anchorRef:RefObject<HTMLElement|null>;readonly onClose:(reason:CloseReason,event?:Event)=>void;readonly title:string;readonly children:ReactNode;readonly side?:'top'|'right'|'bottom'|'left';readonly queue?:CoachFooterProps;readonly showTitle?:boolean }
/** DS 11.4 WidgetCoach: CoachMark with a bold widget-name line, 8px, then the muted description. Non-modal note. */
export function WidgetCoach({open,anchorRef,onClose,title,children,side,queue,showTitle=true}:WidgetCoachProps){
  // One step (a help opened with (?) or a queue of one) has no footer, so its close reads 확인 like the last step of a tour (D-326 Q14).
  return <CoachMark open={open} anchorRef={anchorRef} onClose={onClose} side={side} noteLabel={title}
    footer={queue&&queue.total>=2?<CoachFooter {...queue}/>:undefined}>{showTitle?<span className="ui-widget-coach__title">{title}</span>:null}<span className="ui-widget-coach__body">{children}</span></CoachMark>;
}
