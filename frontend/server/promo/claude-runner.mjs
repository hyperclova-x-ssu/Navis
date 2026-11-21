// Claude 실행기 — 프로젝트에서 Claude를 부르는 유일한 곳 (ARCHITECTURE 12.1·12.5, D-81).
// 밖에 보이는 것은 run({prompt, images, schema, timeoutMs}) → {output, usage, durationMs} 하나.
// 나중에 API(SDK)로 바꿀 때 이 파일의 구현만 바꾼다.
// 로그 금지: stdout·stderr·프롬프트·사진·생성 코드를 어디에도 쓰지 않는다.
// --bare는 쓰지 않는다: 확인 결과(2026-11-10, claude 2.1.319) --bare는 키체인 읽기를 건너뛰어
// 로그인 계정으로는 "Not logged in"이 된다.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromoError } from './errors.mjs';
import { validateSchema } from './schema.mjs';

const MAX_STDOUT = 4 * 1024 * 1024;
const ENV_KEEP = ['PATH', 'HOME', 'LANG', 'USER', 'LOGNAME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
const UNAVAILABLE_TEXT = /log ?in|logged in|auth|credit|quota|usage limit|rate.?limit|overloaded|billing|subscription|429|401|403|529/i;

export function childEnv(env = process.env) {
  const out = {};
  for (const key of ENV_KEEP) if (env[key]) out[key] = env[key];
  if (!out.LANG) out.LANG = 'en_US.UTF-8';
  return out;
}

export function buildArgs({ model, schema }) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', model, '--json-schema', JSON.stringify(schema),
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
    '--no-session-persistence',
  ];
}

export function buildMessage({ prompt, images = [] }) {
  const content = images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: Buffer.from(img.bytes).toString('base64') } }));
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

function terminate(child) {
  if (!child) return;
  if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); return; } catch {} }
  try { child.kill('SIGKILL'); } catch {}
}

/** stream-json 출력에서 마지막 result 줄을 꺼낸다. */
export function parseStream(raw) {
  let result = null;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try { const obj = JSON.parse(text); if (obj?.type === 'result') result = obj; } catch {}
  }
  return result;
}

export function usageOf(result) {
  const u = result?.usage || {};
  const n = v => (Number.isFinite(v) ? v : 0);
  return { calls: 1, inputTokens: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens), outputTokens: n(u.output_tokens) };
}

export function createClaudeRunner({ command, model = 'sonnet', spawnProcess = spawn, env = process.env, retries = 1, tempRoot = tmpdir() } = {}) {
  async function once({ prompt, images, schema, timeoutMs, signal }) {
    if (!command) throw new PromoError('TOOL_MISSING');
    const cwd = await mkdtemp(join(tempRoot, 'navis-claude-'));
    const started = Date.now();
    try {
      const { code, stdout, timedOut, spawnError } = await new Promise(resolve => {
        let child;
        try {
          child = spawnProcess(command, buildArgs({ model, schema }), { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
        } catch (err) { resolve({ spawnError: err }); return; }
        const out = []; let size = 0; let timedOut = false; let spawnError; let settled = false;
        const finish = value => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); resolve(value); } };
        const timer = setTimeout(() => { timedOut = true; terminate(child); }, timeoutMs);
        const onAbort = () => { timedOut = true; terminate(child); };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        child.stdout?.on('data', chunk => { size += chunk.length; if (size > MAX_STDOUT) terminate(child); else out.push(Buffer.from(chunk)); });
        child.stderr?.resume();
        child.on('error', err => { spawnError = err; });
        // 조각을 모아 한 번에 UTF-8로 푼다(조각마다 풀면 경계에 걸친 한글이 U+FFFD로 깨짐, T-087에서 발견).
        child.on('close', code => finish({ code, stdout: Buffer.concat(out).toString('utf8'), timedOut, spawnError }));
        child.stdin?.on('error', () => {});
        child.stdin?.end(buildMessage({ prompt, images }));
      });
      if (spawnError) throw new PromoError(spawnError.code === 'ENOENT' ? 'TOOL_MISSING' : 'AI_UNAVAILABLE');
      if (timedOut || signal?.aborted) throw new PromoError('AI_TIMEOUT');
      const result = parseStream(stdout);
      if (!result) throw new PromoError(code === 0 ? 'AI_BAD_OUTPUT' : 'AI_UNAVAILABLE');
      if (result.is_error) {
        const text = `${result.subtype || ''} ${typeof result.result === 'string' ? result.result : ''} ${result.api_error_status || ''}`;
        throw new PromoError(UNAVAILABLE_TEXT.test(text) ? 'AI_UNAVAILABLE' : 'AI_BAD_OUTPUT');
      }
      const output = result.structured_output;
      if (output === undefined || output === null || validateSchema(schema, output).length) throw new PromoError('AI_BAD_OUTPUT');
      return { output, usage: usageOf(result), durationMs: Number.isFinite(result.duration_ms) ? result.duration_ms : Date.now() - started };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  return {
    model,
    /** 스키마 불일치·빈 출력(AI_BAD_OUTPUT)만 1회 다시 부른다. 쓴 사용량은 합친다. */
    async run(request) {
      let spent = { calls: 0, inputTokens: 0, outputTokens: 0 };
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await once(request);
          res.usage = { calls: spent.calls + 1, inputTokens: spent.inputTokens + res.usage.inputTokens, outputTokens: spent.outputTokens + res.usage.outputTokens };
          return res;
        } catch (err) {
          spent = { ...spent, calls: spent.calls + 1 };
          if (!(err instanceof PromoError) || err.code !== 'AI_BAD_OUTPUT' || attempt >= retries || request.signal?.aborted) {
            if (err instanceof PromoError) err.usage = spent;
            throw err;
          }
        }
      }
    },
  };
}
