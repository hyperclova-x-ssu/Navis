import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const base = new URL('../../../.evidence/navis-scenarios/', import.meta.url);
export const evidence = name => readFileSync(new URL(name, base), 'utf8');
const csvFields = line => [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/gu)]
  .map(([, quoted, literal]) => quoted === undefined ? literal : quoted.replaceAll('""', '"'));

export function readTrace() {
  const [header, ...lines] = evidence('TRACE.csv').trimEnd().split(/\r?\n/u).map(csvFields);
  return lines.map(fields => {
    assert.equal(fields.length, header.length, 'Invalid trace row width');
    return Object.fromEntries(header.map((field, index) => [field, fields[index]]));
  });
}

class MissingFixtureToken extends Error {
  constructor(path) {
    super(`missing-token ${path}`);
  }
}

function resolveReferences(value, facts) {
  const lookup = path => {
    const result = path.split('.').reduce((record, field) => {
      if (!record || !Object.hasOwn(record, field)) throw new MissingFixtureToken(path);
      return record[field];
    }, facts);
    if (result === undefined) throw new MissingFixtureToken(path);
    return result;
  };
  if (Array.isArray(value)) return value.map(item => resolveReferences(item, facts));
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, 'cafe')) return lookup(value.cafe);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, facts)]));
  }
  if (typeof value === 'string') {
    const exact = /^\{\{([\w.-]+)\}\}$/u.exec(value);
    if (exact) {
      const resolved = lookup(exact[1]);
      return Array.isArray(resolved) ? resolved : String(resolved);
    }
    return value.replace(/\{\{([\w.-]+)\}\}/gu, (_, key) => String(lookup(key)));
  }
  return value;
}

function resolvePatch(patch, facts) {
  try {
    return resolveReferences(patch, facts);
  } catch (error) {
    if (!(error instanceof MissingFixtureToken)) throw error;
    return { fixtureBlock: error.message };
  }
}

