import type { FeatureId, QueryCondition } from '../../../contracts';
import { seedToday } from '../../../data/db/generated/today';
import { addDays, TODAY } from '../../../data/db/time';
import { createWidgetDataStore, selectWidget, widgetFacts, type DataSnapshot } from '../../../data/widget-data';

export const cafeTodayNet = seedToday.rollup.net;
export const cafeWeek = { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY } as const;
export const cafeSnapshot = createWidgetDataStore().getSnapshot();
export const cafeFacts = (featureId: FeatureId, condition: QueryCondition = { kind: 'default' }, snapshot: DataSnapshot = cafeSnapshot) =>
  widgetFacts(selectWidget(snapshot, featureId, condition, 'normal'));
