/**
 * T-049 message bundle: `widget.{calendar|inventory-booking|suppliers}.*` (ARCHITECTURE 11.6 prefix table).
 * `.title`·`.coach`·`.aliases` stay in the common bundle (T-041). Sources: plan-1 widget key tables
 * (`team/plan-1/widgets/{calendar,inventory,stock-sync,suppliers}.md`, marked `plan1`), the stock-sync rows
 * merged into inventory (D-54), and rows the worker wrote in the LOCALES 1 style (`written`, R2 review).
 */
import type { MessageBundle } from '../../../i18n';

type Source = 'plan1' | 'written';
type Row = readonly [key: string, ko: string, en: string, hans: string, hant: string, source: Source];
const P: Source = 'plan1';
const W: Source = 'written';

const calendarRows = [
  ['widget.calendar.today', '오늘 일정', "Today's schedule", '今日日程', '今日行程', P],
  ['widget.calendar.thisWeek', '이번 주 일정', 'This week', '本周日程', '本週行程', P],
  ['widget.calendar.countUnit', '개', '{count, plural, one {event} other {events}}', '项', '項', W],
  ['widget.calendar.eventCount', '{number}개', '{count, plural, one {# event} other {# events}}', '{number}项', '{number}項', W],
  ['widget.calendar.summary', '오늘 일정 {count}개, {date}', '{count, plural, one {# event} other {# events}} today, {date}', '今日日程 {count} 项，{date}', '今日行程 {count} 項，{date}', W],
  ['widget.calendar.weekSummary', '이번 주 일정 {count}개', '{count, plural, one {# event} other {# events}} this week', '本周日程 {count} 项', '本週行程 {count} 項', W],
  ['widget.calendar.noEvents', '일정이 없어요', 'No events', '没有日程', '沒有行程', W],
  ['widget.calendar.allDay', '종일', 'All day', '全天', '全天', W],
  ['widget.calendar.todoMark', 'To-Do', 'To-do', '待办', '待辦', W],
  ['widget.calendar.view.label', '보기', 'View', '视图', '檢視', W],
  ['widget.calendar.view.month', '월', 'Month', '月', '月', W],
  ['widget.calendar.view.week', '주', 'Week', '周', '週', W],
  ['widget.calendar.view.day', '일', 'Day', '日', '日', W],
  ['widget.calendar.monthTitle', '{year}년 {month}월', '{monthShort} {year}', '{year}年{month}月', '{year}年{month}月', W],
  ['widget.calendar.tableName', '{title} 달력', '{title} calendar', '{title}日历', '{title}行事曆', W],
  ['widget.calendar.todayMark', '오늘', 'Today', '今天', '今天', W],
  ['widget.calendar.dayCellName', '{date}, 일정 {count}개', '{date}, {count, plural, one {# event} other {# events}}', '{date}，{count} 项日程', '{date}，{count} 項行程', W],
  ['widget.calendar.sources', '출처별 보이기', 'Show by source', '按来源显示', '依來源顯示', W],
  ['widget.calendar.source.delivery', '입고', 'Deliveries', '到货', '到貨', W],
  ['widget.calendar.source.reservation', '예약', 'Reservations', '预约', '預約', W],
  ['widget.calendar.source.shift', '근무', 'Shifts', '排班', '排班', W],
  ['widget.calendar.source.deadline', '마감', 'Deadlines', '截止', '截止', W],
  ['widget.calendar.source.direct', '직접 추가함', 'My events', '自己添加', '自行新增', W],
  ['widget.calendar.sourceReservationHint', '예약은 기본으로 꺼져 있어요. 켜면 오늘 일정 수에 들어가요', 'Reservations are off by default. Turn them on to count them today', '预约默认关闭，开启后会计入今日日程', '預約預設關閉，開啟後會計入今日行程', W],
  ['widget.calendar.fromSource', '{source}에서 고칠 수 있어요', 'Edit it in its source', '请在来源中修改', '請在來源中修改', W],
  ['widget.calendar.openSource', '{entry}, {widget} 자세히 보기', '{entry}, view in {widget}', '{entry}，在{widget}中查看', '{entry}，在{widget}中查看', W],
  ['widget.calendar.form.kind', '종류', 'Type', '类型', '類型', W],
  ['widget.calendar.form.event', '일정', 'Event', '日程', '行程', W],
  ['widget.calendar.form.todo', 'To-Do', 'To-do', '待办', '待辦', W],
  ['widget.calendar.form.title', '제목', 'Title', '标题', '標題', W],
  ['widget.calendar.form.time', '시각', 'Time', '时间', '時間', W],
  ['widget.calendar.form.timeHint', '예: 15:00. 비워 두면 종일이에요', 'e.g. 15:00. Leave empty for all day', '例如 15:00，留空则为全天', '例如 15:00，留空則為全天', W],
  ['widget.calendar.form.memo', '메모(선택)', 'Note (optional)', '备注（选填）', '備註（選填）', W],
  ['widget.calendar.form.edit', '일정 고치기', 'Edit event', '修改日程', '修改行程', W],
  ['widget.calendar.edit', '고치기', 'Edit', '修改', '修改', W],
  ['widget.calendar.delete', '지우기', 'Delete', '删除', '刪除', W],
  ['widget.calendar.memoLine', '메모: {memo}', 'Note: {memo}', '备注：{memo}', '備註：{memo}', W],
] as const satisfies readonly Row[];

