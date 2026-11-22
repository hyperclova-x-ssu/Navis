/**
 * REAL-PLAN F12 — what the service's briefing projection changes in the briefing model (`projectBriefing` calls `applyRealBriefing`).
 *
 * The figures keep coming from the same snapshot tables the source widgets read, so the panel, the detail, the arrival card and Navis facts stay on one number.
 * What the service adds, and the screens must show honestly: a section whose source is not connected (or could not be read) is withheld instead of showing
 * rows a pair that is not on HTTP yet still holds from the seed, and every source carries its period and state into the "sources" card.
 */
import type { BriefingModel } from '../../models/types';
import { hasData, sourceNamed, type BriefingAcknowledgementDto, type BriefingSource, type BriefingSourceState, type RealBriefingSnapshot } from './dto';

export type SectionId = 'schedule' | 'reservations' | 'pickups' | 'closing' | 'purchasing' | 'stock' | 'tax' | 'tasks';
export interface SectionStatus { readonly state: BriefingSourceState; readonly sources: readonly string[] }

/** The service's sources behind each section of the briefing, in the order the briefing shows them. `tasks` is judged item by item (`itemSources`). */
export const SECTION_SOURCES: Readonly<Record<SectionId, readonly string[]>> = {
  schedule: ['calendar', 'shifts', 'calendarProjections'],
  reservations: ['reservations'],
  pickups: ['pickups'],
  purchasing: ['purchasing'],
  stock: ['stock'],
  tax: ['tax'],
  tasks: ['notices', 'environment', 'cctv', 'manualsGrants'],
  closing: ['finance', 'closing'],
};

/** Which source an alert row depends on (its id prefix names the origin; ids from other origins, like a missing POS order, are not gated). */
export function itemSources(groupId: string, itemId: string): readonly string[] {
  if (groupId === 'purchasing') return SECTION_SOURCES.purchasing;
  if (groupId === 'stock') return SECTION_SOURCES.stock;
  if (groupId === 'tax') return SECTION_SOURCES.tax;
  const prefix = itemId.split(':', 1)[0];
  if (prefix === 'closure') return ['notices'];
  if (prefix === 'environment') return ['environment'];
  if (prefix === 'camera') return ['cctv'];
  if (prefix === 'manual' || prefix === 'grant') return ['manualsGrants'];
  return [];
}

const SEVERITY: Readonly<Record<BriefingSourceState, number>> = { ready: 0, partial: 1, unavailable: 2, 'not-connected': 3 };
const worst = (states: readonly BriefingSourceState[]): BriefingSourceState => states.reduce<BriefingSourceState>((a, b) => SEVERITY[b] > SEVERITY[a] ? b : a, 'ready');
/** A source the service did not send is not connected: nothing is shown as if it were read. */
const stateOf = (read: RealBriefingSnapshot, key: string): BriefingSourceState => sourceNamed(read, key)?.state ?? 'not-connected';
export const isWithheld = (state: BriefingSourceState): boolean => state === 'not-connected' || state === 'unavailable';

export interface BriefingRealView {
  readonly businessDay: string;
  readonly arrivalDay: string | null;
  readonly asOf: string;
  readonly acknowledgement: BriefingAcknowledgementDto | null;
  readonly sources: readonly BriefingSource[];
  readonly sections: Readonly<Record<SectionId, SectionStatus>>;
  /** Sources a section of the briefing depends on that are not connected, could not be read or came partial, in briefing order. */
  readonly notes: readonly { readonly key: string; readonly state: Exclude<BriefingSourceState, 'ready'> }[];
}

export function realBriefingView(read: RealBriefingSnapshot): BriefingRealView {
  const sections = Object.fromEntries((Object.keys(SECTION_SOURCES) as SectionId[]).map(id => [id, {
    state: worst(SECTION_SOURCES[id].map(key => stateOf(read, key))), sources: SECTION_SOURCES[id],
  }])) as Record<SectionId, SectionStatus>;
  const seen = new Set<string>();
  const notes = (Object.keys(SECTION_SOURCES) as SectionId[]).flatMap(id => SECTION_SOURCES[id]).flatMap(key => {
    const state = stateOf(read, key);
    if (state === 'ready' || seen.has(key)) return [];
    seen.add(key);
    return [{ key, state }];
  });
  return { businessDay: read.businessDay, arrivalDay: read.arrivalDay, asOf: read.asOf, acknowledgement: read.acknowledgement, sources: read.sources, sections, notes };
}

/**
 * Fixture builds (no `realBriefing`) return the model untouched. Over HTTP an alert whose source is withheld is dropped and the count follows,
 * so Navis, the panel and the detail agree; the section's honest state is on `model.real`.
 */
export function applyRealBriefing(model: BriefingModel, read: RealBriefingSnapshot | undefined): BriefingModel {
  if (!read) return model;
  const real = realBriefingView(read);
  const groups = model.importantAlerts.groups
    .map(group => ({ ...group, items: group.items.filter(item => !itemSources(group.id, item.id).some(key => isWithheld(stateOf(read, key)))) }))
    .filter(group => group.items.length > 0);
  return { ...model, importantAlerts: { count: groups.reduce((sum, group) => sum + group.items.length, 0), groups }, real };
}

/** The section's state, `ready` when the briefing is not read over HTTP. */
export const sectionState = (model: { readonly real?: BriefingRealView }, id: SectionId): BriefingSourceState => model.real?.sections[id].state ?? 'ready';
export const sectionWithheld = (model: { readonly real?: BriefingRealView }, id: SectionId): boolean => isWithheld(sectionState(model, id));
/** The source that withholds the section (the first one of the worst state), for the honest line shown instead of its rows. */
export function withheldNote(model: { readonly real?: BriefingRealView }, id: SectionId): { readonly key: string; readonly state: BriefingSourceState } | null {
  const real = model.real;
  if (!real || !isWithheld(real.sections[id].state)) return null;
  const state = real.sections[id].state;
  const key = real.sections[id].sources.find(name => (real.sources.find(source => source.key === name)?.state ?? 'not-connected') === state);
  return key ? { key, state } : null;
}
export { hasData };
