/**
 * REAL-PLAN F12 — the arrival gate's view of the service (D-327 over HTTP).
 * One read per run of `GET /insight/briefings`: its `arrivalDay` replaces the local weekday rule when the service has authoritative weekly opening
 * times (null keeps the current gate), and its acknowledgement keeps the card closed in a new browser or session. The answer is `undefined` while the read
 * runs (the card waits), the day pair when it is known, and `null` when the read failed (the local rule alone decides, so the card is never held back).
 */
import type { BriefingServerDay } from '../../../state/briefing-day';
import type { PortTransport } from '../00';
import { appTransport } from '../00/app-port';
import { dataSourceFor } from '../00/registry';
import type { BriefingDto } from './dto';

export type BriefingServerSource = () => BriefingServerDay | null | undefined;

export function createServerArrival(transport: PortTransport): BriefingServerSource {
  let answer: BriefingServerDay | null | undefined;
  let started = false;
  return () => {
    if (!started) {
      started = true;
      void transport.request<BriefingDto>({ method: 'GET', path: '/insight/briefings' }).then(dto => {
        const day = typeof dto?.businessDay === 'string' ? dto.businessDay : null;
        answer = { arrivalDay: typeof dto?.arrivalDay === 'string' ? dto.arrivalDay : null, acknowledgedDay: dto?.acknowledgement && day ? day : null };
      }, () => { answer = null; });
    }
    return answer;
  };
}

/** The app composition's source: only a build that reads the briefing over HTTP has one (fixture builds keep their exact current gate). */
export const browserServerArrival = (): BriefingServerSource | undefined => dataSourceFor('briefing') === 'http' ? createServerArrival(appTransport()) : undefined;
