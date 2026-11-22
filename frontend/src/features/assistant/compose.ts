// D-380: HyperCLOVA X may write the answer sentences. The browser sends the question and the fact lines it already shows (the same lines a plain
// answer is made of); what comes back is checked again here by the shared numeric guard and shown only if it passes. The fact lines stay the
// answer otherwise. Nothing here reads the store or writes anything.
import type { DashboardLayerId, Locale } from '../../contracts';
import type { DataSnapshot } from '../../data/db/types';
import { guardComposed } from '../../../shared/navis-answer-guard.mjs';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../../shared/navis-agent-schema.mjs';
import { TODAY } from '../../data/widget-data';
import { navisTranslator } from './messages';
import type { AgentReadEvidence } from './snapshot';

/**
 * The fact lines a read answer is made of ("오늘 매출 48.1만 원"), one per verified fact or record, in answer order. A plain answer is these lines
 * joined by newlines; the composed answer is written from the very same lines, so what the model sees is what the owner would have been shown.
 */
export function readAnswerLines(
  evidence: readonly AgentReadEvidence[], tr: ReturnType<typeof navisTranslator>, question: string, contextOnly: ReadonlySet<number>, selectedId?: string,
): string[] {
  const asksForRestockItems = /(?:부족한|보충이 필요한)\s*(?:품목|재료|상품|거)/u.test(question);
  return evidence.flatMap((record, index) => {
    if (contextOnly.has(index)) return [];
    if (record.tool === 'search_records') return record.matches.filter(match => !selectedId || match.handle === selectedId)
      .flatMap(match => {
        const display = record.display?.get(match.handle);
        return display ? [display] : match.label && match.price !== undefined ? [`${match.label} ${tr.format.money(match.price, 'full')}`] : [];
      });
    return record.facts.map(fact => {
      if (fact.key === 'menu.count') return tr.t('common.navis.agent.menuCount', { count: typeof fact.value === 'number' ? tr.format.number(fact.value) : fact.display });
      if (fact.key === 'inventory.restock.count' && fact.value === 0 && asksForRestockItems) return tr.t('navis.stock.noRestock');
      if (/^calendar\.entry\.\d+$/u.test(fact.key)) return fact.source === 'staff-schedule' ? `${fact.label} · ${fact.display}` : fact.display;
      if (fact.key === 'ledger.candidates.empty') return fact.display;
      return fact.label === fact.display ? fact.display : `${fact.label} ${fact.display}`;
    });
  });
}

const MAX_WORDED_LINES = 6;

/** One plain fact answers itself; the model words a list of facts and any question that asks to compare or explain. */
export function worthWording(lines: readonly string[], question: string): boolean {
  if (!lines.length) return false;
  if (lines.length > MAX_WORDED_LINES) return false;
  // Three or more rows of one kind ("근무 11/18(수) …" ×3) are a list: it is the answer as it stands.
  const kinds = new Map<string, number>();
  for (const line of lines) {
    const kind = line.split(/\s+/u, 2).join(' ');
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  if ([...kinds.values()].some(count => count >= 3)) return false;
  return lines.length >= 2 || /왜|이유|원인|비교|어때|늘었|줄었|차이|많아|적어|높아|낮아|올랐|내렸|떨어/u.test(question);
}

export interface ComposeContext {
  readonly fetcher: (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status'> & Partial<Pick<Response, 'body' | 'headers'>>>;
  readonly snapshot: DataSnapshot; readonly locale: Locale; readonly layer: DashboardLayerId;
  readonly text: string; readonly lines: readonly string[]; readonly previous?: string; readonly signal?: AbortSignal;
}

const MAX_LINES = 24;
const COMPOSE_TIMEOUT_MS = 6_000;

/** The composed frame of a small SSE body, or null for an error frame, a frame outside the schema or any transport problem. */
export function readComposedFrames(body: string): { readonly text: string; readonly used: readonly number[] } | null {
  let event = '', composed: { text: string; used: readonly number[] } | null = null, failed = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      try {
        const data = JSON.parse(line.slice(5).trim()) as { text?: string; used?: readonly number[] };
        if (event === 'composed' && validateAgentFrame('composed', data)) composed = { text: data.text!, used: data.used ?? [] };
        if (event === 'error') failed = true;
      } catch { failed = true; }
    }
  }
  return failed ? null : composed;
}

/** The guarded sentences, or null: the caller then keeps the fact lines. Never throws. */
export async function requestComposedAnswer(context: ComposeContext): Promise<string | null> {
  const { fetcher, snapshot, locale, layer, text, lines, previous, signal } = context;
  if (!snapshot.runId || !lines.length || lines.length > MAX_LINES) return null;
  const body = {
    runId: snapshot.runId, snapshotRevision: snapshot.revision, locale, layer, businessDate: snapshot.pos?.businessDate ?? TODAY,
    intent: { kind: 'compose', text: text.slice(0, 240), lines: lines.map(line => line.slice(0, 240)), ...(previous && { previous: previous.slice(0, 300) }) },
    slots: [], catalog: [], snapshot: [], searches: [],
  };
  if (!validateAgentRequest(body)) return null;
  const timeout = AbortSignal.timeout(COMPOSE_TIMEOUT_MS);
  try {
    const response = await fetcher('/api/navis/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || response.headers?.get(AGENT_PROTOCOL_HEADER) !== AGENT_PROTOCOL || !response.body) return null;
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let raw = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (raw.length > 8_192) { void reader.cancel().catch(() => {}); return null; }
    }
    const composed = readComposedFrames(raw);
    // The browser guards again: it never trusts the server's own check.
    return composed ? guardComposed({ text: composed.text, lines, used: [...composed.used], question: text, context: previous }) : null;
  } catch { return null; }
}
