/**
 * T-050 message bundle for mgmt-store (ARCHITECTURE 11.6: `widget.{id}.*` besides title/coach/aliases belongs to the
 * widget folder). Rows are [ko, en, zh-Hans, zh-Hant]. Keys that plan-1 lists (`needHelp`, `draftPost`, `count`,
 * `fromNote`, `seats`, `mood`) use the plan-1 words; the other English and Chinese rows were written here
 * (LOCALES 1 rule) and need R2 review.
 */
import { defineBundle, type MessageBundle } from '../../../i18n';

type Row = readonly [string, string, string, string];

const rows = {
  /* 알바모집 */
  'widget.hiring.needHelp': ['도움이 필요한 시간', 'Hours needing help', '需要人手的时段', '需要人手的時段'],
  'widget.hiring.draftPost': ['공고 초안 만들기', 'Draft a job post', '生成招聘草稿', '產生徵才草稿'],
  'widget.hiring.busiest': ['{days} {range, particle, 이/가} 가장 바빠요', '{days} {range} is the busiest', '{days}{range}最忙', '{days}{range}最忙'],
  'widget.hiring.weekend': ['주말', 'Weekends', '周末', '週末'],
  'widget.hiring.daysSeparator': ['·', ', ', '、', '、'],
  'widget.hiring.staff': ['그 시간 근무 {staff}', 'Staff then: {staff}', '该时段上班 {staff}', '該時段上班 {staff}'],
  'widget.hiring.staffLabel': ['그 시간 근무 인원', 'Staff on duty then', '该时段上班人数', '該時段上班人數'],
  'widget.hiring.weekdayLoad': ['요일별 바쁜 정도', 'Busy level by day', '各星期的忙碌程度', '各星期的忙碌程度'],
  'widget.hiring.loadTable': ['요일·시간대별 일손 부담', 'Staffing load by day and hour', '按星期和时段的人手压力', '按星期和時段的人手壓力'],
  'widget.hiring.loadHint': ['1단계는 여유롭고 5단계는 가장 바빠요. 최근 4주 결제 건수와 근무 인원으로 계산해요', 'Level 1 is calm and level 5 is the busiest. Based on payments and staffing over the last 4 weeks', '1 级最空闲，5 级最忙。依据最近 4 周的结算笔数和上班人数计算', '1 級最空閒，5 級最忙。依據最近 4 週的結帳筆數和上班人數計算'],
  'widget.hiring.basis': ['기준 기간\u00A0· 최근 4주 ({range})', 'Basis\u00A0· last 4 weeks ({range})', '统计期间\u00A0· 最近 4 周（{range}）', '統計期間\u00A0· 最近 4 週（{range}）'],
  'widget.hiring.hourColumn': ['시간', 'Hour', '时间', '時間'],
  'widget.hiring.statusNone': ['공고 초안 없음', 'No job post draft', '暂无招聘草稿', '尚無徵才草稿'],
  'widget.hiring.statusDraft': ['공고 초안 저장함', 'Job post draft saved', '招聘草稿已保存', '徵才草稿已儲存'],
  'widget.hiring.statusCopied': ['공고 초안 복사함', 'Job post copied', '招聘草稿已复制', '徵才草稿已複製'],
  'widget.hiring.formTitle': ['공고 초안', 'Job post draft', '招聘草稿', '徵才草稿'],
  'widget.hiring.wage': ['시급', 'Hourly wage', '时薪', '時薪'],
  'widget.hiring.wageUnit': ['원', 'KRW', '韩元', '韓元'],
  'widget.hiring.wageHint': ['최저임금 {min} 이상으로 적어 주세요', 'Enter at least the minimum wage, {min}', '请填写不低于最低工资 {min} 的金额', '請填寫不低於最低工資 {min} 的金額'],
  'widget.hiring.postHead': ['[알바 모집] {days} {range}', '[Hiring] {days}, {range}', '【招聘兼职】{days} {range}', '【徵才兼職】{days} {range}'],
  'widget.hiring.postTasks': ['하는 일: {tasks}', 'Tasks: {tasks}', '工作内容：{tasks}', '工作內容：{tasks}'],
  'widget.hiring.postWage': ['시급: {wage}', 'Hourly wage: {wage}', '时薪：{wage}', '時薪：{wage}'],
  'widget.hiring.postContact': ['연락: {contact}', 'Contact: {contact}', '联系方式：{contact}', '聯絡方式：{contact}'],
  'widget.hiring.tasksSeparator': [', ', ', ', '、', '、'],
  'widget.hiring.editWage': ['시급 바꾸기', 'Change the wage', '修改时薪', '修改時薪'],
  'widget.hiring.draftNote': ['공고는 복사해서 직접 올려요. 앱은 외부에 올리지 않아요', "Copy the post and publish it yourself. The app doesn't post anywhere", '请复制招聘内容后自行发布，应用不会对外发布', '請複製徵才內容後自行發布，應用程式不會對外發布'],
  'widget.hiring.copiedStatus': ['복사했어요. 외부 구인 서비스에 직접 붙여 넣어 주세요', 'Copied. Paste it into a job site yourself', '已复制，请自行粘贴到招聘网站', '已複製，請自行貼到徵才網站'],

  /* 매뉴얼 작성 */
  'widget.manuals.count': ['인수인계', 'Store manuals', '店铺手册', '店鋪手冊'],
  'widget.manuals.fromNote': ['메모로 만들기', 'Create from a note', '从备忘生成', '從備忘產生'],
  'widget.manuals.recent': ['최근 고침', 'Recently edited', '最近修改', '最近修改'],
  'widget.manuals.all': ['전체', 'All', '全部', '全部'],
  'widget.manuals.todayChecklist': ['오늘 체크리스트', "Today's checklist", '今日清单', '今日清單'],
  'widget.manuals.steps': ['단계', 'Steps', '步骤', '步驟'],
  'widget.manuals.stepCount': ['{n}단계', '{n, plural, one {# step} other {# steps}}', '{n} 个步骤', '{n} 個步驟'],
  'widget.manuals.checklistBadge': ['체크리스트', 'Checklist', '清单', '清單'],
  'widget.manuals.listLabel': ['매뉴얼 목록', 'Manual list', '手册列表', '手冊列表'],
  'widget.manuals.tabsLabel': ['매뉴얼 분류', 'Manual categories', '手册分类', '手冊分類'],
  'widget.manuals.memoLabel': ['메모', 'Note', '备忘', '備忘'],
  'widget.manuals.memoHint': ['적어 둔 내용을 단계 목록 초안으로 정리해요', 'Turns your note into a draft list of steps', '把备忘整理成分步草稿', '把備忘整理成分步草稿'],
  'widget.manuals.makeDraft': ['초안 만들기', 'Create draft', '生成草稿', '產生草稿'],
  'widget.manuals.draftNote': ['저장하기 전에는 매뉴얼 수에 들어가지 않아요', "It isn't counted as a manual until you save it", '保存之前不计入手册数量', '儲存之前不計入手冊數量'],
  'widget.manuals.noSteps': ['이 매뉴얼에는 아직 단계가 없어요', 'This manual has no steps yet', '这份手册还没有步骤', '這份手冊還沒有步驟'],
  'widget.manuals.draftTitle': ['제목', 'Title', '标题', '標題'],

  /* 매장 인테리어 */
  'widget.interior.mood': ['공간 분위기', 'Space mood', '空间氛围', '空間氛圍'],
  'widget.interior.material': ['재료', 'Materials', '材料', '材料'],
  'widget.interior.suggestion': ['제안 메모', 'Suggestion note', '建议备忘', '建議備忘'],
  'widget.interior.memoSave': ['메모 저장하기', 'Save note', '保存备忘', '儲存備忘'],
  'widget.interior.memoField': ['바꿀 점 메모', 'Notes on what to change', '想改动的备忘', '想改動的備忘'],
  'widget.interior.reference': ['참고용이며 시공 견적이 아니에요', 'For reference only, not a construction quote', '仅供参考，并非施工报价', '僅供參考，並非施工報價'],
  'widget.interior.moodPick': ['분위기 고르기', 'Choose a mood', '选择氛围', '選擇氛圍'],
  'widget.interior.materialPick': ['재료 고르기', 'Choose materials', '选择材料', '選擇材料'],
  'widget.interior.scene': ['적용 예시', 'Applied preview', '应用示例', '套用範例'],
  'widget.interior.sceneAlt': ['예시 그림\u00A0· {mood}\u00A0· {materials}', 'Sample image\u00A0· {mood}\u00A0· {materials}', '示例图\u00A0· {mood}\u00A0· {materials}', '範例圖\u00A0· {mood}\u00A0· {materials}'],
  'widget.interior.goFloorPlan': ['사진으로 자리 배치 보기', 'Open seating from photos', '查看照片生成座位布局', '查看照片產生座位配置'],
  'widget.interior.noMaterials': ['고른 재료가 없어요', 'No materials chosen', '尚未选择材料', '尚未選擇材料'],
  'widget.interior.materialsSeparator': [', ', ', ', '、', '、'],

  'widget.manuals.createDocument': ['문서 만들기', 'Create a document', '创建手册', '建立文件'],
  'widget.manuals.sampleNote': ['예시 메모', 'Sample note', '示例笔记', '範例筆記'],
  'widget.manuals.note.mn-open': ['오픈 전 조명·장비·재고 점검', 'Check lights, equipment and stock before opening', '开店前检查照明、设备和库存', '開店前檢查照明、設備和庫存'],
  'widget.manuals.note.mn-close': ['마감 전 우유·청소·POS 확인', 'Check milk, cleaning and POS before closing', '打烊前检查牛奶、清洁和 POS', '打烊前檢查牛奶、清潔和 POS'],
  'widget.manuals.note.mn-newstaff': ['첫 출근 때 확인할 것', 'What to check on the first day', '上班第一天要检查的事项', '上班第一天要檢查的事項'],
  'widget.manuals.generate': ['문서 초안 만들기', 'Create document draft', '生成手册草稿', '產生文件草稿'],
  'widget.manuals.editStep': ['{n}단계', 'Step {n}', '第 {n} 步', '第 {n} 步'],
  'widget.manuals.addStep': ['단계 추가하기', 'Add a step', '添加步骤', '新增步驟'],
  'widget.manuals.optionalCautions': ['주의할 점(선택)', 'Cautions (optional)', '注意事项（可选）', '注意事項（選填）'],
  'widget.manuals.saveAnyway': ['그래도 저장하기', 'Save anyway', '继续保存', '繼續儲存'],
  'widget.manuals.leaveAsIs': ['그대로 두기', 'Keep as is', '保持不变', '保持不變'],

  /* 사진으로 자리 배치 */
  'widget.floor-plan.seats': ['좌석', 'Seats', '座位', '座位'],
  'widget.floor-plan.tableSummary': ['테이블 {tables}개\u00A0· {seats}석', '{tables, plural, one {# table} other {# tables}}\u00A0· {seats, plural, one {# seat} other {# seats}}', '{tables} 张桌子\u00A0· {seats} 个座位', '{tables} 張桌子\u00A0· {seats} 個座位'],
  'widget.floor-plan.tableCount': ['테이블 {tables}개', '{tables, plural, one {# table} other {# tables}}', '{tables} 张桌子', '{tables} 張桌子'],
  'widget.floor-plan.aisle': ['통로 {cm}cm', 'Aisle {cm} cm', '通道 {cm} 厘米', '走道 {cm} 公分'],
  'widget.floor-plan.aisleWarning': ['통로가 {min}cm보다 좁아요', 'The aisle is narrower than {min} cm', '通道比 {min} 厘米窄', '走道比 {min} 公分窄'],
  'widget.floor-plan.zones': ['구역별 좌석', 'Seats by zone', '各区域座位', '各區域座位'],
  'widget.floor-plan.layouts': ['배치안', 'Layouts', '布局方案', '配置方案'],
  'widget.floor-plan.inUse': ['쓰는 중', 'In use', '使用中', '使用中'],
  'widget.floor-plan.saveLayout': ['배치안 저장하기', 'Save layout draft', '保存布局方案', '儲存配置方案'],
  'widget.floor-plan.tryLayout': ['배치 바꿔 보기', 'Try a layout', '试排布局', '試排配置'],
  'widget.floor-plan.tryTitle': ['배치안 만들기', 'Make a layout draft', '制作布局方案', '製作配置方案'],
  'widget.floor-plan.zoneTables': ['{zone} 테이블', '{zone} tables', '{zone}桌子', '{zone}桌子'],
  'widget.floor-plan.seatsPerTable': ['테이블당 {n}석', '{n} seats per table', '每张桌子 {n} 座', '每張桌子 {n} 座'],
  'widget.floor-plan.aisleField': ['통로 폭', 'Aisle width', '通道宽度', '走道寬度'],
  'widget.floor-plan.useReason': ['지금 쓰고 있는 배치예요', 'This is the layout in use', '这就是当前使用的布局', '這就是目前使用的配置'],
  'widget.floor-plan.plan': ['예시 자리도', 'Sample seating plan', '示例座位图', '範例座位圖'],
  'widget.floor-plan.planAlt': ['예시 자리도, {summary}, {zones}, 가운데 통로', 'Sample seating plan, {summary}, {zones}, center aisle', '示例座位图，{summary}，{zones}，中间通道', '範例座位圖，{summary}，{zones}，中間走道'],
  'widget.floor-plan.zoneSeats': ['{zone} {seats}', '{zone} {seats}', '{zone} {seats}', '{zone} {seats}'],
  'widget.floor-plan.photos': ['예시 사진', 'Sample photos', '示例照片', '示範照片'],
  'widget.floor-plan.photoN': ['예시 사진 {n}', 'Sample photo {n}', '示例照片 {n}', '示範照片 {n}'],
  'widget.floor-plan.progress': ['사진을 살펴보고 자리도를 그리고 있어요', 'Looking at your photos and drawing the plan', '正在查看照片并绘制座位图', '正在查看照片並繪製座位圖'],
  'widget.floor-plan.pos': ['주문/결제 연결됨(예시)', 'Orders/payments connected (sample)', '订单/支付已连接（示例）', '訂單/付款已連線（範例）'],
  'widget.floor-plan.voiceLink': ['음성 예약확정이 이 좌석 수를 써요', 'Voice booking uses this seat count', '语音预约确认使用这个座位数', '語音預約確認使用這個座位數'],
  'widget.floor-plan.goInterior': ['매장 인테리어 보기', 'Open store interior', '查看店铺装修', '查看店鋪裝潢'],
  'widget.floor-plan.draftOnly': ['저장만 해서는 좌석 수가 바뀌지 않아요', "Saving a layout doesn't change your seats", '仅保存不会改变座位数', '僅儲存不會改變座位數'],
} as const satisfies Readonly<Record<string, Row>>;

