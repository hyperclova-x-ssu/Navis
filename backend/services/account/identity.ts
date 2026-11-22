import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Seed verifies these identifiers against the generated snapshot before writing.
export const demoIdentity = {
  storeId: 'c05409a6-f082-5964-a787-c1ed3184988b',
  userId: '9fee123c-ad63-5539-9775-3381f3c67ffe',
} as const;

export function normalizedLogin(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const login = value.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9@._+-]{0,253}$/.test(login)) return login;
}

function passwordHash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, hash) => {
      if (error) reject(error);
      else resolve(hash);
    });
  });
}

export async function newPassword(password: string) {
  const salt = randomBytes(16);
  return { salt, hash: await passwordHash(password, salt) };
}

const dummySalt = randomBytes(16);
const dummyHash = randomBytes(32);

export async function verifyPassword(password: string, credential?: { salt: Buffer; password_hash: Buffer }) {
  const actual = await passwordHash(password, credential?.salt ?? dummySalt);
  return timingSafeEqual(actual, credential?.password_hash ?? dummyHash) && credential !== undefined;
}
