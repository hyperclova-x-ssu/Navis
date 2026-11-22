import type { PoolClient } from 'pg';
import { boardWidgetLayers } from '../../../../packages/contracts/index.ts';
import { emitAccountEvent } from './outbox.ts';
import { array, expectedRevision, identifier, integer, invalid, option, record, unique } from './wire.ts';

export const boardIds = ['management', 'marketing'] as const;
type BoardId = typeof boardIds[number];
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !dayPattern.test(value)) throw invalid(field);
  const checked = new Date(value);
  if (Number.isNaN(checked.getTime()) || checked.toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

function condition(value: unknown) {
  const kind = option((value as { kind?: unknown } | null)?.kind, ['default', 'dateRange', 'snapshot'], 'condition');
  if (kind === 'default') {
    record(value, ['kind'], 'condition');
    return { kind };
  }
  if (kind === 'snapshot') {
    const { asOf } = record(value, ['kind', 'asOf'], 'condition');
    // The widget uses date-only snapshots and can also return a timezone-qualified timestamp.
    if (typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(asOf)
      && Number.isFinite(Date.parse(asOf))) return { kind, asOf };
    return { kind, asOf: date(asOf, 'asOf') };
  }
  const input = record(value, ['kind', 'start', 'end'], 'condition');
  const start = date(input.start, 'start'), end = date(input.end, 'end');
  if (start > end) throw invalid('condition');
  return { kind, start, end };
}

function panel(value: unknown) {
  const input = record(value, ['featureId', 'column', 'row', 'width', 'height', 'condition'], 'panels');
  const column = integer(input.column, 0, 7, 'column'), row = integer(input.row, 0, 4, 'row');
  return {
    featureId: identifier(input.featureId, 'featureId'), column, row,
    width: integer(input.width, 1, Math.min(4, 8 - column), 'width'),
    height: integer(input.height, 1, Math.min(4, 5 - row), 'height'),
    ...(input.condition === undefined ? {} : { condition: condition(input.condition) }),
  };
}

function page(value: unknown) {
  const input = record(value, ['pageId', 'panels'], 'pages');
  const panels = array(input.panels, 0, 40, 'panels', panel);
  const cells: number[] = [];
  for (const { column, row, width, height } of panels) {
    for (let y = row; y < row + height; y++) {
      for (let x = column; x < column + width; x++) cells.push(y * 8 + x);
    }
  }
  unique(cells, 'panels');
  return { pageId: identifier(input.pageId, 'pageId'), panels };
}

export function parseBoard(input: unknown, boardId: BoardId) {
  const request = record(input, ['expectedRevision', 'pages', 'currentPage']);
  const pages = array(request.pages, 1, 5, 'pages', page);
  unique(pages.map(item => item.pageId), 'pageId');
  const features = pages.flatMap(item => item.panels.map(panel => panel.featureId));
  unique(features, 'featureId');
  for (const feature of features) {
    if (!Object.hasOwn(boardWidgetLayers, feature) || boardWidgetLayers[feature as keyof typeof boardWidgetLayers] !== boardId) {
      throw invalid('featureId');
    }
  }
  return { expected: expectedRevision(request.expectedRevision), currentPage: integer(request.currentPage, 0, pages.length - 1, 'currentPage'), pages };
}

type Page = ReturnType<typeof page>;
type Board = { boardId: BoardId; revision: number; currentPage: number; pages: Page[] };

export async function readBoards(client: PoolClient, storeId: string): Promise<Board[]> {
  const { rows } = await client.query<Board>(`
    SELECT b.board_id AS "boardId", b.revision, b.current_page AS "currentPage",
      (SELECT jsonb_agg(jsonb_build_object('pageId', p.page_id, 'panels', COALESCE((
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'featureId', n.feature_id, 'column', n.column_no, 'row', n.row_no, 'width', n.width,
          'height', n.height, 'condition', n.condition)) ORDER BY n.position)
        FROM account.board_panel n WHERE (n.store_id, n.board_id, n.page_id) = (p.store_id, p.board_id, p.page_id)
      ), '[]'::jsonb)) ORDER BY p.position)
      FROM account.board_page p WHERE (p.store_id, p.board_id) = (b.store_id, b.board_id)) AS pages
    FROM account.board b WHERE b.store_id = $1
  `, [storeId]);
  return boardIds.map(boardId => rows.find(row => row.boardId === boardId) ??
    { boardId, revision: 0, currentPage: 0, pages: [{ pageId: `${boardId}-1`, panels: [] }] });
}

export async function saveBoard(
  client: PoolClient, storeId: string, previous: Board, input: ReturnType<typeof parseBoard>, revision: number,
) {
  const { boardId } = previous;
  await client.query(`
    INSERT INTO account.board (store_id, board_id, revision, current_page) VALUES ($1, $2, $3, $4)
    ON CONFLICT (store_id, board_id) DO UPDATE SET revision = EXCLUDED.revision, current_page = EXCLUDED.current_page
  `, [storeId, boardId, revision, input.currentPage]);
  await client.query('DELETE FROM account.board_page WHERE store_id = $1 AND board_id = $2', [storeId, boardId]);
  await client.query(`
    INSERT INTO account.board_page (store_id, board_id, page_id, position)
    SELECT $1, $2, p->>'pageId', i - 1 FROM jsonb_array_elements($3) WITH ORDINALITY pages(p, i)
  `, [storeId, boardId, JSON.stringify(input.pages)]);
  await client.query(`
    INSERT INTO account.board_panel (store_id, board_id, page_id, feature_id, position, column_no, row_no, width, height, condition)
    SELECT $1, $2, p->>'pageId', n->>'featureId', i - 1, (n->>'column')::int, (n->>'row')::int,
      (n->>'width')::int, (n->>'height')::int, n->'condition'
    FROM jsonb_array_elements($3) p CROSS JOIN LATERAL jsonb_array_elements(p->'panels') WITH ORDINALITY panels(n, i)
  `, [storeId, boardId, JSON.stringify(input.pages)]);
  await emitAccountEvent(client, 'account.panel_changed.v1', boardId, { storeId, boardId, revision });
  const signature = (item: Page['panels'][number]) =>
    JSON.stringify([item.column, item.row, item.width, item.height, item.condition?.kind,
      item.condition && 'asOf' in item.condition ? item.condition.asOf : null,
      item.condition && 'start' in item.condition ? [item.condition.start, item.condition.end] : null]);
  const panels = (pages: Page[]) => new Map(pages.flatMap(({ pageId, panels: values }) =>
    values.map(item => [`${pageId}/${item.featureId}`, { pageId, featureId: item.featureId, signature: signature(item) }] as const)));
  const before = panels(previous.pages), after = panels(input.pages);
  for (const [key, item] of new Map([...before, ...after])) {
    if (before.get(key)?.signature === after.get(key)?.signature) continue;
    await emitAccountEvent(client, 'account.widget_changed.v1', item.featureId,
      { storeId, boardId, pageId: item.pageId, featureId: item.featureId, revision });
  }
}
