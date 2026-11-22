import type { DataTables } from '../../db/types';
import { dateRange } from '../../db/time';
import type { CalendarEntry } from '../../models/types';

export function selectCalendarProjections(tables: DataTables, start: string, end: string, sourceFailed?: boolean): readonly CalendarEntry[] {
  return (tables.calendarProjection ?? []).flatMap(row => {
    const source = row.visibility;
    if (tables.calendarSettings[source] === false || !tables.categoryVisibility[row.categoryId] || sourceFailed && source === 'deadline') return [];
    const first = row.date < start ? start : row.date;
    const lastDay = row.endDate ?? row.date;
    const last = lastDay > end ? end : lastDay;
    if (first > last) return [];
    return dateRange(first, last).map(date => ({
      id: `${row.source}:${row.sourceId}${date === row.date ? '' : `:${date}`}`,
      source, sourceFeatureId: row.featureId, sourceId: row.sourceId, kind: 'event', date,
      time: date === row.date ? row.time : null, title: { raw: row.title }, memo: null,
      ref: { featureId: row.featureId, itemId: row.sourceId, ...(source === 'delivery' ? { view: 'order' } : {}) },
      editable: false, categoryId: row.categoryId,
    }));
  });
}
