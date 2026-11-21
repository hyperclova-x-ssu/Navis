/**
 * T-072 app↔server clock (API-17 ping/pong). The server clock is `time.monotonic()` seconds, never epoch.
 * offset = serverT − (t + rtt/2), median of the last 5 samples; serverTime(local) = local + offset.
 */
const KEEP = 5;

export class ClockSync {
  private samples: number[] = [];

  /** `t` = the local time (s) the ping was sent, `serverT` from the pong, `now` = local receive time (s). */
  addPong(t: number, serverT: number, now: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(serverT) || now < t) return;
    const rtt = now - t;
    this.samples.push(serverT - (t + rtt / 2));
    if (this.samples.length > KEEP) this.samples.shift();
  }

  get offset(): number | null {
    if (this.samples.length === 0) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  }

  /** Local seconds → server seconds; null before the first pong. */
  toServer(local: number): number | null {
    const o = this.offset;
    return o === null ? null : local + o;
  }

  /** e2eMs = drawn moment (server clock) − captureT, in ms; null before the first pong. */
  e2eMs(drawnLocal: number, captureT: number): number | null {
    const s = this.toServer(drawnLocal);
    return s === null ? null : Math.max(0, Math.round((s - captureT) * 1000));
  }

  reset(): void {
    this.samples = [];
  }
}
