import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let image: string;

beforeEach(() => {
  image = mkdtempSync(join(tmpdir(), 'navis-entrypoint-'));
  mkdirSync(join(image, 'infra'));
  copyFileSync(new URL('./entrypoint.ts', import.meta.url), join(image, 'infra', 'entrypoint.ts'));
  writeFileSync(join(image, 'infra', 'http.ts'), `
    export const createApp = () => ({});
    export const listen = () => console.log('probe listener started');
    export const startHealthService = listen;
  `);
});

afterEach(() => rmSync(image, { recursive: true, force: true }));

const workloads = [
  ['account', 'services/account/index.ts'],
  ['inventory', 'services/inventory/index.ts'],
  ['api-gateway', 'gateway/index.ts'],
] as const;

function start(workload: string) {
  return spawnSync(process.execPath, ['infra/entrypoint.ts', workload], { cwd: image, encoding: 'utf8', timeout: 5_000 });
}

it.each(workloads)('fails startup for %s when %s is absent', (workload) => {
  const result = start(workload);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toMatchObject({ service: workload, msg: 'Workload initialization failed' });
});

it.each(workloads)('starts %s through its packaged %s', (workload, entrypoint) => {
  const entry = join(image, entrypoint);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, 'console.log("workload entrypoint started");');
  const result = start(workload);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('workload entrypoint started');
});
