/**
 * KIOSK-UI — mounts the Navis side of the Npay 커넥트 prop once inside the run host (see enter.ts for how an order is entered).
 */
import { useEffect, useRef } from 'react';
import type { RunStore } from '../contracts';
import { usePosStatusSession } from '../pos/react';
import { usePosBridge } from '../pos/remote-context';
import { CONNECT_CHANNEL, createBrowserTransport, type ConnectOrderMessage, type ConnectTransport } from './channel';
import { enterConnectOrder, type IntakeResult } from './enter';

const RETRY_MS = 500, MAX_RETRIES = 120;
const sleep = (ms: number) => new Promise<void>(resolve => { window.setTimeout(resolve, ms); });

/** Mounted once inside the Navis run host: listens for kiosk orders and enters them one at a time. */
export function ConnectOrderIntake({ run, transport }: { readonly run: RunStore; readonly transport?: ConnectTransport }) {
  const runtime = usePosStatusSession(), bridge = usePosBridge();
  const live = useRef({ run, runtime, bridge });
  useEffect(() => { live.current = { run, runtime, bridge }; });
  useEffect(() => {
    const seen = new Set<string>(), queue: ConnectOrderMessage[] = [];
    let working = false, alive = true;
    const pump = async () => {
      if (working) return;
      working = true;
      try {
        for (let retries = 0; alive && queue.length;) {
          let result: IntakeResult;
          try { result = await enterConnectOrder(live.current, queue[0]); } catch { result = 'drop'; }
          if (result === 'retry' && retries < MAX_RETRIES) { retries += 1; await sleep(RETRY_MS); continue; }
          queue.shift(); retries = 0;
        }
      } finally { working = false; }
    };
    const bus = transport ?? createBrowserTransport(CONNECT_CHANNEL);
    const stop = bus.subscribe(message => {
      if (seen.has(message.id)) return;
      seen.add(message.id); queue.push(message); void pump();
    });
    return () => { alive = false; stop(); };
  }, [transport]);
  return null;
}
