/**
 * T-073 zone editor state (DATA_MODEL 12.3): draft zones, edit ops, numbering, undo (50 steps).
 * Zone cell arrays are never mutated; an op that changes nothing returns the same state (no undo step).
 */
import { CELLS, MAX_ZONES, MIN_ZONE_CELLS, UNDO_LIMIT, type DraftZone, type DraftZoneSet, type EditOp, type Zone, type ZoneId, type ZoneSet } from './types';
import { cellCount, decodeRle, encodeRle, eraseCells, lassoCells, readingOrder, subtractCells, zoneCenter } from './mask';

export interface EditorState {
  readonly draft: DraftZoneSet;
  readonly undo: readonly (readonly DraftZone[])[];
  readonly selectedId: ZoneId | null;
}
export type EditorAction =
  | { readonly type: 'op'; readonly op: EditOp }
  | { readonly type: 'undo' }
  | { readonly type: 'select'; readonly id: ZoneId | null }
  | { readonly type: 'suggestions'; readonly zones: readonly Zone[] };
export interface EditorContext { readonly aspect: number; readonly newId: () => ZoneId }

export function newZoneId(): ZoneId {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'z' + Array.from(bytes, b => alphabet[b % 36]).join('');
}

export function draftFromSaved(set: ZoneSet): DraftZoneSet {
  const zones = set.zones.map((z): DraftZone => ({ id: z.id, number: z.number, source: z.source, adopted: true, cells: decodeRle(z.mask) }));
  return { baseRevision: set.revision, frameAspect: set.frameAspect, zones: renumber(zones) };
}

export function suggestionsToDraft(zones: readonly Zone[]): DraftZone[] {
  return zones
    .map((z): DraftZone => ({ id: z.id, number: 0, source: 'suggested', adopted: false, cells: decodeRle(z.mask) }))
    .filter(z => cellCount(z.cells) >= MIN_ZONE_CELLS);
}

export const initialEditorState = (draft: DraftZoneSet): EditorState => ({ draft, undo: [], selectedId: null });

function unionAdopted(zones: readonly DraftZone[], except?: ZoneId): Uint8Array {
  const u = new Uint8Array(CELLS);
  for (const z of zones) if (z.adopted && z.id !== except) for (let i = 0; i < CELLS; i++) if (z.cells[i]) u[i] = 1;
  return u;
}

/** Numbers adopted zones 1..n in reading order; suggestions get 0. Keeps objects whose number did not change. */
export function renumber(zones: readonly DraftZone[]): DraftZone[] {
  const order = readingOrder(zones.filter(z => z.adopted).map(z => ({ id: z.id, ...zoneCenter(z.cells) })));
  const num = new Map(order.map((id, i) => [id, i + 1]));
  return zones.map(z => { const n = num.get(z.id) ?? 0; return n === z.number ? z : { ...z, number: n }; });
}

/** Adopts zone `id` against the other adopted zones; null when fewer than 12 cells would remain. */
function adoptAgainst(zones: readonly DraftZone[], z: DraftZone, cells = z.cells): DraftZone | null {
  const rest = subtractCells(cells, unionAdopted(zones, z.id));
  return cellCount(rest) < MIN_ZONE_CELLS ? null : { ...z, adopted: true, cells: rest };
}

/** Applies one op; returns the same array when nothing changes. */
export function applyOp(zones: readonly DraftZone[], op: EditOp, ctx: EditorContext): readonly DraftZone[] {
  switch (op.kind) {
    case 'adopt': {
      const z = zones.find(x => x.id === op.id);
      if (!z || z.adopted) return zones;
      if (zones.filter(x => x.adopted).length >= MAX_ZONES) return zones;
      const next = adoptAgainst(zones, z);
      return next ? zones.map(x => (x.id === z.id ? next : x)) : zones.filter(x => x.id !== z.id);
    }
    case 'remove':
      return zones.some(x => x.id === op.id) ? zones.filter(x => x.id !== op.id) : zones;
    case 'draw': {
      if (op.path.length < 3 || zones.filter(x => x.adopted).length >= MAX_ZONES) return zones;
      const cells = subtractCells(lassoCells(op.path), unionAdopted(zones));
      if (cellCount(cells) < MIN_ZONE_CELLS) return zones;
      return [...zones, { id: ctx.newId(), number: 0, source: 'drawn', adopted: true, cells }];
    }
    case 'erase': {
      let changed = false;
      let out: DraftZone[] = [...zones];
      for (const z of zones) {
        const cells = eraseCells(z.cells, op.path, op.radius, ctx.aspect);
        if (cells === z.cells) continue;
        changed = true;
        // SCREENS 9.6 ④: a suggestion the eraser touches becomes adopted with only the rubbed part gone.
        const next = z.adopted ? (cellCount(cells) < MIN_ZONE_CELLS ? null : { ...z, cells }) : adoptAgainst(out, z, cells);
        out = next ? out.map(x => (x.id === z.id ? next : x)) : out.filter(x => x.id !== z.id);
      }
      return changed ? out : zones;
    }
  }
}

export function editorReducer(state: EditorState, action: EditorAction, ctx: EditorContext): EditorState {
  switch (action.type) {
    case 'select':
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
    case 'suggestions': {
      const known = new Set(state.draft.zones.map(z => z.id));
      const add = suggestionsToDraft(action.zones).filter(z => !known.has(z.id));
      return add.length ? { ...state, draft: { ...state.draft, zones: [...state.draft.zones, ...add] } } : state;
    }
    case 'undo': {
      const prev = state.undo.at(-1);
      if (!prev) return state;
      const selectedId = state.selectedId && prev.some(z => z.id === state.selectedId) ? state.selectedId : null;
      return { draft: { ...state.draft, zones: prev }, undo: state.undo.slice(0, -1), selectedId };
    }
    case 'op': {
      const zones = applyOp(state.draft.zones, action.op, ctx);
      if (zones === state.draft.zones) return state;
      const undo = [...state.undo, state.draft.zones].slice(-UNDO_LIMIT);
      const numbered = renumber(zones);
      const selectedId = state.selectedId && numbered.some(z => z.id === state.selectedId) ? state.selectedId : null;
      return { draft: { ...state.draft, zones: numbered }, undo, selectedId };
    }
  }
}

/** API-18 PUT body: adopted zones only. */
export function putBody(draft: DraftZoneSet, frameAspect: number | null): { baseRevision: number; frameAspect: number | null; zones: Zone[] } {
  return {
    baseRevision: draft.baseRevision,
    frameAspect,
    zones: draft.zones.filter(z => z.adopted).map(z => ({ id: z.id, number: z.number, source: z.source, mask: encodeRle(z.cells) })),
  };
}

/** Draft kept in page memory when the editor closes without saving (SCREENS 9.6 ⑧); gone on reload. */
let kept: EditorState | null = null;
export const keepDraft = (s: EditorState | null): void => { kept = s; };
export const takeKeptDraft = (): EditorState | null => kept;
