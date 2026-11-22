import { describe, expect, it } from 'vitest';
import type { BusinessType, DashboardLayerId, FeatureId } from '../contracts';
import { getBusinessPreset, getMarketingPreset, getCatalog, getLayerCatalog, getLayerGroups, getRegistration, getRegistry, layerBusinessPresets, listFeatures, searchFeatures } from './index';
import { evaluate, preview, screenPresets } from '../layout';

const management: readonly FeatureId[] = ['menu','custom-order','inventory-booking','suppliers','ledger','margin','tax','credit-receivable','members','customer-analysis','store-environment','manuals','grants','staff-schedule','calendar','voice-booking','briefing'];
const marketing: readonly FeatureId[] = ['local-changes','trade-area','local-trends','ai-response','community','marketing-today','slot-coupon','expiry-coupon','promo-video','notice-send','coupon-status','customer-groups'];
const plan2Names: Readonly<Partial<Record<FeatureId,string>>> = {'marketing-today':'오늘 할 홍보','slot-coupon':'빈 시간 단골 쿠폰','expiry-coupon':'당일 소진 쿠폰','promo-video':'AI 홍보 영상','coupon-status':'진행 중인 쿠폰','customer-groups':'손님 그룹'};
// LOCALES 4 Korean names (legacy/dev label only).
const names: Readonly<Partial<Record<FeatureId,string>>> = {'credit-receivable':'충전금·외상 관리','custom-order':'주문제작','store-environment':'매장 환경','notice-send':'공지 발송',...plan2Names,menu:'메뉴',briefing:'브리핑',ledger:'손익',margin:'마진',tax:'세무관리',grants:'정부지원','customer-analysis':'CCTV 현황',members:'회원목록','voice-booking':'예약',calendar:'캘린더','inventory-booking':'재고',suppliers:'발주',manuals:'매뉴얼 작성','staff-schedule':'직원 스케줄표','local-changes':'동네 변화 알림','trade-area':'상권분석','local-trends':'로컬 트렌드','ai-response':'메시지·리뷰 응대',community:'커뮤니티'};
// DATA_MODEL 10.8 (R4 SCREENS 7.3, D-63); marketing recommendations are R4 SCREENS 8.1 (plan-2).
const table: Readonly<Record<BusinessType|'general',Readonly<Record<DashboardLayerId,readonly FeatureId[]>>>> = {
  cafe:{management:['ledger','margin','calendar','inventory-booking','menu'],marketing:['marketing-today','ai-response','slot-coupon','promo-video']},
  restaurant:{management:['ledger','margin','calendar','inventory-booking','customer-analysis'],marketing:['marketing-today','ai-response','slot-coupon','promo-video']},
  pub:{management:['ledger','voice-booking','calendar','margin','inventory-booking'],marketing:['marketing-today','ai-response','slot-coupon','promo-video']},
  beauty:{management:['calendar','members','ledger','voice-booking','manuals'],marketing:['marketing-today','slot-coupon','customer-groups','ai-response']},
  retail:{management:['ledger','inventory-booking','calendar','margin','grants'],marketing:['marketing-today','expiry-coupon','coupon-status','ai-response']},
  academy:{management:['calendar','members','ledger','manuals','tax'],marketing:['marketing-today','ai-response','slot-coupon','promo-video']},
  fitness:{management:['calendar','members','ledger','voice-booking','manuals'],marketing:['marketing-today','ai-response','slot-coupon','promo-video']},
  other:{management:['ledger','calendar','briefing','grants','tax'],marketing:['marketing-today','promo-video','slot-coupon','local-changes']},
  general:{management:['ledger','calendar','briefing','grants','tax'],marketing:['marketing-today','ai-response','slot-coupon','promo-video']},
};

