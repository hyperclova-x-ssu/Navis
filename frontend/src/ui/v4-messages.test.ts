import { describe, expect, it } from 'vitest';
import { baseBundles, findDuplicateKeys, findKoGaps, createTranslator, type MessageBundle } from '../i18n';
import { locales, type Notice } from '../contracts';
import { uiBundle, uiReviewKeys, createKitTranslator } from './messages';
import { formatNotice } from './copy';

const params=(text:string)=>[...text.matchAll(/\{(\w+)/g)].map(m=>m[1]).filter(Boolean).sort().join(',');
describe('ui.* bundle (T-045)',()=>{
  it('has every key in Korean, only ui.* keys, and no key shared with the common bundles',()=>{
    expect(findKoGaps(uiBundle)).toEqual([]);
    expect(Object.keys(uiBundle.ko).every(k=>k.startsWith('ui.'))).toBe(true);
    expect(findDuplicateKeys(uiBundle,...(baseBundles as unknown as readonly MessageBundle<string>[]))).toEqual([]);
  });
  it('gives all four languages every key and the same placeholder names in each language',()=>{
    for(const [key,ko] of Object.entries(uiBundle.ko)){
      for(const locale of ['en','zh-Hans','zh-Hant'] as const){
        const text=(uiBundle[locale] as Record<string,string>)[key];
        expect(text,`${locale} ${key}`).toBeTruthy();
        expect(params(text!),`${locale} ${key}`).toBe(params(ko));
      }
    }
  });
  it('never shows a key name: unknown keys fall back to Korean then empty',()=>{
    const t=createTranslator('en',uiBundle);
    expect(t.t('ui.nope' as never)).not.toBe('ui.nope');
  });
  it('counts the worker-written rows for the R2 review',()=>{
    expect(uiReviewKeys.length).toBeGreaterThan(0);
    expect(uiReviewKeys.length).toBeLessThan(Object.keys(uiBundle.ko).length);
  });
  it('joins a function row name and its placed state with the language\'s own comma (T-064)',()=>{
    const joined={ko:'장부, 이미 있어요',en:'Ledger, Already added','zh-Hans':'账本，已添加','zh-Hant':'帳本，已新增'} as const;
    const label={ko:'장부',en:'Ledger','zh-Hans':'账本','zh-Hant':'帳本'} as const;
    for(const l of locales){const t=createKitTranslator(l);expect(t.t('ui.row.named',{label:label[l],state:t.t('app.drawer.alreadyAdded' as never)})).toBe(joined[l]);}
  });
  it('speaks DS 11.7/11.11 sentences exactly',()=>{
    const t=(l:'ko'|'en'|'zh-Hans'|'zh-Hant')=>createKitTranslator(l);
    expect(t('ko').t('ui.coach.skipAll')).toBe('남은 안내 모두 건너뛰기');
    expect(t('en').t('ui.coach.skipAll')).toBe('Skip all remaining tips');
    expect(t('zh-Hans').t('ui.confirm.title',{n:3})).toBe('要向 3 位发送优惠券吗？');
    expect(t('zh-Hant').t('ui.discount.limitText')).toBe('超過此處將虧損');
    expect(t('ko').t('ui.panel.name',{name:'가계부',row:1,col:2,w:1,h:1,summary:'오늘 매출 128.4만 원'})).toBe('가계부, 1행 2열, 가로 1칸 세로 1칸, 오늘 매출 128.4만 원, 자세히 보기');
  });
});
describe('formatNotice is translator based and keeps the Korean words',()=>{
  const base:Notice={kind:'success',id:'n',messageKey:'move',expiresAt:1,panel:{featureId:'margin',column:3,row:2,width:2,height:1},displacedCount:2};
  it('returns the same Korean sentences as before without a translator',()=>{
    expect(formatNotice(base,'가계부')).toBe('가계부, 3행 4열, 가로 2칸, 세로 1칸. 패널 2개가 비켜났어요');
    expect(formatNotice({...base,displacedCount:0},'가계부')).toBe('가계부, 3행 4열, 가로 2칸, 세로 1칸.');
    expect(formatNotice({...base,messageKey:'add'},'가계부')).toBe('가계부를 추가했어요');
    expect(formatNotice({...base,messageKey:'remove'},'마진')).toBe('마진을 뺐어요');
    expect(formatNotice({...base,messageKey:'NO_CAPACITY'})).toBe('자리가 없어요. 패널을 줄이거나 빼거나 새 페이지를 추가해 주세요');
    expect(formatNotice({...base,messageKey:'OUTSIDE_GRID'})).toBe('대시보드 안에 놓아 주세요');
    expect(formatNotice({...base,messageKey:'DUPLICATE'})).toBe('이미 있어요');
    expect(formatNotice({...base,messageKey:'UNDO_UNAVAILABLE'})).toBe('지금은 되돌릴 수 없어요. 패널을 줄이거나 빼 주세요');
    expect(formatNotice({...base,messageKey:'undo-complete'})).toBe('되돌렸어요');
    expect(formatNotice({...base,messageKey:'edit-complete'})).toBe('배치를 바꿨어요');
    expect(formatNotice({...base,messageKey:'starter-add'})).toBe('패널 3개로 시작했어요');
    expect(formatNotice({...base,messageKey:'unknown-key'})).toBe('화면을 보여 주지 못했어요. 다시 열어 주세요');
  });
  it('speaks every language for the new page notices and never prints the key',()=>{
    for(const locale of locales){
      const t=createKitTranslator(locale);
      for(const key of ['move-page','page-limit','no-room-next-page','duplicate-other-page','other-layer','move','add','remove','NO_CAPACITY']){
        const text=formatNotice({...base,messageKey:key,params:{n:2,layer:'marketing'}},'Margin',t);
        expect(text,`${locale} ${key}`).toBeTruthy();
        expect(text).not.toBe(key);
      }
    }
    expect(formatNotice({...base,messageKey:'page-limit'},'x',createKitTranslator('en'))).toBe('You can have up to 5 pages');
    expect(formatNotice({...base,messageKey:'move-page',params:{n:2}},'Margin',createKitTranslator('en'))).toContain('page 2');
    expect(formatNotice({...base,messageKey:'move-page',params:{n:2}},'가계부')).toBe('가계부를 2페이지로 옮겼어요 · 되돌리기');
    expect(formatNotice({...base,messageKey:'other-layer',params:{layer:'marketing'}},'쿠폰')).toBe('쿠폰은 마케팅에 있어요');
  });
  it('uses the carried message key for data completions',()=>{
    const t=createKitTranslator('ko');
    expect(formatNotice({...base,messageKey:'common.copied'},'x',t)).toBe('복사했어요');
  });
});
