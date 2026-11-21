import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { buildArgs, childEnv, createClaudeRunner } from '../claude-runner.mjs';
import { PHOTO_META_SCHEMA } from '../prompts.mjs';
import { PHOTO_META, fakeSpawn, resultLine } from './helpers.mjs';

const schema = PHOTO_META_SCHEMA;
const image = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mediaType: 'image/jpeg' };

test('12.5 인자 그대로, 도구 0개, 빈 임시 cwd(끝나면 지움), 환경변수 최소, 사진은 stdin base64', async () => {
  const seen = [];
  const runner = createClaudeRunner({ command: '/x/claude', model: 'sonnet', spawnProcess: fakeSpawn(() => ({ stdout: resultLine(PHOTO_META) }), seen), env: { PATH: '/bin', HOME: '/h', LANG: 'ko_KR.UTF-8', SECRET_TOKEN: 's', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/c' } });
  const res = await runner.run({ prompt: '사진을 보세요', images: [image], schema, timeoutMs: 1000 });
  assert.deepEqual(res.output, PHOTO_META);
  assert.deepEqual(res.usage, { calls: 1, inputTokens: 110, outputTokens: 50 });
  assert.equal(res.durationMs, 1234);
  const { command, args, options, input } = seen[0];
  assert.equal(command, '/x/claude');
  assert.deepEqual(args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--json-schema', JSON.stringify(schema), '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence']);
  assert.ok(!args.includes('--bare'));
  assert.equal(options.shell, false);
  assert.deepEqual(options.env, { PATH: '/bin', HOME: '/h', LANG: 'ko_KR.UTF-8', CLAUDE_CONFIG_DIR: '/c' });
  await assert.rejects(access(options.cwd));
  const msg = JSON.parse(input);
  assert.equal(msg.type, 'user');
  assert.deepEqual(msg.message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.bytes.toString('base64') } });
  assert.deepEqual(msg.message.content[1], { type: 'text', text: '사진을 보세요' });
});

test('buildArgs·childEnv는 한 곳에서만 만든다', () => {
  assert.equal(buildArgs({ model: 'm', schema: {} })[7], 'm');
  assert.equal(childEnv({}).LANG, 'en_US.UTF-8');
});

test('실패 코드: 실행 파일 없음·시간 초과·로그인 만료·스키마 불일치(1회 재시도)', async () => {
  const missing = createClaudeRunner({ command: '/none', spawnProcess: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  await assert.rejects(missing.run({ prompt: 'p', schema, timeoutMs: 100 }), { code: 'TOOL_MISSING' });
  const noCommand = createClaudeRunner({ command: null });
  await assert.rejects(noCommand.run({ prompt: 'p', schema, timeoutMs: 100 }), { code: 'TOOL_MISSING' });

  const slow = createClaudeRunner({ command: 'c', spawnProcess: fakeSpawn(() => ({ hang: true })) });
  await assert.rejects(slow.run({ prompt: 'p', schema, timeoutMs: 30 }), { code: 'AI_TIMEOUT' });

  const login = createClaudeRunner({ command: 'c', spawnProcess: fakeSpawn(() => ({ stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }) + '\n', code: 1 })) });
  await assert.rejects(login.run({ prompt: 'p', schema, timeoutMs: 100 }), { code: 'AI_UNAVAILABLE' });
  const crashed = createClaudeRunner({ command: 'c', spawnProcess: fakeSpawn(() => ({ stdout: '', code: 1 })) });
  await assert.rejects(crashed.run({ prompt: 'p', schema, timeoutMs: 100 }), { code: 'AI_UNAVAILABLE' });

  const seen = [];
  const bad = createClaudeRunner({ command: 'c', spawnProcess: fakeSpawn(() => ({ stdout: resultLine({ kind: 'nope' }) }), seen) });
  await assert.rejects(bad.run({ prompt: 'p', schema, timeoutMs: 100 }), err => err.code === 'AI_BAD_OUTPUT' && err.usage.calls === 2);
  assert.equal(seen.length, 2);

  let n = 0;
  const flaky = createClaudeRunner({ command: 'c', spawnProcess: fakeSpawn(() => ({ stdout: ++n === 1 ? 'garbage' : resultLine(PHOTO_META) })) });
  const ok = await flaky.run({ prompt: 'p', schema, timeoutMs: 100 });
  assert.equal(ok.usage.calls, 2);
});

test('실행기는 출력·프롬프트를 로그에 쓰지 않는다', async () => {
  const writes = [];
  const orig = [process.stderr.write, console.log, console.error, console.warn, console.info];
  process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
  console.log = console.error = console.warn = console.info = (...a) => writes.push(a.join(' '));
  try {
    const runner = createClaudeRunner({ command: 'c', spawnProcess: fakeSpawn(() => ({ stdout: resultLine(PHOTO_META) })) });
    await runner.run({ prompt: 'SECRET-PROMPT', images: [image], schema, timeoutMs: 100 });
  } finally { [process.stderr.write, console.log, console.error, console.warn, console.info] = orig; }
  assert.ok(!writes.some(w => w.includes('SECRET-PROMPT') || w.includes('financier')));
});

test('T-087: 한글이 stdout 조각 경계에 걸려도 깨지지 않는다(U+FFFD 없음)', async () => {
  const meta = { ...PHOTO_META, subject: '초콜릿 올라간 마지막 하나' };
  const bytes = Buffer.from(resultLine(meta), 'utf8');
  const cut = bytes.indexOf(Buffer.from('올', 'utf8')) + 1; // '올'의 첫 바이트 뒤에서 자름
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); }, final(cb) {
      cb();
      setImmediate(() => { child.stdout.write(bytes.subarray(0, cut)); setImmediate(() => { child.stdout.end(bytes.subarray(cut)); setImmediate(() => child.emit('close', 0)); }); });
    } });
    return child;
  };
  const runner = createClaudeRunner({ command: '/x/claude', spawnProcess, env: { PATH: '/bin' } });
  const res = await runner.run({ prompt: 'p', images: [image], schema, timeoutMs: 2000 });
  assert.equal(res.output.subject, '초콜릿 올라간 마지막 하나');
});