describe.each(['A','B'] as const)('%s v4 widget registry (API-01 v4, DATA_MODEL 10.7)', presetId => {
  it('returns exactly 29 frozen registrations (마케팅 성과 is gone, D-365) without stock-sync, in the DATA_MODEL 10.7 order', () => {
    const registry = getRegistry(presetId);
    expect(registry.map(f => f.id)).toEqual([...management, ...marketing]);
    expect(registry.some(f => (f.id as string) === 'stock-sync')).toBe(false);
    expect(Object.isFrozen(registry)).toBe(true);
    for (const f of registry) {
      expect(Object.isFrozen(f)).toBe(true);
      expect(f.presetId).toBe(presetId);
      expect(f.label).toBe(names[f.id]);
      expect(f).toMatchObject({ nameKey: `widget.${f.id}.title`, coachKey: `widget.${f.id}.coach`, aliasesKey: `widget.${f.id}.aliases`, iconKey: f.id });
    }
    expect(getRegistry(presetId)).toBe(registry);
  });
  it('splits the layers 17/12 with their groups and detail frames', () => {
    expect(getLayerCatalog(presetId, 'management').map(f => f.id)).toEqual(management);
    expect(getLayerCatalog(presetId, 'marketing').map(f => f.id)).toEqual(marketing);
    expect(getRegistry(presetId)).toHaveLength(29);
    expect(getLayerCatalog(presetId, 'marketing').map(f => f.groupId)).toEqual(['neighborhood','neighborhood','neighborhood','customers','neighborhood','recommended','customers','money','news','news','money','customers']);
    expect(getLayerGroups('management')).toEqual(['recommended','products','stock','finance','members','store','schedule','misc']);
    expect(getLayerGroups('marketing')).toEqual(['recommended','news','money','customers','neighborhood']);
    const frames = Object.fromEntries(getRegistry(presetId).map(f => [f.id, `${f.detail.frame}/${f.detail.kind}`]));
    expect(frames).toMatchObject({ menu:'large/list-work', members:'large/list-work', 'inventory-booking':'large/workspace', suppliers:'large/workspace', briefing:'compact/text', ledger:'large/chart', margin:'large/chart', tax:'large/list-work', grants:'large/list-work', 'customer-analysis':'large/chart', manuals:'large/list-work', calendar:'large/chart', 'voice-booking':'large/list-work', 'local-changes':'compact/text', 'local-trends':'compact/text', 'trade-area':'large/chart', 'ai-response':'large/list-work', community:'large/list-work' });
  });
  it('lists by layer: groups, the layer recommendations and Korean search on 21 entries', () => {
    expect(listFeatures({ presetId, layer: 'management', query: '' })).toHaveLength(17);
    expect(listFeatures({ presetId, layer: 'marketing', group: 'recommended', businessType: 'cafe' }).map(f => f.id)).toEqual(table.cafe.marketing);
    // AC-319: home-recommended widget first, then the business recommendations without duplicates.
    expect(listFeatures({ presetId, layer: 'marketing', group: 'recommended', businessType: 'beauty' }).map(f => f.id)).toEqual(['marketing-today','slot-coupon','customer-groups','ai-response']);
    expect(listFeatures({ presetId, layer: 'marketing', group: 'recommended', businessType: 'retail' }).map(f => f.id)).toEqual(['marketing-today','expiry-coupon','coupon-status','ai-response']);
    expect(listFeatures({ presetId, layer: 'marketing', group: 'recommended', businessType: 'other' }).map(f => f.id)).toEqual(['marketing-today','promo-video','slot-coupon','local-changes']);
    expect(listFeatures({ presetId, layer: 'marketing', group: 'recommended', businessType: null }).map(f => f.id)).toEqual(['marketing-today','ai-response','slot-coupon','promo-video']);
    expect(listFeatures({ presetId, layer: 'marketing', group: 'news' }).map(f => f.id)).toEqual(['promo-video','notice-send']);
    expect(listFeatures({ presetId, layer: 'marketing', group: 'money' }).map(f => f.id)).toEqual(['expiry-coupon','coupon-status']);
    expect(listFeatures({ presetId, layer: 'marketing', group: 'customers' }).map(f => f.id)).toEqual(['ai-response','slot-coupon','customer-groups']);
    expect(listFeatures({ presetId, layer: 'marketing', group: 'neighborhood' }).map(f => f.id)).toEqual(['local-changes','trade-area','local-trends','community']);
    expect(listFeatures({ presetId, layer: 'management', group: 'recommended', businessType: 'retail' }).map(f => f.id)).toEqual(table.retail.management);
    expect(listFeatures({ presetId, layer: 'management', group: 'schedule' }).map(f => f.id)).toEqual(['calendar','voice-booking','briefing']);
    expect(listFeatures({ presetId, layer: 'management', query: '온라인 재고' })).toEqual([]);
    expect(listFeatures({ presetId, layer: 'marketing', query: ' 리뷰 ' }).map(f => f.id)).toEqual(['ai-response']);
    expect(listFeatures({ presetId, layer: 'marketing', query: '쿠폰' }).map(f => f.id)).toEqual(['slot-coupon','expiry-coupon','coupon-status']);
    const ledger = getLayerCatalog(presetId, 'management').find(f => f.id === 'ledger');
    expect(listFeatures({ presetId, layer: 'management', group: 'recommended', businessType: 'cafe' })[0]).toBe(ledger);
  });
  it('uses the same registry as the run and layout catalog (T-055: the iteration-3 22-item list and its stock-sync are removed)', () => {
    expect(getCatalog(presetId)).toBe(getRegistry(presetId));
    expect(getCatalog(presetId).map(f => f.id)).toEqual([...management, ...marketing]);
    expect(getCatalog(presetId).find(f => f.id === 'inventory-booking')?.label).toBe('재고');
  });
});

