import { useRef, useState, useSyncExternalStore } from 'react';
import type { WidgetHost } from '../../../contracts';
import type { DataCommand } from '../../../data/commands/types';
import { useDataExecute, useRealPort, useRealRetry, useWidgetDataStore } from '../../../data/react';
import type { CommandReceipt } from '../../../data/reality/00';
import type { PeriodDto } from '../../../data/reality/13/dto';
import type { Translator } from './shared';
import { dateRangeWithWeekdays } from '../date-range';

export const localKey = (name: string) => `data.real.local.${name}`;
export const periodText = (t: Translator, period: PeriodDto) => period.from === period.to
  ? t.format.date(period.from, 'short') : dateRangeWithWeekdays(t, period.from, period.to);

export function useLocalData() {
  const store = useWidgetDataStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).tables.realLocal;
}

export function useReadHost(host: WidgetHost, domain: 'local' | 'inbox' = 'local'): WidgetHost {
  const port = useRealPort();
  const retry = useRealRetry(domain);
  return port?.mode(domain) === 'http' ? { ...host, resetPreview: retry } : host;
}

export function useLocalCommand(host: WidgetHost) {
  const execute = useDataExecute();
  const retry = useRealRetry('local');
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function send(command: DataCommand, { notifySuccess = true, success }: { notifySuccess?: boolean; success?: Pick<Parameters<WidgetHost['notify']>[0], 'messageKey' | 'params'> } = {}): Promise<boolean> {
    if (active.current) return false;
    active.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await execute(command);
      if (!result.ok) {
        setError(result.messageKey);
        if (result.reason === 'OFFER_CLOSED' || result.reason === 'OFFER_EXPIRED') retry();
        return false;
      }
      if (notifySuccess && result.noticeKey) {
        const expiry = (result.value as CommandReceipt | undefined)?.undoUntil;
        host.notify({ kind: 'success', messageKey: result.noticeKey, ...success,
          ...(result.undoToken ? { undoToken: result.undoToken } : {}), ...(expiry ? { undoUntil: expiry } : {}) });
      }
      return true;
    } catch {
      setError('data.real.error.SERVICE_UNAVAILABLE');
      return false;
    } finally {
      active.current = false;
      setPending(false);
    }
  }
  return { pending, error, send };
}

export function allowedSource(value: string | null | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Invalid source URL. */ }
}

export function seoulStamp(stamp: string): string {
  // An example (fixture) stamp is already the store's wall time; only a timezone-qualified service stamp is moved to Seoul time.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/u.test(stamp)) return stamp.slice(0, 16);
  const time = Date.parse(stamp);
  return Number.isFinite(time) ? new Date(time + 9 * 3_600_000).toISOString().slice(0, 16) : stamp;
}
