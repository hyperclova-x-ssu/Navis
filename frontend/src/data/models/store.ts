import type { DataTables, ManualCategory, Material, Mood, Zone } from '../db/types';
import { addDays, MINIMUM_WAGE, TODAY, WEEK_END, weekdayOf } from '../db/time';
import type { FloorPlanModel, HiringModel, InteriorModel, LayoutRow, ManualRow, ManualsModel } from './types';
import { staffAt } from './customers';
import { ready, sum, type Projector } from './util';

/* 알바모집 */
export const projectHiring: Projector<'hiring'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const grid = [...t.hiringLoad].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
  const max = Math.max(...grid.map((g) => g.level));
  // Longest run of consecutive max-level hours per weekday; weekdays sharing the best run are grouped (토·일 14~17시).
  const runs: { weekday: number; start: number; end: number }[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    const hours = grid.filter((g) => g.weekday === weekday && g.level === max).map((g) => g.hour);
    let start = -1;
    hours.forEach((h, i) => {
      if (start < 0) start = h;
      if (hours[i + 1] !== h + 1) { runs.push({ weekday, start, end: h + 1 }); start = -1; }
    });
  }
  const bestLen = Math.max(0, ...runs.map((r) => r.end - r.start));
  const best = runs.find((r) => r.end - r.start === bestLen);
  const helpHours = best ? { weekdays: runs.filter((r) => r.start === best.start && r.end === best.end).map((r) => r.weekday), startHour: best.start, endHour: best.end, level: max } : null;
  const shiftDates = [...new Set(t.staffSchedule.map((s) => s.date))].filter((d) => d >= TODAY && d <= WEEK_END).sort();
  const roster = shiftDates.flatMap((date) => Array.from({ length: 14 }, (_, i) => ({ date, hour: 8 + i, staff: staffAt(t, date, 8 + i) })));
  const helpDate = helpHours ? shiftDates.find((d) => helpHours.weekdays.includes(weekdayOf(d))) : undefined;
  const helpStaff = helpHours && helpDate ? roster.filter((r) => r.date === helpDate && r.hour >= helpHours.startHour && r.hour < helpHours.endHour).map((r) => r.staff) : [];
  const draft = t.jobPostDraft;
  const pad = (h: number): string => `${String(h).padStart(2, '0')}:00`;
  const model: HiringModel = {
    basisWeeks: 4, basis: { start: addDays(TODAY, -28), end: addDays(TODAY, -1) }, helpHours, grid,
    weekdayLevels: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, level: Math.max(...grid.filter((g) => g.weekday === i + 1).map((g) => g.level)) })),
    staffOnHelpHours: helpStaff.length > 0 ? Math.min(...helpStaff) : null, roster,
    draft: draft ? { days: draft.days, start: draft.start, end: draft.end, tasks: draft.tasks, hourlyWage: draft.hourlyWage, contact: draft.contact, status: draft.status } : null,
    draftStatus: draft?.status ?? 'none',
    suggestion: {
      days: helpHours?.weekdays ?? [6, 7], start: pad(helpHours?.startHour ?? 14), end: pad(helpHours?.endHour ?? 17),
      tasks: [{ key: 'data.hiring.task.drinks' }, { key: 'data.hiring.task.counter' }, { key: 'data.hiring.task.cleaning' }], hourlyWage: 10_500, contact: { key: 'data.hiring.contact' },
    },
    minimumWage: MINIMUM_WAGE,
  };
  return ready('hiring', condition, variant, model);
};

