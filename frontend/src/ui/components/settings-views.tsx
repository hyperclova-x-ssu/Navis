import { useId, type ReactNode, type Ref } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { locales, type Locale, type PreviewFamily } from '../../contracts';
import { koreanScreenText } from '../../i18n';
import { useKitT } from '../kit-i18n';
import { ActionButton, IconButton } from './controls';
import { Icon } from '../icons';

/** Shared bordered settings row for controls and grouped content. */
export function SettingRow({children,className=''}:{readonly children:ReactNode;readonly className?:string}){return <div className={`ui-setting-row-frame ${className}`}>{children}</div>;}

/** DS 11.4 ListSelectRow: height 64, label left, current value and chevron right. The value is read as a sentence. */
export function ListSelectRow({label,value,onPress,lang,ref,ariaLabel,disabled=false}:{readonly label:string;readonly value:string;readonly onPress:()=>void;readonly ariaLabel?:string;readonly disabled?:boolean;/** lang of the value text (language names carry their own). */readonly lang?:string;readonly ref?:Ref<HTMLButtonElement>}){
  const {t,locale}=useKitT();
  return <ActionButton ref={ref} variant="outline" className="ui-list-select-row" disabled={disabled} aria-label={ariaLabel??t('ui.settings.listValue',{label,value})} onClick={onPress}><span className="ui-list-select-row__label">{label}</span><span className="ui-list-select-row__value" lang={lang}>{locale==='ko'?koreanScreenText(value):value}</span><Icon name="chevron-right"/></ActionButton>;
}
export interface ChoiceOption<V extends string> { readonly value:V;readonly label:string;readonly description?:string;readonly lang?:string }
/** DS 11.4 ChoiceSubview: fixed header (back, title, close) and radio rows (min 64, 80 at large text). A choice applies at once. */
export function ChoiceSubview<V extends string>({title,groupLabel,value,options,onChange,onBack,onClose,note}:{readonly title:string;readonly groupLabel?:string;readonly value:V;readonly options:readonly ChoiceOption<V>[];readonly onChange:(value:V)=>void;readonly onBack:()=>void;readonly onClose:()=>void;readonly note?:ReactNode}){
  const {t}=useKitT();const id=useId();
  return <section className="ui-choice-subview" aria-labelledby={`${id}-title`}>
    <header className="ui-choice-subview__header"><IconButton label={t('ui.settings.back')} icon="arrow-left" variant="ghost" onClick={onBack}/><h2 id={`${id}-title`} className="ui-choice-subview__title">{title}</h2><IconButton label={t('common.close')} icon="close" variant="ghost" onClick={onClose}/></header>
    {note?<p className="ui-choice-subview__note">{note}</p>:null}
    <RadioGroup value={value} onValueChange={next=>onChange(next as V)} aria-label={groupLabel??title} className="ui-choice-subview__list">
      {options.map(option=><label key={option.value} className="ui-choice-row" data-checked={String(option.value===value)}><Radio.Root value={option.value} className="ui-choice-row__radio"><Radio.Indicator className="ui-choice-row__dot"/></Radio.Root><span className="ui-choice-row__text"><span className="ui-choice-row__label" lang={option.lang}>{option.label}</span>{option.description?<span className="ui-choice-row__description">{option.description}</span>:null}</span></label>)}
    </RadioGroup>
  </section>;
}
const languageNameKey=(locale:Locale)=>`language.${locale}` as const;
/** DS 11.4 LanguageSelect: ListSelectRow plus ChoiceSubview with four radios, each name in its own lang. */
export function LanguageSelectRow({locale,onPress,ref}:{readonly locale:Locale;readonly onPress:()=>void;readonly ref?:Ref<HTMLButtonElement>}){
  const {t}=useKitT();return <ListSelectRow ref={ref} label={t('common.language')} value={t(languageNameKey(locale))} lang={locale} onPress={onPress}/>;
}
export function LanguageSelect({locale,onChange,onBack,onClose}:{readonly locale:Locale;readonly onChange:(locale:Locale)=>void;readonly onBack:()=>void;readonly onClose:()=>void}){
  const {t}=useKitT();
  return <ChoiceSubview<Locale> title={t('common.language')} value={locale} onChange={onChange} onBack={onBack} onClose={onClose} options={locales.map(value=>({value,label:t(languageNameKey(value)),lang:value}))}/>;
}
const familyKey={normal:'preview.family.normal',empty:'preview.family.empty',error:'preview.family.error',special:'preview.family.special'} as const;
export function ExampleStateRow({family,byWidgetCount=0,onPress,ref}:{readonly family:PreviewFamily;readonly byWidgetCount?:number;readonly onPress:()=>void;readonly ref?:Ref<HTMLButtonElement>}){
  const {t}=useKitT();return <ListSelectRow ref={ref} label={t('common.previewStates')} value={byWidgetCount>0?t('preview.family.byWidget'):t(familyKey[family])} onPress={onPress}/>;
}
/** DS 11.4 ExampleStateSelect: four radios with descriptions. */
export function ExampleStateSelect({family,onChange,onBack,onClose}:{readonly family:PreviewFamily;readonly onChange:(family:PreviewFamily)=>void;readonly onBack:()=>void;readonly onClose:()=>void}){
  const {t}=useKitT();
  return <ChoiceSubview<PreviewFamily> title={t('common.previewStates')} value={family} onChange={onChange} onBack={onBack} onClose={onClose} options={(['normal','empty','error','special'] as const).map(value=>({value,label:t(familyKey[value]),description:value==='special'?t('preview.family.specialHint'):undefined}))}/>;
}
/** DS 11.4 ExampleStateChip: header chip (visual 40, hit 48) shown only when the state is not normal. */
export function ExampleStateChip({state,onPress}:{readonly state:string;readonly onPress:()=>void}){
  const {t}=useKitT();
  return <ActionButton variant="ghost" className="ui-example-chip" aria-label={`${t('preview.family.chip',{state})}. ${t('ui.example.chipOpen')}`} onClick={onPress}><Icon name="info"/>{t('preview.family.chip',{state})}</ActionButton>;
}
