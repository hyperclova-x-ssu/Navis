// T-054 app shell bundle: onboarding.* business.* settings.* shell.* (business question, settings, layer menu, coming-soon screens).
// The common bundle already owns app.layer.*, app.comingSoon, common.language/previewStates/close/settings,
// language.*, preview.family.*. Everything else the shell shows is here, in four languages.
// Rows the LOCALES / DS 11.7 tables do not give were written in the LOCALES 1 style (short, soft guide tone) and are counted for R2 review.
import type { MessageBundle } from '../../i18n';

type Row = readonly [key: string, ko: string, en: string, hans: string, hant: string];
const rows = [
  ['onboarding.title', '어떤 가게를 하세요?', 'What kind of shop do you run?', '您经营什么类型的店铺？', '您經營什麼類型的店家？'],
  ['onboarding.description', '가게에 맞는 기능을 먼저 보여 드려요', 'We will show the features that fit your shop first', '先为您展示适合店铺的功能', '先為您顯示適合店家的功能'],
  ['onboarding.skip', '나중에 고를게요', "I'll choose later", '稍后再选', '稍後再選'],
  ['business.group', '업종', 'Business type', '业态', '業態'],
  ['settings.content', '설정 내용', 'Settings', '设置内容', '設定內容'],
  ['settings.business', '업종', 'Business type', '业态', '業態'],
  ['settings.businessNone', '아직 고르지 않았어요', 'Not chosen yet', '尚未选择', '尚未選擇'],
  ['settings.changeBusiness', '업종 바꾸기', 'Change business type', '更改业态', '更改業態'],
  ['settings.businessChanged', '{business}에 맞게 추천 기능을 바꿨어요', 'Recommendations now fit {business}', '已换成适合{business}的推荐', '已換成適合{business}的推薦'],
  ['settings.mode', '화면 모드', 'Display mode', '显示模式', '顯示模式'],
  ['settings.modeLight', '라이트로 보기', 'Light mode', '浅色模式', '淺色模式'],
  ['settings.modeDark', '다크로 보기', 'Dark mode', '深色模式', '深色模式'],
  ['settings.modeCurrent', '현재 선택: {mode}', 'Current: {mode}', '当前选择：{mode}', '目前選擇：{mode}'],
  ['settings.modeLightName', '라이트', 'Light', '浅色', '淺色'],
  ['settings.modeDarkName', '다크', 'Dark', '深色', '深色'],
  ['settings.byWidgetTitle', '패널별로 고르기', 'Choose by widget', '按小组件选择', '依小工具選擇'],
  ['settings.byWidgetNone', '고른 패널 없음', 'None chosen', '未选择小组件', '未選擇小工具'],
  ['shell.screens', '화면', 'Screens', '页面', '頁面'],
  ['shell.soon', '{layer, particle, 은/는} 준비 중이에요', '{layer} is coming soon', '{layer}敬请期待', '{layer}敬請期待'],
  ['shell.backToManagement', '관리로 돌아가기', 'Back to Management', '返回管理', '返回管理'],
] as const satisfies readonly Row[];

export type ShellKey = (typeof rows)[number][0];
const build = (index: 1 | 2 | 3 | 4) => Object.fromEntries(rows.map((r) => [r[0], r[index]])) as Record<ShellKey, string>;

export const shellBundle: MessageBundle<ShellKey> = { id: 'shell', ko: build(1), en: build(2), 'zh-Hans': build(3), 'zh-Hant': build(4) };

/** Rows whose en / zh text is the worker's own writing (no LOCALES / DS 11.7 row), for R2 review. */
const sourced = new Set(['settings.byWidgetTitle', 'settings.modeLight', 'settings.modeDark']);
export const shellReviewKeys: readonly ShellKey[] = rows.map((r) => r[0]).filter((k) => !sourced.has(k));