/* 매뉴얼 */
const CATEGORY_ORDER: readonly ManualCategory[] = ['opening', 'closing', 'recipe', 'cleaning', 'new-staff', 'hygiene'];
export const projectManuals: Projector<'manuals'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const manuals: ManualRow[] = t.manual.filter((m) => m.isPublished).map((m) => ({
    body: m.section === 'store-info' ? t.manualStep.filter((s) => s.manualId === m.manualId).sort((a, b) => a.stepNo - b.stepNo)[0]?.body ?? null : null,
    section: m.section ?? 'handover', cautions: m.cautions ?? { raw: '' }, manualId: m.manualId, title: m.title, category: m.category, categoryKey: `data.manualCategory.${m.category}`, updatedAt: m.updatedAt, checklist: m.section !== 'store-info' && (m.category === 'opening' || m.category === 'closing'),
    steps: t.manualStep.filter((s) => s.manualId === m.manualId).sort((a, b) => a.stepNo - b.stepNo).map((s) => ({ stepNo: s.stepNo, body: s.body, checkedToday: t.checklistLog.some((c) => c.date === TODAY && c.manualId === m.manualId && c.stepNo === s.stepNo) })),
  }));
  const model: ManualsModel = {
    publishedCount: manuals.filter((m) => m.section === 'handover').length, storeInfoCount: manuals.filter((m) => m.section === 'store-info').length, storeInfo: manuals.filter((m) => m.section === 'store-info'),
    byCategory: CATEGORY_ORDER.map((category) => ({ category, categoryKey: `data.manualCategory.${category}`, count: manuals.filter((m) => m.section === 'handover' && m.category === category).length })).filter((c) => c.count > 0),
    manuals: manuals.filter((m) => m.section === 'handover'),
    recent: manuals.filter((m) => m.section === 'handover').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.manualId.localeCompare(b.manualId)).slice(0, 2),
    todayChecklist: manuals.filter((m) => m.checklist && m.section === 'handover').map((m) => ({ section: m.section ?? 'handover', cautions: m.cautions ?? { raw: '' }, manualId: m.manualId, title: m.title, done: m.steps.filter((s) => s.checkedToday).length, total: m.steps.length })),
    drafts: t.manualDraft.filter((d) => d.status === 'draft').map((d) => ({ draftId: d.draftId, memo: d.memo, title: d.title, category: d.category, steps: d.steps })),
  };
  return ready('manuals', condition, variant, model);
};

/* 매장 인테리어 */
export const MOODS: readonly Mood[] = ['warm-wood', 'bright-white', 'calm-gray'];
export const MATERIALS: readonly Material[] = ['wood', 'gray', 'tile', 'plant'];
export const projectInterior: Projector<'interior'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const plan = t.interiorPlan;
  const model: InteriorModel = {
    mood: plan.mood, moodKey: `data.mood.${plan.mood}`, materials: plan.materials.map((id) => ({ id, nameKey: `data.material.${id}` })), memo: plan.memo,
    previewAssetKey: `interior-${plan.mood}`, moods: MOODS.map((id) => ({ id, nameKey: `data.mood.${id}`, assetKey: `interior-${id}` })),
    materialOptions: MATERIALS.map((id) => ({ id, nameKey: `data.material.${id}` })), photoKeys: t.floorSpace.photoKeys,
  };
  return ready('interior', condition, variant, model);
};

/* 사진으로 자리 배치 */
export const AISLE_MIN_CM = 90;
const ZONES: readonly Zone[] = ['window', 'center', 'bar'];
export function layoutRow(t: DataTables, layoutId: string): LayoutRow | null {
  const layout = t.floorLayout.find((l) => l.layoutId === layoutId);
  if (!layout) return null;
  const spots = t.tableSpot.filter((s) => s.layoutId === layoutId);
  return {
    layoutId, name: layout.name, isCurrent: layout.isCurrent, aisleCm: layout.aisleCm, aisleWarning: layout.aisleCm < AISLE_MIN_CM, tableCount: spots.length, seatCount: sum(spots.map((s) => s.seats)),
    zones: ZONES.map((zone) => ({ zone, nameKey: `data.zone.${zone}`, tables: spots.filter((s) => s.zone === zone).length, seats: sum(spots.filter((s) => s.zone === zone).map((s) => s.seats)) })).filter((z) => z.tables > 0),
  };
}
export const projectFloorPlan: Projector<'floor-plan'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const layouts = t.floorLayout.map((l) => layoutRow(t, l.layoutId)).filter((l): l is LayoutRow => l !== null);
  const current = layouts.find((l) => l.isCurrent) ?? layouts[0];
  const model: FloorPlanModel = {
    current, layouts, tableCount: current.tableCount, seatCount: current.seatCount, zones: current.zones, photoKeys: t.floorSpace.photoKeys, planGenerated: t.floorSpace.planGenerated,
    aisleMinCm: AISLE_MIN_CM, noteKey: 'data.floorPlan.aisleNote', posConnected: t.integration.pos,
  };
  return ready('floor-plan', condition, variant, model);
};

