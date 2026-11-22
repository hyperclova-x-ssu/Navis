import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DataCommandResult } from '../../../data/commands/types';
import { useDataDispatch, useDataExecute, useDomainState, useWidgetDataStore } from '../../../data/react';
import type { MenuCommand } from '../../../data/reality/01/menu-dto';
import type { GridCommitResult } from '../../../ui';
import { menuError } from './pos-menu-messages';

export type MenuResult = DataCommandResult | Promise<DataCommandResult>;

export function onMenuResult(result: MenuResult, callback: (result: DataCommandResult) => void) {
  if (result instanceof Promise) void result.then(callback);
  else callback(result);
}

export function menuGridResult(result: MenuResult, editToken: string, t: (key: string) => string): GridCommitResult {
  // The grid's commit callback is synchronous. Async errors go to the editor's alert and notice.
  if (result instanceof Promise || result.ok) return { ok: true };
  return { ok: false, error: { id: editToken, message: menuError(result, t) } };
}

export function useMenuCommand() {
  const domain = useDomainState('menu');
  const dispatch = useDataDispatch();
  const execute = useDataExecute();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const send = (command: MenuCommand): MenuResult => {
    if (domain.mode === 'fixture') return dispatch(command);
    if (inFlight.current || domain.pending > 0) {
      return { ok: false, code: 'CONFLICT', reason: 'TRANSACTION_BUSY', messageKey: 'data.management.error.TRANSACTION_BUSY' };
    }
    inFlight.current = true;
    setPending(true);
    return execute(command).finally(() => {
      inFlight.current = false;
      setPending(false);
    });
  };

  return { send, pending, http: domain.mode === 'http' };
}

export function useMenuIngredients() {
  const menu = useDomainState('menu');
  const stock = useDomainState('stock');
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const available = menu.mode === 'fixture' || (stock.mode === 'http' && (stock.status === 'ready' || stock.status === 'stale'));
  return useMemo(() => available ? snapshot.tables.inventoryItem.filter(item => item.kind === 'ingredient' && !item.deletedAt) : [],
    [available, snapshot.tables.inventoryItem]);
}