const inventoryRows = [
  ['widget.inventory-booking.restockNeeded', '보충 필요', 'Needs restocking', '需要补货', '需要補貨', P],
  ['widget.inventory-booking.restockCount', '{count}개 품목', '{count, plural, one {# item} other {# items}}', '{count} 种商品', '{count} 種商品', P],
  ['widget.inventory-booking.outOfStock', '품절 {count}개 품목', '{count, plural, one {# item out of stock} other {# items out of stock}}', '{count} 种商品缺货', '{count} 種商品缺貨', P],
  ['widget.inventory-booking.listTitle', '보충 품목', 'Items to restock', '待补货商品', '待補貨商品', P],
  ['widget.inventory-booking.stockRow', '{item} {stock}', '{item}\u00A0· {stock}', '{item}\u00A0· {stock}', '{item}\u00A0· {stock}', P],
  ['widget.inventory-booking.stockRowWithThreshold', '{item} {stock} / 기준 {threshold}', '{item}\u00A0· {stock} / Threshold {threshold}', '{item}\u00A0· {stock} / 补货阈值 {threshold}', '{item}\u00A0· {stock} / 補貨門檻 {threshold}', P],
  ['widget.inventory-booking.empty', '아직 등록한 품목이 없어요', 'No inventory items yet', '尚未添加库存商品', '尚未新增庫存商品', P],
  ['widget.inventory-booking.registerItem', '품목 추가하기', 'Add item', '添加商品', '新增商品', P],
  ['widget.inventory-booking.needsReview', '현재고와 보충 기준을 확인해 주세요', 'Check stock levels and restock thresholds', '请检查库存和补货阈值', '請確認庫存與補貨門檻', P],
  ['widget.inventory-booking.itemNeedsReview', '확인 필요', 'Needs review', '需要确认', '需要確認', P],
  ['widget.inventory-booking.partialZero', '확인된 품목 중 보충 필요 0개', 'No checked items need restocking', '已确认的商品中没有需要补货的商品', '已確認的商品中沒有需要補貨的商品', P],
  ['widget.inventory-booking.noRestock', '보충이 필요한 품목이 없어요', 'No items need restocking', '没有需要补货的商品', '沒有需要補貨的商品', P],
  ['widget.inventory-booking.error', '재고를 불러오지 못했어요', "Couldn't load inventory", '无法加载库存', '無法載入庫存', P],
  ['widget.inventory-booking.openDetail', '재고관리 상세 열기', 'Open inventory details', '打开库存详情', '開啟庫存詳細資料', P],
  ['widget.inventory-booking.options.showOutOfStock', '품절 품목 수 표시', 'Show out-of-stock count', '显示缺货商品数量', '顯示缺貨商品數量', P],
  // stock-sync merged into inventory (D-54): its two plan-1 rows move under this widget's prefix.
  ['widget.inventory-booking.productsTotal', '전체 재고', 'Total stock', '总库存', '總庫存', P],
  ['widget.inventory-booking.lowInChannel', '품절 가까움', 'Running low', '即将缺货', '即將缺貨', P],
  ['widget.inventory-booking.restockUnit', '개 품목', '{count, plural, one {item} other {items}}', '种商品', '種商品', W],
  ['widget.inventory-booking.summary', '보충 필요 {count}개 품목', 'Needs restocking: {count, plural, one {# item} other {# items}}', '需要补货 {count} 种商品', '需要補貨 {count} 種商品', W],
  ['widget.inventory-booking.summaryOut', '{summary}, 품절 {out}개 품목', '{summary}, {out} out of stock', '{summary}，{out} 种商品缺货', '{summary}，{out} 種商品缺貨', W],
  ['widget.inventory-booking.channelLine', '매장 {store}\u00A0· 온라인 {online}', 'Store {store}\u00A0· Online {online}', '门店 {store}\u00A0· 线上 {online}', '門市 {store}\u00A0· 線上 {online}', W],
  ['widget.inventory-booking.filter.label', '목록 보기', 'Show', '显示', '顯示', W],
  ['widget.inventory-booking.filter.all', '전체', 'All', '全部', '全部', W],
  ['widget.inventory-booking.stock', '현재고', 'In stock', '现有库存', '現有庫存', W],
  ['widget.inventory-booking.threshold', '보충 기준', 'Restock threshold', '补货阈值', '補貨門檻', W],
  ['widget.inventory-booking.thresholdShort', '기준 {threshold}', 'Threshold {threshold}', '补货阈值 {threshold}', '補貨門檻 {threshold}', W],
  ['widget.inventory-booking.channel.store', '매장', 'Store', '门店', '門市', W],
  ['widget.inventory-booking.channel.online', '온라인', 'Online', '线上', '線上', W],
  ['widget.inventory-booking.moved', '채널을 옮겼어요', 'Stock moved between channels', '已调配渠道库存', '已調配通路庫存', W],
  ['widget.inventory-booking.moveAgain', '다시 옮기기', 'Move more', '再次调配', '再次調配', W],
  ['widget.inventory-booking.updatedAt', '{time} 갱신', 'Updated {time}', '{time} 更新', '{time} 更新', W],
  ['widget.inventory-booking.nextDelivery', '{when} {qty} 입고 예정\u00A0· {supplier}', '{when}: {qty} due\u00A0· {supplier}', '{when}预计到货 {qty}\u00A0· {supplier}', '{when}預計到貨 {qty}\u00A0· {supplier}', W],
  ['widget.inventory-booking.noDelivery', '예정된 입고가 없어요', 'No delivery scheduled', '没有预计到货', '沒有預計到貨', W],
  ['widget.inventory-booking.openOrder', '{text}, 거래처 주문 열기', '{text}, open the supplier order', '{text}，打开供应商订单', '{text}，開啟供應商訂單', W],
  ['widget.inventory-booking.outBadge', '품절', 'Out of stock', '缺货', '缺貨', W],
  ['widget.inventory-booking.expiry.badge', '당일 소진', 'Sell today', '当日售完', '當日售完', W],
  ['widget.inventory-booking.expiry.until', '오늘까지', 'Until today', '今天到期', '今天到期', W],
  ['widget.inventory-booking.expiry.group', '당일 소진 품목', 'Sell-today items', '当日售完商品', '當日售完商品', W],
  ['widget.inventory-booking.expiry.note', '보충 대상이 아니에요. 남은 수량만 고쳐요', 'Not restocked. Only the count left can be edited', '不在补货范围内，只需修改剩余数量', '不在補貨範圍內，只需修改剩餘數量', W],
  ['widget.inventory-booking.expiry.qty', '남은 수량', 'Left today', '剩余数量', '剩餘數量', W],
  ['widget.inventory-booking.products.note', '당일 소진 품목은 포함하지 않아요', 'Sell-today items are not included', '不含当日售完商品', '不含當日售完商品', W],
  ['widget.inventory-booking.col.product', '상품', 'Product', '商品', '商品', W],
  ['widget.inventory-booking.col.total', '합계', 'Total', '合计', '合計', W],
  ['widget.inventory-booking.col.sales7d', '최근 7일 판매', 'Sold in 7 days', '近 7 天销量', '近 7 天銷量', W],
  ['widget.inventory-booking.transfer.product', '옮길 상품', 'Product to move', '要调配的商品', '要調配的商品', W],
  ['widget.inventory-booking.registerProduct', '상품 추가하기', 'Add product', '添加在售商品', '新增在售商品', W],
  ['widget.inventory-booking.registered', '품목을 등록했어요', 'Item added', '已添加商品', '已新增商品', W],
  ['widget.inventory-booking.registeredProduct', '상품을 등록했어요', 'Product added', '已添加在售商品', '已新增在售商品', W],
  ['widget.inventory-booking.form.itemName', '품목 이름', 'Item name', '商品名称', '商品名稱', W],
  ['widget.inventory-booking.form.productName', '상품 이름', 'Product name', '在售商品名称', '在售商品名稱', W],
  ['widget.inventory-booking.sampleNote', '예시 화면이라 실제로 저장하지 않아요', 'This is a sample, so nothing is saved', '这是示例，不会实际保存', '這是範例，不會實際儲存', W],
] as const satisfies readonly Row[];

