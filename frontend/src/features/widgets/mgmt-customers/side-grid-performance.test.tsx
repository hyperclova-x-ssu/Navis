import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { useSideGrid } from './workspace';

const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, left, right: left + width, top, bottom: top + height, width, height, toJSON: () => ({}) });
const ids = ['one', 'two', 'three', 'four'];
let right: number, panelWidth: number;
let callbacks: (() => void)[];
const disconnect = vi.fn();
let reads: MockInstance<() => DOMRect>;
let readNodes: HTMLElement[];

function Fixture({ open, rowIds = ids }: { open: boolean; rowIds?: readonly string[] }) {
  const { root, obscured } = useSideGrid(open, rowIds.join(','));
  return <div ref={root} data-testid="frame">
    <table role="grid"><thead><tr>{['name', 'price', '$actions'].map(id => <th key={id}><button data-grid-target={id} tabIndex={-1}>{id}</button></th>)}</tr></thead>
      <tbody>{rowIds.map(id => <tr key={id} data-grid-row={id}>{['name', 'price', '$actions'].map(column => <td key={column} data-grid-row-id={id} data-grid-column-id={column} data-grid-target={`${id}:${column}`} tabIndex={-1} inert={obscured.has(`${id}:${column}`)} aria-hidden={obscured.has(`${id}:${column}`) || undefined}>{id}</td>)}</tr>)}</tbody>
    </table>
    <aside className="ui-detail-side-panel"><table role="grid"><tbody><tr data-grid-row="recipe"><td data-grid-row-id="recipe" data-grid-column-id="name">안쪽 표</td></tr></tbody></table></aside>
    <output>{[...obscured].sort().join(',')}</output>
  </div>;
}

beforeEach(() => {
  right = 600; panelWidth = 200; callbacks = []; readNodes = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() { disconnect(); } });
  reads = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    readNodes.push(this);
    if (this.dataset.testid === 'frame') return rect(0, 0, right, 300);
    if (this.matches('aside')) return rect(right - panelWidth + 24, 0, panelWidth, 180);
    if (this.matches('th')) return rect(Array.from(this.parentElement!.children).indexOf(this) * 200, 0, 200, 48);
    if (this.matches('[data-grid-row]')) return rect(0, 48 + Array.from(this.parentElement!.children).indexOf(this) * 60, 600, 60);
    if (this.matches('td')) return rect(Array.from(this.parentElement!.children).indexOf(this) * 200, 48 + Array.from(this.parentElement!.parentElement!.children).indexOf(this.parentElement!) * 60, 200, 60);
    return rect(0, 0, 0, 0);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); disconnect.mockClear(); });

it('reads no rectangles and installs no observer while closed, including rerenders, resize and scroll', () => {
  const view = render(<Fixture open={false} />);
  view.rerender(<Fixture open={false} rowIds={['five']} />);
  fireEvent.scroll(view.getByTestId('frame'));
  fireEvent(window, new Event('resize'));
  expect(reads).not.toHaveBeenCalled();
  expect(callbacks).toHaveLength(0);
});

it('measures once per column and row, uses the destination box and excludes the inner grid', () => {
  const view = render(<Fixture open />);
  expect(view.container.querySelector('output')).toHaveTextContent('one:$actions,three:$actions,two:$actions');
  expect(view.container.querySelector<HTMLElement>('thead [data-grid-target="$actions"]')!.inert).toBe(true);
  expect(readNodes.filter(node => node.matches('td'))).toHaveLength(0);
  expect(reads).toHaveBeenCalledTimes(2 + 3 + ids.length);
  reads.mockClear();
  view.rerender(<Fixture open />);
  expect(reads).not.toHaveBeenCalled();
  expect(callbacks).toHaveLength(1);
});

it('refreshes coverage on scroll, resize and row replacement, then clears it without reads on close', () => {
  const view = render(<Fixture open />);
  right = 800;
  fireEvent.scroll(view.getByTestId('frame'));
  expect(view.container.querySelector('output')).toBeEmptyDOMElement();
  expect(view.getByRole('button', { name: '$actions' }).inert).toBe(false);
  right = 600;
  act(() => callbacks.forEach(callback => callback()));
  view.rerender(<Fixture open rowIds={['four', 'three', 'two', 'one']} />);
  expect(view.container.querySelector('output')).toHaveTextContent('four:$actions,three:$actions,two:$actions');
  reads.mockClear();
  view.rerender(<Fixture open={false} />);
  expect(view.container.querySelector('output')).toBeEmptyDOMElement();
  expect(view.getByRole('button', { name: '$actions' }).inert).toBe(false);
  fireEvent(window, new Event('resize'));
  expect(reads).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalled();
  view.rerender(<Fixture open />);
  expect(view.container.querySelector('output')).toHaveTextContent('one:$actions,three:$actions,two:$actions');
});

it('does not read grid rectangles if the open panel has no measured width', () => {
  panelWidth = 0;
  const view = render(<Fixture open />);
  expect(view.container.querySelector('output')).toBeEmptyDOMElement();
  expect(readNodes.every(node => node.matches('aside'))).toBe(true);
});
