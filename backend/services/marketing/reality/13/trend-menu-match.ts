export interface TrendMenuItem { readonly name: string; readonly category?: string; readonly price?: number }

const categoryWords: Readonly<Record<string, readonly string[]>> = {
  coffee: ['커피', 'coffee'],
  tea: ['차', '티', 'tea'],
  beverage: ['음료', 'beverage'],
  drink: ['음료', 'beverage'],
  dessert: ['디저트', 'dessert'],
};
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
type Match = { name: string; length: number; score: number; price: number };
const compare = (left: Match, right: Match) => right.score - left.score || left.length - right.length
  || left.price - right.price || left.name.localeCompare(right.name, 'ko');

/** Prefer an exact name, then a contiguous name match, then a category-qualified name. */
export function matchTrendMenu(keyword: string, catalog: readonly TrendMenuItem[]): string | null {
  const query = normalize(keyword);
  if (!query) return null;
  const tokens = keyword.normalize('NFKC').toLowerCase().trim().split(/\s+/u);
  let best: Match | undefined;
  for (const { name, category, price } of catalog) {
    const compact = normalize(name);
    const words = category && Object.hasOwn(categoryWords, category) ? categoryWords[category] : [];
    const categoryMatch = words.some(word => tokens.includes(word) && tokens.every(token => token === word || compact.includes(token))
      || tokens.length === 1 && query.endsWith(word) && query.length > word.length && compact.includes(query.slice(0, -word.length)));
    const score = compact === query ? 3 : compact.includes(query) ? 2 : categoryMatch ? 1 : 0;
    if (!score) continue;
    const match = { name, length: compact.length, score, price: price ?? Number.MAX_SAFE_INTEGER };
    if (!best || compare(match, best) < 0) best = match;
  }
  return best?.name ?? null;
}
