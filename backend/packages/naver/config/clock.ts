export const PINNED_VIRTUAL_INSTANT = '2026-11-17T06:45:00.000Z';

export function createVirtualClock(mode = 'fixed', systemTime = Date.now): () => Date {
  if (mode === 'real') return () => new Date(systemTime());
  if (mode === 'fixed') return () => new Date(PINNED_VIRTUAL_INSTANT);
  throw new Error('NAVIS_NAVER_VIRTUAL_CLOCK must be fixed or real');
}
import { disposableReplayClock } from '../../contracts/replay-clock.ts';


export function virtualSigningClock(env: NodeJS.ProcessEnv = process.env) {
  return disposableReplayClock(env) ?? createVirtualClock(env.NAVIS_NAVER_VIRTUAL_CLOCK ?? 'real');
}
