import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';

export const services = ['account', 'pos', 'inventory', 'customer', 'marketing', 'insight'] as const;
export type Service = (typeof services)[number];
export type DbRole = 'runtime' | 'migrate' | 'relay' | 'worker';
export type DbMode = 'local' | 'test';

const roleSuffix = { migrate: 'mig', runtime: 'run', relay: 'rly', worker: 'wrk' } as const;

export function dbRoleName(service: Service, role: DbRole): string {
  return `${service}_${roleSuffix[role]}`;
}

export function readSecret(path: string): string {
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error(`Secret file is empty: ${path}`);
  return value;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

export const fileSecret = (name: string): string => readSecret(requiredEnv(name));

export function dbConfig(service: Service, role: DbRole = 'runtime', mode?: DbMode): PoolConfig {
  const user = dbRoleName(service, role);
  const test = mode === 'test' || process.env.NODE_ENV === 'test';
  return {
    host: test ? 'test-db' : process.env.NAVIS_DB_HOST ?? 'db',
    port: 5432,
    database: service,
    user,
    password: readSecret(join(test ? '/run/navis-test-db' : '/run/secrets', `${user}_password`)),
    application_name: user,
    max: 5,
    connectionTimeoutMillis: 2_000,
    query_timeout: 3_000,
  };
}

export function dbPool(service: Service, role: DbRole = 'runtime', mode?: DbMode): Pool {
  return new Pool(dbConfig(service, role, mode));
}
