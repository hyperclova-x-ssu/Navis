import { useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { motion } from 'motion/react';
import type { FeatureId, GroupId } from '../../contracts';
import { usePress } from '../usePress';
import { panelShape } from '../panel-layout';
import { groupStyle } from '../tones';
import { useFlyInContent } from '../fly-context';
import { useKitT } from '../kit-i18n';
import { PanelChromeContext } from '../panel-chrome';
import { HelpButton } from './help';

export function Card({className='',...props}:HTMLAttributes<HTMLDivElement>){return <div {...props} className={`ui-card ${className}`}/>;}
export function CardHeader({className='',...props}:HTMLAttributes<HTMLDivElement>){return <div {...props} className={`ui-card-header ${className}`}/>;}
export function CardTitle({className='',...props}:HTMLAttributes<HTMLHeadingElement>){return <h2 {...props} className={`ui-card-title ${className}`}/>;}
export function CardDescription({className='',...props}:HTMLAttributes<HTMLParagraphElement>){return <p {...props} className={`ui-card-description ${className}`}/>;}
export function CardContent({className='',...props}:HTMLAttributes<HTMLDivElement>){return <div {...props} className={`ui-card-content ${className}`}/>;}
export function CardFooter({className='',...props}:HTMLAttributes<HTMLDivElement>){return <div {...props} className={`ui-card-footer ${className}`}/>;}
export function CardAction({className='',...props}:HTMLAttributes<HTMLDivElement>){return <div {...props} className={`ui-card-action ${className}`}/>;}
export interface FeaturePanelProps { readonly ref?:Ref<HTMLElement>;readonly featureId:FeatureId;readonly label:string;readonly title?:string;readonly groupId:GroupId;readonly width:number;readonly height:number;readonly editing?:boolean;readonly selected?:boolean;readonly highlighted?:boolean;readonly children?:ReactNode;readonly controls?:ReactNode;readonly footer?:ReactNode;readonly interactionProps?:ButtonHTMLAttributes<HTMLButtonElement>&{readonly ref?:Ref<HTMLButtonElement>};readonly onOpen?:()=>void;readonly onSelect?:()=>void;readonly className?:string;
  /** v4 (API-07): 1-based position and the key sentence build the accessible name '{name}, {row}행 {col}열, 가로 {w}칸 세로 {h}칸, {summary}, 자세히 보기'. Without summary the iteration-3 name is kept. */
  readonly row?:number;readonly column?:number;readonly summary?:string;
  /** v4: the (?) button at the top right in the normal state only; hidden while editing, slot kept while waiting. */
  readonly onHelp?:()=>void;readonly helpRef?:Ref<HTMLButtonElement>;readonly waiting?:boolean;
  /** v4.1 (DS 11.9.2): title and body flow top to bottom so a two-line title pushes the body down and a PanelAction fits the Q budget. */
  readonly describeViewInteraction?:boolean; readonly flow?:boolean; readonly interactive?:boolean }
export function FeaturePanel({ref,featureId,label,title=label,groupId,width,height,editing=false,selected=false,highlighted=false,children,controls,footer,interactionProps={},onOpen,onSelect,className='',row,column,summary,onHelp,helpRef,waiting=false,flow=false,interactive=true,describeViewInteraction=true}:FeaturePanelProps){
  const t=useKitT();const id=useId();const press=usePress(false,interactionProps);const flight=useFlyInContent();const shape=panelShape(width,height);
  return <article ref={ref} className={`ui-feature-panel ${className}`} style={groupStyle(groupId)} data-feature-id={featureId} aria-label={!editing&&!interactive&&row!==undefined&&column!==undefined&&summary!==undefined?t.t(summary?'ui.panel.nameStatic':'ui.panel.nameStaticNoSummary',{name:label,row,col:column,w:width,h:height,summary}):undefined} data-shape={shape} data-width={width} data-height={height} data-has-help={onHelp?'true':undefined} data-flow={flow?'true':undefined} data-editing={String(editing)} data-selected={String(selected)} data-highlighted={String(highlighted)} data-pressed={press['data-pressed']}>{editing||interactive?<BaseButton {...interactionProps} {...press} type="button" className="ui-panel-hit" aria-label={row!==undefined&&column!==undefined&&summary!==undefined?(editing?t.t('ui.panel.nameEditing',{name:label,row,col:column,w:width,h:height}):summary?t.t('ui.panel.name',{name:label,row,col:column,w:width,h:height,summary}):t.t('ui.panel.nameNoSummary',{name:label,row,col:column,w:width,h:height}))  :t.t(editing?'ui.panel.nameBasicEditing':'ui.panel.nameBasic',{name:label,size:t.t('ui.panel.size',{w:width,h:height})})} aria-describedby={editing||describeViewInteraction?`${id}-help`:undefined} onClick={event=>{interactionProps.onClick?.(event);if(!event.defaultPrevented){if(editing)onSelect?.();else onOpen?.();}}}><span className="ui-sr-only">{label}</span></BaseButton>:null}<PanelChromeContext value={{editing,waiting,span:{width,height}}}><div className="ui-panel-surface ui-glass-card"><span className="ui-panel-group-line" aria-hidden="true"/><motion.h2 {...flight} lang={t.locale!=='ko'&&/\p{Script=Hangul}/u.test(title)?'ko':undefined} className="ui-panel-title">{title}</motion.h2>{onHelp&&!editing?<div className="ui-panel-help-slot" data-hidden={waiting?'true':undefined} aria-hidden={waiting||undefined} inert={waiting||undefined}><HelpButton ref={helpRef} name={label} onPress={onHelp}/></div>:null}<motion.div {...flight} className="ui-panel-content">{children}</motion.div>{footer?<motion.div {...flight} className="ui-panel-footer">{footer}</motion.div>:null}</div></PanelChromeContext>{editing?controls:null}<span className="ui-existing-ring" aria-hidden="true"/>{editing||describeViewInteraction?<span id={`${id}-help`} className="ui-sr-only">{editing?t.t('ui.panel.editHelp'):t.t('ui.panel.openHelp')}</span>:null}</article>;
}
/** Slot layout only: screens supply the same feature's shape-specific content. */
export function PanelBody({width,height,primary,chart,list,secondary,workspace,action}:{readonly width:number;readonly height:number;readonly primary:ReactNode;readonly chart?:ReactNode;readonly list?:ReactNode;readonly secondary?:ReactNode;readonly workspace?:ReactNode;/** v4.1: the PanelAction. Q/T under the body, W in the right column's lower part, S/L and 4x1 at the bottom. */readonly action?:ReactNode}){
  return <div className="ui-panel-body" data-shape={panelShape(width,height)}><div className="ui-panel-primary">{primary}</div>{chart?<div className="ui-panel-chart">{chart}</div>:null}{workspace?<div className="ui-panel-workspace">{workspace}</div>:null}{list?<div className="ui-panel-list">{list}</div>:null}{secondary?<div className="ui-panel-secondary">{secondary}</div>:null}{action?<div className="ui-panel-action-area">{action}</div>:null}</div>;
}
