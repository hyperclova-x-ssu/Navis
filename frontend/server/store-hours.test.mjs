import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STORE_HOURS, storeHoursGroundingKo, storeHoursSummaryKo, sundayHoursSentenceKo } from './fixtures/store-hours.mjs';
import { LATTE_RECIPE, widgetFixtures } from './fixtures/widget-drafts.mjs';

const content = JSON.parse(await readFile(new URL('../../db/seed/ansungjalbu/content.json', import.meta.url), 'utf8'));

test('the server fixtures copy of STORE_HOURS equals content.json store.hours', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(STORE_HOURS)), content.store.hours);
});

test('the Sunday guidance and answer in the widget-draft fixtures are generated from that copy', () => {
  const [open, close] = content.store.hours.sun;
  assert.equal(sundayHoursSentenceKo(), `일요일에는 ${open}~${close}에 열어요.`);
  assert.equal(storeHoursSummaryKo(), '평일 08:00~22:00 · 토요일 09:30~21:30 · 일요일 10:00~20:30');
  const th3 = widgetFixtures['ai-response']['th-3'];
  assert.equal(th3.facts.guidance, storeHoursGroundingKo());
  assert.ok(th3.facts.approved.includes(sundayHoursSentenceKo()));
});

test('the 카페라테 manual fixture uses the generated café recipe', async () => {
  const { latteRecipe } = JSON.parse(await readFile(new URL('../src/data/db/generated/manifest.json', import.meta.url), 'utf8'));
  const beansG = latteRecipe.find(part => part.itemId === 'i-bean-house' && part.unitDimension === 'g').quantityBase;
  const milkMl = latteRecipe.find(part => part.itemId === 'i-milk' && part.unitDimension === 'mL').quantityBase;
  assert.deepEqual({ ...LATTE_RECIPE }, { beansG, milkMl });
  const steps = widgetFixtures.manuals['mn-latte'].facts.steps;
  assert.ok(steps.some(step => step.includes(`${beansG} g`)));
  assert.ok(steps.some(step => step.includes(`${milkMl} mL`)));
});