async function cafeSelectorValues(vite) {
  const [fixture, data, dates, reservations, messages, marketing, promoMessages] = await Promise.all([
    vite.ssrLoadModule('/src/features/assistant/__fixtures__/scenario-cafe.ts'),
    vite.ssrLoadModule('/src/data/widget-data.ts'),
    vite.ssrLoadModule('/src/data/db/time.ts'),
    vite.ssrLoadModule('/src/data/derive/reservations.ts'),
    vite.ssrLoadModule('/src/features/assistant/messages.ts'),
    vite.ssrLoadModule('/src/data/marketing/derive.ts'),
    vite.ssrLoadModule('/src/features/widgets/mkt-promo/messages.ts'),
  ]);
  const facts = fixture.cafeScenarioValues();
  const snapshot = data.createWidgetDataStore().getSnapshot();
  const stock = data.deriveStock(snapshot, { date: facts.today });
  const tr = messages.navisTranslator('ko');
  const references = marketing.REFERENCE_IDS.map((id, index) => ({
    id, name: id === 'ref-2' ? `디자인 ${index + 1}번` : promoMessages.mktPromoBundle.ko[`promo.ref.${id}.name`],
  }));
  const menuSeed = menuSelectorValues(data, snapshot, facts, tr);
  const quantity = (value, unit) => tr.format.quantity(value, unit);
  const ingredient = itemId => {
    const row = stock.rows.find(item => item.itemId === itemId);
    assert.ok(row, itemId);
    return { id: row.itemId, sku: row.sku, unit: row.unit, current: row.raw,
      opening: quantity(row.opening, row.unit), used: quantity(row.usedToday, row.unit),
      remaining: quantity(row.stock, row.unit), daysLeft: row.usedToday > 0 ? quantity(Math.floor(row.stock / row.usedToday), 'day') : null,
      usingMenus: row.usingMenus.filter(menu => menu.name).map(menu => data.resolveDataText(tr.t, menu.name)) };
  };
  const preview = (itemId, update) => {
    const store = data.createWidgetDataStore();
    const result = store.dispatch({ type: 'inventory.updateItem', itemId, ...update });
    assert.ok(result.ok, itemId);
    const after = data.deriveStock(store.getSnapshot(), { date: facts.today });
    const beforeRow = stock.rows.find(row => row.itemId === itemId);
    const afterRow = after.rows.find(row => row.itemId === itemId);
    return {
      before: { stock: beforeRow.stock, threshold: beforeRow.restockThreshold },
      after: { stock: afterRow.stock, threshold: afterRow.restockThreshold },
      delta: afterRow.raw - beforeRow.raw,
      unit: afterRow.unit, display: quantity(afterRow.stock, afterRow.unit),
      restockCount: after.restockCount, outOfStockCount: after.outOfStockCount,
    };
  };
  const milk = ingredient('i-milk'), beans = ingredient('i-bean-house'), cup = ingredient('i-cup-takeout');
  const tomorrow = dates.addDays(facts.today, 1);
  const todayVisits = data.selectReservations(snapshot, { date: facts.today });
  const visitsTomorrow = data.selectReservations(snapshot, { date: tomorrow });
  const allocation = (date, time, partySize) => {
    const { tableId, status, allocationWarning } = reservations.allocateReservation(snapshot.tables, { date, time, partySize }, 'auto');
    return { tableId, status, warning: allocationWarning ?? null };
  };
  const waiting = todayVisits.rows.find(visit => visit.canConfirm);
  const requestVisit = todayVisits.rows.find(visit => visit.status === 'confirmed' && visit.request?.raw);
  assert.ok(waiting, 'The café fixture needs a visit eligible for single confirmation');
  assert.ok(requestVisit, 'The café fixture needs a confirmed visit with a request');
  return {
    ...facts, menuSeed, tomorrow, tomorrowRange: { kind: 'dateRange', start: tomorrow, end: tomorrow },
    promo: {
      themes: marketing.CONCEPTS.map(id => tr.t(`data.marketing.concept.${id}`)),
      designs: { ...references, names: references.map(reference => reference.name) },
    },
    saturdayRange: { kind: 'dateRange', start: facts.thisSaturday, end: facts.thisSaturday },
    inventorySeed: { milk, beans, cup,
      edits: {
        milk5000: preview(milk.id, { stock: 5000 }), milk500: preview(milk.id, { stock: 500 }),
        milk5: preview(milk.id, { stock: 5 }),
        milkThreshold6000: preview(milk.id, { threshold: 6000 }),
        milk5000Threshold6000: preview(milk.id, { stock: 5000, threshold: 6000 }),
        beans2500: preview(beans.id, { stock: 2500 }), beans3000: preview(beans.id, { stock: 3000 }),
        beans500: preview(beans.id, { stock: 500 }), cupThreshold100: preview(cup.id, { threshold: 100 }),
        cup120: preview(cup.id, { stock: 120 }),
      },
    },
    visitSeed: {
      people: quantity(todayVisits.partyTotal, 'person'),
      requests: todayVisits.rows.filter(row => row.request?.raw || row.requestKey)
        .map(row => row.request?.raw ?? tr.t(row.requestKey)),
      phone: quantity(todayVisits.rows.filter(row => row.counts && row.source === 'phone_ai').length, 'reservation'),
      direct: quantity(todayVisits.rows.filter(row => row.counts && row.source === 'direct').length, 'reservation'),
      completed: quantity(todayVisits.rows.filter(row => row.status === 'completed').length, 'reservation'),
      eligible: quantity(todayVisits.rows.filter(row => row.canMarkCompleted).length, 'reservation'),
      nextCount: quantity(visitsTomorrow.count, 'reservation'), nextPeople: quantity(visitsTomorrow.partyTotal, 'person'),
      waitingCount: quantity(todayVisits.needsCheckCount, 'reservation'), waitingId: waiting.reservationId,
      requestVisit: { id: requestVisit.reservationId, time: requestVisit.time },
      tableLayoutEnabled: todayVisits.tableLayoutEnabled,
      allocation: {
        '020': allocation(facts.today, '19:00', 4), '021': allocation(tomorrow, '12:00', 3),
        '024': allocation(facts.today, '20:00', 2), '038': allocation(facts.today, '19:00', 6),
        '037': allocation(facts.today, '17:00', 4),
        '039': allocation(facts.today, '17:00', 12),
      },
    },
  };
}

