// T-052 dashboard.* message bundle (ARCHITECTURE 11.6: this prefix belongs to the dashboard screen).
// Korean: DESIGN_SYSTEM 7 (existing dashboard words) and 11.11 (recommended-layout notice). Page, help, layer,
// group, search and Navis phrases are read from the common, ui and navis bundles and are not repeated here.
// English and Chinese rows that DS 11.11 does not give were written by T-052 in the LOCALES 1 style
// (short, soft guide tone; Simplified and Traditional separate) and are counted for R2 review.
import { defineBundle } from '../../i18n';

type Row = readonly [key: string, ko: string, en: string, hans: string, hant: string];
const businessKo = '{business, select, cafe {카페} restaurant {음식점} pub {주점} beauty {미용·뷰티} retail {소매} academy {학원} fitness {운동} other {기타}}';
const businessEn = '{business, select, cafe {cafes} restaurant {restaurants} pub {pubs} beauty {salons} retail {shops} academy {academies} fitness {gyms} other {stores like yours}}';
const businessHans = '{business, select, cafe {咖啡店} restaurant {餐厅} pub {酒吧} beauty {美容美发} retail {零售} academy {培训机构} fitness {健身房} other {其他}}';
const businessHant = '{business, select, cafe {咖啡廳} restaurant {餐廳} pub {酒吧} beauty {美容美髮} retail {零售} academy {補習班} fitness {健身房} other {其他}}';
const rows = [
  ['dashboard.rail.label', '기능 열', 'Features', '功能栏', '功能欄'],
  ['dashboard.title', '우리 가게', 'Management', '管理', '管理'],
  // U-A2: the empty-state card no longer repeats the top-right tip ("pick the features here"); it only states the situation above its start button.
  ['dashboard.empty.hint', '아직 패널이 없어요', 'No panels yet', '还没有面板', '還沒有面板'],
  ['dashboard.starter.business', `${businessKo} 사장님이 많이 쓰는 3개로 시작하기`, `Start with 3 picks popular with ${businessEn}`, `从${businessHans}老板常用的 3 个开始`, `從${businessHant}老闆常用的 3 個開始`],
  ['dashboard.starter.general', '많이 쓰는 3개로 시작하기', 'Start with 3 popular picks', '从常用的 3 个开始', '從常用的 3 個開始'],
  ['dashboard.coach.choose', '필요한 기능을 여기서 눌러 추가해요', 'Pick the features you need here', '在这里选择需要的功能', '在這裡選擇需要的功能'],
  ['dashboard.coach.resize', '길게 누른 뒤 모서리를 끌면 크기가 바뀌어요', 'Drag a corner to resize', '拖动边角可调整大小', '拖曳邊角可調整大小'],
  // The header button is named "배치 편집" (U-A1); en / zh names follow it.
  ['dashboard.coach.move', "길게 누르거나 위의 '배치 편집'을 눌러 옮길 수 있어요", "Press and hold, or tap 'Edit layout' above, to move it", '长按，或点按上方的“编辑布局”即可移动', '長按，或點按上方的「編輯版面」即可移動'],
  ['dashboard.coach.next', '다음', 'Next', '下一步', '下一步'],
  ['dashboard.coach.close', '안내 닫기', 'Close tip', '关闭提示', '關閉提示'],
  ['dashboard.coach.note', '안내', 'Tip', '提示', '提示'],
  ['dashboard.coach.scroll', '코칭 안내 본문', 'Tip text', '提示内容', '提示內容'],
  ['dashboard.navis.open', 'Navis 열기', 'Open Navis', '打开 Navis', '開啟 Navis'],
  ['dashboard.navis.close', 'Navis 닫기', 'Close Navis', '关闭 Navis', '關閉 Navis'],
  ['dashboard.navis.closedReply', '창을 닫았어요', 'Closed the chat', '已关闭对话', '已關閉對話'],
  ['dashboard.navis.placed', '{name} 패널을 추가했어요', 'Placed {name}', '已放置{name}', '已放置{name}'],
  ['dashboard.drop.blocked', '여기에 놓을 수 없어요', "Can't drop it here", '无法放在这里', '無法放在這裡'],
  ['dashboard.drop.error', '놓을 자리를 확인하지 못했어요. 다시 시도해 주세요', "Couldn't check the spot. Please try again", '无法确认放置位置，请重试', '無法確認放置位置，請重試'],
  ['dashboard.resize.outside', '격자 밖으로 커질 수 없어요', "It can't grow past the grid", '不能超出网格', '不能超出網格'],
  ['dashboard.tools.page', '페이지 보내기', 'Send to a page', '移到其他页面', '移到其他頁面'],
  // DS 11.11 (all four languages given). The preset start notice itself is the kit's ui.notice.presetStarted (T-055).
  ['dashboard.announce.preset', '패널 7개를 추가했어요', 'Placed 7 widgets', '已放置 7 个小组件', '已放置 7 個小工具'],
  ['dashboard.announce.layer', '{layer}, {status}', '{layer}, {status}', '{layer}，{status}', '{layer}，{status}'],
] as const satisfies readonly Row[];

export type DashboardKey = (typeof rows)[number][0];
const build = (index: 1 | 2 | 3 | 4) => Object.fromEntries(rows.map((row) => [row[0], row[index]])) as Record<DashboardKey, string>;
export const dashboardBundle = defineBundle<DashboardKey>({ id: 'dashboard', ko: build(1), en: build(2), 'zh-Hans': build(3), 'zh-Hant': build(4) });

/** Rows whose en / zh text comes from DS 11.11 (not written by T-052). */
const sourced: ReadonlySet<string> = new Set(['dashboard.announce.preset']);
/** Translated strings (en + zh-Hans + zh-Hant) written by T-052 for R2 review. */
export const dashboardReviewStringCount = rows.filter((row) => !sourced.has(row[0])).length * 3;
