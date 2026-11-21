import { describe, expect, it } from 'vitest';
import { CELLS, GRID, UNDO_LIMIT, type DraftZone, type Zone, type ZoneSet } from './types';
import { cellCount, encodeRle } from './mask';
import { draftFromSaved, editorReducer, initialEditorState, putBody, suggestionsToDraft, type EditorState } from './editor-state';

const rect = (c0: number, r0: number, c1: number, r1: number) => {
  const m = new Uint8Array(CELLS);
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) m[r * GRID.cols + c] = 1;
  return m;
};
const zone = (id: string, cells: Uint8Array, source: Zone['source'] = 'suggested'): Zone => ({ id, number: 0, source, mask: encodeRle(cells) });
const saved = (zones: Zone[], revision = 3): ZoneSet => ({ revision, savedAt: '2026-11-10T00:00:00Z', frameAspect: 16 / 9, zones });
let n = 0;
const ctx = { aspect: 16 / 9, newId: () => `zdraw${String(n++).padStart(4, '0')}` };
const reduce = (s: EditorState, ...actions: Parameters<typeof editorReducer>[1][]) => actions.reduce((acc, a) => editorReducer(acc, a, ctx), s);
const find = (s: EditorState, id: string) => s.draft.zones.find(z => z.id === id) as DraftZone | undefined;
// Rectangle path in 0..1 around cells [c0,c1) x [r0,r1).
const box = (c0: number, r0: number, c1: number, r1: number) => [[c0 / 160, r0 / 90], [c1 / 160, r0 / 90], [c1 / 160, r1 / 90], [c0 / 160, r1 / 90]] as [number, number][];

const withSuggestions = () => {
  const empty = initialEditorState(draftFromSaved(saved([], 0)));
  return reduce(empty, { type: 'suggestions', zones: [zone('zsugaaaa1', rect(10, 10, 30, 20)), zone('zsugbbbb2', rect(100, 10, 120, 20)), zone('ztiny0003', rect(0, 80, 3, 83))] });
};

describe('opening (DATA_MODEL 12.3)', () => {
  it('opens saved zones adopted, with their numbers, and no undo', () => {
    const s = initialEditorState(draftFromSaved(saved([zone('zaaaaaaa1', rect(10, 10, 20, 20), 'drawn')])));
    expect(s.draft.baseRevision).toBe(3);
    expect(s.draft.zones[0]).toMatchObject({ id: 'zaaaaaaa1', adopted: true, number: 1 });
    expect(s.undo).toHaveLength(0);
  });
  it('adds suggestions not adopted, number 0, drops masks under 12 cells, without an undo step', () => {
    const s = withSuggestions();
    expect(s.draft.zones.map(z => [z.id, z.adopted, z.number])).toEqual([['zsugaaaa1', false, 0], ['zsugbbbb2', false, 0]]);
    expect(s.undo).toHaveLength(0);
    expect(suggestionsToDraft([zone('zx', rect(0, 0, 3, 3))])).toHaveLength(0);
  });
});

