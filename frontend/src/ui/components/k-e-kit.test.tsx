import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { UiProvider } from '../UiProvider';
import { screenPresets } from '../../layout/presets';
import { DataGrid, type GridColumn, type GridCommit, type GridFocus, type GridSort } from './data-grid';

/** K-E (kit leftovers from the widget fix wave): DS 12.1 DataGrid / Table / StatusChip rules that widgets must not be able to break. */
afterEach(cleanup);

const read = (path: string) => readFileSync(path, 'utf8');
const manage = read('src/ui/mastermanage.css');
const tokens = read('src/ui/tokens.css');
const rule = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('}', start) + 1);
};

type Row = { id: string; name: string; due: string };
const ROWS: Row[] = [
  { id: 'a', name: '알파', due: '2026-11-30' },
  { id: 'b', name: '베타', due: '2026-12-15' },
];
const columns: GridColumn<Row>[] = [
  { id: 'name', header: '이름', kind: 'text', minWidth: 200, value: (r) => r.name, sortable: true },
  { id: 'due', header: '납부 기한', kind: 'text', minWidth: 160, value: (r) => r.due, editable: () => true, editor: 'date' },
];

function Host({ onCommit }: { onCommit?: (edit: GridCommit) => void }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<GridSort>(null);
  const [focus, setFocus] = useState<GridFocus>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const rows = ROWS.filter((r) => r.name.includes(query));
  return <UiProvider screenPreset={screenPresets.A} reducedMotion>
    <DataGrid id="ke" label="표" rows={rows} columns={columns} getRowId={(r) => r.id} getRowLabel={(r) => r.name}
      query={query} onQueryChange={setQuery} searchLabel="찾기" searchPlaceholder="찾기"
      sort={sort} onSortChange={setSort} focus={focus} onFocusChange={setFocus} selectedRowId={selected} onSelectionChange={setSelected}
      expandedRowIds={new Set()} onCommit={(edit) => { onCommit?.(edit); return { ok: true }; }}
      emptyContent="없어요" />
  </UiProvider>;
}

describe('K-E 1: DataGrid toolbar search is 48 (DS 12.1)', () => {
  it('sets the toolbar search control to --target-default, not the 56 primary target', () => {
    const control = rule(manage, '.ui-data-grid__toolbar .ui-search-field__control');
    expect(control).toMatch(/height:var\(--target-default\)/);
    expect(control).toMatch(/min-height:0/);
    // the generic search field keeps its own 56 outside the grid toolbar
    expect(rule(tokens, '.ui-search-field__control')).toMatch(/min-height: var\(--target-primary\)/);
  });
});

describe('K-E 2: filtering the focused row away keeps focus in the search box', () => {
  it('does not move focus to the table when the remembered row disappears while the user types a search', async () => {
    const user = userEvent.setup();
    render(<Host />);
    // remember a row in the grid, then go to the search box and type a term that filters that row out
    await user.click(screen.getByRole('gridcell', { name: /알파, 이름/ }));
    const search = screen.getByRole('searchbox', { name: '찾기' });
    await user.click(search);
    await user.keyboard('베');
    expect(screen.queryByRole('gridcell', { name: /알파/ })).not.toBeInTheDocument();
    expect(search).toHaveFocus();
    await user.keyboard('타');
    expect(search).toHaveFocus();
    expect(search).toHaveValue('베타');
  });
});

describe('K-E 3: the kit Table header rule is not tied to a detail dialog', () => {
  it('applies the 48 (56 at 125%) sticky header wherever a kit Table is used', () => {
    const header = rule(manage, '.ui-table.ui-table thead th');
    expect(header).toMatch(/height:calc\(var\(--table-header-height\) \+ var\(--stroke-hairline\)\)/);
    expect(header).toMatch(/position:sticky;top:0/);
    expect(header).toMatch(/font-size:var\(--type-caption\);line-height:var\(--leading-caption\);font-weight:var\(--weight-bold\)/);
    expect(manage).not.toMatch(/\.ui-overlay-body \.ui-table thead th/);
  });
  it('selected rows keep the DS 12.2 bar and face in any container', () => {
    expect(rule(manage, '.ui-table tbody tr[aria-selected="true"]>*')).toMatch(/background:var\(--selection\)/);
    expect(rule(manage, '.ui-table tbody tr[aria-selected="true"]>:first-child')).toMatch(/box-shadow:inset var\(--space-1\) 0 var\(--selection-foreground\)/);
  });
});

