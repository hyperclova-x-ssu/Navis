import { useLayoutEffect, useRef } from 'react';
export type CloseReason='button'|'Esc'|'outside';

/** Share one close request across all dismissal paths for each opening. */
export function useOverlayClose(open:boolean,onClose:(reason:CloseReason,event?:Event)=>void){
  const requested=useRef(!open);
  useLayoutEffect(()=>{requested.current=!open;},[open]);
  return (reason:CloseReason,event?:Event)=>{
    if(!open||requested.current)return;
    requested.current=true;
    onClose(reason,event);
  };
}
const pending=new WeakMap<Document,()=>void>();
/** Consume the close-causing native sequence, including the click after pointerup. */
export function consumeDismissSequence(event:Event):void{
  const isPointer=/^(pointer|mouse|touch)/u.test(event.type);const isKeyboard=/^key(down|up)$/u.test(event.type);
  if(!isPointer&&!isKeyboard&&event.type!=='click')return;
  event.preventDefault();event.stopPropagation();
  const target=event.target;const doc=target instanceof Node?target.ownerDocument??document:document;
  pending.get(doc)?.();
  if(event.type==='click'||event.type==='pointerup'||event.type==='mouseup')return;
  const keyboard=event.type==='keydown';const key=keyboard?((event as KeyboardEvent).code||(event as KeyboardEvent).key):null;
  let released=false;
  const stop=(next:Event)=>{next.preventDefault();next.stopPropagation();};
  function cleanup(){doc.removeEventListener('pointerup',up,true);doc.removeEventListener('pointercancel',cancel,true);doc.removeEventListener('click',click,true);doc.removeEventListener('keyup',keyUp,true);doc.removeEventListener('pointerdown',newSequence,true);doc.removeEventListener('keydown',newSequence,true);pending.delete(doc);}
  function up(next:Event){if(!keyboard){released=true;stop(next);}}
  function cancel(next:Event){stop(next);cleanup();}
  function click(next:Event){stop(next);cleanup();}
  function keyUp(next:Event){if(keyboard&&((next as KeyboardEvent).code||(next as KeyboardEvent).key)===key){stop(next);cleanup();}}
  function newSequence(next:Event){if(keyboard&&next.type==='keydown'&&((next as KeyboardEvent).code||(next as KeyboardEvent).key)===key){stop(next);return;}if(released||keyboard||next.type==='keydown')cleanup();}
  doc.addEventListener('pointerup',up,true);doc.addEventListener('pointercancel',cancel,true);doc.addEventListener('click',click,true);doc.addEventListener('keyup',keyUp,true);doc.addEventListener('pointerdown',newSequence,true);doc.addEventListener('keydown',newSequence,true);pending.set(doc,cleanup);
}

/** Our canvas owns one portal host, so Base UI's portal containment includes
 * the surrounding dashboard. Check the actual popup when focus leaves it. */
export function dismissOnFocusOut(event:FocusEvent,popup:HTMLElement,anchor:HTMLElement|null,onClose:(reason:CloseReason,event?:Event)=>void):void {
  if(popup.closest('[inert]'))return;
  const next=event.relatedTarget;
  if(next instanceof Node&&(popup.contains(next)||anchor?.contains(next)))return;
  onClose('outside',event);
}
