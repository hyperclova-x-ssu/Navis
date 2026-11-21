import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider } from '../UiProvider';
import { screenPresets } from '../../layout/presets';
import { DataGrid, type GridColumn, type GridSort } from './data-grid';
import { DetailSidePanel } from './detail-side-panel';

/** K-A (KIT-DATAGRID-SIDEPANEL): DS 12.1 DataGrid and 12.2 SidePanel rules that widgets must not be able to break. */
afterEach(cleanup);

const css = readFileSync('src/ui/mastermanage.css', 'utf8');
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('}', start) + 1);
};

type Row = { id: string; name: string; qty: number };
const columns: GridColumn<Row>[] = [
  { id: 'name', header: '품목 이름', kind: 'text', minWidth: 200, value: (r) => r.name, sortable: true },
  { id: 'due', header: '납부 기한', kind: 'text', minWidth: 160, value: () => '', sortable: true },
  { id: 'qty', header: '수량', kind: 'number', minWidth: 120, value: (r) => r.qty, sortable: true },
];

function Host({ rows = [] as Row[], noResults, initialQuery = '', onQuery }: { rows?: Row[]; noResults?: string; initialQuery?: string; onQuery?: (q: string) => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState<GridSort>({ columnId: 'due', direction: 'asc' });
  return <UiProvider screenPreset={screenPresets.A} reducedMotion>
    <DataGrid id="kit" label="품목" rows={rows} columns={columns} getRowId={(r) => r.id} getRowLabel={(r) => r.name}
      query={query} onQueryChange={(q) => { onQuery?.(q); setQuery(q); }} searchLabel="품목 찾기" searchPlaceholder="품목 찾기"
      sort={sort} onSortChange={setSort} focus={null} onFocusChange={() => {}} selectedRowId={null} expandedRowIds={new Set()}
      addAction={{ id: 'add', label: '품목 추가하기', onPress: () => {} }}
      emptyContent="아직 등록한 품목이 없어요" noResultsContent={noResults} />
  </UiProvider>;
}

describe('K-A A10: zero-result search block', () => {
  it('keeps the [검색어 지우기] button when the widget supplies its own no-results sentence', async () => {
    const onQuery = vi.fn();
    render(<Host initialQuery="없는 품목" noResults="찾는 항목이 없어요" onQuery={onQuery} />);
    const cell = document.querySelector('.ui-data-grid__empty') as HTMLElement;
    expect(within(cell).getByText('찾는 항목이 없어요')).toBeInTheDocument();
    const clear = within(cell).getByRole('button', { name: '검색어 지우기' });
    await userEvent.setup().click(clear);
    expect(onQuery).toHaveBeenLastCalledWith('');
    // focus returns to the search box instead of vanishing with the removed button
    expect(screen.getByRole('searchbox', { name: '품목 찾기' }) ?? screen.getByRole('textbox', { name: '품목 찾기' })).toHaveFocus();
  });
  it('shows the sentence and the button for the kit default sentence too', () => {
    render(<Host initialQuery="없는 품목" />);
    const cell = document.querySelector('.ui-data-grid__empty') as HTMLElement;
    expect(within(cell).getByText('찾는 항목이 없어요')).toBeInTheDocument();
    expect(within(cell).getByRole('button', { name: '검색어 지우기' })).toBeInTheDocument();
  });
  it('shows the empty-state content, not the clear button, when nothing was searched', () => {
    render(<Host noResults="찾는 항목이 없어요" />);
    const cell = document.querySelector('.ui-data-grid__empty') as HTMLElement;
    expect(within(cell).getByText('아직 등록한 품목이 없어요')).toBeInTheDocument();
    expect(within(cell).queryByRole('button', { name: '검색어 지우기' })).not.toBeInTheDocument();
  });
});

describe('K-A A4: header and sort arrow', () => {
  it('keeps the sort arrow glued to the last word of a label that wraps at 125% text', () => {
    render(<Host rows={[{ id: 'a', name: '우유', qty: 1 }]} />);
    const button = screen.getByRole('button', { name: '납부 기한' });
    const tail = button.querySelector('.ui-data-grid__sort-tail') as HTMLElement;
    expect(tail).toHaveTextContent('기한');
    expect(tail.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    // the arrow exists only on the sorted column
    expect(screen.getByRole('button', { name: '수량' }).querySelector('svg')).toBeNull();
    expect(rule('.ui-data-grid__sort-tail')).toMatch(/white-space:nowrap/);
  });
  it('gives the plain kit Table (dialog, panel or side panel) the same 48 (56 at 125%) sticky header', () => {
    const header = rule('.ui-table.ui-table thead th');
    expect(header).toMatch(/height:calc\(var\(--table-header-height\) \+ var\(--stroke-hairline\)\)/);
    expect(header).toMatch(/position:sticky;top:0/);
    expect(header).toMatch(/font-size:var\(--type-caption\);line-height:var\(--leading-caption\);font-weight:var\(--weight-bold\)/);
    expect(header).toMatch(/padding-block:0/);
  });
  it('keeps header height 48 (56 at 125%), sticky at the top, growing only with text lines', () => {
    expect(css).toMatch(/--table-header-height:48px/);
    expect(css).toMatch(/\[data-text-scale="125"\]\s*\{[^}]*--table-header-height:56px/);
    expect(rule('.ui-data-grid__table>thead')).toMatch(/position:sticky;top:0/);
    expect(rule('.ui-data-grid__table th')).toMatch(/min-height:var\(--table-header-height\)/);
    expect(rule('.ui-data-grid__table th')).not.toMatch(/(^|[;{])height:/);
  });
});

describe('K-A A6: toolbar add button', () => {
  it('is the last item of the tool row, pushed to the right end', () => {
    render(<Host rows={[{ id: 'a', name: '우유', qty: 1 }]} />);
    const toolbar = document.querySelector('.ui-data-grid__toolbar') as HTMLElement;
    const add = within(toolbar).getByRole('button', { name: '품목 추가하기' });
    expect(toolbar.lastElementChild).toBe(add);
    expect(add).toHaveClass('ui-button--secondary');
    expect(add).toHaveAttribute('data-grid-add');
    expect(rule('.ui-data-grid__toolbar>.ui-button:last-child')).toMatch(/margin-left:auto/);
  });
  it('is 48 high, not 52, and grows only with wrapped text lines', () => {
    expect(rule('.ui-data-grid__toolbar>.ui-button')).toMatch(/min-height:var\(--target-default\)/);
    // K-D: the vertical padding that lets one line at 125% text (32.5px + 2px border) fit inside 48 is now the shared `.ui-press-surface` rule (tokens.css), not a toolbar override
    expect(readFileSync('src/ui/tokens.css', 'utf8')).toMatch(/^\.ui-press-surface \{[^}]*padding: var\(--space-1\) var\(--space-4\)/m);
    expect(css).not.toMatch(/\.ui-data-grid__toolbar>\.ui-button>\.ui-press-surface\s*\{[^}]*padding/);
  });
});

describe('K-A B1: SidePanel metrics and slot order', () => {
  const panel = (extra = {}) => render(<UiProvider screenPreset={screenPresets.A} reducedMotion>
    <div className="ui-overlay-body">
      <DetailSidePanel open selectedRowId="a" title="우유" onClose={() => {}} returnFocusKey="a" onRestoreFocus={() => {}} {...extra}>
        <section><h4>기본 정보</h4><p>내용</p></section>
        <section><h4>변경 이력</h4><p>기록</p></section>
      </DetailSidePanel>
    </div>
  </UiProvider>);

  it('renders the danger slot as the last item of the body, after every section', () => {
    panel({ danger: <button type="button">우유 지우기</button> });
    const body = document.querySelector('.ui-detail-side-panel__body') as HTMLElement;
    const last = body.lastElementChild as HTMLElement;
    expect(last).toHaveClass('ui-detail-side-panel__danger');
    expect(last).toHaveAttribute('data-panel-slot', 'danger');
    expect(within(last).getByRole('button', { name: '우유 지우기' })).toBeInTheDocument();
    expect(body.querySelectorAll('.ui-detail-side-panel__danger')).toHaveLength(1);
    expect(screen.getByText('변경 이력').compareDocumentPosition(screen.getByRole('button', { name: '우유 지우기' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('has no danger slot when the widget gives none', () => {
    panel();
    expect(document.querySelector('.ui-detail-side-panel__danger')).toBeNull();
  });
  it('limits the panel to the height of the dialog body so it never pushes the table or scrolls the window body', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return (this as HTMLElement).classList.contains('ui-overlay-body') ? 718 : 0; } });
    try {
      panel();
      const aside = screen.getByRole('region', { name: '우유' });
      expect(aside.style.maxHeight).toBe('718px');
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  });
  it('shrinks an in-flow panel by the space above it so the window body cannot scroll', () => {
    const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!;
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return (this as HTMLElement).classList.contains('ui-overlay-body') ? 790 : 0; } });
    Element.prototype.getBoundingClientRect = function () {
      const top = (this as HTMLElement).classList?.contains('ui-detail-side-panel') ? 153 : 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} } as DOMRect;
    };
    try {
      render(<UiProvider screenPreset={screenPresets.A} reducedMotion>
        <style>{'.ui-detail-side-panel{position:relative}'}</style>
        <div className="ui-overlay-body"><DetailSidePanel open selectedRowId="a" title="우유" onClose={() => {}} returnFocusKey="a" onRestoreFocus={() => {}}>내용</DetailSidePanel></div>
      </UiProvider>);
      const aside = screen.getByRole('region', { name: '우유' });
      expect(aside).toHaveAttribute('data-layout', 'flow');
      expect(aside.style.maxHeight).toBe('637px');
    } finally {
      Object.defineProperty(Element.prototype, 'getBoundingClientRect', rect);
      if (height) Object.defineProperty(HTMLElement.prototype, 'clientHeight', height); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  });
  it('fixes width 560, header 72, body padding 24 and scrolls only its own body', () => {
    expect(css).toMatch(/--sidepanel-width:560px/);
    expect(css).toMatch(/--sidepanel-header:72px/);
    const aside = rule('.ui-detail-side-panel');
    expect(aside).toMatch(/width:var\(--sidepanel-width\)/);
    expect(aside).toMatch(/overflow:hidden/);
    expect(aside).toMatch(/display:flex;flex-direction:column/);
    expect(rule('.ui-detail-side-panel>header')).toMatch(/min-height:var\(--sidepanel-header\)/);
    // beats widget-level padding overrides (specificity 0,3,0) without !important
    expect(rule('.ui-detail-side-panel[role="region"]>.ui-detail-side-panel__body')).toMatch(/padding:var\(--space-6\)/);
    expect(rule('.ui-detail-side-panel__body')).toMatch(/overflow:auto/);
    expect(rule('.ui-detail-side-panel__body')).toMatch(/flex:1/);
    expect(rule('.ui-detail-side-panel__danger')).toMatch(/border-top:var\(--stroke-hairline\) solid var\(--border\)/);
  });
  it('draws the selected row as a 4px --selection-foreground bar on the --selection face', () => {
    expect(rule('.ui-data-grid__table tr[aria-selected="true"]>td')).toMatch(/background:var\(--selection\)/);
    expect(rule('.ui-data-grid__table tr[aria-selected="true"]>td:first-child')).toMatch(/box-shadow:inset var\(--space-1\) 0 var\(--selection-foreground\)/);
    expect(readFileSync('src/ui/tokens.css', 'utf8')).toMatch(/--space-1:\s*4px/);
  });
  it('gives the plain kit Table the same selected-row bar', () => {
    expect(rule('.ui-table tbody tr[aria-selected="true"]>*')).toMatch(/background:var\(--selection\)/);
    expect(rule('.ui-table tbody tr[aria-selected="true"]>:first-child')).toMatch(/box-shadow:inset var\(--space-1\) 0 var\(--selection-foreground\)/);
  });
  it('narrows the grid to calc(100% - panel - 24px) beside an overlay panel, scrolling inside the table', () => {
    expect(css).toMatch(/\.ui-overlay-body :has\(>\.ui-detail-side-panel\[data-layout="overlay"\]\)>\.ui-data-grid\.ui-data-grid\s*\{[^}]*width:calc\(100% - var\(--sidepanel-width\) - var\(--space-6\)\)/);
    expect(rule('.ui-data-grid__scroll')).toMatch(/overflow:auto/);
  });
  it('marks an absolutely positioned panel as an overlay layout', () => {
    const { container } = render(<UiProvider screenPreset={screenPresets.A} reducedMotion>
      <style>{'.ui-detail-side-panel{position:absolute}'}</style>
      <div className="ui-overlay-body"><DetailSidePanel open selectedRowId="a" title="우유" onClose={() => {}} returnFocusKey="a" onRestoreFocus={() => {}}>내용</DetailSidePanel></div>
    </UiProvider>);
    expect(container.ownerDocument.querySelector('.ui-detail-side-panel')).toHaveAttribute('data-layout', 'overlay');
  });
  it('still closes from its own X button', () => {
    const onClose = vi.fn();
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><div className="ui-overlay-body"><DetailSidePanel open selectedRowId="a" title="우유" onClose={onClose} returnFocusKey="a" onRestoreFocus={() => {}}>내용</DetailSidePanel></div></UiProvider>);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
