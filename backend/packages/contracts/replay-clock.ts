export function disposableReplayClock(env: NodeJS.ProcessEnv = process.env): (() => Date) | undefined {
  const { NAVIS_REPLAY_DISPOSABLE: disposable, NAVIS_REPLAY_INSTANT: instant } = env;
  if (!disposable && !instant) return;
  if (disposable !== '1' || env.NAVIS_DB_HOST !== 'db' || env.NAVIS_HOSTED_DEMO_AUTH === '1') {
    throw new Error('Replay clock requires the disposable Compose database');
  }
  const match = instant?.match(/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  const date = match && new Date(`${match[1]}T00:00:00Z`);
  const timestamp = instant && Date.parse(instant);
  if (!date || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== match[1]
    || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new Error('Replay clock requires a timezone-qualified ISO instant');
  }
  return () => new Date(timestamp);
}
