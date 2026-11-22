import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import ts from 'typescript';

let seed;
let inputs;
let files;
const modules = new Map();
before(async () => {
  seed = await import('./seed-from-content.mjs');
  inputs = await seed.readSeedInputs();
  files = seed.buildSeedFiles(inputs);
  for (const [name, source] of files) {
    if (!name.endsWith('.ts')) continue;
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    const url = 'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64');
    modules.set(name.slice(0, -3), Object.values(await import(url))[0]);
  }
});

function data(name) {
  assert.ok(modules.has(name), name);
  return modules.get(name);
}

test('independent generations produce the same bytes', () => {
  assert.deepEqual(seed.buildSeedFiles(inputs), files);
});

test('check detects input, manifest, and output drift without rewriting files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cafe-seed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seed.publishSeedFiles(directory, files);
  await seed.publishSeedFiles(directory, files, { check: true });

  const changedInput = seed.buildSeedFiles({ ...inputs, supplementSource: inputs.supplementSource + '\n' });
  await assert.rejects(seed.publishSeedFiles(directory, changedInput, { check: true }), /manifest\.json/);
  const manifest = join(directory, 'manifest.json');
  assert.equal(await readFile(manifest, 'utf8'), files.get('manifest.json'));

  const today = join(directory, 'today.ts');
  await writeFile(today, '// stale\n');
  await assert.rejects(seed.publishSeedFiles(directory, files, { check: true }), /today\.ts/);
  assert.equal(await readFile(today, 'utf8'), '// stale\n');
  await rm(today);
  await assert.rejects(seed.publishSeedFiles(directory, files, { check: true }), /today\.ts/);

  await writeFile(join(directory, 'obsolete.ts'), '');
  await assert.rejects(seed.publishSeedFiles(directory, files, { check: true }), /obsolete\.ts/);
});

test('emitted POS, money and catalog reconcile to the planned cutoff', () => {
  const today = data('today');
  const history = data('history');
  const catalog = data('catalog');
  const members = data('members');
  assert.equal(today.pos.businessDate, '2026-11-17');
  assert.equal(today.pos.orders.length, 153);
  assert.equal(today.pos.payments.length, 153);
  const amounts = { card: 0, easy_pay: 0, cash: 0 };
  for (const payment of today.pos.payments) {
    assert.ok(payment.at <= '2026-11-17T15:45:00');
    for (const split of payment.splits) amounts[split.method] += split.amount;
  }
  assert.deepEqual(amounts, { card: 557050, easy_pay: 217270, cash: 56900 });
  assert.equal(Object.values(amounts).reduce((sum, amount) => sum + amount, 0), 831220);
  assert.equal(today.rollup.net, 831220);
  assert.equal(today.rollup.cost, 244333);
  assert.equal(today.rollup.expenses, 110000);
  assert.equal(today.pos.drawer.opening + amounts.cash, 256900);
  assert.equal(today.pos.drawer.actual, null);
  assert.equal(today.bookings.length, 1);
  assert.equal(today.bookings[0].status, 'completed');
  assert.equal(history.comparison.date, '2026-11-10');
  assert.equal(history.comparison.net, 882160);
  assert.equal(history.days.filter(day => day.date >= '2026-11-11').reduce((sum, day) => sum + day.net, today.rollup.net), 6706290);
  assert.equal(catalog.menu.length, 25);
  assert.equal(members.members.length, 460);
  assert.equal(data('closing-history').length, 89);
  const latte = catalog.menu.find(item => item.menuId === 'm-cafe-latte');
  assert.equal(latte.unitCost, 1278);
  assert.deepEqual(latte.recipeBase.map(part => [part.itemId, part.quantityBase, part.unitDimension]), [
    ['i-bean-house', 18, 'g'], ['i-milk', 260, 'mL'], ['i-cup-takeout', 1, 'pcs'],
  ]);
});

test('strawberry cake has a priced recipe and six portions available without seeded sales', () => {
  const cake = data('catalog').menu.find(item => item.menuId === 'm-strawberry-cake');
  assert.equal(cake?.name, '딸기 케이크');
  assert.equal(cake.category, 'dessert');
  assert.equal(cake.price, 6500);
  assert.equal(cake.unitCost, 2420);
  assert.deepEqual(cake.recipeBase.map(part => part.itemId), ['i-strawberry', 'i-fresh-cream', 'i-cake-sponge', 'i-strawberry-cake-slice']);
  const today = data('today');
  assert.ok(![today.rollup, ...data('history').days].some(day => day.menu.some(([id]) => id === cake.menuId)));
  const portions = cake.recipeBase.map(part => {
    const balance = today.stock.find(item => item.itemId === part.itemId && item.channel === 'store');
    return Math.floor(balance.onHand / part.quantityBase);
  });
  assert.deepEqual(portions, [6, 6, 6, 6]);
});

