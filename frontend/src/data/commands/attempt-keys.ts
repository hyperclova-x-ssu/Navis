/** Create this once per form. Ask for a key only when the owner submits the final values. */
export function createCommandAttemptKeys(prefix: string): (fingerprint: string) => string {
  const keys = new Map<string, string>();
  return fingerprint => {
    const existing = keys.get(fingerprint);
    if (existing) return existing;
    const key = `${prefix}:${globalThis.crypto.randomUUID()}`;
    keys.set(fingerprint, key);
    return key;
  };
}
