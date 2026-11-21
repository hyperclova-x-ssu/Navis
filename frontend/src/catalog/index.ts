import { managementRecommendations } from './management-templates';
export { getManagementTemplates } from './management-templates';
export { collectWidgetModules } from './widget-modules';
export type { WidgetFolderModules } from './widget-modules';
import type { BusinessPreset, BusinessType, CellSpan, DashboardLayerId, DetailFrame, DetailKind, FeatureId, FeatureQuery, GroupId, ResolvedCatalog, ResolvedWidgetRegistration, ScreenPresetId, WidgetRegistration, WidgetRegistry } from '../contracts';

function freeze<T>(value:T):T {
  if(value && typeof value==='object' && !Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value))freeze(child);
  }
  return value;
}
export function normalizeSearch(value:string):string { return value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/gu,'').trim(); }

/** API-279 M3: one immutable catalog for management (17) and marketing (13). */
const registryTable: readonly [FeatureId,string,DashboardLayerId,GroupId,DetailFrame,DetailKind,readonly string[]][] = [
 ['menu','메뉴','management','products','large','list-work',[]],
 ['custom-order','주문제작','management','products','large','list-work',['케이크 주문','맞춤 주문']],
 ['inventory-booking','재고','management','stock','large','workspace',[]],
 ['suppliers','발주','management','stock','large','workspace',[]],
 ['ledger','손익','management','finance','large','chart',[]],
 ['margin','마진','management','finance','large','chart',[]],
 ['tax','세무관리','management','finance','large','list-work',[]],
 ['credit-receivable','충전금·외상 관리','management','members','large','list-work',['충전','외상','미수금']],
 ['members','회원목록','management','members','large','list-work',[]],
 ['customer-analysis','CCTV 현황','management','store','large','chart',[]],
 ['store-environment','매장 환경','management','store','large','chart',['온도','습도','음악']],
 ['manuals','매뉴얼 작성','management','misc','large','list-work',[]],
 ['grants','정부지원','management','misc','large','list-work',[]],
 ['staff-schedule','직원 스케줄표','management','misc','large','list-work',['근무표','시간표']],
 ['calendar','캘린더','management','schedule','large','chart',[]],
 ['voice-booking','예약','management','schedule','large','list-work',[]],
 ['briefing','브리핑','management','schedule','compact','text',[]],
 ['local-changes','동네 변화 알림','marketing','neighborhood','compact','text',['경쟁점','개업','동네 변화']],
 ['trade-area','상권분석','marketing','neighborhood','large','chart',['상권','유동인구']],
 ['local-trends','로컬 트렌드','marketing','neighborhood','compact','text',['디카페인','동네 유행']],
 ['ai-response','메시지·리뷰 응대','marketing','customers','large','list-work',['전화','메시지']],
 ['community','커뮤니티','marketing','neighborhood','large','list-work',['가게 매칭','제휴']],
 // plan-2 (DATA_MODEL 10.15.1). marketing-today has no detail of its own (Detail is null), so its frame is never opened.
 ['marketing-today','오늘 할 홍보','marketing','recommended','compact','text',['오늘 홍보','홍보','할 일']],
 ['slot-coupon','빈 시간 단골 쿠폰','marketing','customers','large','list-work',['쿠폰','한산한 시간','단골']],
 ['expiry-coupon','당일 소진 쿠폰','marketing','money','large','list-work',['쿠폰','소진','유통기한']],
 ['promo-video','AI 홍보 영상','marketing','news','large','list-work',['영상','홍보 영상','숏폼']],
 ['notice-send','공지 발송','marketing','news','large','list-work',['휴무','공지']],
 ['coupon-status','진행 중인 쿠폰','marketing','money','large','list-work',['쿠폰','진행 중','사용 현황']],
 ['customer-groups','손님 그룹','marketing','customers','large','list-work',['단골','첫 방문','이탈']],
 ['marketing-performance','마케팅 성과','marketing','money','large','chart',['성과','경로','쿠폰 사용']],
];
const registrations:ReadonlyMap<string,WidgetRegistration>=new Map(registryTable.map(([id,label,layer,groupId,frame,kind,aliases])=>[id,freeze({
  id,label,panelTitle:label,aliases,groupId,iconKey:id,layer,
  nameKey:`widget.${id}.title`,coachKey:`widget.${id}.coach`,aliasesKey:`widget.${id}.aliases`,
  detail:{frame,kind},searchText:normalizeSearch([label,...aliases].join(' ')),
})]));
const resolve=(presetId:ScreenPresetId):WidgetRegistry=>[...registrations.values()].map(r=>({...r,presetId} as ResolvedWidgetRegistration));
const registries:Readonly<Record<ScreenPresetId,WidgetRegistry>>=freeze({A:resolve('A'),B:resolve('B')});
const layerCatalogs:Readonly<Record<ScreenPresetId,Readonly<Record<DashboardLayerId,WidgetRegistry>>>>=freeze({
  A:{management:registries.A.filter(r=>r.layer==='management'),marketing:registries.A.filter(r=>r.layer==='marketing')},
  B:{management:registries.B.filter(r=>r.layer==='management'),marketing:registries.B.filter(r=>r.layer==='marketing')},
});
const layerGroups:Readonly<Record<DashboardLayerId,readonly GroupId[]>>=freeze({management:['recommended','products','stock','finance','members','store','schedule','misc'],marketing:['recommended','news','money','customers','neighborhood']});
export function getRegistry(presetId:ScreenPresetId):WidgetRegistry { return registries[presetId]; }
/**
 * The run and layout-engine catalog: every registry widget for the preset (the same frozen list as getRegistry).
 * The engine checks only membership; the store checks layers (OTHER_LAYER). The iteration-3 22-item list is gone (T-055).
 */
