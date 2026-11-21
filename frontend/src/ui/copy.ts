import type { MessageParams, Notice } from '../contracts';
import type { Translator } from '../i18n';
import { createKitTranslator } from './messages';
export function objectParticle(label:string):string {const spoken=label.trim().replace(/\p{P}+$/gu,'');const last=spoken.codePointAt(spoken.length-1)??0;return last>=0xac00&&last<=0xd7a3&&(last-0xac00)%28!==0?'을':'를';}
let koKit:Translator|null=null;
const defaultTranslator=():Translator=>koKit??(koKit=createKitTranslator('ko'));
/** Translator-based notice sentence (API-07 v4). Without a translator it speaks Korean, with the same words as before. */
export function formatNotice(notice:Notice,label?:string,translator:Translator=defaultTranslator()):string{
  const t=translator.t.bind(translator) as (key:string,params?:MessageParams)=>string;
  const name=label??t('ui.notice.panelFallback');
  switch(notice.messageKey){
    case 'move':case 'resize':{
      if(!notice.panel)return t('ui.notice.editComplete');
      const params={label:name,row:notice.panel.row+1,col:notice.panel.column+1,size:t('ui.panel.size',{w:notice.panel.width,h:notice.panel.height}),n:notice.displacedCount??0};
      return t(notice.displacedCount?'ui.notice.layoutDisplaced':'ui.notice.layout',params);
    }
    case 'add':return t('ui.notice.added',{label:name});
    case 'remove':return t('ui.notice.removed',{label:name});
    // The marketing board starts with the recommended layout of eight widgets (SCR-41, DS 11.11a).
    case 'starter-add':return t(notice.layerId==='marketing'?'ui.notice.presetStarted':'ui.notice.starterAdd');
    case 'undo-complete':return t('ui.notice.undoComplete');
    case 'edit-complete':return t('ui.notice.editComplete');
    case 'NO_CAPACITY':return t(notice.params?.maxPages===1?'ui.notice.noCapacity':'ui.notice.noCapacityMore');
    case 'OUTSIDE_GRID':return t('ui.notice.outsideGrid');
    case 'DUPLICATE':return t('ui.notice.duplicate');
    case 'UNDO_UNAVAILABLE':return t('ui.notice.undoUnavailable');
    case 'move-page':return t('page.moved',{name,n:Number(notice.params?.n??1)});
    case 'duplicate-other-page':return t('page.alreadyOn',{n:Number(notice.params?.n??1)});
    case 'page-limit':return t('page.limit');
    case 'no-room-next-page':return t('page.noRoomNext');
    case 'other-layer':{const layer=String(notice.params?.layer??'');return t('page.inOtherLayer',{name,layer:layer&&translator.has(`app.layer.${layer}`)?t(`app.layer.${layer}`):layer});}
    default:
      // Data command completions carry their own message key and parameters.
      if(translator.has(notice.messageKey))return t(notice.messageKey,notice.params);
      return t('ui.notice.displayError');
  }
}
