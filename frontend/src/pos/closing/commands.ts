import type { PosDrawerCommand, PosPlanningResult, PosReadSnapshot } from '../../contracts/pos';
import { canonical, checkMeta, commandKey, freezePos, makePlan, money, posFailure, unchanged } from '../domain/common';

export const drawerCommandPayload = (command: PosDrawerCommand) => { const { meta: _meta, ...payload } = command; return payload; };
export function planDrawerCommand(read: PosReadSnapshot, command: PosDrawerCommand, now: string): PosPlanningResult {
  const payload = drawerCommandPayload(command), checked = checkMeta(read, command.meta, command.type, payload); if (checked) return checked;
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'empty' || read.scenario === 'error') return posFailure('DATA_UNAVAILABLE');
  if (read.posUi.approval?.status === 'pending') return posFailure('APPROVAL_BUSY', 'CONFLICT');
  const before = read.pos.drawer;
  let after = before, seq = read.pos.seq;
  if (command.type === 'drawer.set') {
    if (command.opening !== undefined && !money(command.opening) || command.actual !== undefined && command.actual !== null && !money(command.actual)) return posFailure('INVALID_AMOUNT');
    if (command.memo !== undefined && (typeof command.memo !== 'string' || command.memo.length > 100)) return posFailure('TEXT_LIMIT');
    after = { ...before, ...(command.opening !== undefined ? { opening: command.opening } : {}), ...(command.actual !== undefined ? { actual: command.actual } : {}), ...(command.memo !== undefined ? { memo: command.memo } : {}) };
  } else if (command.type === 'drawer.addMovement') {
    if (!['in', 'out'].includes(command.kind) || !money(command.amount) || command.amount < 1) return posFailure('INVALID_AMOUNT');
    if (command.memo !== undefined && (typeof command.memo !== 'string' || command.memo.length > 100)) return posFailure('TEXT_LIMIT');
    after = { ...before, movements: [...before.movements, { movementId: `pos:drawer:${commandKey(command.meta, command.type)}`, at: now, seq: ++seq, kind: command.kind, amount: command.amount, memo: command.memo ?? '' }] };
  } else {
    if (!before.movements.some(m => m.movementId === command.movementId)) return posFailure('NOT_FOUND', 'NOT_FOUND');
    after = { ...before, movements: before.movements.filter(m => m.movementId !== command.movementId) };
  }
  if (canonical(before) === canonical(after)) return unchanged(read, null);
  const key = commandKey(command.meta, command.type), token = `pos:drawer:${key}`;
  return makePlan(read, { ...read.pos, revision: read.posRevision + 1, seq, drawer: after },
    { ...read.posUi, drawerUndo: { token, commandKey: key, closingGeneration: read.data.closingGeneration, before, after } }, null, command.meta, command.type, payload, token);
}
export function planDrawerUndo(read: PosReadSnapshot, token: string): PosPlanningResult {
  const undo = read.posUi.drawerUndo;
  if (!undo || undo.token !== token || read.data.closingGeneration !== undo.closingGeneration) return posFailure('UNDO_UNAVAILABLE', 'CONFLICT');
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.posUi.approval?.status === 'pending') return posFailure('APPROVAL_BUSY', 'CONFLICT');
  if (canonical(read.pos.drawer) !== canonical(undo.after)) return posFailure('UNDO_UNAVAILABLE', 'CONFLICT');
  const nextPos = { ...read.pos, revision: read.posRevision + 1, drawer: undo.before,
    commandLedger: read.pos.commandLedger.map(e => e.key === undo.commandKey ? { ...e, undone: true } : e) };
  return { ok: true, plan: freezePos({ nextPos, nextUi: { ...read.posUi, drawerUndo: null },
    result: { ok: true, status: 'applied', posRevision: nextPos.revision, dataRevision: read.dataRevision + 1, value: null } }) };
}
