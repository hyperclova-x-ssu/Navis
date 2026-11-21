import type { Readable } from 'node:stream';
import { createClovaStudio } from '../../../../frontend/server/clova-studio.mjs';
import { parseStream } from '../../../../frontend/server/promo/claude-runner.mjs';
import { readConfig } from '../../../../frontend/server/promo/config.mjs';
import { PromoError } from '../../../../frontend/server/promo/errors.mjs';
import { createHcxRunner, HCX_PHOTO_MODEL, HCX_PROMO_MODEL } from '../../../../frontend/server/promo/hcx-runner.mjs';
import { createClaudeCliRunner } from '../../../../frontend/server/promo/scene-provider.mjs';
import type { PromoUsage } from '../../../services/insight/usage.ts';

export type ModelStage = 'look' | 'story' | 'scenes';
export type ProviderUsage = Pick<PromoUsage, 'latencyMs' | 'outcome' | 'inputTokens' | 'outputTokens' | 'reasoningTokens'>;
export type Received = {
  state: 'received';
  usage: ProviderUsage | null;
} & ({ output: unknown; error?: never } | { error: string; output?: never });
export type Recovery = Received | { state: 'not_sent' } | { state: 'unknown' };
export type ModelRequest = {
  prompt: string;
  schema: object;
  images?: { bytes: Buffer; mediaType: string; lookKey: string }[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

export interface PromoProvider {
  identity(stage: ModelStage): Pick<PromoUsage, 'model' | 'mode'>;
  invoke(stage: ModelStage, attemptId: string, request: ModelRequest): Promise<Recovery>;
  /** not_sent requires authoritative evidence that this attempt did not start and cannot start late. */
  reconcile(stage: ModelStage, attemptId: string, signal: AbortSignal): Promise<Recovery>;
}

type Spawn = (command: string, args: readonly string[], options: object) => { stdout?: Readable | null };
interface FakeOptions {
  env?: NodeJS.ProcessEnv;
  naverFetch: (stage: ModelStage, attemptId: string) => typeof fetch;
  claudeSpawn: (attemptId: string) => Spawn;
  reconcile?: PromoProvider['reconcile'];
}

type HcxReport = {
  httpStatus: number | null;
  schemaValid: boolean | null;
  latencyMs: number;
  tokens: { input: number | null; output: number | null };
};

const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const errorCode = (error: unknown) => error instanceof PromoError ? error.code as string : 'AI_UNAVAILABLE';

// The existing .mjs factories omit some optional destructured fields from their inferred types.
const createClovaTransport = createClovaStudio as (options: {
  apiKey: string; baseUrl: string; fetchImpl: typeof fetch;
}) => ReturnType<typeof createClovaStudio>;
type Runner = { run(request: ModelRequest): Promise<{ output: unknown }> };
const createNaverStage = createHcxRunner as (options: {
  stage: ModelStage; transport: ReturnType<typeof createClovaStudio>; retries: number;
  beforeCall: () => void; onCall: (report: HcxReport) => void;
}) => Runner;
const createClaudeStage = createClaudeCliRunner as unknown as (options: {
  command: string; model: string; env: NodeJS.ProcessEnv; retries: number; spawnProcess: Spawn;
}) => Runner;

export function createFakePromoProvider({ env = process.env, naverFetch, claudeSpawn, reconcile }: FakeOptions): PromoProvider {
  const config = readConfig(env);
  if (config.sceneProvider === 'claude-api') throw new PromoError('AI_UNAVAILABLE', 'CLAUDE_API_NOT_APPROVED');
  const usesClaude = (stage: ModelStage) => stage === 'scenes' && config.sceneProvider === 'claude';
  const identity: PromoProvider['identity'] = stage => ({
    model: usesClaude(stage) ? config.model : stage === 'look' ? HCX_PHOTO_MODEL : HCX_PROMO_MODEL,
    mode: stage === 'look' ? 'image' : 'structured_outputs',
  });

  async function naver(stage: ModelStage, attemptId: string, request: ModelRequest): Promise<Recovery> {
    const transport = createClovaTransport({
      apiKey: attemptId, baseUrl: 'https://promo-fixture.invalid', fetchImpl: naverFetch(stage, attemptId),
    });
    const metering: HcxReport[] = [];
    const runner = createNaverStage({ stage, transport, retries: 0, beforeCall: () => {},
      onCall: (report: HcxReport) => { metering.push(report); } });
    let output: unknown;
    let error: string | undefined;
    try {
      ({ output } = await runner.run(request));
    } catch (failure) {
      error = errorCode(failure);
    }
    const report = metering[0];
    if (!report) return { state: 'not_sent' };
    const missingProviderResult = !report.httpStatus || report.httpStatus >= 500
      || (report.httpStatus >= 200 && report.httpStatus < 300 && report.schemaValid === null);
    if (error === 'AI_TIMEOUT' || (error && missingProviderResult)) {
      return { state: 'unknown' };
    }
    const usage: ProviderUsage = {
      latencyMs: report.latencyMs,
      inputTokens: report.tokens.input, outputTokens: report.tokens.output,
      outcome: report.httpStatus === 429 ? 'rate_limited' : error === 'AI_BAD_OUTPUT' ? 'invalid_output' : error ? 'error' : 'success',
    };
    return error ? { state: 'received', error, usage } : { state: 'received', output, usage };
  }

  async function claude(attemptId: string, request: ModelRequest): Promise<Recovery> {
    const fake = claudeSpawn(attemptId);
    const chunks: Buffer[] = [];
    let length = 0;
    let started = false;
    const watched: Spawn = (...args) => {
      const child = fake(...args);
      started = true;
      child.stdout?.on('data', (data: Buffer) => {
        length += data.length;
        if (length <= 4 * 1024 * 1024) chunks.push(Buffer.from(data));
      });
      return child;
    };
    const runner = createClaudeStage({ command: 'fake-claude', model: config.model, env: {}, retries: 0, spawnProcess: watched });
    const start = Date.now();
    let output: unknown;
    let error: string | undefined;
    try {
      ({ output } = await runner.run(request));
    } catch (failure) {
      error = errorCode(failure);
    }
    if (!started) return { state: 'not_sent' };
    const result = parseStream(Buffer.concat(chunks).toString('utf8'));
    if (!result) return { state: 'unknown' };
    const inputTokens = tokenCount(result.usage?.input_tokens);
    const usage: ProviderUsage = {
      latencyMs: Date.now() - start,
      outcome: error === 'AI_BAD_OUTPUT' ? 'invalid_output' : error ? 'error' : 'success',
      inputTokens: inputTokens === null ? null : tokenCount(inputTokens
        + (tokenCount(result.usage?.cache_creation_input_tokens) ?? 0)
        + (tokenCount(result.usage?.cache_read_input_tokens) ?? 0)),
      outputTokens: tokenCount(result.usage?.output_tokens),
    };
    return error ? { state: 'received', error, usage } : { state: 'received', output, usage };
  }

  return {
    identity,
    invoke: (stage, attemptId, request) => usesClaude(stage) ? claude(attemptId, request) : naver(stage, attemptId, request),
    reconcile: reconcile ?? (async () => ({ state: 'unknown' })),
  };
}
