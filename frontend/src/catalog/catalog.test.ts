import { describe,expect,it } from 'vitest';
import type { FeatureId } from '../contracts';
import { getCatalog,getRegistry,getLayerCatalog,listFeatures } from './index';
// AC-271 (D-54, T-055): stock-sync is merged into inventory-booking and exists nowhere — no FeatureId, no list, no drawer, no search.
describe.each(['A','B'] as const)('%s run catalog',presetId=>{
  const catalog=getCatalog(presetId);
  it('is the 30-widget registry: frozen, one per id, management 17 and marketing 13 (iteration-3 22-item list removed)',()=>{
    expect(catalog).toBe(getRegistry(presetId));
    expect(new Set(catalog.map(f=>f.id)).size).toBe(30);expect(Object.isFrozen(catalog)).toBe(true);
    for(const f of catalog){expect(f.presetId).toBe(presetId);expect(Object.isFrozen(f)).toBe(true);}
    expect(getLayerCatalog(presetId,'management')).toHaveLength(17);expect(getLayerCatalog(presetId,'marketing')).toHaveLength(13);
    expect(catalog.reduce<Record<string,number>>((sum,f)=>({...sum,[f.groupId]:(sum[f.groupId]??0)+1}),{})).toEqual({products:2,stock:2,finance:3,members:2,store:2,misc:3,schedule:3,neighborhood:4,customers:3,recommended:1,money:3,news:2});
  });
  it('has no stock-sync anywhere a user can reach a widget (AC-271)',()=>{
    expect(catalog.some(f=>(f.id as string)==='stock-sync')).toBe(false);
    for(const layer of ['management','marketing'] as const){
      for(const group of ['recommended','products','stock','finance','members','store','misc','schedule','news','money','customers','neighborhood'] as const)expect(listFeatures({presetId,layer,group,businessType:'retail'}).map(f=>f.id as string)).not.toContain('stock-sync');
      for(const query of ['온라인 재고','매장 재고','온오프라인','재고 통합'])expect(listFeatures({presetId,layer,query}).map(f=>f.id as string)).not.toContain('stock-sync');
    }
    // The merged widget is found under its own name and the old search words that still fit it.
    expect(listFeatures({presetId,layer:'management',query:'재고'}).map(f=>f.id)).toEqual(['inventory-booking'] satisfies FeatureId[]);
    expect(listFeatures({presetId,layer:'management',group:'recommended',businessType:'retail'}).map(f=>f.id)).toEqual(['ledger','inventory-booking','calendar','margin','grants']);
  });
  it('searches only current Korean management names, excluding removed and renamed labels',()=>{
    for(const query of ['손님예측','알바모집','매장 인테리어','사진으로 자리 배치','회원권','가계부','마진·원가분석','세금계산','재고관리','음성 예약확정','거래처','CCTV 손님분석']) {
      expect(listFeatures({presetId,layer:'management',query}),query).toEqual([]);
    }
    for(const [query,id] of [['메뉴','menu'],['손익','ledger'],['회원목록','members'],['발주','suppliers'],['  CCTV  ','customer-analysis'],['예약','voice-booking']] as const) {
      expect(listFeatures({presetId,layer:'management',query}).map(f=>f.id)).toEqual([id]);
    }
    expect(listFeatures({presetId,layer:'marketing',query:'리뷰'}).map(f=>f.id)).toEqual(['ai-response']);
    expect(listFeatures({presetId,layer:'management',query:'없는기능'})).toEqual([]);
  });
});
