import type {Box} from './types';

type Occupancy = 'occupied' | 'checking' | 'empty';

interface TableObservation {
  readonly id: string;
  readonly occupancy: Occupancy;
  readonly cups: readonly Box[];
}

export interface DrinkWaitFrame {
  readonly t: number;
  readonly tables: readonly TableObservation[];
}

export type TableDrinkWait =
  | {readonly state: 'waiting'; readonly seconds: number}
  | {readonly state: 'received'; readonly seconds: number | null}
  | {readonly state: 'inactive' | 'start-unknown' | 'checking'; readonly seconds: null};

interface CupTrack {
  readonly box: Box;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly confirmed: boolean;
}

interface Session {
  readonly startedAt: number | null;
  readonly openedAt: number;
  readonly firstCupAt: number | null;
  readonly emptySince: number | null;
}

interface TableProgress {
  readonly display: TableDrinkWait;
  readonly lastOccupancy: Occupancy;
  readonly cups: readonly CupTrack[];
  readonly session: Session | null;
}

export interface DrinkWaitProjection {
  readonly t: number;
  readonly tables: ReadonlyMap<string, TableProgress>;
}

const END_AFTER = 3;
const OBSERVATION_GAP = 2;
const elapsed = (now: number, since: number) => (Math.round(now * 1000) - Math.round(since * 1000)) / 1000;

/** The cup foot is the anchor used by the CNN crop and clearing passes. */
export function detectDrinkWaitFrame(
  t: number,
  zones: readonly {readonly id: string; readonly contains: (x: number, y: number) => boolean}[],
  occupiedIds: readonly string[],
  personZoneIds: ReadonlySet<string>,
  cups: readonly Box[],
): DrinkWaitFrame {
  const occupied = new Set(occupiedIds);
  const cupsByZone = new Map<string, Box[]>();
  for (const cup of cups) {
    if (!Array.isArray(cup) || cup.length !== 4 || !cup.every(v => Number.isFinite(v) && v >= 0 && v <= 1) || cup[0] >= cup[2] || cup[1] >= cup[3]) continue;
    const at = zones.filter(zone => zone.contains((cup[0] + cup[2]) / 2, cup[3]));
    if (at.length !== 1) continue;
    const id = at[0].id;
    const assigned = cupsByZone.get(id);
    if (assigned) assigned.push(cup);
    else cupsByZone.set(id, [cup]);
  }
  return {t, tables: zones.map(({id}) => ({
    id,
    occupancy: occupied.has(id) ? (personZoneIds.has(id) ? 'occupied' : 'checking') : 'empty',
    cups: cupsByZone.get(id) ?? [],
  }))};
}

function matchDistance(a: Box, b: Box): number {
  const dx = (a[0] + a[2] - b[0] - b[2]) / (2 * Math.max(a[2] - a[0], b[2] - b[0]));
  const dy = (a[3] - b[3]) / Math.max(a[3] - a[1], b[3] - b[1]);
  return Math.hypot(dx, dy);
}

function trackCups(observation: TableObservation, now: number, prev: TableProgress | undefined, previousTime: number | undefined) {
  const remaining = (prev?.cups ?? []).filter(cup => elapsed(now, cup.lastSeen) < END_AFTER);
  const visible = observation.cups.map(box => {
    let nearest = -1;
    let bestDistance = 0.5;
    for (let i = 0; i < remaining.length; i++) {
      const distance = matchDistance(box, remaining[i].box);
      if (distance <= bestDistance) { nearest = i; bestDistance = distance; }
    }
    if (nearest < 0) return {box, firstSeen: now, lastSeen: now, confirmed: false};
    const [matched] = remaining.splice(nearest, 1);
    const consecutive = matched.lastSeen === previousTime && prev?.lastOccupancy !== 'checking';
    const residual = !!prev?.session && matched.firstSeen < prev.session.openedAt;
    const keep = matched.confirmed || consecutive || residual || observation.occupancy === 'checking';
    return {box, firstSeen: keep ? matched.firstSeen : now, lastSeen: now, confirmed: matched.confirmed || consecutive};
  });
  // Missing positions remain available for matching residual cups across short occlusions.
  return {visible, tracks: [...visible, ...remaining]};
}

function advanceTable(observation: TableObservation, t: number, prev: TableProgress | undefined, previousTime: number | undefined): TableProgress {
  const {visible, tracks} = trackCups(observation, t, prev, previousTime);
  const {occupancy} = observation;
  let session = prev?.session ?? null;
  let display: TableDrinkWait = {state: 'inactive', seconds: null};

  if (occupancy === 'occupied') {
    session ??= {startedAt: prev?.lastOccupancy === 'empty' ? t : null, openedAt: t, firstCupAt: null, emptySince: null};
    const {openedAt, startedAt} = session;
    const firstCupAt = session.firstCupAt ?? visible.find(cup => cup.confirmed && cup.firstSeen >= openedAt)?.firstSeen ?? null;
    session = {...session, firstCupAt, emptySince: null};
    if (firstCupAt !== null) {
      display = {state: 'received', seconds: startedAt === null || firstCupAt === openedAt ? null : elapsed(firstCupAt, startedAt)};
    } else {
      display = startedAt === null ? {state: 'start-unknown', seconds: null} : {state: 'waiting', seconds: elapsed(t, startedAt)};
    }
  } else if (session) {
    const emptySince = occupancy === 'empty' ? (session.emptySince ?? t) : null;
    if (emptySince !== null && elapsed(t, emptySince) >= END_AFTER) session = null;
    else {
      session = {...session, emptySince};
      display = {state: 'checking', seconds: null};
    }
  }

  return {display, lastOccupancy: occupancy, cups: tracks, session};
}

/** Projects one timestamped observation. The previous projection can be kept by a live stream or folded over a recording. */
export function selectTableDrinkWait(frame: DrinkWaitFrame, previous?: DrinkWaitProjection): DrinkWaitProjection {
  if (previous && frame.t <= previous.t) return previous;
  const continuous = previous && elapsed(frame.t, previous.t) < OBSERVATION_GAP ? previous : undefined;
  return {
    t: frame.t,
    tables: new Map(frame.tables.map(observation => [observation.id, advanceTable(observation, frame.t, continuous?.tables.get(observation.id), continuous?.t)])),
  };
}
