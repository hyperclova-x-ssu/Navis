// Runs the Node test suites under server/ and scripts/ with the built-in test runner.
// The Navis contract suites (server/navis/n*-contract.test.mjs) replay a recorded
// conversation corpus kept outside this repository; they run only when it is present.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const corpus = existsSync(new URL('../../.evidence/navis-scenarios', import.meta.url));
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.name === 'node_modules' ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
const files = ['server', 'scripts'].flatMap(dir => walk(join(root, dir)))
  .filter(file => file.endsWith('.test.mjs'))
  .filter(file => corpus || !/server\/navis\/n\d+-contract\.test\.mjs$/.test(file))
  .map(file => relative(root, file));

const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
