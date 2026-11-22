import { readFileSync } from 'node:fs';
import { readSecret } from '../../db/index.ts';

export const PERSONA_TOKEN_HEADER = 'x-navis-naver-virtual-token';
export const PERSONA_ACCOUNT_HEADER = 'x-navis-naver-virtual-account';

export const personaOperationPattern = /^pn(?:0[1-9]|1[0-7])\.[a-z][a-z0-9.-]{0,79}$/;
export const personaAccountPattern = /^[a-z][a-z0-9-]{0,63}$/;

export type PersonaGrant = {
  workload: string;
  accountId: string;
  operations: readonly string[];
  token: string;
  providerCredentials?: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function loadPersonaGrants(path: string, accountId: string): PersonaGrant[] {
  const entries: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(entries) || !entries.length) throw new Error('Invalid persona grant list');
  return entries.map((entry: unknown) => {
    if (!record(entry) || typeof entry.workload !== 'string' || entry.accountId !== accountId
      || typeof entry.tokenFile !== 'string' || !Array.isArray(entry.operations)
      || !entry.operations.every((operation: unknown): operation is string => typeof operation === 'string')) {
      throw new Error('Invalid persona workload grant');
    }
    const operations: string[] = entry.operations;
    const files = entry.providerCredentialFiles ?? {};
    if (!record(files)) throw new Error('Invalid persona provider credential map');
    const providerCredentials = Object.fromEntries(Object.entries(files).map(([operation, names]) => {
      if (!operations.includes(operation) || !record(names)) throw new Error('Invalid persona provider credential scope');
      return [operation, Object.fromEntries(Object.entries(names).map(([name, file]) => {
        if (typeof file !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(name)) {
          throw new Error('Invalid persona provider credential reference');
        }
        return [name, readSecret(file)];
      }))];
    }));
    return { workload: entry.workload, accountId, operations, token: readSecret(entry.tokenFile), providerCredentials };
  });
}

export type NaverRequestScope = {
  operation: string;
  providerAccount: string;
  storeId: string;
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array<ArrayBuffer> | undefined;
  approvalScope: unknown;
  signal: AbortSignal;
};

type NaverBindingBase = {
  operation: string;
  storeId: string;
  providerAccount: string;
  grade: 'W' | 'P' | 'O';
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD';
  route: RegExp;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  allowRedirectResponse?: (location: URL) => boolean;
};

type WireCredential = {
  credentialFile: string;
  authorize: (request: NaverRequestScope, credential: string) => HeadersInit | Promise<HeadersInit>;
};

export type NaverBinding = NaverBindingBase & (
  | { mode: 'fake'; handler: (request: NaverRequestScope) => Response | Promise<Response> }
  | ({ mode: 'virtual'; origin?: string; privateTokenFile: string } & (WireCredential | Partial<Record<keyof WireCredential, never>>))
  | ({ mode: 'live'; origin: string; allowedOrigins: readonly string[]; verifiedPartner?: true;
      approve: (request: NaverRequestScope) => boolean | Promise<boolean> } & WireCredential)
);

const personaHost = /^naver-virtual(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.svc(?:\.cluster\.local)?)?$/;

export function validatePersonaOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !personaHost.test(url.hostname)
    || (url.port !== '3000' && (url.port !== '' || url.protocol !== 'https:'))
    || url.origin !== value) throw new Error('Invalid private persona origin');
  return url.origin;
}

export function bindingOrigin(binding: NaverBinding): string {
  if (binding.mode === 'fake') return 'https://naver-fixture.invalid';
  if (binding.mode === 'virtual') return validatePersonaOrigin(binding.origin ?? 'http://naver-virtual:3000');
  const url = new URL(binding.origin);
  if (url.protocol !== 'https:' || url.origin !== binding.origin || !binding.allowedOrigins.includes(url.origin)) {
    throw new Error('Live NAVER origin is outside the operation allowlist');
  }
  if (binding.grade !== 'W' && !binding.verifiedPartner) throw new Error('Live operation requires a verified partner contract');
  return url.origin;
}