describe('adopt and remove', () => {
  it('adopts a suggestion: solid, numbered in reading order', () => {
    let s = reduce(withSuggestions(), { type: 'op', op: { kind: 'adopt', id: 'zsugbbbb2' } });
    expect(find(s, 'zsugbbbb2')).toMatchObject({ adopted: true, number: 1 });
    s = reduce(s, { type: 'op', op: { kind: 'adopt', id: 'zsugaaaa1' } });
    expect(find(s, 'zsugaaaa1')?.number).toBe(1); // left of b on the same row
    expect(find(s, 'zsugbbbb2')?.number).toBe(2);
    expect(s.undo).toHaveLength(2);
  });
  it('removes adopted overlap when adopting, and drops the suggestion if under 12 cells remain', () => {
    let s = initialEditorState(draftFromSaved(saved([zone('zaaaaaaa1', rect(10, 10, 30, 20), 'drawn')])));
    s = reduce(s, { type: 'suggestions', zones: [zone('zover0001', rect(25, 10, 40, 20)), zone('zover0002', rect(28, 10, 32, 14))] });
    s = reduce(s, { type: 'op', op: { kind: 'adopt', id: 'zover0001' } });
    expect(cellCount(find(s, 'zover0001')!.cells)).toBe(10 * 10);
    s = reduce(s, { type: 'op', op: { kind: 'adopt', id: 'zover0002' } });
    expect(find(s, 'zover0002')).toBeUndefined();
  });
  it('removes suggested and adopted zones alike and renumbers', () => {
    let s = reduce(withSuggestions(), { type: 'op', op: { kind: 'adopt', id: 'zsugaaaa1' } }, { type: 'op', op: { kind: 'adopt', id: 'zsugbbbb2' } });
    s = reduce(s, { type: 'op', op: { kind: 'remove', id: 'zsugaaaa1' } });
    expect(find(s, 'zsugaaaa1')).toBeUndefined();
    expect(find(s, 'zsugbbbb2')?.number).toBe(1);
    const t = reduce(withSuggestions(), { type: 'op', op: { kind: 'remove', id: 'zsugbbbb2' } });
    expect(t.draft.zones.map(z => z.id)).toEqual(['zsugaaaa1']);
  });
});

describe('draw (lasso)', () => {
  it('makes a drawn, adopted zone from the closed path', () => {
    const s = reduce(withSuggestions(), { type: 'op', op: { kind: 'draw', path: box(50, 50, 70, 60) } });
    const drawn = s.draft.zones.find(z => z.source === 'drawn')!;
    expect(drawn).toMatchObject({ adopted: true, number: 1 });
    expect(drawn.id).toMatch(/^z/);
    expect(cellCount(drawn.cells)).toBe(200);
    expect(s.undo).toHaveLength(1);
  });
  it('does not take cells of other adopted zones', () => {
    let s = initialEditorState(draftFromSaved(saved([zone('zaaaaaaa1', rect(10, 10, 30, 20), 'drawn')])));
    s = reduce(s, { type: 'op', op: { kind: 'draw', path: box(20, 10, 40, 20) } });
    expect(cellCount(s.draft.zones.find(z => z.id !== 'zaaaaaaa1')!.cells)).toBe(100);
  });
  it('ignores a drawing under 12 cells: no zone and no undo step', () => {
    const before = withSuggestions();
    const s = reduce(before, { type: 'op', op: { kind: 'draw', path: box(50, 50, 53, 53) } });
    expect(s).toBe(before);
  });
});

