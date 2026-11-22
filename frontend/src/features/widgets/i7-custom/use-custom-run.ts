import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomOrderCommand } from '../../../data/iteration7/custom-orders';
import type { CustomOrderPort, CustomUiResult } from './port-types';

/**
 * One press, one command. A fixture port answers at once, so `settled` runs inside the press (what the widget always did). An HTTP port answers
 * when the service has confirmed or refused the write: the widget shows `pending` until then, and a second press is ignored (the port also
 * returns the same promise for the same command). An answer that arrives after the widget is gone, or after `abandon()`, is dropped.
 */
export function useCustomRun(port: CustomOrderPort | null) {
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const active = useRef(true);
  const epoch = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const run = useCallback((command: CustomOrderCommand, settled: (result: CustomUiResult) => void): boolean => {
    if (!port || busy.current) return false;
    if (!port.execute) { settled(port.dispatch(command)); return true; }
    busy.current = true;
    setPending(true);
    const issued = epoch.current;
    void port.execute(command).then(result => {
      busy.current = false;
      if (!active.current) return;
      setPending(false);
      if (issued === epoch.current) settled(result);
    });
    return true;
  }, [port]);
  return { pending, run, abandon: () => { epoch.current += 1; } };
}
