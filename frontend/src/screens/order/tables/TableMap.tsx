import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import type { PosTableState, PosTableView } from '../../../contracts/pos';
import { dataBundles } from '../../../data/widget-data';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { usePosSnapshot } from '../../../pos/react';
import { selectTableMap, tableTransferReason, type TableTransferKind } from '../../../pos/tables';
import { ActionButton, ErrorPanel, Icon, formatPosMoney, motionTokens, timePolicy, useUi, type IconName } from '../../../ui';
import './tables.css';
import { tableTransferBundle } from './messages';
import { linkedOccupancyText, type LinkedTableDisplay } from '../../../features/cctv/zones/linked-ui';

export interface TableSelection {
  kind: TableTransferKind; billId: string;
  lines?: readonly { orderLineId: string; qty: number }[];
}

export const stateKeys = { empty: 'pos.emptyTable', reserved: 'pos.reservedTable', occupied: 'pos.occupiedTable', payment_pending: 'pos.waitingTable', cleaning: 'pos.cleaningTable' } as const;
const icons: Record<PosTableState, IconName | null> = { empty: null, reserved: 'calendar', occupied: 'members', payment_pending: 'receipt', cleaning: 'check' };
function TableTools({ selection, children }: { selection: boolean; children: ReactNode }) {
  const present = useIsPresent(), { reducedMotion } = useUi();
  return <motion.div className={selection ? 'pos-tables__selection-band' : 'pos-tables__normal-tools'} data-exiting={!present} inert={!present || undefined} aria-hidden={!present || undefined}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : motionTokens.duration.band / 1000, ease: motionTokens.ease.out }}>{children}</motion.div>;
}
function TableFace({ table, description, picker, link }: { table: PosTableView; description: string; picker: boolean; link?: LinkedTableDisplay }) {
  const present = useIsPresent(), { reducedMotion } = useUi(), { t } = useBundle(posBundle);
  return <motion.span aria-hidden="true" className="pos-tables__face" data-state={table.state} data-exiting={!present} initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : motionTokens.duration.stateSwap / 1000, ease: motionTokens.ease.out }}>
    <span className="pos-tables__tile-heading"><strong>T{table.number}</strong><span>{t('pos.tableSeats', { n: table.seats })}</span></span>
    {!picker ? <><span className="pos-tables__state">{icons[table.state] ? <Icon name={icons[table.state]!}/> : null}{t(stateKeys[table.state])}</span><span className="pos-tables__info">{description}</span>{table.state === 'occupied' ? <span className="pos-tables__order-count">{t('pos.tableOrders', { n: table.orderCount })}</span> : null}</> : null}
    {!picker && link ? <span className="pos-tables__linked-status"><span className="ui-badge">{linkedOccupancyText(link)}</span>{link.needsClearingBadge ? <span className="ui-badge" data-tone="warning">치울 테이블</span> : null}</span> : null}
  </motion.span>;
}
export function TableMap({ onPick, onEdit, onRetry, picker = false, selection, onCancelSelection, onSelect, linkedTables = [] }: {
  onPick: (table: PosTableView) => void; onEdit?: () => void; onRetry?: () => void; picker?: boolean;
  selection?: TableSelection | null; onCancelSelection?: () => void; onSelect?: (table: PosTableView) => boolean;
  linkedTables?: readonly LinkedTableDisplay[];
}) {
  const read = usePosSnapshot(), map = selectTableMap(read), { t } = useBundle(posBundle, tableTransferBundle, ...dataBundles), { reducedMotion } = useUi();
  const root = useRef<HTMLDivElement>(null), [focused, setFocused] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<readonly string[]>([]), previous = useRef(map.tables);
  const [flight, setFlight] = useState<{ id: number; from: NonNullable<typeof map.layout>['tables'][number]; to: NonNullable<typeof map.layout>['tables'][number] } | null>(null);
  const flightSequence = useRef(0);
  const source = read.pos.bills.find(b => b.billId === selection?.billId);
  const sourceTable = map.tables.find(t => t.tableId === source?.tableId);
  useEffect(() => {
    if (selection) root.current?.querySelector<HTMLElement>(`[data-pos-table="${source?.tableId}"]`)?.focus({ preventScroll: true });
  }, [selection, source?.tableId]);
  const signature = map.tables.map(table => `${table.tableId}:${table.state}:${table.total}`).join('|');
  useEffect(() => {
    const before = previous.current; previous.current = map.tables;
    const changed = map.tables.filter(table => { const old = before.find(row => row.tableId === table.tableId); return old && (old.state !== table.state || old.total !== table.total); }).map(table => table.tableId);
    if (!changed.length) return;
    setHighlight(changed);
    const timer = setTimeout(() => setHighlight([]), timePolicy.existingHighlightMs);
    return () => clearTimeout(timer);
  }, [signature]);
  const info = (table: PosTableView) => {
    if (table.state === 'occupied') return t('pos.tableInfo', { amount: formatPosMoney(table.total), n: table.elapsed });
    if (table.state === 'payment_pending') return `${formatPosMoney(table.total)} · ${t('pos.requestPayment')}`;
    if (table.state === 'cleaning') {
      const session = read.pos.tableSessions.find(s => s.tableId === table.tableId);
      const bill = read.pos.bills.find(b => b.billId === session?.billId);
      return t('pos.paidAt', { time: bill?.settledAt?.slice(-5) ?? '' });
    }
    const r = table.reservation;
    return r ? table.state === 'reserved' ? t('pos.reservationInfo', { time: r.time, name: typeof r.name === 'string' ? r.name : t(r.name.key), n: r.partySize }) : t('pos.nextReservation', { time: r.time }) : '';
  };
  const ordered = (map.layout?.tables ?? []).slice().sort((a, b) => a.row - b.row || a.column - b.column);
  const keydown = (event: KeyboardEvent, id: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = ordered.find(table => table.tableId === id)!;
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const backwards = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const candidates = ordered.filter(table => table.tableId !== id && (horizontal ? table.row === current.row && (backwards ? table.column < current.column : table.column > current.column) : table.column === current.column && (backwards ? table.row < current.row : table.row > current.row)));
    candidates.sort((a, b) => (horizontal ? Math.abs(a.column - current.column) - Math.abs(b.column - current.column) : Math.abs(a.row - current.row) - Math.abs(b.row - current.row)));
    const next = event.key === 'Home' ? ordered[0] : event.key === 'End' ? ordered.at(-1) : candidates[0];
    if (next) { setFocused(next.tableId); root.current?.querySelector<HTMLElement>(`[data-pos-table="${next.tableId}"]`)?.focus(); }
  };
  if (read.scenario === 'error') return <ErrorPanel title={t('pos.tableError')} actions={<ActionButton onClick={onRetry}>{t('pos.retry')}</ActionButton>}/>;
  const target = map.tables.some(table => table.tableId === focused) ? focused : ordered[0]?.tableId;
  return <div className="pos-tables" data-picker={picker} data-selecting={!!selection} data-pos-alert-blocker={selection ? '' : undefined} lang="ko" onKeyDown={event => { if (selection && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancelSelection?.(); } }}>
    {!picker ? <div className="pos-tables__tools"><AnimatePresence initial={false} mode="sync">{selection ? <TableTools key="selection" selection><span role="status">{t(`table.${selection.kind}Prompt`, { n: sourceTable?.number ?? '' })}</span><ActionButton variant="secondary" onClick={onCancelSelection}>{t('table.close')}</ActionButton></TableTools> : <TableTools key="legend" selection={false}><div className="pos-tables__legend">{(Object.keys(stateKeys) as PosTableState[]).map(state => <span key={state} data-state={state}>{icons[state] ? <Icon name={icons[state]!}/> : null}{t(stateKeys[state])} {map.tables.filter(table => table.state === state).length}</span>)}</div><ActionButton variant="secondary" onClick={onEdit}>{t('pos.editTables')}</ActionButton></TableTools>}</AnimatePresence></div> : null}
    <div className={`pos-tables__scroll ${picker ? '' : 'ui-glass-card'}`}><div ref={root} role="grid" aria-label={t(picker ? 'pos.pickTable' : 'pos.tableMap')} aria-rowcount={6} aria-colcount={9} className="pos-tables__grid" data-linked={!picker && linkedTables.length > 0 || undefined}>
      {Array.from({ length: 6 }, (_, row) => <div role="row" aria-rowindex={row + 1} key={row} className="pos-tables__row">{ordered.filter(table => table.row === row).map(position => {
        const table = map.tables.find(item => item.tableId === position.tableId)!;
        const link = linkedTables.find(item => item.tableId === table.tableId);
        const description = info(table), reason = selection ? tableTransferReason(read, selection.kind, selection.billId, table.tableId) : null;
        const blocked = picker && (table.state === 'cleaning' || table.state === 'payment_pending');
        return <div role="gridcell" aria-colindex={position.column + 1} key={table.tableId} style={{ gridColumn: position.column + 1 }}>
          <ActionButton variant="outline" className="pos-tables__tile" data-pos-table={table.tableId} data-state={table.state} data-highlighted={highlight.includes(table.tableId)} data-transfer-target={selection ? !reason : undefined} data-transfer-source={selection ? source?.tableId === table.tableId : undefined} aria-disabled={blocked || !!reason} tabIndex={target === table.tableId ? 0 : -1} onFocus={() => setFocused(table.tableId)} onKeyDown={event => keydown(event, table.tableId)} onClick={() => {
            if (selection) {
              const from = map.layout?.tables.find(t => t.tableId === source?.tableId);
              if (onSelect?.(table) && from && !reducedMotion) setFlight({ id: ++flightSequence.current, from, to: position });
            } else if (!blocked) onPick(table);
          }} aria-label={`T${table.number}, ${t('pos.tableSeats', { n: table.seats })}, ${t(stateKeys[table.state])}, ${description}${selection && !reason ? `, ${t('table.here')}` : ''}${!picker && link ? `, ${linkedOccupancyText(link)}${link.needsClearingBadge ? ', 치울 테이블' : ''}` : ''}`}>
            <AnimatePresence initial={false}><TableFace key={table.state} table={table} description={description} picker={picker} link={link}/></AnimatePresence>
            {selection && !reason ? <span className="pos-tables__here" aria-hidden="true">{t('table.here')}</span> : null}
          </ActionButton>
        </div>;
      })}</div>)}
      {flight && !reducedMotion ? <motion.span key={flight.id} aria-hidden="true" className="pos-tables__bill-chip" style={{ left: `calc((${flight.from.column} + .5) * var(--pos-table-cell-width))`, top: `calc((${flight.from.row} + .5) * var(--pos-table-cell-height))` }}
        initial={{ transform: 'translate(-50%, -50%)' }} animate={{ transform: `translate(calc(-50% + ${flight.to.column - flight.from.column} * var(--pos-table-cell-width)), calc(-50% + ${flight.to.row - flight.from.row} * var(--pos-table-cell-height)))` }} transition={{ duration: motionTokens.duration.billMove / 1000, ease: motionTokens.ease.inOut }} onAnimationComplete={() => setFlight(current => current?.id === flight.id ? null : current)}>{t('pos.tableBill', { n: flight.from.number })}</motion.span> : null}
    </div></div>
  </div>;
}
