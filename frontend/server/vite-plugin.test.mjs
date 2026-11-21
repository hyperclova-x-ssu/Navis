import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { navisPlugin } from './vite-plugin.mjs';

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook} loads CLOVA, Navis and SENS settings without exposing them to client config`, () => {
    const reads = []; const configurations = []; const mounted = []; const closed = [];
    const media = Object.assign(() => {}, { close: () => closed.push('media') });
    const bridge = Object.assign(() => {}, { close: () => closed.push('bridge') });
    const promo = Object.assign(() => {}, { close: () => closed.push('promo') });
    const plugin = navisPlugin({
      loadEnv: (...args) => {
        reads.push(args);
        if (args[2] === 'NAVIS_') return {
          NAVIS_AGENT_MODE: 'live', NAVIS_AGENT_MODEL: 'HCX-DASH-002',
          NAVIS_ALLOWED_ORIGINS: 'https://proxy.invalid:5443', NAVIS_WIDGET_MODE: 'moa',
          NAVIS_REPLY_SEND_ENABLED: 'true', NAVIS_REPLY_TEST_TARGETS: 'sample=00000000001', NAVIS_UNRELATED: 'excluded',
        };
        if (args[2] === 'CLOVASTUDIO_') return {
          CLOVASTUDIO_API_KEY: 'nonsecret-sentinel', CLOVASTUDIO_BASE_URL: 'https://fake.invalid/',
          CLOVASTUDIO_MODEL: 'HCX-005', VITE_UNRELATED: 'excluded',
        };
        return {
          SENS_SMS_SERVICE_ID: 'example-service', NCP_APIGW_KEY_ID: 'example-id',
          NCP_APIGW_KEY: 'example-signing-material', SENS_SMS_SENDER_NUMBER: '00000000002', SENS_SMS_UNRELATED: 'excluded',
        };
      },
      createBridge: config => { configurations.push(config); return bridge; },
      createMediaService: config => {
        assert.deepEqual(config, {
          allowedOrigins: new Map([['https://proxy.invalid:5443', new Set(['proxy.invalid:5443', 'proxy.invalid'])]]),
        });
        return media;
      },
      createPromoService: config => {
        assert.deepEqual(config, {
          fake: true,
          allowedOrigins: new Map([['https://proxy.invalid:5443', new Set(['proxy.invalid:5443', 'proxy.invalid'])]]),
        });
        return promo;
      },
      promo: { fake: true },
    });
    const server = { config: { root: '/fake/root', envDir: '/fake/environment', mode: 'test' }, middlewares: { use: middleware => mounted.push(middleware) }, httpServer: new EventEmitter() };
    plugin[hook](server);
    assert.deepEqual(reads, [
      ['test', '/fake/environment', 'CLOVASTUDIO_'], ['test', '/fake/environment', 'NAVIS_'],
      ['test', '/fake/environment', ['SENS_SMS_', 'NCP_APIGW_KEY']],
    ]);
    assert.deepEqual(configurations, [{
      apiKey: 'nonsecret-sentinel', baseUrl: 'https://fake.invalid/', model: 'HCX-005', allowedOrigins: 'https://proxy.invalid:5443',
      agentMode: 'live', agentModel: 'HCX-DASH-002',
      widgets: {
        mode: 'moa', sendEnabled: 'true', testTargets: 'sample=00000000001',
        sens: { serviceId: 'example-service', accessKey: 'example-id', secretKey: 'example-signing-material', senderNumber: '00000000002' },
      },
    }]);
    assert.deepEqual(mounted, [media, promo, bridge]);
    assert.equal(plugin.define, undefined); assert.equal(plugin.config, undefined);
    assert.deepEqual(server.config, { root: '/fake/root', envDir: '/fake/environment', mode: 'test' });
    server.httpServer.emit('close'); server.httpServer.emit('close'); assert.deepEqual(closed, ['bridge', 'promo', 'media']);
  });
}

test('envDir falls back to server root, unset settings stay unset for bridge defaults and missing-key handling', () => {
  const reads = []; let config;
  const plugin = navisPlugin({ loadEnv: (...args) => { reads.push(args); return {}; }, createBridge: input => { config = input; return Object.assign(() => {}, { close() {} }); }, createPromoService: () => Object.assign(() => {}, { close() {} }) });
  plugin.configureServer({ config: { root: '/fake/app', mode: 'development' }, middlewares: { use() {} } });
  assert.deepEqual(reads, [
    ['development', '/fake/app', 'CLOVASTUDIO_'], ['development', '/fake/app', 'NAVIS_'],
    ['development', '/fake/app', ['SENS_SMS_', 'NCP_APIGW_KEY']],
  ]);
  assert.deepEqual(config, {
    apiKey: undefined, baseUrl: undefined, model: undefined, allowedOrigins: undefined,
    agentMode: undefined, agentModel: undefined,
    widgets: {
      mode: undefined, sendEnabled: undefined, testTargets: undefined,
      sens: { serviceId: undefined, accessKey: undefined, secretKey: undefined, senderNumber: undefined },
    },
  });
});

test('Vite forwards its server-side Navis scope resolver to the bridge', () => {
  const resolveAgentScope = () => ({ storeId: 'store-a', sessionId: 'session-b' });
  const plugin = navisPlugin({ loadEnv: () => ({}), resolveAgentScope,
    createBridge: config => {
      assert.equal(config.resolveAgentScope, resolveAgentScope);
      return Object.assign(() => {}, { close() {} });
    },
    createPromoService: () => Object.assign(() => {}, { close() {} }),
  });
  plugin.configureServer({ config: { root: '/fake/app', mode: 'development' }, middlewares: { use() {} } });
});
