import { createHash } from 'node:crypto';

export class CardError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
