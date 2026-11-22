import { expect, it } from 'vitest';
import { disposableReplayClock } from './replay-clock.ts';

const instant = '2026-11-22T04:59:59+09:00';
const replay = { NAVIS_REPLAY_DISPOSABLE: '1', NAVIS_REPLAY_INSTANT: instant, NAVIS_DB_HOST: 'db' };

it('pins the disposable service business clock to the same timezone-qualified instant', () => {
  const now = disposableReplayClock(replay)!;
  expect(now().toISOString()).toBe('2026-11-21T19:59:59.000Z');
  expect(now()).not.toBe(now());
  expect(disposableReplayClock({})).toBeUndefined();
});

it('rejects a partial, hosted, non-disposable or invalid replay override', () => {
  for (const override of [
    { NAVIS_REPLAY_DISPOSABLE: '' }, { NAVIS_REPLAY_INSTANT: '' }, { NAVIS_HOSTED_DEMO_AUTH: '1' },
    { NAVIS_DB_HOST: 'hosted-postgres' }, { NAVIS_REPLAY_INSTANT: '2026-02-30T04:59:59+09:00' },
    { NAVIS_REPLAY_INSTANT: '2026-11-22T04:59:59' },
  ]) expect(() => disposableReplayClock({ ...replay, ...override })).toThrow();
});
