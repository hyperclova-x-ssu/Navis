import { createPrivateKey, createPublicKey } from 'node:crypto';
import { calculateJwkThumbprint, SignJWT } from 'jose';
import { readSecret } from '../../packages/db/index.ts';

export const accessIssuer = 'navis-account';
export const accessAudience = 'navis-api';
const accessLifetime = 600;

export type Role = 'owner' | 'staff';
export interface SessionClaims {
  sid: string;
  sub: string;
  store_id: string;
  role: Role;
}

function publicVerifier(key: unknown) {
  if (!key || typeof key !== 'object' || 'd' in key ||
      !('kty' in key && key.kty === 'EC' && 'crv' in key && key.crv === 'P-256') ||
      !('x' in key && typeof key.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.x)) ||
      !('y' in key && typeof key.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.y))) {
    throw new Error('Expected a public P-256 verifier');
  }
  return createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: 'jwk' }).export({ format: 'jwk' });
}

async function publishedJwk(key: unknown) {
  const { kty, crv, x, y } = publicVerifier(key);
  const publicKey = { kty, crv, x, y };
  return { ...publicKey, kid: await calculateJwkThumbprint(publicKey), alg: 'ES256', use: 'sig' };
}

export async function createSigningKeys(pem: string, publicKeys: unknown = []) {
  if (!Array.isArray(publicKeys)) throw new Error('Expected a public verifier list');
  const signer = createPrivateKey({ key: pem, format: 'pem' });
  const active = await publishedJwk(createPublicKey(signer).export({ format: 'jwk' }));
  const additional = await Promise.all(publicKeys.map(publishedJwk));
  const keys = [...new Map([active, ...additional].map((key) => [key.kid, key])).values()];

  return {
    jwks: { keys },
    async sign(claims: SessionClaims, sessionExpiry: Date) {
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = Math.min(accessLifetime, Math.floor(sessionExpiry.getTime() / 1000) - now);
      if (expiresIn <= 0) return null;
      const accessToken = await new SignJWT({ sid: claims.sid, store_id: claims.store_id, role: claims.role })
        .setProtectedHeader({ alg: 'ES256', kid: active.kid, typ: 'JWT' })
        .setIssuer(accessIssuer)
        .setAudience(accessAudience)
        .setSubject(claims.sub)
        .setIssuedAt(now)
        .setExpirationTime(now + expiresIn)
        .sign(signer);
      return { accessToken, expiresIn, storeId: claims.store_id };
    },
  };
}

export type SigningKeys = Awaited<ReturnType<typeof createSigningKeys>>;

export async function loadSigningKeys(path: string): Promise<SigningKeys> {
  const file = readSecret(path);
  if (!file.startsWith('{')) return createSigningKeys(file);
  const { activePkcs8, publicKeys } = JSON.parse(file);
  if (typeof activePkcs8 !== 'string') throw new Error('Expected an active P-256 signing key');
  return createSigningKeys(activePkcs8, publicKeys);
}
