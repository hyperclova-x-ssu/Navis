import type { DataCommandResult } from '../../../data/commands/types';
import type { CustomCommandValue } from '../../../data/iteration7/custom-orders';
import { selectCustomOrderRead } from '../../../data/pos/projection';
import type { CommandReceipt } from '../../../data/reality/00';
import type { WidgetDataStore } from '../../../data/widget-data';
import type { CustomOrderPort, CustomUiResult } from './port-types';

type FlatReceipt = CommandReceipt & Partial<Omit<CustomCommandValue, 'reservationId'>> & { readonly orderNo?: number };

/** The service names every record a command touched at the top of its receipt (B08): the widget keeps its own `CustomCommandValue`. */
export function customUiResult(result: DataCommandResult): CustomUiResult {
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? result.code, ...(result.messageKey ? { noticeKey: result.messageKey } : {}),
      ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}) };
  }
  const receipt = result.value as FlatReceipt | undefined;
  const value: CustomCommandValue = receipt ? Object.fromEntries(([
    'templateId', 'customOrderId', 'pickupReservationId', 'quoteRevision', 'stage', 'settlementId', 'paymentId', 'recognitionId', 'correctionId',
  ] as const).flatMap(key => receipt[key] == null ? [] : [[key, receipt[key]]])) : {};
  return { ok: true, value, ...(result.noticeKey ? { noticeKey: result.noticeKey } : {}), ...(result.params ? { params: result.params } : {}),
    ...(result.undoToken ? { undoToken: result.undoToken, ...(receipt?.undoUntil ? { undoUntil: receipt.undoUntil } : {}) } : {}) };
}

/**
 * The same widget port on an HTTP build: it reads the run's tables (which the `custom` adapter fills from the POS service) and every write waits
 * for the service's receipt. Opening the simulated terminal of the fixture build is not offered: the widget records the owner's own terminal slip.
 */
export function createHttpCustomPort(base: CustomOrderPort, store: WidgetDataStore): CustomOrderPort {
  const real = store.real;
  return {
    ...base,
    read: () => selectCustomOrderRead(store.getSnapshot()),
    subscribe: store.subscribe,
    // A write is only ever shown as saved after the service's receipt: the synchronous door stays shut, loudly.
    dispatch: () => ({ ok: false, reason: 'ASYNC_REQUIRED' }),
    execute: command => store.execute(command).then(customUiResult),
    record: command => store.execute(command).then(customUiResult),
    ...(real ? { real } : {}),
  };
}
