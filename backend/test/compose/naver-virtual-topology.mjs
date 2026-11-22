import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../..', import.meta.url));
const rendered = JSON.parse(execFileSync('docker', [
  'compose', '--env-file', '/dev/null', '--profile', '*', 'config', '--format', 'json',
], { cwd: backend, encoding: 'utf8' }));
const provider = rendered.services['naver-virtual'];
assert.ok(provider, 'The virtual server needs a Compose workload');
assert.equal(provider.build.target, 'naver-virtual');
assert.match(provider.healthcheck.test.join(' '), /127\.0\.0\.1:3000\/readyz/);
assert.deepEqual(provider.ports ?? [], [], 'The virtual server has no host-published ports');
assert.deepEqual(Object.keys(provider.networks).sort(), ['naver-virtual-api', 'naver-virtual-data']);
for (const name of Object.keys(provider.networks)) assert.equal(rendered.networks[name].internal, true);

for (const name of ['edge', 'api-gateway', 'frontend', 'insight-navis', 'relay']) {
  const workload = rendered.services[name];
  assert.ok(Object.keys(provider.networks).every(network => !(network in workload.networks)), `${name} has no virtual server network`);
  assert.ok(!Object.keys(workload.environment ?? {}).some(key => key.startsWith('NAVIS_NAVER_VIRTUAL_')), `${name} has no virtual server origin or grants`);
}

const migration = rendered.services['naver-virtual-tools'];
assert.deepEqual(migration.command, ['node', '--experimental-transform-types', 'services/naver-virtual/migrate.ts']);
assert.deepEqual(Object.keys(migration.networks), ['naver-virtual-data']);
assert.deepEqual(migration.secrets.map(secret => secret.source), ['nvirtual_mig_password']);
assert.ok('naver-virtual-data' in rendered.services.db.networks);
assert.ok(provider.secrets.some(secret => secret.source === 'nvirtual_run_password'));
assert.ok(provider.secrets.every(secret => !secret.source.endsWith('_mig_password')));
assert.equal(provider.environment.NAVIS_NAVER_VIRTUAL_GRANTS_FILE, '/etc/navis/naver-virtual-grants.json');
assert.equal(provider.environment.NAVIS_NAVER_VIRTUAL_CLOCK, 'fixed');