describe('eraser (AC-1337, AC-1339)', () => {
  it('clears only the rubbed cells of an adopted zone; one stroke = one undo step', () => {
    let s = initialEditorState(draftFromSaved(saved([zone('zaaaaaaa1', rect(0, 0, 160, 30), 'drawn')])));
    s = reduce(s, { type: 'op', op: { kind: 'erase', path: [[0.1, 0.1], [0.5, 0.1]], radius: 0.02 } });
    const left = cellCount(find(s, 'zaaaaaaa1')!.cells);
    expect(left).toBeLessThan(160 * 30);
    expect(left).toBeGreaterThan(160 * 20);
    expect(s.undo).toHaveLength(1);
  });
  it('removes a zone erased to nothing (or under 12 cells)', () => {
    let s = initialEditorState(draftFromSaved(saved([zone('zaaaaaaa1', rect(10, 10, 14, 14), 'drawn')])));
    s = reduce(s, { type: 'op', op: { kind: 'erase', path: [[12 / 160, 12 / 90]], radius: 0.05 } });
    expect(s.draft.zones).toHaveLength(0);
  });
  it('erases suggested zones too; the touched suggestion becomes adopted with the rest kept', () => {
    let s = reduce(withSuggestions(), { type: 'op', op: { kind: 'erase', path: [[10 / 160, 15 / 90], [14 / 160, 15 / 90]], radius: 0.02 } });
    const z = find(s, 'zsugaaaa1')!;
    expect(z.adopted).toBe(true);
    expect(z.number).toBe(1);
    expect(cellCount(z.cells)).toBeLessThan(200);
    expect(find(s, 'zsugbbbb2')?.adopted).toBe(false);
    // Long-press removal, undo brings it back, and the same place can be drawn again.
    s = reduce(s, { type: 'op', op: { kind: 'remove', id: 'zsugaaaa1' } });
    expect(find(s, 'zsugaaaa1')).toBeUndefined();
    s = reduce(s, { type: 'undo' });
    expect(find(s, 'zsugaaaa1')?.adopted).toBe(true);
    s = reduce(s, { type: 'op', op: { kind: 'remove', id: 'zsugaaaa1' } }, { type: 'op', op: { kind: 'draw', path: box(10, 10, 30, 20) } });
    expect(s.draft.zones.filter(x => x.adopted)).toHaveLength(1);
    expect(cellCount(s.draft.zones.find(x => x.source === 'drawn')!.cells)).toBe(200);
  });
  it('is a no-op (no undo step) when the stroke touches no zone', () => {
    const before = withSuggestions();
    expect(reduce(before, { type: 'op', op: { kind: 'erase', path: [[0.9, 0.9]], radius: 0.02 } })).toBe(before);
  });
});

describe('undo (AC-1338)', () => {
  it('undoes the last action one at a time and keeps at most 50 steps', () => {
    let s = withSuggestions();
    s = reduce(s, { type: 'op', op: { kind: 'adopt', id: 'zsugaaaa1' } }, { type: 'op', op: { kind: 'draw', path: box(50, 50, 70, 60) } });
    expect(s.draft.zones.filter(z => z.adopted)).toHaveLength(2);
    s = reduce(s, { type: 'undo' });
    expect(s.draft.zones.filter(z => z.adopted).map(z => z.id)).toEqual(['zsugaaaa1']);
    s = reduce(s, { type: 'undo' });
    expect(s.draft.zones.every(z => !z.adopted)).toBe(true);
    expect(reduce(s, { type: 'undo' })).toBe(s);
    for (let i = 0; i < 30; i++) {
      s = reduce(s, { type: 'op', op: { kind: 'draw', path: box(0, 50, 10, 60) } });
      const drawn = s.draft.zones.find(z => z.source === 'drawn')!;
      s = reduce(s, { type: 'op', op: { kind: 'remove', id: drawn.id } });
    }
    expect(s.undo.length).toBe(UNDO_LIMIT);
  });
  it('clears the selection when undo removes the selected zone', () => {
    let s = reduce(withSuggestions(), { type: 'op', op: { kind: 'draw', path: box(50, 50, 70, 60) } });
    const id = s.draft.zones.find(z => z.source === 'drawn')!.id;
    s = reduce(s, { type: 'select', id });
    expect(s.selectedId).toBe(id);
    s = reduce(s, { type: 'undo' });
    expect(s.selectedId).toBeNull();
  });
});

describe('PUT body (API-18)', () => {
  it('sends adopted zones only, numbered, with baseRevision and frame aspect', () => {
    const s = reduce(withSuggestions(), { type: 'op', op: { kind: 'adopt', id: 'zsugbbbb2' } });
    const body = putBody(s.draft, 1.778);
    expect(body.baseRevision).toBe(0);
    expect(body.frameAspect).toBe(1.778);
    expect(body.zones).toHaveLength(1);
    expect(body.zones[0]).toMatchObject({ id: 'zsugbbbb2', number: 1, source: 'suggested' });
    expect(body.zones[0].mask.runs.reduce((a, b) => a + b, 0)).toBe(CELLS);
  });
});
