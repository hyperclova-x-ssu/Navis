import { describe, expect, it } from 'vitest';
import type { BusinessType, Panel } from '../contracts';
import * as catalog from './index';

const businesses = ['cafe','restaurant','pub','beauty','retail','academy','fitness','other',null] as const;
const cell = (p: Panel) => [p.featureId,p.column,p.row,p.width,p.height];
const expected = {
  prepaid: [
    [['briefing',0,0,2,2],['ledger',2,0,2,1],['margin',2,1,2,1],['calendar',4,0,2,2],['inventory-booking',0,2,2,1],['menu',2,2,2,1]],
    [['inventory-booking',0,0,3,2],['suppliers',3,0,3,2],['menu',0,2,2,1],['margin',2,2,2,1],['calendar',4,2,2,1],['ledger',0,3,2,1]],
    [['members',0,0,2,2],['voice-booking',4,0,2,2],['briefing',2,0,2,1],['calendar',2,1,2,1],['ledger',0,2,2,1],['customer-analysis',2,2,2,1]],
  ],
  postpaid: [
    [['briefing',0,0,2,2],['voice-booking',4,0,2,2],['ledger',2,0,2,1],['inventory-booking',2,1,2,1],['calendar',0,2,2,1],['margin',2,2,2,1]],
    [['inventory-booking',0,0,3,2],['suppliers',3,0,3,2],['menu',0,2,2,1],['margin',2,2,2,1],['voice-booking',4,2,2,1],['calendar',0,3,2,1]],
    [['voice-booking',0,0,3,2],['members',3,0,3,2],['briefing',0,2,2,1],['calendar',2,2,2,1],['customer-analysis',4,2,2,1]],
  ],
};

describe('management template source (API-212)', () => {
  it.each(['prepaid','postpaid'] as const)('%s preview and application share the six exact layouts', paymentStyle => {
    expect(catalog.getManagementTemplates).toBeTypeOf('function');
    const templates = catalog.getManagementTemplates({businessType:'cafe',paymentStyle,presetId:'A'});
    expect(templates.map(t=>t.id)).toEqual(['A','B','C']);
    expect(templates.map(t=>t.panels.map(cell))).toEqual(expected[paymentStyle]);
    for(const t of templates) expect(t.tourOrder).toEqual(t.panels.map(p=>p.featureId));
  });

  for(const businessType of businesses) for(const paymentStyle of ['prepaid','postpaid'] as const) for(const presetId of ['A','B'] as const) {
    it(`${businessType ?? 'skip'}/${paymentStyle}/${presetId}: three immutable, distinct, bounded layouts`,()=>{
      expect(catalog.getManagementTemplates).toBeTypeOf('function');
      const templates = catalog.getManagementTemplates({businessType,paymentStyle,presetId});
      expect(templates).toHaveLength(3);
      expect(Object.isFrozen(templates)).toBe(true);
      const grid = presetId==='A' ? {columns:6,rows:4} : {columns:8,rows:5};
      for(const [index,t] of templates.entries()) {
        expect(Object.isFrozen(t)).toBe(true);
        expect(Object.isFrozen(t.panels)).toBe(true);
        expect(Object.isFrozen(t.tourOrder)).toBe(true);
        expect(t.paymentStyle).toBe(paymentStyle);
        expect(t.nameKey).not.toBe('');
        expect(t.descriptionKey).not.toBe('');
        expect(t.panels).toHaveLength(paymentStyle==='postpaid' && index===2 ? 5 : 6);
        expect(new Set(t.panels.map(p=>p.featureId)).size).toBe(t.panels.length);
        const occupied = new Set<string>();
        for(const p of t.panels) {
          expect(Object.isFrozen(p)).toBe(true);
          expect(catalog.getRegistration(p.featureId)?.layer).toBe('management');
          expect(p.column).toBeGreaterThanOrEqual(0); expect(p.row).toBeGreaterThanOrEqual(0);
          expect(p.column+p.width).toBeLessThanOrEqual(grid.columns); expect(p.row+p.height).toBeLessThanOrEqual(grid.rows);
          for(let y=p.row;y<p.row+p.height;y++) for(let x=p.column;x<p.column+p.width;x++) {
            const key=`${x},${y}`;
            expect(occupied.has(key),key).toBe(false); occupied.add(key);
          }
        }
        expect(occupied.size).toBe((paymentStyle==='prepaid' ? [16,20,16] : [16,20,18])[index]);
        expect(t.tourOrder).toEqual(t.panels.map(p=>p.featureId));
        const recommended=businessType==='retail' ? 'B' : ['beauty','academy','fitness'].includes(businessType ?? '') ? 'C' : 'A';
        expect(t.recommended).toBe(t.id===recommended);
      }
    });
  }

  it.each(['beauty','academy','fitness'] as BusinessType[])('%s replaces menu before margin without losing coordinates',businessType=>{
    expect(catalog.getManagementTemplates).toBeTypeOf('function');
    const [a,b]=catalog.getManagementTemplates({businessType,paymentStyle:'prepaid',presetId:'A'});
    expect(a.panels.map(cell)).toEqual([
      ['briefing',0,0,2,2],['ledger',2,0,2,1],['members',2,1,2,1],['calendar',4,0,2,2],['inventory-booking',0,2,2,1],['voice-booking',2,2,2,1],
    ]);
    expect(b.panels.map(p=>p.featureId)).toEqual(['inventory-booking','suppliers','voice-booking','members','calendar','ledger']);
    const postpaid=catalog.getManagementTemplates({businessType,paymentStyle:'postpaid',presetId:'A'});
    expect(postpaid[1].panels.map(p=>p.featureId)).toEqual(['inventory-booking','suppliers','members','manuals','voice-booking','calendar']);
  });

  it('retail substitutes members in the menu slot and leaves the source reusable',()=>{
    expect(catalog.getManagementTemplates).toBeTypeOf('function');
    const args={businessType:'retail',paymentStyle:'prepaid',presetId:'A'} as const;
    const result=catalog.getManagementTemplates(args);
    expect(result[1].panels.map(p=>p.featureId)).toEqual(['inventory-booking','suppliers','members','margin','calendar','ledger']);
    expect(catalog.getManagementTemplates(args)).toBe(result);
    expect(catalog.getManagementTemplates({...args,businessType:'cafe'})[1].panels[2].featureId).toBe('menu');
  });
});