const mounts = provider.configs.find(config => config.target === provider.environment.NAVIS_NAVER_VIRTUAL_GRANTS_FILE);
assert.ok(mounts, 'The virtual server mounts the operation grant list');
const grants = JSON.parse(rendered.configs[mounts.source].content);
const byWorkload = Object.fromEntries(grants.map(grant => [grant.workload, grant]));
const identities = new Set();
const receiverTokens = { customer: 'nvirtual_aicall_customer_token', marketing: 'nvirtual_talktalk_marketing_token' };
const wirePrefix = '/run/navis-naver-virtual/provider/';
const talkTalkCallbackFile = '/run/secrets/' + receiverTokens.marketing;
const ownerGrantOperation = 'pn11.fixture.owner-grant';
for (const grant of grants) {
  assert.equal(grant.accountId, 'ansungjalbu-cafe');
  assert.equal(new Set(grant.operations).size, grant.operations.length);
  assert.ok(grant.operations.every(operation => /^pn\d\d\.[a-z][a-z.-]*$/.test(operation)));
  assert.ok(grant.operations.every(operation => !/^pn0[68]\.fixture\./.test(operation)), 'Fixture dispatch is proof-only');
  assert.ok(!identities.has(grant.workload), 'One grant identity per workload');
  identities.add(grant.workload);
  const credential = grant.tokenFile.replace('/run/secrets/', '');
  assert.ok(provider.secrets.some(secret => secret.source === credential), 'Provider mounts the referenced token');
  const caller = rendered.services[grant.workload];
  assert.ok('naver-virtual-api' in caller.networks && !('naver-virtual-data' in caller.networks));
  assert.equal(caller.environment.NAVIS_NAVER_VIRTUAL_ORIGIN, 'http://naver-virtual:3000');
  assert.equal(caller.environment.NAVIS_NAVER_VIRTUAL_TOKEN_FILE, grant.tokenFile);
  const providerFiles = new Set(Object.entries(grant.providerCredentialFiles ?? {})
    .filter(([operation]) => operation !== ownerGrantOperation).flatMap(([, fields]) => Object.values(fields)));
  assert.equal(caller.environment.NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR, '/run/secrets');
  const expected = [credential, receiverTokens[grant.workload], ...[...providerFiles]
    .filter(file => file.startsWith(wirePrefix)).map(file => `nvirtual_${file.split('/').at(-1).replaceAll('-', '_')}`)].filter(Boolean);
  assert.deepEqual(new Set(caller.secrets.filter(secret => secret.source.startsWith('nvirtual_')).map(secret => secret.source)),
    new Set(expected));
  for (const [operation, fields] of Object.entries(grant.providerCredentialFiles ?? {})) {
    assert.ok(grant.operations.includes(operation));
    for (const [field, file] of Object.entries(fields)) {
      assert.ok(file.startsWith(wirePrefix) || (operation === 'pn06.chatbot.send'
        && field === 'talktalkCallbackToken' && file === talkTalkCallbackFile));
    }
  }
}
assert.equal(provider.environment.NAVIS_NAVER_VIRTUAL_TALKTALK_CALLBACK_URL, 'http://marketing:3000/internal/v1/naver/talktalk/webhook');
assert.equal(rendered.services.marketing.environment.NAVIS_NAVER_VIRTUAL_TALKTALK_CALLBACK_TOKEN_FILE, talkTalkCallbackFile);
assert.ok(provider.secrets.some(secret => secret.source === receiverTokens.marketing));
assert.ok(byWorkload.customer.operations.includes('pn02.bookings.confirm'));
for (const [workload, scope] of [['customer', 'calendar'], ['marketing', 'cafe']]) {
  assert.deepEqual(byWorkload[workload].providerCredentialFiles[ownerGrantOperation], {
    storeId: wirePrefix + 'owner-store-id', actorId: wirePrefix + 'owner-actor-id', scopes: wirePrefix + scope + '-owner-scope',
  });
}
assert.equal(grants.filter(grant => grant.operations.includes(ownerGrantOperation)).length, 2);
assert.ok(byWorkload.marketing.providerCredentialFiles?.['pn06.chatbot.send']?.talktalkAuthorization);
assert.ok(byWorkload['marketing-worker'].providerCredentialFiles?.['pn13.brandmessage.send']?.consentedRecipients);
assert.ok(byWorkload.insight.providerCredentialFiles?.['pn15.receipt']?.invokeKey);
assert.ok(byWorkload.inventory.providerCredentialFiles?.['pn16.commerce.token']?.clientSecret);
assert.notEqual(byWorkload.inventory.providerCredentialFiles['pn16.commerce.token'].clientId, byWorkload.pos.providerCredentialFiles['pn16.commerce.token'].clientId);
assert.ok(!byWorkload.pos.operations.includes('pn16.commerce.options.update'));
assert.notEqual(byWorkload.account.providerCredentialFiles['pn16.object.put'].keyPrefix, byWorkload['marketing-worker'].providerCredentialFiles['pn16.object.put'].keyPrefix);
assert.ok(!byWorkload.marketing.operations.some(operation => operation.startsWith('pn13.')));
assert.ok(byWorkload['marketing-worker'].operations.includes('pn13.sms.send'));
for (const [credential, members] of [
  ['marketing_customer_sms_token', ['customer', 'marketing']],
  ['marketing_sms_worker_token', ['marketing', 'marketing-worker']],
]) {
  const mounted = Object.entries(rendered.services).filter(([, service]) =>
    service.secrets?.some(secret => secret.source === credential)).map(([name]) => name);
  assert.deepEqual(mounted.sort(), members.sort());
}
assert.ok(provider.volumes.some(mount => mount.target === '/run/navis-naver-virtual/provider' && mount.read_only));
console.info('PASS NAVER Virtual Server Compose has private networks, isolated migration credentials, and scoped grants');