describe('layer business presets (DATA_MODEL 10.8)', () => {
  it.each(Object.keys(table) as (BusinessType|'general')[])('%s recommends five per layer; management first three start it', type => {
    for (const layer of ['management','marketing'] as const) {
      const preset = getBusinessPreset(type === 'general' ? null : type, layer);
      expect(preset.recommendationIds).toEqual(table[type][layer]);
      expect(preset.starterIds).toEqual(table[type][layer].slice(0, 3)); // marketing starts with getMarketingPreset instead
      expect(preset.layer).toBe(layer);
      expect(preset.businessType).toBe(type);
      for (const id of preset.recommendationIds) expect(getRegistration(id)?.layer).toBe(layer);
      if (layer === 'management') for (const presetId of ['A','B'] as const) {
        const placed = preview([], { type: 'starter', featureIds: preset.starterIds }, screenPresets[presetId].grid, getLayerCatalog(presetId, layer));
        expect(placed.panels.map(p => [p.featureId, p.column, p.row, p.width, p.height])).toEqual(preset.starterIds.map((id, column) => [id, column, 0, 1, 1]));
      }
    }
    expect(getBusinessPreset(type === 'general' ? null : type)).toBe(getBusinessPreset(type === 'general' ? null : type, 'management'));
    expect(layerBusinessPresets.management).toHaveLength(9);
    expect(layerBusinessPresets.marketing).toHaveLength(9);
  });
});

describe('registration and search helpers', () => {
  it('reads one registration by id and rejects stock-sync and unknown ids', () => {
    expect(getRegistration('ai-response')).toMatchObject({ id: 'ai-response', layer: 'marketing', groupId: 'customers', label: '메시지·리뷰 응대' });
    expect(getRegistration('stock-sync')).toBeUndefined();
    expect(getRegistration('nope')).toBeUndefined();
    expect(Object.isFrozen(getRegistration('ledger'))).toBe(true);
  });
  it('matches NFKC, case and whitespace normalized partial terms from the caller', () => {
    const features = getLayerCatalog('A', 'management');
    const terms = (f: { readonly id: FeatureId }) => f.id === 'inventory-booking' ? ['Inventory', '재고관리'] : f.id === 'ledger' ? ['Ledger', '가계부'] : [];
    expect(searchFeatures(features, ' inven tory ', terms).map(f => f.id)).toEqual(['inventory-booking']);
    expect(searchFeatures(features, 'ＬＥＤＧＥＲ', terms).map(f => f.id)).toEqual(['ledger']);
    expect(searchFeatures(features, '재고 관리', terms).map(f => f.id)).toEqual(['inventory-booking']);
    expect(searchFeatures(features, '', terms)).toBe(features);
    expect(searchFeatures(features, 'zzz', terms)).toEqual([]);
  });
});

describe('marketing start layout (ARCHITECTURE 11.13.3, AC-309~311)', () => {
  const cells = (type: BusinessType | null) => getMarketingPreset(type).map(c => [c.featureId, c.column, c.row, c.width, c.height]);
  const rowOf = (type: BusinessType | null, row: number) => getMarketingPreset(type).filter(c => c.row === row).map(c => c.featureId);
  it('cafe: the base table (AC-309)', () => {
    expect(cells('cafe')).toEqual([
      ['marketing-today',0,0,4,1],['ai-response',0,1,2,1],['expiry-coupon',2,1,2,1],['promo-video',4,1,2,1],
      ['slot-coupon',0,2,2,1],['coupon-status',2,2,2,1],['customer-groups',4,2,2,1],
    ]);
  });
  it.each([
    ['beauty', ['slot-coupon','expiry-coupon','promo-video'], ['ai-response','coupon-status','customer-groups']],
    ['retail', ['expiry-coupon','slot-coupon','promo-video'], ['ai-response','coupon-status','customer-groups']],
    ['other', ['promo-video','expiry-coupon','slot-coupon'], ['ai-response','coupon-status','customer-groups']],
    [null, ['ai-response','expiry-coupon','promo-video'], ['slot-coupon','coupon-status','customer-groups']],
    ['restaurant', ['ai-response','expiry-coupon','promo-video'], ['slot-coupon','coupon-status','customer-groups']],
  ] as const)('%s: rows 2 and 3 (AC-311)', (type, second, third) => {
    expect(rowOf(type as BusinessType | null, 1)).toEqual(second);
    expect(rowOf(type as BusinessType | null, 2)).toEqual(third);
    expect(rowOf(type as BusinessType | null, 0)).toEqual(['marketing-today']);
    expect(rowOf(type as BusinessType | null, 3)).toEqual([]);
  });
  it.each(['cafe','restaurant','pub','beauty','retail','academy','fitness','other',null] as const)('%s: seven distinct marketing widgets, no overlap, width <= 4, valid on A and B', type => {
    const preset = getMarketingPreset(type);
    expect(new Set(preset.map(c => c.featureId)).size).toBe(7);
    expect(preset.every(c => c.width <= 4 && getRegistration(c.featureId)?.layer === 'marketing')).toBe(true);
    for (const presetId of ['A','B'] as const) {
      const panels = preset.map(c => ({ featureId: c.featureId, column: c.column, row: c.row, width: c.width, height: c.height }));
      const result = evaluate(panels, screenPresets[presetId].grid, getLayerCatalog(presetId, 'marketing'));
      expect(result.valid, `${type} ${presetId}`).toBe(true);
    }
    expect(Object.isFrozen(preset)).toBe(true);
  });
});
