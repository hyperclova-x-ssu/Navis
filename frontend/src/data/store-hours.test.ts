import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LATTE_RECIPE } from './db/latte-recipe';
import manifest from './db/generated/manifest.json';
import { createSeedTables } from './db/seed';
import { dataBundle } from './messages';
import { managementBundle } from './messages/management';
import { STORE_HOURS, STORE_WEEKDAYS, storeHoursGrounding, storeHoursOn, storeHoursSummary, storeOpenClose } from './store-hours';

const content = JSON.parse(readFileSync(resolve(__dirname, '../../../db/seed/ansungjalbu/content.json'), 'utf8'));

describe('STORE_HOURS (S-1: one set of hours, from content.json)', () => {
  it('equals content.json store.hours for every weekday', () => {
    expect(JSON.parse(JSON.stringify(STORE_HOURS))).toEqual(content.store.hours);
    expect([...STORE_WEEKDAYS]).toEqual(Object.keys(content.store.hours));
  });

  it('the server fixtures copy equals the same JSON (and so this constant)', async () => {
    const path = resolve(__dirname, '../../server/fixtures/store-hours.mjs');
    const copy = await import(/* @vite-ignore */ path) as { STORE_HOURS: unknown };
    expect(JSON.parse(JSON.stringify(copy.STORE_HOURS))).toEqual(JSON.parse(JSON.stringify(STORE_HOURS)));
  });

  it('writes the week as 평일 · 토요일 · 일요일 in every language', () => {
    expect(storeHoursSummary('ko')).toBe('평일 08:00~22:00 · 토요일 09:30~21:30 · 일요일 10:00~20:30');
    expect(storeHoursSummary('en')).toBe('Weekdays 08:00–22:00 · Saturday 09:30–21:30 · Sunday 10:00–20:30');
    expect(storeHoursSummary('zh-Hans')).toBe('平日 08:00–22:00 · 周六 09:30–21:30 · 周日 10:00–20:30');
    expect(storeHoursSummary('zh-Hant')).toBe('平日 08:00–22:00 · 週六 09:30–21:30 · 週日 10:00–20:30');
    expect(storeHoursOn('sun')).toBe('10:00~20:30');
    expect(storeOpenClose('sat')).toEqual({ open: '09:30', close: '21:30' });
  });

  it('every hours sentence the app shows is generated from the constant', () => {
    const [sunOpen, sunClose] = content.store.hours.sun;
    // store-info manual (영업시간 및 운영 정보)
    expect(managementBundle.ko['data.management.info.hours.body']).toBe(storeHoursSummary('ko'));
    // grounding line for message drafts, in all 4 languages
    for (const [locale, bundle] of [['ko', dataBundle.ko], ['en', dataBundle.en], ['zh-Hans', dataBundle['zh-Hans']], ['zh-Hant', dataBundle['zh-Hant']]] as const) {
      expect(bundle['data.storeInfo.hours']).toBe(storeHoursGrounding(locale));
    }
    // "Are you open on Sundays?" draft names Sunday's own open and close time
    expect(dataBundle.ko['data.inquiry.draft.hours']).toBe(`네, 일요일에도 ${sunOpen}부터 ${sunClose}까지 열어요.`);
    expect(dataBundle.en['data.inquiry.draft.hours']).toContain(`${sunOpen} to ${sunClose}`);
    expect(dataBundle['zh-Hans']['data.inquiry.draft.hours']).toContain(`${sunOpen} 到 ${sunClose}`);
    expect(dataBundle['zh-Hant']['data.inquiry.draft.hours']).toContain(`${sunOpen} 到 ${sunClose}`);
  });

  it('the seeded store-info manual includes the cafe identity and hours', () => {
    const tables = createSeedTables();
    const hoursInfo = tables.manual.find((m) => 'key' in m.title && m.title.key === 'data.management.info.hours');
    expect(hoursInfo?.section).toBe('store-info');
    expect(tables.manualStep.find((s) => s.manualId === hoursInfo!.manualId)?.body).toEqual({
      raw: `${manifest.store.name}\n${manifest.store.address}\n${storeHoursGrounding()}`,
    });
  });
});

describe('카페라떼 recipe (S-1: manual text and recipe seed come from one constant)', () => {
  it('the active recipe and localized manual text use LATTE_RECIPE', () => {
    const tables = createSeedTables();
    const lines = tables.recipeLine.filter((line) => line.menuId === 'm-cafe-latte');
    const { beansG, milkMl } = LATTE_RECIPE;
    expect(lines.find((line) => line.itemId === 'i-bean-house')).toMatchObject({ quantity: beansG, unit: 'g' });
    expect(lines.find((line) => line.itemId === 'i-milk')).toMatchObject({ quantity: milkMl, unit: 'mL' });
    expect(dataBundle.ko['data.manual.latteRecipe.step1']).toContain(`${beansG} g`);
    expect(dataBundle.ko['data.manual.latteRecipe.step2']).toContain(`${milkMl} mL`);
    expect(dataBundle.en['data.manual.latteRecipe.step1']).toContain(`${beansG} g`);
    expect(dataBundle.en['data.manual.latteRecipe.step2']).toContain(`${milkMl} mL`);
    expect(dataBundle['zh-Hans']['data.manual.latteRecipe.step2']).toContain(`${milkMl}`);
    expect(dataBundle['zh-Hant']['data.manual.latteRecipe.step2']).toContain(`${milkMl}`);
  });

  it('the server fixtures manual uses the same numbers', async () => {
    const path = resolve(__dirname, '../../server/fixtures/widget-drafts.mjs');
    const copy = await import(/* @vite-ignore */ path) as { LATTE_RECIPE: unknown };
    expect(JSON.parse(JSON.stringify(copy.LATTE_RECIPE))).toEqual({ ...LATTE_RECIPE });
  });

  it('LATTE_RECIPE equals the source cafe latte recipe', () => {
    const recipe = content.menu.find((item: { id: string }) => item.id === 'm-cafe-latte').recipe as { ingredient: string; qty_base: number }[];
    expect(LATTE_RECIPE).toEqual({
      beansG: recipe.find(line => line.ingredient === 'i-bean-house')?.qty_base,
      milkMl: recipe.find(line => line.ingredient === 'i-milk')?.qty_base,
    });
  });
});