describe('K-E 5: a date cell edits with the kit DateField, not ISO text', () => {
  it('opens the calendar on the cell value, shows the long date, and commits the picked ISO day', async () => {
    const user = userEvent.setup();
    const commits: GridCommit[] = [];
    render(<Host onCommit={(edit) => commits.push(edit)} />);
    await user.click(screen.getByRole('gridcell', { name: /알파, 납부 기한/ }));
    // no ISO text box: the field says the long date and the calendar is already open on that month
    expect(screen.queryByRole('textbox', { name: /납부 기한/ })).not.toBeInTheDocument();
    const field = screen.getByRole('button', { name: /알파, 납부 기한/ });
    // the field shows the same short date as the cell (the row must not grow), never ISO
    expect(field).toHaveTextContent('11/30(월)');
    expect(field).not.toHaveTextContent('2026-11-30');
    const day = await screen.findByRole('button', { name: /11월 28일/ });
    await user.click(day);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ rowId: 'a', columnId: 'due', raw: '2026-11-28' });
    // the edit ended and the cell is back to a plain cell
    expect(screen.queryByRole('button', { name: /알파, 납부 기한/ })).not.toBeInTheDocument();
  });
  it('Esc closes the calendar first, a second Esc leaves the cell without committing', async () => {
    const user = userEvent.setup();
    const commits: GridCommit[] = [];
    render(<Host onCommit={(edit) => commits.push(edit)} />);
    await user.click(screen.getByRole('gridcell', { name: /알파, 납부 기한/ }));
    await screen.findByRole('button', { name: /11월 28일/ });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /11월 28일/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /알파, 납부 기한/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /알파, 납부 기한/ })).not.toBeInTheDocument();
    expect(commits).toHaveLength(0);
  });
});

describe('K-E 4: StatusChip / StatusBadge stay 28 at 125% text (DS 12.1)', () => {
  it('fixes the height at 28 and the line at 28 instead of the scaled 1.5rem caption line', () => {
    const chip = rule(manage, '.ui-status-chip');
    expect(chip).toMatch(/height:28px/);
    expect(chip).toMatch(/line-height:28px/);
    expect(chip).not.toMatch(/line-height:var\(--leading-caption\)/);
    expect(tokens).toMatch(/\n\.ui-status-badge \{ height: 28px; min-height: 28px; line-height: 28px; \}/);
  });
  it('keeps the text-only compact variant on its own 24 line', () => {
    expect(rule(manage, '.ui-status-chip[data-compact]')).toMatch(/height:auto;min-height:var\(--space-6\)/);
  });
});

