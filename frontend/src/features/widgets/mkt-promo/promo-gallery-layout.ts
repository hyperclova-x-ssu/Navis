export const POSTER_HEIGHT: Readonly<Record<string, number>> = { '9:16': 520, '3:5': 520, '4:5': 390, '1:1': 312 };

/** PROMO_TEMPLATES 1: card i goes into the lowest column (leftmost on ties). */
export function masonryColumns<T>(items: readonly T[], height: (item: T) => number, columns = 4): T[][] {
  const out: T[][] = Array.from({ length: columns }, () => []);
  const heights = new Array<number>(columns).fill(0);
  for (const item of items) {
    let target = 0;
    for (let c = 1; c < columns; c += 1) if (heights[c] < heights[target]) target = c;
    out[target].push(item);
    heights[target] += height(item) + 16;
  }
  return out;
}