export function getCatalog(presetId:ScreenPresetId):ResolvedCatalog { return registries[presetId]; }
export function getLayerCatalog(presetId:ScreenPresetId,layer:DashboardLayerId):WidgetRegistry { return layerCatalogs[presetId][layer]; }
export function getLayerGroups(layer:DashboardLayerId):readonly GroupId[] { return layerGroups[layer]; }
export function getRegistration(id:string):WidgetRegistration|undefined { return registrations.get(id); }
/** Normalized (NFKC, lower case, no whitespace) partial match over the caller's translated names and aliases. The catalog knows no translations. */
export function searchFeatures<T>(features:readonly T[],query:string,termsOf:(feature:T)=>readonly string[]):readonly T[] {
  const search=normalizeSearch(query);if(!search)return features;
  return Object.freeze(features.filter(feature=>termsOf(feature).some(term=>normalizeSearch(term).includes(search))));
}

/** DATA_MODEL 10.8 (R4 SCREENS 7.3, D-63): five recommendations per layer. Management's first three start it; marketing (plan-2, R4 SCREENS 8.1) starts with getMarketingPreset and its starterIds are unused. */
const presetLabels: readonly [BusinessType|'general',string][] = [['cafe','카페'],['restaurant','음식점'],['pub','주점'],['beauty','미용·뷰티'],['retail','소매'],['academy','학원'],['fitness','운동'],['other','기타'],['general','']];
const layerPresetData: Readonly<Record<DashboardLayerId,Readonly<Record<BusinessType|'general',readonly FeatureId[]>>>> = {
 management:managementRecommendations,
 marketing:{cafe:['marketing-today','marketing-performance','ai-response','slot-coupon','promo-video'],restaurant:['marketing-today','marketing-performance','ai-response','slot-coupon','promo-video'],pub:['marketing-today','marketing-performance','ai-response','slot-coupon','promo-video'],beauty:['marketing-today','marketing-performance','slot-coupon','customer-groups','ai-response'],retail:['marketing-today','marketing-performance','expiry-coupon','coupon-status','ai-response'],academy:['marketing-today','marketing-performance','ai-response','slot-coupon','promo-video'],fitness:['marketing-today','marketing-performance','ai-response','slot-coupon','promo-video'],other:['marketing-today','marketing-performance','promo-video','slot-coupon','local-changes'],general:['marketing-today','marketing-performance','ai-response','slot-coupon','promo-video']},
};
const makePreset=(businessType:BusinessType|'general',label:string,layer:DashboardLayerId):BusinessPreset=>{const recommendationIds=layerPresetData[layer][businessType];return {businessType,label,recommendationIds,starterIds:recommendationIds.slice(0,3),starterMessageKey:businessType==='general'?'starter.general':'starter.business',layer};};
export const layerBusinessPresets: Readonly<Record<DashboardLayerId,readonly BusinessPreset[]>> = freeze({
 management:presetLabels.map(([businessType,label])=>makePreset(businessType,label,'management')),
 marketing:presetLabels.map(([businessType,label])=>makePreset(businessType,label,'marketing')),
});
/** The layer defaults to management. */
export function getBusinessPreset(type:BusinessType|'general'|null,layer:DashboardLayerId='management'): BusinessPreset { return layerBusinessPresets[layer].find(p=>p.businessType===(type??'general'))!; }

