import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../../', import.meta.url));
const db = 'forecast-test-db';
const redis = 'forecast-test-redis';
const tools = 'forecast-test-tools';
const override = `
services:
  ${db}:
    extends: { file: compose.yaml, service: test-db }
    networks: !override
      forecast-test-data: { aliases: [test-db] }
  ${redis}:
    extends: { file: compose.yaml, service: streams-test-redis }
    networks: !override [forecast-test-data]
    secrets: !reset []
    command: ["redis-server", "--save", "", "--appendonly", "no"]
  ${tools}:
    extends: { file: compose.yaml, service: tools }
    image: navis-backend-local-tools:latest
    build: !reset null
    networks: !override [forecast-test-data]
    secrets: !override
      - { source: test_inventory_relay_password, target: inventory_relay_password }
      - { source: test_pos_relay_password, target: pos_relay_password }
    environment:
      NAVIS_FORECAST_TEST_REDIS_URL: redis://${redis}:6379/3
      NAVIS_INSIGHT_TEST_REDIS_URL: redis://${redis}:6379/2
      NAVIS_DB_HOST: ${db}
networks:
  forecast-test-data: { internal: true }
`;

const mounts = [
  ['services', 'backend/services'], ['workers', 'backend/workers'],
  ['packages', 'backend/packages'], ['gateway', 'backend/gateway'],
  ['infra', 'backend/infra'], ['test', 'backend/test'], ['relay', 'backend/relay'],
  ['../server', 'server'], ['../shared', 'shared'], ['../src', 'src'],
].flatMap(([source, target]) => ['-v', `${join(backend, source)}:/app/${target}:ro`]);

function compose(...args) {
  execFileSync('docker', ['compose', '--env-file', '/dev/null', '-p', 'navis-backend-local',
    '-f', 'compose.yaml', '-f', '-', '--profile', 'test', ...args], {
    input: override, cwd: backend, stdio: ['pipe', 'inherit', 'inherit'],
  });
}

const { bavail, bsize } = statfsSync(backend);
if (bavail * bsize < 3_000_000_000) throw new Error('T-315 requires 3 GB of free disk space');

const run = (...args) => compose('run', '-T', '--rm', '--pull', 'never', '--no-deps', ...mounts, tools, ...args);
try {
  if (process.argv[2] !== 'typecheck') {
    compose('up', '-d', '--pull', 'never', '--no-deps', '--wait', db, redis);
    run('env', 'NODE_ENV=test', 'npm', 'run', 'migrate', '--', 'inventory');
    compose('exec', '-T', db, '/docker-entrypoint-initdb.d/20-stream-access.sh');
  }
  switch (process.argv[2]) {
    case 'typecheck':
      console.info('Checking the forecast worker entrypoint');
      run('node_modules/.bin/tsc', '--noEmit', '--target', 'ES2024', '--module', 'ESNext',
        '--moduleResolution', 'Bundler', '--strict', '--verbatimModuleSyntax', '--skipLibCheck',
        '--allowImportingTsExtensions', '--types', 'node', 'workers/forecast-cron/index.ts');
      run('npm', 'run', 'typecheck');
      break;
    case 'suite':
      run('npm', 'test', '--', '--maxWorkers=1');
      break;
    default:
      run('npm', 'test', '--', 'services/inventory/forecast/forecast.test.ts', ...process.argv.slice(2));
  }
} catch (error) {
  if (typeof error.status !== 'number') throw error;
  process.exitCode = error.status;
} finally {
  if (process.argv[2] !== 'typecheck') compose('rm', '-sf', db, redis);
}