const supplierRows = [
  ['widget.suppliers.incoming', '7일 내 입고 예정', 'Deliveries due within 7 days', '未来 7 天预计到货', '未來 7 天預計到貨', P],
  ['widget.suppliers.incomingCount', '{count}건', '{count, plural, one {# order} other {# orders}}', '{count} 笔订单', '{count} 筆訂單', P],
  ['widget.suppliers.overdue', '입고 확인 필요 {count}건', '{count, plural, one {# delivery to check} other {# deliveries to check}}', '{count} 笔到货需确认', '{count} 筆到貨需確認', P],
  ['widget.suppliers.listTitle', '예정 입고', 'Upcoming deliveries', '预计到货', '預計到貨', P],
  ['widget.suppliers.deliveryRowCompact', '{date} {item}\u00A0· {supplier}', '{date}\u00A0· {item}\u00A0· {supplier}', '{date}\u00A0· {item}\u00A0· {supplier}', '{date}\u00A0· {item}\u00A0· {supplier}', P],
  ['widget.suppliers.deliveryRowQuantity', '{date} {item} {quantity}', '{date}\u00A0· {item}\u00A0· {quantity}', '{date}\u00A0· {item}\u00A0· {quantity}', '{date}\u00A0· {item}\u00A0· {quantity}', P],
  ['widget.suppliers.empty', '아직 등록한 거래처가 없어요', 'No suppliers yet', '尚未添加供应商', '尚未新增供應商', P],
  ['widget.suppliers.registerSupplier', '발주사 추가하기', 'Add supplier', '添加供应商', '新增供應商', P],
  ['widget.suppliers.noIncoming', '7일 내 입고 예정이 없어요', 'No deliveries due within 7 days', '未来 7 天没有预计到货', '未來 7 天沒有預計到貨', P],
  ['widget.suppliers.error', '입고 일정을 불러오지 못했어요', "Couldn't load delivery schedules", '无法加载到货计划', '無法載入到貨計畫', P],
  ['widget.suppliers.openDetail', '거래처 입고 상세 열기', 'Open supplier delivery details', '打开供应商到货详情', '開啟供應商到貨詳細資料', P],
  ['widget.suppliers.options.showOverdue', '입고 확인 필요 건수 표시', 'Show deliveries to check', '显示需确认的到货数量', '顯示需確認的到貨數量', P],
  ['widget.suppliers.incomingUnit', '건', '{count, plural, one {order} other {orders}}', '笔订单', '筆訂單', W],
  ['widget.suppliers.summary', '7일 내 입고 예정 {count}건', 'Deliveries due within 7 days: {count, plural, one {# order} other {# orders}}', '未来 7 天预计到货 {count} 笔订单', '未來 7 天預計到貨 {count} 筆訂單', W],
  ['widget.suppliers.summaryOverdue', '{summary}, 입고 확인 필요 {overdue}건', '{summary}, {overdue, plural, one {# delivery to check} other {# deliveries to check}}', '{summary}，{overdue} 笔到货需确认', '{summary}，{overdue} 筆到貨需確認', W],
  ['widget.suppliers.when.today', '오늘', 'Today', '今天', '今天', W],
  ['widget.suppliers.when.tomorrow', '내일', 'Tomorrow', '明天', '明天', W],
  ['widget.suppliers.when.dayAfter', '모레', 'In 2 days', '后天', '後天', W],
  ['widget.suppliers.when.undated', '날짜 미정', 'Date not set', '日期未定', '日期未定', W],
  ['widget.suppliers.whenSupplier', '{when}\u00A0· {supplier}', '{when}\u00A0· {supplier}', '{when}\u00A0· {supplier}', '{when}\u00A0· {supplier}', W],
  ['widget.suppliers.group.overdue', '입고 확인 필요', 'Deliveries to check', '到货需确认', '到貨需確認', W],
  ['widget.suppliers.group.upcoming', '7일 내 예정', 'Due within 7 days', '7 天内预计到货', '7 天內預計到貨', W],
  ['widget.suppliers.group.past', '지난 주문', 'Past orders', '过往订单', '過往訂單', W],
  ['widget.suppliers.contact', '연락처', 'Contact', '联系方式', '聯絡方式', W],
  ['widget.suppliers.contactLine', '{person}\u00A0· {phone}', '{person}\u00A0· {phone}', '{person}\u00A0· {phone}', '{person}\u00A0· {phone}', W],
  ['widget.suppliers.due', '입고 예정일', 'Due date', '预计到货日', '預計到貨日', W],
  ['widget.suppliers.status.scheduled', '예정', 'Scheduled', '待到货', '待到貨', W],
  ['widget.suppliers.status.partial', '일부 입고', 'Partly received', '部分到货', '部分到貨', W],
  ['widget.suppliers.status.complete', '입고 완료', 'Received', '已到货', '已到貨', W],
  ['widget.suppliers.lines', '주문 품목', 'Order items', '订单品项', '訂單品項', W],
  ['widget.suppliers.col.item', '품목', 'Item', '品项', '品項', W],
  ['widget.suppliers.col.ordered', '주문량', 'Ordered', '订购量', '訂購量', W],
  ['widget.suppliers.col.received', '입고량', 'Received', '到货量', '到貨量', W],
  ['widget.suppliers.col.remaining', '잔량', 'Remaining', '余量', '餘量', W],
  ['widget.suppliers.record.title', '{item} 입고 기록', 'Record {item} delivery', '记录{item}到货', '記錄{item}到貨', W],
  ['widget.suppliers.record.qty', '받은 수량', 'Quantity received', '到货数量', '到貨數量', W],
  ['widget.suppliers.record.min', '1 이상으로 기록해요', 'Record at least 1', '至少记录 1', '至少記錄 1', W],
  ['widget.suppliers.record.expenseNote', '기록하면 가계부에 지출 후보로 들어가요', 'Recording adds an expense to confirm in the ledger', '记录后会作为待确认支出记入账本', '記錄後會作為待確認支出記入帳本', W],
  ['widget.suppliers.remaining', '잔량 {value}', 'Remaining {value}', '余量 {value}', '餘量 {value}', W],
  ['widget.suppliers.due.change', '예정일 바꾸기', 'Change due date', '更改预计到货日', '更改預計到貨日', W],
  ['widget.suppliers.due.calendarNote', '바꾸면 캘린더의 입고 일정도 함께 옮겨져요', 'The calendar delivery moves with it', '日历中的到货日程会一起更改', '行事曆中的到貨行程會一起更改', W],
  ['widget.suppliers.registered', '거래처를 등록했어요', 'Supplier added', '已添加供应商', '已新增供應商', W],
  ['widget.suppliers.form.supplierName', '거래처 이름', 'Supplier name', '供应商名称', '供應商名稱', W],
  ['widget.suppliers.sampleNote', '예시 화면이라 실제로 저장하지 않아요', 'This is a sample, so nothing is saved', '这是示例，不会实际保存', '這是範例，不會實際儲存', W],
  ['widget.suppliers.noOrder', '주문을 골라 주세요', 'Choose an order', '请选择订单', '請選擇訂單', W],
] as const satisfies readonly Row[];

