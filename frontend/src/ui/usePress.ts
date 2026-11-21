import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
type Events<ElementType extends HTMLElement>=Pick<HTMLAttributes<ElementType>,'onPointerDown'|'onPointerUp'|'onPointerCancel'|'onPointerLeave'|'onKeyDown'|'onKeyUp'|'onBlur'>;
/** Press affects only an inner visual surface, leaving the outer hit box fixed. */
export function usePress<ElementType extends HTMLElement=HTMLButtonElement>(disabled=false,events:Events<ElementType>={}){
  const [pressed,setPressed]=useState(false);const pointer=useRef<number|null>(null);
  useEffect(()=>{
    const release=()=>{pointer.current=null;setPressed(false);};
    const releasePointer=(event:PointerEvent)=>{if(pointer.current===event.pointerId)release();};
    window.addEventListener('pointerup',releasePointer);window.addEventListener('pointercancel',releasePointer);window.addEventListener('blur',release);
    return ()=>{window.removeEventListener('pointerup',releasePointer);window.removeEventListener('pointercancel',releasePointer);window.removeEventListener('blur',release);};
  },[]);
  return {
    'data-pressed':!disabled&&pressed?'true':undefined,
    onPointerDown:(event:React.PointerEvent<ElementType>)=>{events.onPointerDown?.(event);if(!disabled&&(event.button===0||event.button===undefined)&&pointer.current===null){pointer.current=event.pointerId;setPressed(true);}},
    onPointerUp:(event:React.PointerEvent<ElementType>)=>{events.onPointerUp?.(event);if(pointer.current===event.pointerId){pointer.current=null;setPressed(false);}},
    onPointerCancel:(event:React.PointerEvent<ElementType>)=>{events.onPointerCancel?.(event);pointer.current=null;setPressed(false);},
    onPointerLeave:(event:React.PointerEvent<ElementType>)=>{events.onPointerLeave?.(event);pointer.current=null;setPressed(false);},
    onKeyDown:(event:React.KeyboardEvent<ElementType>)=>{events.onKeyDown?.(event);if(!disabled&&(event.key===' '||event.key==='Enter'))setPressed(true);},
    onKeyUp:(event:React.KeyboardEvent<ElementType>)=>{events.onKeyUp?.(event);if(event.key===' '||event.key==='Enter')setPressed(false);},
    onBlur:(event:React.FocusEvent<ElementType>)=>{events.onBlur?.(event);pointer.current=null;setPressed(false);},
  };
}
