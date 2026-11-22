/**
 * App header copy for the 배치 편집 button next to 마감 정산 (U-B), in the four languages.
 * Plain data, not a registered MessageBundle: a new bundle id needs a line in src/i18n/all-bundles.test.ts (not part of U-B), and the
 * `closing` bundle must stay a Korean-only round (D-209). The zh Han characters are still checked by src/assets/fonts/coverage.test.ts.
 * Convert to a MessageBundle ('app-header') when the registry line can be added.
 */
import type { Locale } from '../contracts';
export interface LayoutEditCopy { readonly button: string; readonly open: string; readonly empty: string }
export const layoutEditCopy: Readonly<Record<Locale, LayoutEditCopy>> = {
  ko: { button: '배치 편집', open: '배치 편집하기', empty: '먼저 패널을 추가해 주세요' },
  en: { button: 'Edit layout', open: 'Edit layout', empty: 'Add a panel first' },
  'zh-Hans': { button: '编辑布局', open: '编辑布局', empty: '请先添加面板' },
  'zh-Hant': { button: '編輯版面', open: '編輯版面', empty: '請先新增面板' },
};
