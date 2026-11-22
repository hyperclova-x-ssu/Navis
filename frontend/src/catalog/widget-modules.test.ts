import { describe, expect, it } from 'vitest';
import type { WidgetModule } from '../contracts';
import * as catalog from './index';

const module = (id: string) => ({ id, Panel: () => null, Detail: null, useSummary: () => '' }) as WidgetModule;
const groups = {
  'mgmt-products':['menu'], 'mgmt-customers':['customer-analysis','members','voice-booking'],
  'mgmt-money':['briefing','ledger','margin','tax','grants'], 'mgmt-store':['manuals'],
  'i7-credit':['credit-receivable'],
  'i7-notice':['notice-send'], 'i7-environment':['store-environment'], 'i7-custom':['custom-order'],
  'i7-staff':['staff-schedule'], 'mgmt-supply':['calendar','inventory-booking','suppliers'],
  'mkt-local':['local-changes','trade-area','local-trends','ai-response','community'],
  'mkt-coupon':['slot-coupon','expiry-coupon','coupon-status','customer-groups'],
  'mkt-promo':['marketing-today','promo-video'],
} as const;

describe('pure module collection without rendering consumers (API-201)',()=>{
  it('assembles exactly 29 unique active ids from thirteen contract folders',()=>{
    expect(catalog.collectWidgetModules).toBeTypeOf('function');
    const folders=Object.fromEntries(Object.entries(groups).map(([name,ids])=>[`./${name}/index.ts`,{widgets:ids.map(module)}]));
    expect(Object.keys(folders)).toHaveLength(13);
    const result=catalog.collectWidgetModules(folders);
    expect(result).toHaveLength(29);
    expect(new Set(result.map(m=>m.id)).size).toBe(29);
    expect(result.map(m=>m.id).sort()).toEqual(catalog.getRegistry('A').map(r=>r.id).sort());
    expect(result.filter(m=>catalog.getRegistration(m.id)?.layer==='management')).toHaveLength(17);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('supports absent and partial folders in deterministic path order',()=>{
    expect(catalog.collectWidgetModules).toBeTypeOf('function');
    expect(catalog.collectWidgetModules({})).toEqual([]);
    expect(catalog.collectWidgetModules({'./empty/index.ts':{}})).toEqual([]);
    expect(catalog.collectWidgetModules({'./b/index.ts':{widgets:[module('tax')]},'./a/index.ts':{widgets:[module('ledger'),module('margin')]}}).map(m=>m.id)).toEqual(['ledger','margin','tax']);
  });
  it('rejects duplicate and removed ids with the source folder in the error',()=>{
    expect(catalog.collectWidgetModules).toBeTypeOf('function');
    expect(()=>catalog.collectWidgetModules({'./a/index.ts':{widgets:[module('tax')]},'./b/index.ts':{widgets:[module('tax')]}})).toThrow(/exported twice.*a\/index.ts.*b\/index.ts/);
    for(const id of ['stock-sync','demand','hiring','interior','floor-plan','memberships','unknown']) {
      expect(()=>catalog.collectWidgetModules({'./old/index.ts':{widgets:[module(id)]}})).toThrow(/old\/index.ts.*not in the widget registry/);
    }
  });
});