function menuSelectorValues(data, snapshot, facts, tr) {
  const money = value => tr.format.money(value, 'full');
  const label = row => data.resolveDataText(tr.t, row.name ?? { key: row.nameKey });
  const menus = data.selectMenus(snapshot, {}).rows;
  const menu = id => {
    const row = menus.find(item => item.menuId === id);
    assert.ok(row, id);
    return row;
  };
  const sold = row => row.category !== 'dessert'
    ? `${tr.format.number(row.soldQty)}${tr.t('common.navis.agent.menuCups')}`
    : tr.format.count(row.soldQty, 'count');
  const top = [...menus].sort((a, b) => b.soldQty - a.soldQty)[0];
  const { americano, latte, vanilla } = facts;
  const prices = {
    americano: americano.price,
    latte: latte.price,
    vanilla: vanilla.price,
    americanoUp500: americano.price + 500,
    latteUp500: latte.price + 500,
    latteUp10Percent: latte.price * 110 / 100,
    latteRounded10: Math.round(latte.price * 110 / 10000) * 100,
    vanillaUp5Percent: vanilla.price * 105 / 100,
    vanillaUp7Percent: vanilla.price * 107 / 100,
    vanillaRounded5: Math.round(vanilla.price * 105 / 10000) * 100,
    vanillaRounded7: Math.round(vanilla.price * 107 / 10000) * 100,
  };
  const estimate = (entry, next) => {
    const { profit, rate, profitDelta, rateDelta } = data.simulateMenuPrice({ price: entry.price, unitCost: entry.cost, ...next },
      { price: entry.price, unitCost: entry.cost });
    return { profit: money(profit), rate: tr.format.percent(rate, 1),
      profitDelta: money(profitDelta), rateDelta: tr.format.delta(rateDelta, 'pp') };
  };
  const margin = data.readModel(snapshot, 'margin');
  const marginTop = margin.menus.filter(row => row.qty > 0 && row.contribution !== null)
    .sort((a, b) => b.contribution - a.contribution)[0];
  const latteMargin = margin.menus.find(row => row.menuId === latte.id);
  const menuLabels = rows => rows.map(row => [label(row), money(row.price)]).flat();
  return {
    prices,
    priceDisplay: Object.fromEntries(Object.entries(prices).map(([key, value]) => [key, money(value)])),
    priceList: menuLabels(menus),
    dessertList: menuLabels(menus.filter(row => row.category === 'dessert')),
    firstFive: menus.slice(0, 5).map(label),
    coldBrew: menus.filter(row => label(row).includes('콜드브루'))
      .map(row => ({ id: row.menuId, name: label(row), price: row.price, display: money(row.price) })),
    soldOutDisplay: tr.format.count(menus.filter(row => row.saleStatus === 'sold_out').length, 'count'),
    top: { name: label(top), sold: sold(top) },
    latteSold: sold(menu(latte.id)),
    latteCost: money(latte.cost),
    latteRecipe: menu(latte.id).recipeLines.map(line => tr.format.quantity(line.quantity, line.unit)),
    americanoMemo: data.resolveDataText(tr.t, menu(americano.id).memo),
    noMemo: tr.t('common.navis.agent.menuNoMemo'),
    unchanged: tr.t('common.navis.agent.unchanged'),
    prompts: {
      price: tr.t('common.navis.agent.priceQuestion'),
      priceInvalid: tr.t('common.navis.agent.priceInvalid'),
      exactPrice: tr.t('common.navis.agent.menuExactPrice'),
      recipeUnit: tr.t('common.navis.agent.menuUnitMismatch'),
      option: tr.t('common.navis.agent.menuOptionQuestion'),
      marginPeriods: tr.t('common.navis.agent.menuMarginPeriods'),
      unsupportedPeriod: tr.t('common.navis.agent.unsupportedPeriod'),
    },
    latteMargin: [money(latteMargin.unitCost), money(latteMargin.price), money(latteMargin.unitMargin), tr.format.percent(latteMargin.rate, 1)],
    marginTop: [label(marginTop), money(marginTop.contribution)],
    marginCoverage: { costMissing: margin.costMissing, rate: tr.format.percent(margin.rate, 1) },
    estimates: {
      americano5000: estimate(americano, { price: 5000 }),
      latteCost2000: estimate(latte, { unitCost: 2000 }),
    },
  };
}

// D-323 and D-324 supersede the older free-text confirmation expectations.
const cardOnly = {
  'S8-045': 'Agreement leaves the card pending. Press the card to apply the change.',
  'S8-052': 'Agreement makes no change. Pressing the stale card requires a fresh proposal.',
  'S8-053': 'Repeated agreement makes no change. Repeated card presses apply the change once.',
  'S8-054': 'Typed agreement and deletion requests leave the card pending. Press the card and its extra confirmation to delete the item.',
};

// The review used the gallery's field name. Keep the proposal oracle on the existing command argument.
function normalizePromotionDesign(id, patch) {
  if (id !== 'S6-023' || !patch.expected) return patch;
  const { expected } = patch;
  return { ...patch, expected: {
    ...expected,
    // The local editor and the stored draft have different undo receipts. N18 verifies the local receipt.
    ...(expected.kind === 'proposal' && { undo: null }),
    ...(expected.ask && { ask: expected.ask.map(field => field === 'designRef' ? 'referenceId' : field) }),
    ...(expected.tools && { tools: expected.tools.map(call => {
      if (call.name !== 'propose_action' || call.args.command !== 'promo.draft.set' || !Object.hasOwn(call.args.args ?? {}, 'designRef')) return call;
      const { designRef, ...args } = call.args.args;
      if (args.referenceId !== undefined && args.referenceId !== designRef) return call;
      return { ...call, args: { ...call.args, args: { ...args, referenceId: designRef } } };
    }) }),
  } };
}

