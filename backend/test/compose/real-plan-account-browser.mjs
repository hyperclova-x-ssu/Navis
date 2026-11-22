import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withPage } from '../../../../.evidence/tools/chrome.mjs';

const compose = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const edge = 'http://127.0.0.1:18280';
const first = randomUUID();
const second = randomUUID();
const firstName = '계정 시험 첫 매장';
const secondName = '계정 시험 두 번째 매장';
const loginId = `${randomUUID()}@example.invalid`;
const password = randomBytes(24).toString('base64url');
const provisionFile = join(dirname(compose), `owner-${randomUUID()}.json`);
mkdirSync(evidence, { recursive: true });
try {
  for (const [storeId, storeName] of [[first, firstName], [second, secondName]]) {
    writeFileSync(provisionFile, JSON.stringify({ loginId, password, ownerName: '합성 점주', storeId, storeName }), { mode: 0o600 });
    chmodSync(provisionFile, 0o444);
    execFileSync('docker', ['compose', '-f', compose, '--profile', 'tools', 'run', '--rm', '--no-deps',
      '-e', 'NAVIS_OWNER_PROVISION_FILE=/run/secrets/browser-owner',
      '-v', `${provisionFile}:/run/secrets/browser-owner:ro`, 'tools', 'node', 'packages/db/cli.ts', 'provision-owner'],
    { stdio: 'ignore' });
    rmSync(provisionFile);
  }
} finally {
  rmSync(provisionFile, { force: true });
}

const viewport = { width: 1920, height: 1080, colorScheme: 'dark', locale: 'ko-KR', reducedMotion: 'reduce' };
const route = (page, method, path) => page.waitForResponse(response =>
  response.request().method() === method && new URL(response.url()).pathname === path);
const record = (store, path) => `/api/v1/stores/${store}/${path}`;
const panel = page => page.locator('article[data-feature-id="menu"]').first();

async function signIn(page) {
  page.setDefaultTimeout(7000);
  await page.goto(edge);
  await page.getByLabel('아이디').fill(loginId);
  await page.getByLabel('비밀번호').fill(password);
  const loggedIn = route(page, 'POST', '/api/v1/auth/login');
  await page.getByRole('button', { name: '들어가기' }).click();
  assert.equal((await loggedIn).status(), 200);
}

async function setupBoard(page, store) {
  await page.getByRole('button', { name: '카페', exact: true }).click();
  await page.getByText('선불형', { exact: false }).first().click();
  const boardSaved = route(page, 'PUT', record(store, 'boards/management'));
  const profileSaved = route(page, 'PATCH', record(store, 'profile'));
  await page.getByRole('button', { name: '이 화면으로 시작하기' }).click();
  assert.equal((await profileSaved).status(), 200);
  const response = await boardSaved;
  assert.equal(response.status(), 200);
  await panel(page).waitFor();
  return (await response.json()).revision;
}

async function settings(page) {
  const button = page.getByRole('button', { name: '설정', exact: true });
  for (const label of ['안내 닫기', '닫기']) {
    const close = page.getByRole('button', { name: label, exact: true }).first();
    if (await close.isVisible()) await close.click();
  }
  await button.click();
}

async function switchStore(page) {
  await settings(page);
  await page.getByRole('button', { name: /매장 바꾸기/ }).click();
  const switched = route(page, 'POST', '/api/v1/auth/store');
  await page.getByRole('radio', { name: secondName }).click();
  const response = await switched;
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).storeId, second);
}

async function checkSecondStore(page) {
  await panel(page).waitFor();
  await settings(page);
  await page.getByRole('button', { name: new RegExp(secondName) }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '라이트' }).getAttribute('aria-selected'), 'true');
}

await withPage(viewport, async page => {
  await signIn(page);
  await setupBoard(page, first);
  await switchStore(page);
  await setupBoard(page, second);
  await settings(page);
  const preference = route(page, 'PATCH', record(second, 'preferences'));
  await page.getByRole('tab', { name: '라이트' }).click();
  assert.equal((await preference).status(), 200);
  const boardsAfterReload = route(page, 'GET', record(second, 'boards'));
  await page.reload();
  assert.equal((await boardsAfterReload).status(), 200);
  await checkSecondStore(page);
});

await withPage(viewport, async page => {
  await signIn(page);
  await panel(page).waitFor();
  await switchStore(page);
  await checkSecondStore(page);
  await page.screenshot({ path: join(evidence, 'account-new-session.png') });
  const logout = route(page, 'POST', '/api/v1/auth/logout');
  await page.getByRole('button', { name: '로그아웃' }).click();
  assert.equal((await logout).status(), 204);
  await page.getByRole('heading', { name: '로그인', exact: true }).waitFor();
});
console.info('PASS browser credential sign-in, store selection, onboarding board, preference change, reload, new context and sign-out');
