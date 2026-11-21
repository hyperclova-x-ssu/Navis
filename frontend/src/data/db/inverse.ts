/** Three-way inverse: only the command's write set is reverted; concurrent unrelated fields survive. */
const equal = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const rowKey = (row: unknown): string | null => {
  if (!object(row)) return null;
  if (typeof row.reservationId === 'string' && typeof row.changeId !== 'string' && 'partySize' in row) return JSON.stringify([['reservationId', row.reservationId]]);
  const keys = Object.keys(row).filter((k) => /Id$/.test(k) || ['businessDate', 'date', 'stepNo', 'channel', 'hour', 'weekday', 'period', 'route'].includes(k));
  return keys.length ? JSON.stringify(keys.sort().map((k) => [k, row[k]])) : null;
};
export function inverseChange(before: unknown, after: unknown, current: unknown): { ok: true; value: unknown } | { ok: false } {
  if (equal(before, after)) return { ok: true, value: current };
  if (equal(current, after)) return { ok: true, value: before };
  if (object(before) && object(after) && object(current)) {
    const next = { ...current };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const result = inverseChange(before[key], after[key], current[key]);
      if (!result.ok) return result;
      if (result.value === undefined) delete next[key]; else next[key] = result.value;
    }
    return { ok: true, value: next };
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    const map = (rows: unknown[]) => new Map(rows.map((r) => [rowKey(r), r]));
    const b = map(before), a = map(after), c = map(current);
    if (b.has(null) || a.has(null) || c.has(null) || b.size !== before.length || a.size !== after.length || c.size !== current.length) return { ok: false };
    for (const key of new Set([...b.keys(), ...a.keys()])) {
      const result = inverseChange(b.get(key), a.get(key), c.get(key));
      if (!result.ok) return result;
      if (result.value === undefined) c.delete(key); else c.set(key, result.value);
    }
    const order = [...before.map(rowKey), ...current.map(rowKey)];
    return { ok: true, value: [...new Set(order)].filter((key) => c.has(key)).map((key) => c.get(key)) };
  }
  return { ok: false };
}
export { equal as equalData };
