/**
 * REAL-PLAN F12 — the briefing over HTTP. One read (`GET /insight/briefings`: business day, arrival day, acknowledgement and every named
 * source with its state and period) and one write (the owner's explicit acknowledgement). The briefing's numbers keep coming from the
 * same snapshot tables the source widgets read (their own domains), so panel, detail, arrival card and Navis stay on one figure; this
 * domain adds what only the service knows and the screens must show honestly: which sources are connected, partial or unavailable,
 * for which period, and whether this business day was already acknowledged.
 */
import { defineBinding, type DomainAdapter } from '../00';
import { toBriefingSnapshot, type BriefingDto } from './dto';

const base = '/insight';

export const briefingAdapter: DomainAdapter = {
  domain: 'briefing',
  // Other domains' receipts already name `briefing`; the insight service's own names are listed too. B15 inquiry receipts name
  // `inquiries` and `marketing-today`, not `briefing`, and the briefing's inquiry state reads them (B12-2).
  sources: ['briefing', 'briefings', 'insight.briefing', 'insight.briefings', 'inquiries', 'marketing-today', 'notices', 'notice-send',
    // B18 tax writes and undos name `pos.tax`; the briefing's tax state follows them (the backend tax reader arrives with B12-3).
    'pos.tax', 'pos.tax-payments', 'pos.tax-reviews', 'pos.tax-exports'],
  tables: ['realBriefing'],
  clear: () => ({ realBriefing: undefined }),
  errorKeys: {
    BRIEFING_DAY_CHANGED: 'briefing.error.dayChanged',
    IDEMPOTENCY_MISMATCH: 'briefing.error.dayChanged',
    IDEMPOTENCY_KEY_REQUIRED: 'briefing.error.notRecorded',
    INVALID_BUSINESS_DAY: 'briefing.error.notRecorded',
  },
  async load({ reads, signal }) {
    const snapshot = toBriefingSnapshot(await reads.one<BriefingDto>({ resource: 'insight.briefings', path: `${base}/briefings` }, { signal }));
    return { tables: { realBriefing: snapshot }, asOf: snapshot.asOf, sourceRevision: snapshot.sourceRevision, complete: true };
  },
  commands: [
    // Pending until confirmed; never optimistic. The body is empty by contract: the acknowledgement carries no text of the owner's.
    defineBinding({ type: 'briefing.acknowledge', request: command => ({
      method: 'POST', path: `${base}/briefings/${encodeURIComponent(command.businessDay)}/ack`, body: {},
    }) }),
  ],
};
