import { useId, useImperativeHandle, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { Switch } from '@base-ui/react/switch';
import { Tabs } from '@base-ui/react/tabs';
import type { BusinessType, GroupId, Theme } from '../../contracts';
import { groupStyle } from '../tones';
import { Icon, type IconName } from '../icons';
import { usePress } from '../usePress';
import { useKitT } from '../kit-i18n';

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { readonly variant?:'default'|'secondary'|'outline'|'ghost'|'destructive'|'link'; readonly size?:'default'|'primary'|'icon'; readonly loading?:boolean; readonly ref?:Ref<HTMLButtonElement> }
export function ActionButton({children,variant='default',size='default',loading=false,disabled=false,className='',ref,...props}:ActionButtonProps){
  const press=usePress(disabled||loading,props);
  return <BaseButton {...props} {...press} ref={ref} type={props.type??'button'} disabled={disabled||loading} aria-busy={loading||undefined} className={`ui-button ui-button--${variant} ui-button--${size} ${className}`}><span className="ui-press-surface">{loading?<span className="ui-progress" aria-hidden="true"/>:null}{children}</span></BaseButton>;
}
export function IconButton({label,icon,...props}:Omit<ActionButtonProps,'children'|'size'> & {readonly label:string;readonly icon:IconName}){return <ActionButton {...props} size="icon" aria-label={label}><Icon name={icon}/></ActionButton>;}
export function BusinessCard({businessType,selected=false,compact=false,...props}:Omit<ActionButtonProps,'children'> & {readonly businessType:BusinessType;readonly selected?:boolean;readonly compact?:boolean}){
  const {t}=useKitT();
  return <ActionButton {...props} variant="outline" className={`ui-business-card ${compact?'ui-business-card--compact':''} ${props.className??''}`} aria-pressed={selected}><Icon name={businessType} size="business"/><span className="ui-business-card__label">{t(`ui.business.${businessType}`)}</span>{selected?<span className="ui-business-card__check"><Icon name="check"/></span>:null}</ActionButton>;
}
/** Rail button. `shortLabel` (LOCALES 2 rail short names, e.g. en 'Picks') replaces only the visible text; the accessible name stays the full `label`. */
export function FunctionRailItem({label,shortLabel,icon,selected=false,expanded=false,iconSlot,groupId,...props}:Omit<ActionButtonProps,'children'> & {readonly label:string;readonly shortLabel?:string;readonly icon:IconName;readonly selected?:boolean;readonly expanded?:boolean;readonly iconSlot?:ReactNode;readonly groupId?:GroupId}){
  const visible=shortLabel??label;
  return <ActionButton {...props} aria-label={props['aria-label']??(visible!==label?label:undefined)} variant="ghost" style={groupId?{...props.style,...groupStyle(groupId)}:props.style} className={`ui-rail-item ${props.className??''}`} aria-pressed={selected} aria-expanded={expanded}><span>{iconSlot??<Icon name={icon}/>}</span><span className="ui-rail-item__label">{visible}</span></ActionButton>;
}
export function FunctionRow({label,icon,placed=false,hint,groupId,...props}:Omit<ActionButtonProps,'children'> & {readonly label:string;readonly icon:IconName;readonly placed?:boolean;readonly hint?:string;readonly groupId?:GroupId}){
  const {t}=useKitT();
  return <ActionButton {...props} variant="outline" style={groupId?{...props.style,...groupStyle(groupId)}:props.style} className={`ui-function-row ${props.className??''}`} aria-label={placed?t('ui.row.named',{label,state:t('app.drawer.alreadyAdded')}):label}><Icon name={icon} size="row"/><span className="ui-function-row__text"><span className="ui-function-row__label">{label}</span>{placed||hint?<span className="ui-function-row__hint">{placed?t('app.drawer.alreadyAdded'):hint}</span>:null}</span><span className="ui-function-row__check">{placed?<Icon name="check"/>:null}</span></ActionButton>;
}
export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>,'onChange'|'size'> { readonly value:string; readonly onValueChange:(value:string)=>void; readonly label?:string; readonly hideLabel?:boolean; readonly inputRef?:Ref<HTMLInputElement>;readonly clearLabel?:string }
export function SearchField({value,onValueChange,label,hideLabel=false,id,inputRef,className='',clearLabel,...props}:SearchFieldProps){
  const {t}=useKitT();const generated=useId();const local=useRef<HTMLInputElement>(null);const fieldId=id??generated;
  useImperativeHandle(inputRef,()=>local.current!,[]);
  return <div className={`ui-search-field ${className}`}><label htmlFor={fieldId} className={hideLabel?'ui-sr-only':undefined}>{label??t('app.features.find')}</label><div className="ui-search-field__control"><Icon name="search"/><input {...props} id={fieldId} ref={local} className="ui-input" name={props.name??'feature-search'} type="search" autoComplete="off" placeholder={props.placeholder??t('app.features.placeholder')} value={value} onChange={event=>onValueChange(event.currentTarget.value)}/>{value?<IconButton label={clearLabel??t('common.clearSearch')} icon="close" variant="ghost" onClick={()=>{onValueChange('');local.current?.focus();}}/>:null}</div></div>;
}
export interface ResizeAxisControlProps {readonly width:number;readonly height:number;readonly onChange:(size:{width:number;height:number})=>void;readonly unavailable?:{readonly width?:Readonly<Partial<Record<number,string>>>;readonly height?:Readonly<Partial<Record<number,string>>>}}
export function ResizeAxisControl({width,height,onChange,unavailable}:ResizeAxisControlProps){
  const id=useId();const {t}=useKitT();
  return <div className="ui-resize-axis-control" aria-label={t('ui.size.group')}>{(['width','height'] as const).map(axis=><div key={axis} role="group" aria-label={t(axis==='width'?'ui.size.widthCount':'ui.size.heightCount')}><span>{t(axis==='width'?'ui.size.widthCount':'ui.size.heightCount')}</span><div className="ui-size-control">{[1,2,3,4].map(value=>{const reason=unavailable?.[axis]?.[value];return <span key={value}><ActionButton variant="outline" aria-label={t(axis==='width'?'ui.size.widthValue':'ui.size.heightValue',{n:value})} aria-pressed={(axis==='width'?width:height)===value} disabled={!!reason} aria-describedby={reason?`${id}-${axis}-${value}`:undefined} onClick={()=>onChange({width,height,[axis]:value})}>{value}</ActionButton>{reason?<span id={`${id}-${axis}-${value}`} className="ui-sr-only">{reason}</span>:null}</span>;})}</div></div>)}</div>;
}
export function CellMoveControl({onMove,unavailable={}}:{readonly onMove:(delta:{column:number;row:number})=>void;readonly unavailable?:Readonly<Partial<Record<'left'|'right'|'up'|'down',string>>>}){
  const {t}=useKitT();const directions=[['left',-1,0],['right',1,0],['up',0,-1],['down',0,1]] as const;
  return <div className="ui-cell-move-control" role="group" aria-label={t('ui.move.group')}>{directions.map(([key,column,row])=><ActionButton key={key} variant="outline" disabled={!!unavailable[key]} title={unavailable[key]} onClick={()=>onMove({column,row})}>{t(`ui.move.${key}`)}</ActionButton>)}</div>;
}
export function ResizeHandle({label,width,height,...props}:Omit<ActionButtonProps,'children'> & {readonly label:string;readonly width:number;readonly height:number}){
  const {t}=useKitT();
  return <IconButton {...props} label={t('ui.resize.name',{label,size:t('ui.panel.size',{w:width,h:height})})} icon="resize" variant="outline" className={`ui-panel-resize ${props.className??''}`} onPointerDown={event=>{event.stopPropagation();props.onPointerDown?.(event);}} onClick={event=>{event.stopPropagation();props.onClick?.(event);}} onKeyDown={event=>{event.stopPropagation();props.onKeyDown?.(event);}}/>;
}
export function RemoveButton({label,...props}:Omit<ActionButtonProps,'children'> & {readonly label:string}){
  const {t}=useKitT();
  return <IconButton {...props} label={t('ui.remove.name',{label})} icon="remove" variant="outline" className={`ui-panel-remove ${props.className??''}`} onPointerDown={event=>{event.stopPropagation();props.onPointerDown?.(event);}} onClick={event=>{event.stopPropagation();props.onClick?.(event);}} onKeyDown={event=>{event.stopPropagation();props.onKeyDown?.(event);}}/>;
}
export function EditToolbar({onDone}:{readonly onDone:()=>void}){const {t}=useKitT();return <div className="ui-edit-toolbar"><span>{t('ui.edit.status')}</span><ActionButton variant="secondary" onClick={onDone}>{t('common.done')}</ActionButton></div>;}
export function ModeControl({theme,onChange}:{readonly theme:Theme;readonly onChange:(theme:Theme)=>void}){
  const {t}=useKitT();
  return <ActionButton variant="outline" onClick={()=>onChange(theme==='light'?'dark':'light')}><Icon name={theme==='light'?'moon':'sun'}/>{theme==='light'?t('app.mode.dark'):t('app.mode.light')}</ActionButton>;
}
export function ThemeTabs({value,onChange}:{readonly value:Theme;readonly onChange:(theme:Theme)=>void}){
  const {t,locale}=useKitT();const light=locale==='ko'?'라이트':t('app.mode.light'),dark=locale==='ko'?'다크':t('app.mode.dark');
  return <Tabs.Root value={value} onValueChange={next=>{if(next==='light'||next==='dark')onChange(next);}}><Tabs.List className="ui-theme-tabs-list" aria-label={t('ui.theme.mode')}><Tabs.Tab value="light" render={<ActionButton variant="ghost"/>}>{value==='light'?<Icon name="check" width={16} height={16}/>:null}{light}</Tabs.Tab><Tabs.Tab value="dark" render={<ActionButton variant="ghost"/>}>{value==='dark'?<Icon name="check" width={16} height={16}/>:null}{dark}</Tabs.Tab></Tabs.List><Tabs.Panel value="light" className="ui-sr-only">{light}</Tabs.Panel><Tabs.Panel value="dark" className="ui-sr-only">{dark}</Tabs.Panel></Tabs.Root>;
}
export function LargeTextControl({checked,onChange,disabled=false}:{readonly checked:boolean;readonly onChange:(checked:boolean)=>void;readonly disabled?:boolean}){
  const {t}=useKitT();const id=useId();const descriptionId=`${id}-description`;const press=usePress<HTMLSpanElement>(disabled);
  return <div className="ui-setting-row"><div><label htmlFor={id}>{t('ui.largeText.label')}</label><p id={descriptionId} className="ui-setting-description">{t('ui.largeText.description')}</p></div><Switch.Root {...press} nativeButton render={<button type="button"/>} id={id} name="large-text" checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={t('ui.largeText.label')} aria-describedby={descriptionId} className="ui-switch"><span className="ui-switch-track"><Switch.Thumb className="ui-switch-thumb"/></span></Switch.Root></div>;
}