const rows = [...calendarRows, ...inventoryRows, ...supplierRows];
const koOnly = { 'widget.inventory-booking.partialZeroShort': '확인한 재고는 충분해요.' } as const;
export type SupplyKey = (typeof rows)[number][0] | keyof typeof koOnly;

function toBundle(id: string, list: readonly Row[]): MessageBundle<SupplyKey> {
  const pick = (index: 1 | 2 | 3 | 4) => Object.freeze(Object.fromEntries(list.map((row) => [row[0], row[index]]))) as Readonly<Record<SupplyKey, string>>;
  return Object.freeze({ id, ko: Object.freeze({ ...pick(1), ...koOnly }), en: pick(2), 'zh-Hans': pick(3), 'zh-Hant': pick(4) });
}

/** The bundle of the mgmt-supply widget group (calendar, inventory-booking, suppliers). */
export const mgmtSupplyBundle: MessageBundle<SupplyKey> = toBundle('widget.mgmt-supply', rows);

/** “R2 검토 필요 문구 수”: en + zh-Hans + zh-Hant of the rows the worker wrote (plan-1 rows are copied as given). */
export const mgmtSupplyR2Review = Object.freeze({
  plan1Rows: rows.filter((r) => r[5] === P).length,
  writtenRows: rows.filter((r) => r[5] === W).length,
  strings: rows.filter((r) => r[5] === W).length * 3,
});
/** Every key with its source (tests). */
export const mgmtSupplyRows: readonly Row[] = rows;
