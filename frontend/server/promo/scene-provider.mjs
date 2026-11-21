// Scene-stage providers (D-327 Q7). Stages 1–2 (photo look, story) stay NAVER; stage 3 (scene HTML) defaults to Claude.
//   claude     — the headless Claude CLI on the owner's signed-in plan (dev and the moa demo). The default.
//   naver      — the HCX-007 scene pilot (hcx-runner.mjs), kept for comparison runs.
//   claude-api — a server-side Claude API adapter. A STUB: it never runs until the W5 quote/approval and an adapter exist.
// This file is deployed with the server, so nothing here may import from dev/.
import { spawn } from 'node:child_process';
import { PromoError } from './errors.mjs';
import { createClaudeRunner } from './claude-runner.mjs';

// The owner never accepts paid usage credits (D-326 Q8). If the CLI ever offers them, nothing more is called.
const CREDITS = /usage credits|extra usage|switch to .{0,24}credits|add(?:itional)? credits|buy credits/i;
const MAX_WATCHED = 4 * 1024 * 1024;

/** A pay-per-token key or gateway would bill API credits instead of the signed-in plan, so the child never sees them. */
export const baselineEnv = env => Object.fromEntries(Object.entries(env).filter(([key]) => !/^ANTHROPIC_/.test(key)));

/** Reads only facts the baseline table needs from a stream-json run: the exact model id and a credits offer. */
export function inspectStream(stdout, stderr = '') {
  const info = { modelId: null, initModel: null, credits: CREDITS.test(stderr), cliDurationMs: null };
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'system' && event.subtype === 'init') info.initModel = typeof event.model === 'string' ? event.model : null;
    if (event.type === 'result') {
      const ids = Object.keys(event.modelUsage ?? {});
      if (ids.length) info.modelId = ids.join('+');
      if (Number.isFinite(event.duration_ms)) info.cliDurationMs = event.duration_ms;
    }
    if (event.type === 'rate_limit_event' && event.rate_limit_info?.isUsingOverage === true) info.credits = true;
    // Generated HTML lives in assistant turns and structured_output; only the CLI's own messages can offer credits.
    if (event.type !== 'assistant' && event.type !== 'user') {
      const own = { ...event, structured_output: undefined, result: event.is_error ? event.result : undefined };
      if (CREDITS.test(JSON.stringify(own))) info.credits = true;
    }
  }
  info.modelId ??= info.initModel;
  return info;
}

/** Keeps the first MAX_WATCHED bytes of a stream; the CLI's own notices are short and come early or last. */
function watcher(stream) {
  const chunks = []; let size = 0;
  stream?.on('data', chunk => { if (size < MAX_WATCHED) { chunks.push(Buffer.from(chunk)); size += chunk.length; } });
  return () => Buffer.concat(chunks).toString('utf8');
}

/**
 * The same headless CLI path the Claude baseline used (claude-runner.mjs), with its two safeguards:
 * no ANTHROPIC_* variable reaches the child, and a credits offer ends the call, discards its answer and
 * blocks every later call until the server restarts. Repairs and validators live in the pipeline, not here.
 */
export function createClaudeCliRunner({ command, model = 'sonnet', spawnProcess = spawn, env = process.env, retries, tempRoot } = {}) {
  let creditsOffered = false;
  const watchedSpawn = (cmd, args, options) => {
    if (creditsOffered) throw Object.assign(new Error('credits offered'), { code: 'CREDITS_OFFERED' });
    const child = spawnProcess(cmd, args, options);
    const stdout = watcher(child.stdout);
    const stderr = watcher(child.stderr);
    child.on?.('close', () => { if (inspectStream(stdout(), stderr()).credits) creditsOffered = true; });
    return child;
  };
  const inner = createClaudeRunner({ command, model, spawnProcess: watchedSpawn, env: baselineEnv(env), retries, tempRoot });
  const blocked = usage => Object.assign(new PromoError('AI_UNAVAILABLE', 'CLAUDE_CREDITS_OFFERED'), usage ? { usage } : {});
  return {
    model,
    get creditsOffered() { return creditsOffered; },
    async run(request) {
      if (creditsOffered) throw blocked();
      let result;
      try {
        result = await inner.run(request);
      } catch (error) {
        if (creditsOffered) throw blocked(error?.usage);
        throw error;
      }
      if (creditsOffered) throw blocked(result.usage);
      return result;
    },
  };
}

/**
 * Server-side Claude API adapter — a stub. It needs the W5 quote/approval, so it holds no key, reads no environment
 * and makes no network call. `approved` comes from NAVIS_PROMO_CLAUDE_API_APPROVED=true (config.claudeApiApproved);
 * even then it refuses until an adapter is written.
 */
export function createClaudeApiRunner({ approved = false, model = 'sonnet' } = {}) {
  return {
    model,
    async run() {
      throw new PromoError('AI_UNAVAILABLE', approved === true ? 'CLAUDE_API_NOT_IMPLEMENTED' : 'CLAUDE_API_NOT_APPROVED');
    },
  };
}
