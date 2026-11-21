import {useCallback,useLayoutEffect,useState,useSyncExternalStore,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {RunState} from '../contracts';
import {ActionButton,Card} from '../ui';
import type {VerificationScenario} from './verification-policy';
export type {AppVerification,VerificationScenario} from './verification-policy';
export function VerificationFault({active,children}:{readonly active:boolean;readonly children:ReactNode}){if(import.meta.env.DEV&&active)throw new Error('Development verification render failure');return children;}
function VerificationPortal({container,children}:{readonly container:HTMLElement;readonly children:ReactNode}){
 const [host]=useState(()=>document.createElement('div'));
 useLayoutEffect(()=>{container.append(host);return()=>host.remove();},[container,host]);
 return createPortal(children,host);
}
export function VerificationControls({scenario,state,onFailure}:{readonly scenario:VerificationScenario;readonly state:RunState;readonly onFailure:()=>void}){
 const subscribe=useCallback((notify:()=>void)=>{const observer=new MutationObserver(notify);observer.observe(document.body,{childList:true,subtree:true});return()=>observer.disconnect();},[]);
 const snapshot=useCallback(()=>state.overlay.type==='none'||state.overlay.type==='drawer'?null:document.querySelector<HTMLElement>('[role="dialog"] .ui-overlay-note, [role="dialog"] .ui-overlay-note--empty'),[state.overlay.type]);
 const container=useSyncExternalStore(subscribe,snapshot,()=>null);
 if(!import.meta.env.DEV)return null;
 const content=<Card className="app-verification" role="region" aria-label="개발 검증"><p>개발 검증: {scenario}</p>{scenario.startsWith('error-')?<ActionButton onClick={onFailure}>검증 오류 발생</ActionButton>:<p>충돌 후보에서 지연·취소·다시 시도를 확인해요.</p>}</Card>;
 return container?<VerificationPortal container={container}>{content}</VerificationPortal>:content;
}
