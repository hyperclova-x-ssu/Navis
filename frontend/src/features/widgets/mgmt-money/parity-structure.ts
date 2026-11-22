/**
 * PAR-1 (D-384): the structure a widget window shows, without its data. Two renders (HTTP with fake services, fixture with the example data) must give
 * the same sections, tables, row headers, tabs and buttons; only the figures and the rows of a list may differ.
 */
const digits = (text: string) => text.replace(/\s+/g, ' ').replace(/[0-9][0-9,.:/]*/g, '#').trim();
const names = (nodes: Iterable<Element>) => [...nodes].map(node => digits(node.textContent ?? '')).filter(Boolean);
/** Rows of a list or grid carry the owner's data, so their buttons are not structure. */
const inDataRow = (node: Element) => node.closest('[role="grid"], [role="row"], .mm-select-list, .ui-data-grid, .mm-briefing-list, .menu-category-tabs [role="tabpanel"] tbody') !== null;

export interface WindowStructure {
  readonly headings: readonly string[];
  readonly tabs: readonly string[];
  readonly tables: readonly { readonly caption: string; readonly rows: readonly string[] }[];
  readonly columns: readonly string[];
  readonly buttons: readonly string[];
  readonly radios: readonly string[];
}

/** `data`: selectors of the parts that show the owner's own records (a selected item, a "more rows" button); their texts are not structure. */
export function windowStructure(root: ParentNode, data = ''): WindowStructure {
  const isData = (node: Element) => data !== '' && (node.matches(data) || node.closest(data) !== null);
  return {
    headings: names([...root.querySelectorAll('h1, h2, h3, h4')].filter(node => !isData(node))),
    tabs: names(root.querySelectorAll('[role="tab"]')),
    tables: [...root.querySelectorAll('table.mm-table, table.ui-table')].filter(table => !inDataRow(table)).map(table => ({
      caption: digits(table.querySelector('caption')?.textContent ?? table.getAttribute('aria-label') ?? ''),
      rows: names(table.querySelectorAll('tbody th[scope="row"]')),
    })),
    columns: names(root.querySelectorAll('[role="columnheader"], th[scope="col"]')),
    buttons: names([...root.querySelectorAll('button, a.ui-button')].filter(node => !inDataRow(node) && !isData(node))),
    radios: names(root.querySelectorAll('[role="radio"]')),
  };
}

/** The elements of `a` and `b` that only one side has, so a failing parity test names what differs. */
export function structureDifference(a: WindowStructure, b: WindowStructure): Record<string, { readonly onlyHttp: readonly unknown[]; readonly onlyExample: readonly unknown[] }> {
  const out: Record<string, { onlyHttp: unknown[]; onlyExample: unknown[] }> = {};
  for (const key of Object.keys(a) as (keyof WindowStructure)[]) {
    const left = (a[key] as readonly unknown[]).map(value => JSON.stringify(value));
    const right = (b[key] as readonly unknown[]).map(value => JSON.stringify(value));
    const onlyHttp = left.filter(value => !right.includes(value)).map(value => JSON.parse(value) as unknown);
    const onlyExample = right.filter(value => !left.includes(value)).map(value => JSON.parse(value) as unknown);
    if (onlyHttp.length || onlyExample.length) out[key] = { onlyHttp, onlyExample };
  }
  return out;
}
