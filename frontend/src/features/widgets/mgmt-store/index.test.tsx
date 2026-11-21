import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { locales, type Locale } from '../../../contracts';
import { widgets, mgmtStoreBundle } from './index';
import { MGMT_STORE_REVIEW_KEYS } from './messages';
import { baseBundles, createTranslator, findDuplicateKeys, findKoGaps, type MessageBundle } from '../../../i18n';
import { dataBundles } from '../../../data/widget-data';
import { makeHost, renderDetail, renderPanel } from './test-helpers';

afterEach(cleanup);

describe('mgmt-store module shape (API-13)', () => {
  it('exports only manuals; removed store panels are absent with Panel, Detail and useSummary', () => {
    expect(widgets.map((m) => m.id)).toEqual(['manuals']);
    for (const m of widgets) {
      expect(typeof m.Panel).toBe('function');
      expect(typeof m.Detail).toBe('function');
      expect(typeof m.useSummary).toBe('function');
    }
  });
  it('has no shared keys and resolves Korean-only additions through ko fallback (API-213)', () => {
    expect(findDuplicateKeys(mgmtStoreBundle, ...(baseBundles as unknown as MessageBundle<string>[]), ...dataBundles)).toEqual([]);
    expect(findKoGaps(mgmtStoreBundle)).toEqual([]);
    for (const loc of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      const translator = createTranslator<string>(loc, mgmtStoreBundle);
      for (const key of Object.keys(mgmtStoreBundle.ko)) {
        expect(translator.t(key), `${loc} ${key}`).not.toBe('');
        expect(translator.t(key), `${loc} ${key}`).not.toBe(key);
      }
    }
    expect(MGMT_STORE_REVIEW_KEYS.length).toBeGreaterThan(0);
  });
  it('only uses the widget.{id}.* names it owns', () => {
    for (const key of Object.keys(mgmtStoreBundle.ko)) {
      expect(key).toMatch(/^widget\.(hiring|manuals|interior|floor-plan)\./);
      expect(key).not.toMatch(/\.(title|coach|aliases)$/);
    }
  });
});

describe('no raw keys on screen in any language', () => {
  const ids = ['manuals'] as const;
  for (const locale of locales as readonly Locale[]) {
    it(`${locale}: panels and details show no key names`, () => {
      for (const id of ids) {
        const { host } = makeHost();
        for (const [w, h] of [[1, 1], [2, 1], [1, 2], [2, 2], [4, 4]] as const) {
          const { container, unmount } = renderPanel(id, w, h, host, { locale });
          expect(container.textContent ?? '').not.toMatch(/\b(widget|data|common|ui)\.[a-z-]+\.[A-Za-z.-]+/);
          unmount();
        }
        const { container, unmount } = renderDetail(id, host, { locale });
        expect(container.textContent ?? '').not.toMatch(/\b(widget|data|common|ui)\.[a-z-]+\.[A-Za-z.-]+/);
        expect(container.textContent?.length ?? 0).toBeGreaterThan(20);
        unmount();
      }
      expect(screen.queryByText(/^widget\./)).toBeNull();
    });
  }
});