const mastermanageKo = {
  'widget.manuals.handover': '인수인계',
  'widget.manuals.storeInfo': '매장 정보',
  'widget.manuals.sectionTabs': '문서 종류',
  'widget.manuals.create': '매뉴얼 만들기',
  'widget.manuals.edit': '문서 고치기',
  'widget.manuals.delete': '문서 지우기',
  'widget.manuals.category': '분류',
  'widget.manuals.content': '내용',
  'widget.manuals.cautions': '주의할 점',
  'widget.manuals.titleRequired': '제목을 넣어 주세요',
  'widget.manuals.contentRequired': '내용을 넣어 주세요',
  'widget.manuals.storeCount': '매장 정보 {n}개',
  'widget.manuals.progressSentence': '{total}단계 중 {done}단계 완료',
  'widget.manuals.stepExample': '{n}단계 예시 그림',
  'widget.manuals.procedures': '하는 방법',
} as const;
export type MgmtStoreKey = keyof typeof rows | keyof typeof mastermanageKo;

const pick = (index: 0 | 1 | 2 | 3) => Object.freeze(Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, (row as Row)[index]]))) as Readonly<Record<MgmtStoreKey, string>>;

export const mgmtStoreBundle: MessageBundle<MgmtStoreKey> = defineBundle<MgmtStoreKey>({
  id: 'mgmt-store', ko: { ...pick(0), ...mastermanageKo }, en: pick(1), 'zh-Hans': pick(2), 'zh-Hant': pick(3),
});

/** Strings written in this folder for en / zh (R2 review count reported by T-050). */
export const MGMT_STORE_REVIEW_KEYS: readonly MgmtStoreKey[] = (Object.keys(rows) as MgmtStoreKey[]).filter((key) => !['widget.hiring.needHelp', 'widget.hiring.draftPost', 'widget.manuals.count', 'widget.manuals.fromNote', 'widget.interior.mood', 'widget.floor-plan.seats'].includes(key));
