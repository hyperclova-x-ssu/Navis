import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createVite } from 'vite';
import { createBridge } from './bridge.mjs';
import { navisPlugin } from './vite-plugin.mjs';
import { startPreview } from './preview.mjs';

const { cutoff: { businessDate } } = JSON.parse(await readFile(new URL('../src/data/db/generated/manifest.json', import.meta.url), 'utf8'));
const { sources } = JSON.parse(await readFile(new URL('../src/data/marketing/promo-catalog.json', import.meta.url), 'utf8'));
const privateHost = 'demo.tailnet.invalid:5443';
const privateOrigin = `https://${privateHost}`;
const bridgeOptions = {
  apiKey: 'unused-test-key',
  fetchImpl: async () => new Response([
    'event: token\ndata: {"message":{"content":"[IN] 매장 자료가 없어요."}}\n\n',
    'event: result\ndata: {"message":{"content":"[IN] 매장 자료가 없어요."},"finishReason":"stop"}\n\n',
  ].join(''), { headers: { 'content-type': 'text/event-stream' } }),
};
const promoDir = await mkdtemp(join(tmpdir(), 'navis-promo-hosts-'));
const promo = { config: { dir: promoDir, photoSource: 'cafe' }, tools: { claude: null, browser: null, ffmpeg: null } };
async function checkPromo(base) {
  const catalog = await fetch(`${base}/api/promo/catalog`);
  assert.equal(catalog.status, 200);
  assert.deepEqual((await catalog.json()).photos.map(photo => photo.photoId), sources.cafe);
  assert.equal((await fetch(`${base}/api/promo/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api%2fpromo%2fcatalog`)).status, 404);
  assert.equal((await fetch(`${base}/api/promo/missing`)).status, 404);
}
async function checkPrivateApis(base) {
  for (const path of ['/api/promo/catalog', '/api/navis/reply-test-targets']) {
    const status = (headers = {}) => new Promise((resolve, reject) => {
      get(base + path, { headers: { host: privateHost, ...headers } }, res => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(await status({ 'sec-fetch-site': 'same-origin' }), 200, path);
    assert.equal(await status({ origin: privateOrigin }), 200, path);
    assert.equal(await status(), 403, path);
    assert.equal(await status({ 'sec-fetch-site': 'cross-site' }), 403, path);
  }
}
async function check(base) {
  await checkPromo(base);
  const res = await fetch(`${base}/api/navis/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ text: '매장 자료 요약해줘', snapshot: [], catalog: [] }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const events = await res.text();
  assert.match(events, /event: text_delta\ndata: .*매장 자료가 없어요/);
  assert.match(events, /event: done/);
  const agent = await fetch(`${base}/api/navis/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-navis-protocol': 'agent-v1' },
    body: JSON.stringify({
      layer: 'management', businessDate, runId: 'fake-host', snapshotRevision: 0,
      intent: { kind: 'menu.create', category: 'drink' }, slots: ['name'], catalog: [], snapshot: [],
      searches: [{ kind: 'menu', querySlot: 'name', matches: [] }],
    }),
  });
  assert.equal(agent.status, 200);
  assert.equal(agent.headers.get('x-navis-protocol'), 'agent-v1');
  assert.match(await agent.text(), /event: done\ndata: {"outcome":"clarify","clarification":/);
  const targets = await fetch(`${base}/api/navis/reply-test-targets`);
  assert.deepEqual(await targets.json(), { mode: 'fake', targets: [{ id: 'fake-1', label: '테스트 번호 1' }] });
  const draft = await fetch(`${base}/api/navis/widget-drafts`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ widget: 'manuals', sampleId: 'mn-close' }),
  });
  assert.equal(draft.status, 200);
  assert.equal((await draft.json()).content.title, '마감 정리');
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  assert.equal((await fetch(`${base}/%61pi%2fnavis%2fchat`)).status, 404);
}

