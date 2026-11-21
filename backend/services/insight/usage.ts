import type { Pool } from 'pg';
import { fingerprint, InsightError, inStore } from './scope.ts';

const tokenCount = { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' };
const outcomes = ['success', 'length', 'rate_limited', 'error', 'timeout', 'cancelled', 'filtered', 'invalid_output', 'unavailable'] as const;
export const promoUsageSchema = {
  type: 'object', additionalProperties: false,
  required: ['attemptId', 'correlationId', 'stage', 'model', 'mode', 'latencyMs', 'outcome'],
  properties: {
    attemptId: uuid, correlationId: uuid,
    stage: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,47}$' },
    model: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$' },
    mode: { enum: ['text', 'image', 'function_calling', 'structured_outputs'] },
    latencyMs: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
    outcome: { enum: outcomes }, inputTokens: tokenCount, outputTokens: tokenCount, reasoningTokens: tokenCount,
  },
};

type Usage = {
  attemptId: string; correlationId: string; model: string; mode: string; latencyMs: number;
  outcome: typeof outcomes[number]; inputTokens?: number | null; outputTokens?: number | null; reasoningTokens?: number | null;
};
export type PromoUsage = Usage & { stage: string };

export function normalizeOutcome(value: string): Usage['outcome'] {
  const normalized = value.toLowerCase();
  return outcomes.find(entry => entry === normalized) ?? 'error';
}

export function recordUsage(pool: Pool, storeId: string, feature: 'navis' | 'promo', event: Usage, stage: string | null = null) {
  const { attemptId, correlationId, model, mode, outcome, latencyMs, inputTokens = null,
    outputTokens = null, reasoningTokens = null } = event;
  const thinkingMode = mode === 'text' || mode === 'image';
  if (reasoningTokens !== null && (!thinkingMode || (model.startsWith('HCX-') && model !== 'HCX-007'))) {
    throw new InsightError(400, 'INVALID_REQUEST');
  }
  const key = fingerprint({ correlationId, stage, model, mode, outcome, latencyMs, inputTokens, outputTokens, reasoningTokens });
  return inStore(pool, storeId, async db => {
    const identity = [storeId, feature, attemptId];
    const result = await db.query(`
      INSERT INTO insight.ai_usage (store_id, feature, attempt_id, correlation_id, stage, model, mode,
        outcome, latency_ms, input_tokens, output_tokens, reasoning_tokens, fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [...identity, correlationId, stage, model, mode, outcome, latencyMs, inputTokens, outputTokens, reasoningTokens, key]);
    if (result.rowCount) return false;
    const { rows: [prior] } = await db.query<{ fingerprint: string }>(
      'SELECT fingerprint FROM insight.ai_usage WHERE store_id=$1 AND feature=$2 AND attempt_id=$3', identity);
    if (prior?.fingerprint !== key) throw new InsightError(409, 'IDEMPOTENCY_MISMATCH');
    return true;
  });
}