/** Recommended drawer (API-01 v4.1): widgets whose home group is 'recommended' first, then the layer's business recommendations, no duplicates. */
function recommendedFor(catalog:WidgetRegistry,businessType:BusinessType|null,layer:DashboardLayerId):WidgetRegistry{
  const home=catalog.filter(f=>f.groupId==='recommended');
  const picked=getBusinessPreset(businessType,layer).recommendationIds.map(id=>catalog.find(f=>f.id===id)!);
  return [...home,...picked.filter(f=>!home.includes(f))];
}
/** plan-2 start layout (ARCHITECTURE 11.13.3). Coordinates are 0-based; the same on A (6x4) and B (8x5, top-left 6x4). */
export interface MarketingPresetCell { readonly featureId:FeatureId; readonly column:number; readonly row:number; readonly width:CellSpan; readonly height:CellSpan }
const marketingBase:readonly MarketingPresetCell[]=[
  {featureId:'marketing-today',column:0,row:0,width:4,height:1},
  {featureId:'ai-response',column:0,row:1,width:2,height:1},{featureId:'expiry-coupon',column:2,row:1,width:2,height:1},{featureId:'promo-video',column:4,row:1,width:2,height:1},
  {featureId:'slot-coupon',column:0,row:2,width:2,height:1},{featureId:'coupon-status',column:2,row:2,width:2,height:1},{featureId:'customer-groups',column:4,row:2,width:2,height:1},
  {featureId:'marketing-performance',column:0,row:3,width:4,height:1},
];
const marketingFirst:Readonly<Partial<Record<BusinessType,FeatureId>>>={beauty:'slot-coupon',retail:'expiry-coupon',other:'promo-video'};
/** Chosen widget X goes to the 2nd-row first cell, the old 2nd-row first goes to the 3rd-row first cell, the old 3rd-row first goes to X's old cell. Always eight distinct widgets. */
export function getMarketingPreset(businessType:BusinessType|null):readonly MarketingPresetCell[]{
  const x=(businessType&&marketingFirst[businessType])||marketingBase[1].featureId;
  return Object.freeze(marketingBase.map(cell=>Object.freeze({...cell,featureId:cellOwner(cell,x)})));
}
function cellOwner(cell:MarketingPresetCell,x:FeatureId):FeatureId{
  const second=marketingBase[1],third=marketingBase[4];
  const home=marketingBase.find(c=>c.featureId===x)!;
  if(x===second.featureId)return cell.featureId;
  if(cell.column===second.column&&cell.row===second.row)return x;
  if(cell.column===third.column&&cell.row===third.row)return second.featureId;
  if(cell.column===home.column&&cell.row===home.row)return third.featureId;
  return cell.featureId;
}
/** One layer's registry entries: a group, the layer's recommendations, or a Korean-label search (the screen searches translated names with searchFeatures). */
export function listFeatures({presetId,group,businessType=null,query,layer}:FeatureQuery):WidgetRegistry {
  const search=normalizeSearch(query??'');
  const catalog=getLayerCatalog(presetId,layer);
  const source=query!==undefined?catalog:group==='recommended'?recommendedFor(catalog,businessType,layer):group?catalog.filter(f=>f.groupId===group):catalog;
  return Object.freeze(source.filter(f=>!search||f.searchText.includes(search)));
}