async function checkConfirmedMenu(vite, base) {
  const { createWidgetDataStore, selectMenus } = await vite.ssrLoadModule('/src/data/widget-data.ts');
  const { createAssistantProvider } = await vite.ssrLoadModule('/src/features/assistant/provider.ts');
  const store = createWidgetDataStore(undefined, { runId: 'agent-integration' });
  const provider = createAssistantProvider({ store, fetcher: (url, options) => fetch(new URL(url, base), options) });
  const menus = () => selectMenus(store.getSnapshot(), {}).rows;
  const countBefore = menus().length;
  const name = '동백 라테';
  const signal = new AbortController().signal;

  const existing = menus().find(row => row.menuId === 'm-caramel-macchiato');
  assert.deepEqual(existing?.name, { raw: '솔티드 카라멜 마끼아또' });
  for (const text of ['캬라멜 마키야또 메뉴에 넣어줘', '캬라멜 마키야또 5,500원에 메뉴에 넣어줘']) {
    const duplicate = await provider.ask({ text, signal });
    assert.equal(duplicate.turn?.kind, 'refusal');
    assert.equal(duplicate.turn.reason, 'duplicate');
    assert.equal(duplicate.clarification, undefined);
    assert.equal(duplicate.proposal, undefined);
    assert.equal(store.getSnapshot().revision, 0);
    assert.equal(menus().length, countBefore);
  }

  const first = await provider.ask({ text: `${name} 메뉴에 넣어줘`, signal });
  assert.equal(first.clarification?.field, 'price');
  assert.equal(first.proposal, undefined);
  assert.equal(menus().length, countBefore);
  const next = await provider.ask({ text: '5,500원', signal, continuation: { clarificationId: first.clarification.id, price: 5500 } });
  assert.equal(next.proposal?.command, 'menu.create');
  assert.deepEqual(next.proposal.preview, {
    before: null, countBefore, countAfter: countBefore + 1,
    after: { name, category: 'drink', price: 5500, memo: null, saleStatus: 'selling', prepMin: 3, soldQty: 0, cost: null, recipeCount: 0, optionCount: 0, hasPhoto: false },
  });
  assert.equal(menus().length, countBefore);
  await provider.ask({ text: '응', signal });
  assert.equal(store.getSnapshot().revision, 0);
  assert.equal(menus().length, countBefore);
  const receipt = next.proposal.confirm(store);
  assert.equal(receipt.frame.outcome, 'applied');
  assert.equal(menus().length, countBefore + 1);
  assert.deepEqual(menus().at(-1).name, { raw: name });
  assert.equal(store.undo(receipt.notice.undo.token).ok, true);
  assert.equal(menus().length, countBefore);
}

test('Vite serves the fake APIs and confirms and undoes the agent menu proposal in the app store', async () => {
  const plugin = navisPlugin({
    loadEnv: (_mode, _dir, prefix) => prefix === 'NAVIS_' ? { NAVIS_ALLOWED_ORIGINS: privateOrigin } : {},
    createBridge: config => createBridge({ ...config, ...bridgeOptions }),
    promo,
  });
  const vite = await createVite({
    configFile: false, envDir: promoDir, plugins: [plugin], logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, allowedHosts: [new URL(privateOrigin).hostname] },
  });
  await vite.listen();
  try {
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    await check(base);
    await checkPrivateApis(base);
    await checkConfirmedMenu(vite, base);
  } finally { await vite.close(); }
});
test('preview serves static content and the chat, widget and promo APIs using fake transports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navis-static-')); await writeFile(join(dir, 'index.html'), 'preview ok');
  const server = await startPreview({ root: dir, port: 0, bridgeOptions: { ...bridgeOptions, allowedOrigins: privateOrigin }, promoOptions: promo });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal(await (await fetch(base)).text(), 'preview ok'); await check(base);
    await checkPrivateApis(base);
    assert.equal((await fetch(`${base}/api%2fnavis%2fchat`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test.after(() => rm(promoDir, { recursive: true, force: true }));
