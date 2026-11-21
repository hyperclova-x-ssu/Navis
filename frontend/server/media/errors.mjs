export class MediaError extends Error {
  constructor(code, { retryAfter, providerQuota } = {}) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
    this.providerQuota = providerQuota;
  }
}

export const PROVIDER_TIMEOUT_MS = 20_000;

export async function withProviderDeadline(run, cancellation, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const deadline = new AbortController();
  const signal = AbortSignal.any([cancellation, deadline.signal]);
  signal.throwIfAborted();

  const timer = setTimeout(() => deadline.abort(new MediaError('TIMEOUT')), timeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run(signal);
    })]);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
