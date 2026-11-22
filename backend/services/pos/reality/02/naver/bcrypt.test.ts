import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { readSecret } from '../../../../../packages/db/index.ts';
import { bcrypt } from './bcrypt.ts';

// Published OpenBSD/jBCrypt test vectors.
const vectors = [
  ['', '$2a$06$DCq7YPn5Rq63x1Lad4cll.', '$2a$06$DCq7YPn5Rq63x1Lad4cll.TV4S6ytwfsfvkgY8jIucDrjc8deX1s.'],
  ['a', '$2a$06$m0CrhHm10qJ3lXRY.5zDGO', '$2a$06$m0CrhHm10qJ3lXRY.5zDGO3rS2KdeeWLuGmsfGlMfOxih58VYVfxe'],
  ['abc', '$2a$06$If6bvum7DFjUnE9p2uDeDu', '$2a$06$If6bvum7DFjUnE9p2uDeDu0YHzrHM6tf.iqN8.yx.jNN1ILEf7h0i'],
  ['abcdefghijklmnopqrstuvwxyz', '$2a$06$.rCVZVOThsIa97pEDOxvGu', '$2a$06$.rCVZVOThsIa97pEDOxvGuRRgzG64bvtJ0938xuqzv18d3ZpQhstC'],
] as const;

// pgcrypto is provisioned in the NAVER virtual server database, which verifies the Commerce signature the same way.
const virtual = new Pool({ host: 'test-db', database: 'naver_virtual', user: 'nvirtual_run', max: 1,
  password: readSecret('/run/navis-test-db/nvirtual_run_password') });
afterAll(() => virtual.end());

it('matches the published bcrypt vectors', () => {
  for (const [password, salt, expected] of vectors) expect(bcrypt(password, salt)).toBe(expected);
});

it('matches PostgreSQL pgcrypto crypt() for Commerce-shaped inputs and generated salts', async () => {
  const inputs = [
    ['commerce-client_1763866800000', '$2a$04$0123456789abcdef01234.'],
    ['x'.repeat(80), '$2a$05$abcdefghijklmnopqrstuu'],
  ];
  for (let i = 0; i < 6; i++) {
    const { rows: [row] } = await virtual.query<{ salt: string }>('SELECT naver_virtual.gen_salt($1, $2) AS salt', ['bf', 4 + (i % 3)]);
    inputs.push([`${randomBytes(9).toString('base64url')}_${Date.now() + i}`, row.salt]);
  }
  for (const [password, salt] of inputs) {
    const { rows: [row] } = await virtual.query<{ hash: string }>('SELECT naver_virtual.crypt($1, $2) AS hash', [password, salt]);
    expect(bcrypt(password, salt)).toBe(row.hash);
  }
});

it('rejects malformed or overly expensive salts', () => {
  for (const salt of ['', '$1$abc', '$2a$03$0123456789abcdef01234.', '$2a$17$0123456789abcdef01234.', '$2a$04$short']) {
    expect(() => bcrypt('a', salt)).toThrow('Unsupported bcrypt salt');
  }
});