test('ref-1 bakery menus expose one tracked finished piece per sale at the cutoff', () => {
  const catalog = data('catalog');
  const stock = data('today').stock;
  for (const [slug, name, unitCost, remaining] of [
    ['saltbread', '겉바속촉 버터 소금빵', 1418, 12],
    ['bagel-plain', '구운 플레인 베이글', 1218, 7],
    ['basque-cake', '바스크 치즈케이크', 2518, 18],
    ['cookie-choco', '르뱅 초코칩 쿠키', 1318, 9],
  ]) {
    const menu = catalog.menu.find(row => row.menuId === `m-${slug}`);
    const finished = catalog.items.find(row => row.itemId === `i-${slug}`);
    assert.equal(menu.name, name);
    assert.equal(menu.unitCost, unitCost);
    assert.equal(finished.name.replace(/\s*(?:완제품|\(조각\))$/u, ''), name);
    assert.equal(finished.trackRestock, true);
    assert.equal(finished.unitDimension, 'pcs');
    assert.equal(menu.recipeBase.find(row => row.itemId === finished.itemId)?.quantityBase, 1);
    assert.equal(stock.find(row => row.itemId === finished.itemId && row.channel === 'store')?.onHand, remaining);
  }
});

test('each supplement record has sample provenance and valid cafe references', () => {
  const catalog = data('catalog');
  const members = data('members');
  const today = data('today');
  const operations = data('operations');
  const supplement = data('supplement');
  const memberIds = new Set(members.members.map(row => row.memberId));
  const menuIds = new Set(catalog.menu.map(row => row.menuId));
  const itemIds = new Set(catalog.items.map(row => row.itemId));
  const productIds = new Set(operations.membershipProducts.map(row => row.productId));
  const staffIds = new Set(supplement.staff.map(row => row.staffId));
  const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function withinHours(row) {
    const weekday = weekdays[new Date(row.date + 'T00:00:00Z').getUTCDay()];
    const [open, close] = catalog.store.hours[weekday];
    assert.ok(open <= row.start && row.start < row.end && row.end <= close);
  }
  assert.deepEqual(supplement.promos, []);
  for (const [section, records] of Object.entries(supplement)) {
    if (section !== 'promos') assert.ok(records.length > 0, section);
    for (const row of records) {
      assert.equal(row.provenance, 'sample');
      if (row.memberId) assert.ok(memberIds.has(row.memberId));
      if (row.menuId) assert.ok(menuIds.has(row.menuId));
      if (row.itemId) assert.ok(itemIds.has(row.itemId));
      if (row.productId) assert.ok(productIds.has(row.productId));
      if (row.staffId) assert.ok(staffIds.has(row.staffId));
    }
  }
  assert.equal(supplement.staff.filter(row => row.role === 'manager').length, 1);
  assert.equal(supplement.staff.filter(row => row.role === 'hourly' && row.hourlyWage === 10500).length, 4);
  for (const shift of supplement.shifts) withinHours(shift);
  const onDuty = supplement.shifts.filter(row => row.date === today.pos.businessDate && row.start <= '15:45' && '15:45' < row.end);
  assert.equal(onDuty.length, 2);
  for (const booking of supplement.bookings) {
    withinHours(booking);
    assert.equal(booking.date, today.pos.businessDate);
    assert.ok(booking.start > '15:45' && booking.partySize > 0 && booking.partySize <= catalog.store.seats);
    const overlapping = supplement.bookings.filter(other => other.start <= booking.start && other.end > booking.start);
    assert.ok(overlapping.reduce((sum, row) => sum + row.partySize, 0) <= catalog.store.seats);
  }
  for (const row of supplement.taxPayments) {
    assert.ok(row.dueOn > today.pos.businessDate);
    assert.equal(row.basisAmount, operations.expenses.filter(expense => expense.businessDate.startsWith(row.basisMonth) && expense.category === row.basisCategory).reduce((sum, expense) => sum + expense.amount, 0));
  }
  assert.ok(supplement.grants.every(row => row.applyEnd > today.pos.businessDate));
  assert.ok(supplement.cctv.some(row => row.entries !== row.orderCount));
  assert.ok(supplement.expiryBatches.every(row => catalog.items.some(item => item.itemId === row.itemId && item.trackRestock)));
});