describe('K-E 14: a panel without a detail still has an accessible name (SCR-37 without 자세히 보기)', () => {
  it('names the article {name}, {row}행 {col}열, 가로 {w}칸 세로 {h}칸, {summary} when it has no hit button', async () => {
    const { FeaturePanel } = await import('./card');
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion>
      <FeaturePanel featureId="marketing-today" label="오늘 할 홍보" groupId="recommended" width={2} height={1} row={1} column={3} summary="화요일 10~12시가 한산해요" interactive={false}>내용</FeaturePanel>
    </UiProvider>);
    const article = document.querySelector('article[data-feature-id="marketing-today"]')!;
    expect(article).toHaveAttribute('aria-label', '오늘 할 홍보, 1행 3열, 가로 2칸 세로 1칸, 화요일 10~12시가 한산해요');
    expect(article.getAttribute('aria-label')).not.toMatch(/자세히 보기/);
    expect(article.querySelector('.ui-panel-hit')).toBeNull();
  });
  it('keeps the hit button name (with 자세히 보기) for an interactive panel and puts no label on its article', async () => {
    const { FeaturePanel } = await import('./card');
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion>
      <FeaturePanel featureId="ledger" label="손익" groupId="finance" width={2} height={1} row={1} column={1} summary="오늘 120만 원" onOpen={() => {}}>내용</FeaturePanel>
    </UiProvider>);
    const article = document.querySelector('article[data-feature-id="ledger"]')!;
    expect(article).not.toHaveAttribute('aria-label');
    expect(screen.getByRole('button', { name: /손익, 1행 1열.*자세히 보기/ })).toBeInTheDocument();
  });
});

describe('K-E 19: InlineEmpty carries its own ⓘ icon (DS 11.5)', () => {
  it('renders one decorative 20px info icon before the title, and keeps the title and description readable', async () => {
    const { InlineEmpty } = await import('./presentation');
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><InlineEmpty title="아직 이력이 없어요" description="근무를 바꾸면 여기에 남아요" action={<button type="button">근무표 열기</button>} /></UiProvider>);
    const box = screen.getByRole('heading', { name: '아직 이력이 없어요' }).closest('.ui-inline-state')!;
    const icons = box.querySelectorAll('svg');
    expect(icons).toHaveLength(1);
    expect(icons[0]).toHaveAttribute('aria-hidden', 'true');
    expect(box.firstElementChild).toContainElement(icons[0] as unknown as HTMLElement);
    expect(rule(tokens, '.ui-inline-state__icon')).toMatch(/width: 20px; height: 20px/);
    expect(screen.getByText('근무를 바꾸면 여기에 남아요')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '근무표 열기' })).toBeInTheDocument();
  });
});

describe('K-E 2 (side panel): a side panel that closes because its row was filtered away leaves focus in the search box', () => {
  it('does not restore focus to the grid while the user is typing in the toolbar', async () => {
    const { DetailSidePanel } = await import('./detail-side-panel');
    function WithPanel() {
      const [query, setQuery] = useState('');
      const [sort, setSort] = useState<GridSort>(null);
      const [focus, setFocus] = useState<GridFocus>(null);
      const [selected, setSelected] = useState<string | null>(null);
      const rows = ROWS.filter((r) => r.name.includes(query));
      const open = selected !== null && rows.some((r) => r.id === selected);
      return <UiProvider screenPreset={screenPresets.A} reducedMotion><div className="ui-overlay-body">
        <DataGrid id="ke2" label="표" rows={rows} columns={columns} getRowId={(r) => r.id} getRowLabel={(r) => r.name}
          query={query} onQueryChange={setQuery} searchLabel="찾기" searchPlaceholder="찾기" sort={sort} onSortChange={setSort}
          focus={focus} onFocusChange={setFocus} selectedRowId={selected} onSelectionChange={setSelected} expandedRowIds={new Set()} emptyContent="없어요" />
        <DetailSidePanel open={open} selectedRowId={selected} title="알파" onClose={() => setSelected(null)} returnFocusKey="a" onRestoreFocus={() => { document.querySelector<HTMLElement>('[data-ke-add]')?.focus(); }}>내용</DetailSidePanel>
        <button type="button" data-ke-add>추가</button>
      </div></UiProvider>;
    }
    const user = userEvent.setup();
    render(<WithPanel />);
    await user.click(screen.getByRole('gridcell', { name: /알파, 이름/ }));
    const search = screen.getByRole('searchbox', { name: '찾기' });
    await user.click(search);
    await user.keyboard('베');
    expect(screen.queryByRole('region', { name: '알파' })).not.toBeInTheDocument();
    expect(search).toHaveFocus();
    await user.keyboard('타');
    expect(search).toHaveValue('베타');
  });
});
