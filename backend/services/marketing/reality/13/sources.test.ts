import { plainTitle, readSearchLinks } from './sources.ts';
import { describe, expect, it } from 'vitest';
import { parseSearch, readSales } from './sources.ts';

describe('local source contracts', () => {
  it('uses one common date window and rejects invalid intervals', () => {
    expect(parseSearch({ from: '2026-01-01', to: '2026-01-31', keyword: '커피' }).keywordGroups)
      .toEqual([{ groupName: '커피', keywords: ['커피'] }]);
    expect(() => parseSearch({ from: '2026-02-30', to: '2026-01-31', keyword: '커피' })).toThrow();
  });

  it('preserves absent POS data as unavailable', async () => {
    expect(await readSales({}, 'store', { from: '2026-01-01', to: '2026-01-31' })).toEqual({
      status: 'unavailable', source: 'pos', items: [],
    });
  });
});

it('projects only safe display links and keeps failed channels independent', async () => {
  const results = await readSearchLinks(async (_store, channel) => {
    if (channel === 'cafearticle') throw new Error('unavailable');
    return { items: [{ title: '<b>커피</b>', link: 'https://blog.naver.com/coffee', hidden: 'private' },
      { title: 'unsafe', link: 'javascript:alert(1)' }] };
  }, 'store', '커피');
  expect(results.blog).toEqual({ status: 'available', items: [{ title: '커피', url: 'https://blog.naver.com/coffee' }] });
  expect(results.cafearticle).toEqual({ status: 'unavailable', reason: 'provider-failed', items: [] });
});

it('shows plain titles and tells an unbound search port apart from a failed call (RV-GAP-B-N1)', async () => {
  expect(plainTitle('<b>커피</b> &amp; <i>디저트</i> &quot;맛집&quot; &#39;상도&#39; &#x2615; &lt;신상&gt;'))
    .toBe('커피 & 디저트 "맛집" \'상도\' ☕ <신상>');
  expect(plainTitle('a&unknown;b&#0;c')).toBe('a&unknown;bc');
  const unbound = await readSearchLinks(undefined, 'store', '커피');
  expect(unbound.blog).toEqual({ status: 'unavailable', reason: 'not-connected', items: [] });
  expect(unbound.cafearticle).toEqual({ status: 'unavailable', reason: 'not-connected', items: [] });
});