const taxEvidenceRemovals = new Set(['S2-088', 'S2-091']);

function applyReviewedBoundaries(id, patch) {
  if (taxEvidenceRemovals.has(id)) {
    return { ...patch, writes: 'none', reason: 'B17: open the tax evidence workflow without a chat proposal or prefill.',
      expected: { kind: 'refuse', widgetOnly: true, tools: [], ask: [], answer_must_contain: [],
        result_state: 'No change.', reflect: [], undo: 'n/a' } };
  }
  if (id === 'S6-019') {
    return { ...patch, n18PromoDraft: { featureId: 'promo-video', view: 'create' },
      expected: { ...patch.expected, result_state: 'No change.', reflect: [], undo: 'n/a' } };
  }
  return patch;
}

export async function readCafeScenarios(vite, { overlay: suppliedOverlay, extendFacts } = {}) {
  const server = vite ?? await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false, envFile: false, envDir: false, logLevel: 'silent',
    server: { middlewareMode: true, watch: null, ws: false, hmr: false },
  });
  let facts;
  try {
    facts = await cafeSelectorValues(server);
    if (extendFacts) facts = await extendFacts(facts);
  } finally {
    if (!vite) await server.close();
  }
  const overlay = suppliedOverlay ? { ...suppliedOverlay } : JSON.parse(evidence('CAFE-OVERLAY.json'));
  for (const [id, rule] of Object.entries(cardOnly)) {
    const patch = overlay[id];
    overlay[id] = { ...patch, reason: rule, expected: { ...patch?.expected, kind: 'answer', tools: [], ask: [],
      answer_must_contain: [], result_state: rule, reflect: [], undo: 'n/a' }, n02: { ...patch?.n02, control: 'hold' },
    support_note: rule, tester_check: rule };
  }
  const corpus = new Map(JSON.parse(evidence('MERGED.json')).map(scenario => [scenario.id, scenario]));
  for (const [id, authoredPatch] of Object.entries(overlay)) {
    const patch = applyReviewedBoundaries(id, authoredPatch);
    const scenario = corpus.get(id);
    assert.ok(scenario && patch.reason, `Invalid reviewed overlay entry ${id}`);
    const { variants, ...basePatch } = patch;
    const { reason, expected, policyGap, ...rest } = normalizePromotionDesign(id, resolvePatch(basePatch, facts));
    const resolvedVariants = variants && Object.fromEntries(Object.entries(variants)
      .map(([index, variant]) => [index, normalizePromotionDesign(id, resolvePatch(variant, facts))]));
    const releasedExpected = { ...scenario.expected, ...expected };
    corpus.set(id, {
      ...scenario, ...rest, review: reason ?? patch.reason, ...(variants && { variants: resolvedVariants }),
      expected: { ...releasedExpected, ...policyGap?.expected },
      ...(policyGap ? { policyGap: { decision: policyGap.decision, slice: policyGap.slice }, releasedExpected } : {}),
    });
  }
  for (const [id, scenario] of corpus) {
    const precondition = scenario.precondition.replace(/2026-10-26 Mon(?: at)? 15:45/gu, `${facts.today} ${facts.weekday} ${facts.clock}`);
    // D-353 keeps the authored menu creation case and uses the new beverage value for its explicit expected row.
    const expected = id === 'S1-025' ? { ...scenario.expected,
      tools: scenario.expected.tools?.map(call => call.name === 'propose_action' && call.args.command === 'menu.create'
        && call.args.args.category === 'drink' ? { ...call, args: { ...call.args, args: { ...call.args.args, category: 'beverage' } } } : call),
      result_state: scenario.expected.result_state.replace(' / drink / ', ' / beverage / '),
    } : scenario.expected;
    corpus.set(id, { ...scenario, precondition, expected });
  }
  return { corpus, facts, overlay };
}

export function releasedScenario(scenario) {
  return scenario.policyGap ? { ...scenario, expected: scenario.releasedExpected } : scenario;
}

export function scenarioVariant(scenario, index) {
  const override = scenario.variants?.[index + 1];
  return override ? { ...scenario, ...override, expected: { ...scenario.expected, ...override.expected } } : scenario;
}
