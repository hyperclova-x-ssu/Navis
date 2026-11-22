import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WidgetHost } from '../../../contracts';
import type { DataCommand } from '../../../data/commands/types';
import { useDataDispatch, useDataExecute, useRealPort, useWidgetDataStore } from '../../../data/react';
import type { CouponReceipt } from '../../../data/reality/14/dto';
import { reportResult, useMkt } from './shared';

export function useRealCoupons() {
  const store = useWidgetDataStore();
  const read = () => store.getSnapshot().tables.realCoupons;
  return useSyncExternalStore(store.subscribe, read, read);
}

type CouponCommand = Extract<DataCommand, { type: `coupon.${string}` }>;

export function useCouponAction(host: WidgetHost) {
  const dispatch = useDataDispatch(), execute = useDataExecute(), { t } = useMkt();
  const http = useRealPort()?.mode('coupons') === 'http';
  const [pending, setPending] = useState(false);
  const locked = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function run(command: CouponCommand, fallback: string, finish: (error: string | null, receipt?: CouponReceipt) => void) {
    if (locked.current) return;
    if (!http) {
      const result = dispatch(command);
      const notice = result.ok && result.noticeKey === 'data.notice.sent' ? { ...result, noticeKey: 'data.notices.notice.scheduled' } : result;
      finish(reportResult(notice, host, t, fallback));
      return;
    }
    locked.current = true;
    setPending(true);
    void execute(command).then(result => {
      if (!result.ok) {
        if (mounted.current) finish(t(result.messageKey));
        return;
      }
      const receipt = result.value as CouponReceipt;
      const undoUntil = receipt?.undoUntil;
      const undo = result.undoToken && undoUntil && Date.parse(undoUntil) > Date.now();
      host.notify({ kind: 'success', messageKey: receipt?.delivery === 'queued' || command.type === 'coupon.notifyEnding'
        ? 'data.notices.notice.scheduled' : result.noticeKey ?? fallback,
        ...(undo ? { undoToken: result.undoToken, undoUntil } : {}) });
      if (mounted.current) finish(null, receipt);
    }, () => {
      if (mounted.current) finish(t('data.real.error.GENERIC'));
    }).finally(() => {
      locked.current = false;
      if (mounted.current) setPending(false);
    });
  }
  return { http, pending, run };
}
