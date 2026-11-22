import { expect, it, vi } from 'vitest';
import { createMarketingProvider } from '../../naver/binding.ts';
import { configureTrendHcx, trendHcxChooser } from './trend-hcx.ts';
import { createTrendRecommendations, defaultTrendKeywords, trendDictionary } from './trend-recommendations.ts';

const now = () => new Date('2026-11-22T09:00:00Z');
const menu = [{ name: '제주 말차 라떼', category: 'beverage' }];

it('starts with ten unique measurable terms including a matched menu and the model picks', async () => {
  const baseline = await createTrendRecommendations(undefined, now)('store', [], menu, 2);
  const modelPick = baseline.items[4];
  const keywords = defaultTrendKeywords({ ...baseline, items: [modelPick], source: 'hcx' }, menu, now());
  expect(new Set(keywords).size).toBe(10);
  expect(keywords).toEqual(expect.arrayContaining(['말차 라떼', modelPick.keyword]));
  expect(trendDictionary.entries.some(entry => /만들|레시피|홈카페/u.test(entry.keyword))).toBe(false);
});

it('validates dictionary ID-only outputs and falls back to current-season candidates on any invalid pick', async () => {
  const baseline = await createTrendRecommendations(undefined, now)('store', [], menu, 2);
  expect(trendDictionary.entries).toHaveLength(72);
  expect(baseline).toMatchObject({ source: 'rule', version: '2026-11' });
  expect(baseline.items).toHaveLength(8);
  expect(baseline.items[0].months).toContain(11);
  const choose = vi.fn(async () => ({ pickedIds: [baseline.items[0].id, 'invented'], explanation: 'must never surface' }));
  expect(await createTrendRecommendations(choose, now)('store', [], menu, 2)).toEqual(baseline);
  expect(choose).toHaveBeenCalledWith('store', expect.objectContaining({ events: 2 }));
});

it('only returns dictionary projections, excludes saved candidates and reuses the store cache', async () => {
  const baseline = await createTrendRecommendations(undefined, now)('store', [], menu, null);
  const [exclude, keep] = baseline.items;
  const choose = vi.fn(async (_store, input) => {
    expect(input.events).toBe(null);
    expect(input.entries.some((entry: { id: string }) => entry.id === exclude.id)).toBe(false);
    return { pickedIds: [keep.id] };
  });
  const select = createTrendRecommendations(choose, now);
  await expect(select('store', [exclude.keyword], menu, null)).resolves.toMatchObject({ source: 'hcx', items: [keep] });
  await select('store', [exclude.keyword], menu, null);
  expect(choose).toHaveBeenCalledTimes(1);
});

it('sends only scoped context and constrains HCX to a bounded enum of supplied IDs', async () => {
  const entry = trendDictionary.entries[0];
  const handler = vi.fn((request: { body?: Uint8Array; storeId: string; url: URL }) => {
    expect(request.storeId).toBe('store');
    expect(request.url.pathname).toBe('/v3/chat-completions/HCX-007');
    const body = JSON.parse(new TextDecoder().decode(request.body));
    expect(JSON.parse(body.messages[1].content)).toEqual({ month: 11, entries: [entry], menu: ['라떼'], events: 2 });
    expect(body.responseFormat).toEqual({ type: 'json', schema: { type: 'object', required: ['pickedIds'], properties: {
      pickedIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', enum: [entry.id] } },
    } } });
    return Response.json({ status: { code: '20000' }, result: { finishReason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ pickedIds: [entry.id] }) } } });
  });
  const provider = createMarketingProvider({ storeId: 'store', providerAccount: 'test', mode: 'fake',
    operations: ['pn14.chat'], fakeHandler: handler, fakeOnly: true });
  const choose = trendHcxChooser(provider);
  const input = { entries: [entry], menu: ['라떼'], month: 11, events: 2 };
  await expect(choose('other-store', input)).rejects.toThrow('unavailable');
  await expect(choose('store', input)).resolves.toEqual({ pickedIds: [entry.id] });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(configureTrendHcx({}, provider)).toBeUndefined();
});

it('accepts only dictionary IDs from the HCX-005 text JSON path', async () => {
  let allowed = true;
  const provider = createMarketingProvider({ storeId: 'store', providerAccount: 'test', mode: 'fake', operations: ['pn14.chat'],
    fakeHandler: request => {
      expect(request.url.pathname).toBe('/v3/chat-completions/HCX-005');
      const body = JSON.parse(new TextDecoder().decode(request.body));
      expect(body).toMatchObject({ maxTokens: 384 });
      expect(body).not.toHaveProperty('responseFormat');
      const context = JSON.parse(body.messages[1].content);
      const ids = allowed ? [context.entries.at(-1).id] : ['outside-dictionary'];
      return Response.json({ status: { code: '20000' }, result: { finishReason: 'stop', message: {
        role: 'assistant', content: `\`\`\`json\n${JSON.stringify({ pickedIds: ids })}\n\`\`\``,
      } } });
    }, fakeOnly: true });
  const choose = configureTrendHcx({ NAVIS_TREND_HCX_MODE: 'fake', NAVIS_TREND_HCX_MODEL: 'HCX-005' }, provider);
  const recommend = createTrendRecommendations(choose, now);
  expect((await recommend('store', [], menu, null)).source).toBe('hcx');
  allowed = false;
  expect((await recommend('store', [], menu, 1)).source).toBe('rule');
});
