import type { BusinessType, FeatureId, ManagementTemplate, ManagementTemplateId, Panel, PaymentStyle, ScreenPresetId } from '../contracts';

/** API-200 recommendations and the empty dashboard's first three share this source. */
export const managementRecommendations: Readonly<Record<BusinessType | 'general', readonly FeatureId[]>> = Object.freeze({
  cafe: Object.freeze(['ledger','margin','calendar','inventory-booking','menu'] as const),
  restaurant: Object.freeze(['ledger','margin','calendar','inventory-booking','customer-analysis'] as const),
  pub: Object.freeze(['ledger','voice-booking','calendar','margin','inventory-booking'] as const),
  beauty: Object.freeze(['calendar','members','ledger','voice-booking','manuals'] as const),
  retail: Object.freeze(['ledger','inventory-booking','calendar','margin','grants'] as const),
  academy: Object.freeze(['calendar','members','ledger','manuals','tax'] as const),
  fitness: Object.freeze(['calendar','members','ledger','voice-booking','manuals'] as const),
  other: Object.freeze(['ledger','calendar','briefing','grants','tax'] as const),
  general: Object.freeze(['ledger','calendar','briefing','grants','tax'] as const),
});

type Cell = readonly [FeatureId, number, number, number, number];
/** ARCH13.5: zero-based dashboard coordinates; order also drives flight and tour. */
const layouts: Readonly<Record<PaymentStyle, readonly (readonly Cell[])[]>> = {
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

export interface ManagementTemplateQuery {
  readonly businessType: BusinessType | null;
  readonly paymentStyle: PaymentStyle;
  readonly presetId: ScreenPresetId;
}
const cache = new Map<string, readonly ManagementTemplate[]>();
const ids: readonly ManagementTemplateId[] = ['A','B','C'];

/** Cards and application receive the same deeply frozen result, including industry substitutions. */
export function getManagementTemplates({businessType,paymentStyle,presetId}: ManagementTemplateQuery): readonly ManagementTemplate[] {
  const key = `${businessType ?? 'general'}:${paymentStyle}:${presetId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const service = businessType === 'beauty' || businessType === 'academy' || businessType === 'fitness';
  const recommendedId = businessType === 'retail' ? 'B' : service ? 'C' : 'A';
  const result = Object.freeze(layouts[paymentStyle].map((cells,index): ManagementTemplate => {
    const panels: Panel[] = cells.map(([featureId,column,row,width,height])=>({featureId,column,row,width,height}));
    // Menu is replaced first, even when it is later than margin in the tour array.
    const substitutions: readonly (readonly [FeatureId, readonly FeatureId[]])[] = businessType === 'retail'
      ? [['menu',['members','grants']]]
      : service ? [['menu',['voice-booking','members','manuals']],['margin',['members','manuals','grants']]] : [];
    for (const [source,choices] of substitutions) {
      const position = panels.findIndex(p=>p.featureId===source);
      if (position < 0) continue;
      const replacement = choices.find(id=>!panels.some(p=>p.featureId===id));
      if (replacement) panels[position] = {...panels[position],featureId:replacement};
    }
    const id = ids[index];
    return Object.freeze({
      id,paymentStyle,
      nameKey:`onboarding.template.${id}.name`,
      descriptionKey:`onboarding.template.${paymentStyle}.${id}.description`,
      recommended:id===recommendedId,
      panels:Object.freeze(panels.map(p=>Object.freeze(p))),
      tourOrder:Object.freeze(panels.map(p=>p.featureId)),
    });
  }));
  cache.set(key,result);
  return result;
}
