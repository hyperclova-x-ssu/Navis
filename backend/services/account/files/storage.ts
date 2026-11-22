import { mkdirSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { uuidPattern } from '../sessions.ts';

const objectKey = new RegExp(uuidPattern);

export function createLocalPromoStorage(directory: string) {
  if (!isAbsolute(directory)) throw new Error('Promo storage requires an absolute private directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  function path(key: string) {
    if (!objectKey.test(key)) throw new Error('Invalid private object key');
    return join(directory, key);
  }

  return {
    async write(key: string, bytes: Buffer): Promise<void> {
      const file = path(key);
      // The reservation row stays locked while writing. Cleanup can remove a temp file left by a crash.
      const temporary = `${file}.upload`;
      await rm(temporary, { force: true });
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    },
    async read(key: string): Promise<Buffer | undefined> {
      try {
        return await readFile(path(key));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async remove(key: string): Promise<void> {
      const file = path(key);
      await rm(file, { force: true });
      await rm(`${file}.upload`, { force: true });
    },
  };
}

export interface PromoStorage {
  write(key: string, bytes: Buffer, scope: { storeId: string; mime: string }): Promise<void>;
  read(key: string, scope: { storeId: string }): Promise<Buffer | undefined>;
  remove(key: string, scope: { storeId: string }): Promise<void>;
}

export function withNcpPromoStorage(local: PromoStorage, ncp: PromoStorage): PromoStorage {
  return {
    write: ncp.write,
    async read(key, scope) { return await ncp.read(key, scope) ?? await local.read(key, scope); },
    async remove(key, scope) {
      await ncp.remove(key, scope);
      await local.remove(key, scope);
    },
  };
}
