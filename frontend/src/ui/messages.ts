// T-045 UI kit message bundle: ui.* (fixed kit phrases, accessible names, notice sentences).
// Sources: DESIGN_SYSTEM 11.7 / 11.9 / 11.11, LOCALES 6 / 9.1, the iteration-3 kit phrases (same Korean values).
// English / Chinese rows that DS or LOCALES do not give were written by the worker in the LOCALES 1 style
// (short, soft guide tone; Simplified and Traditional separate) and are counted for R2 review (see uiReviewKeys).
import type { MessageBundle } from '../i18n';
import { createTranslator, baseBundles } from '../i18n';
import type { Locale } from '../contracts';
import { managementUiBundle } from './management-messages';

type Row = readonly [key: string, ko: string, en: string, hans: string, hant: string];
const rows = [
  // Panel frame (SCR-30 accessible name template, AC-218)
  ['ui.panel.size', '가로 {w}칸, 세로 {h}칸', '{w} wide, {h} tall', '宽{w}格，高{h}格', '寬{w}格，高{h}格'],
  ['ui.panel.name', '{name}, {row}행 {col}열, 가로 {w}칸 세로 {h}칸, {summary}, 자세히 보기', '{name}, row {row} column {col}, {w} wide {h} tall, {summary}, view details', '{name}，第{row}行第{col}列，宽{w}格高{h}格，{summary}，查看详情', '{name}，第{row}行第{col}列，寬{w}格高{h}格，{summary}，查看詳情'],
  ['ui.panel.nameNoSummary', '{name}, {row}행 {col}열, 가로 {w}칸 세로 {h}칸, 자세히 보기', '{name}, row {row} column {col}, {w} wide {h} tall, view details', '{name}，第{row}行第{col}列，宽{w}格高{h}格，查看详情', '{name}，第{row}行第{col}列，寬{w}格高{h}格，查看詳情'],
  ['ui.panel.nameStatic', '{name}, {row}행 {col}열, 가로 {w}칸 세로 {h}칸, {summary}', '{name}, row {row} column {col}, {w} wide {h} tall, {summary}', '{name}，第{row}行第{col}列，宽{w}格高{h}格，{summary}', '{name}，第{row}行第{col}列，寬{w}格高{h}格，{summary}'],
  ['ui.panel.nameStaticNoSummary', '{name}, {row}행 {col}열, 가로 {w}칸 세로 {h}칸', '{name}, row {row} column {col}, {w} wide {h} tall', '{name}，第{row}行第{col}列，宽{w}格高{h}格', '{name}，第{row}行第{col}列，寬{w}格高{h}格'],
  ['ui.panel.nameEditing', '{name}, {row}행 {col}열, 가로 {w}칸 세로 {h}칸, 편집 중', '{name}, row {row} column {col}, {w} wide {h} tall, editing', '{name}，第{row}行第{col}列，宽{w}格高{h}格，编辑中', '{name}，第{row}行第{col}列，寬{w}格高{h}格，編輯中'],
  ['ui.panel.editHelp', '화살표로 이동, Ctrl 또는 Meta와 화살표로 가로·세로 크기 변경', 'Arrow keys move it. Ctrl or Meta with arrows resizes it', '方向键移动，Ctrl 或 Meta 加方向键调整宽高', '方向鍵移動，Ctrl 或 Meta 加方向鍵調整寬高'],
  ['ui.panel.openHelp', '길게 누르면 배치를 바꿀 수 있어요', 'Press and hold to change the layout', '长按可调整布局', '長按可調整版面'],
  ['ui.panelAction.name', '{label}, {widget}', '{label}, {widget}', '{label}，{widget}', '{label}，{widget}'],
  // Notices (formatNotice)
  ['ui.notice.panelFallback', '패널', 'Panel', '面板', '面板'],
  ['ui.notice.layout', '{label}, {row}행 {col}열, {size}.', '{label}, row {row} column {col}, {size}.', '{label}，第{row}行第{col}列，{size}。', '{label}，第{row}行第{col}列，{size}。'],
  ['ui.notice.layoutDisplaced', '{label}, {row}행 {col}열, {size}. 패널 {n}개가 비켜났어요', '{label}, row {row} column {col}, {size}. {n, plural, one {# panel moved aside} other {# panels moved aside}}', '{label}，第{row}行第{col}列，{size}。{n} 个面板已让开', '{label}，第{row}行第{col}列，{size}。{n} 個面板已讓開'],
  ['ui.notice.added', '{label, particle, 을/를} 추가했어요', 'Added {label}', '已添加{label}', '已新增{label}'],
  ['ui.notice.removed', '{label, particle, 을/를} 뺐어요', 'Removed {label}', '已移除{label}', '已移除{label}'],
  ['ui.notice.starterAdd', '패널 3개로 시작했어요', 'Started with 3 panels', '已用 3 个面板开始', '已用 3 個面板開始'],
  // DS 11.11a ‘추천 배치 완료’ (marketing preset start notice; moved from the dashboard copy in T-055).
  ['ui.notice.presetStarted', '패널 8개로 시작했어요', 'Started with 8 widgets', '已用 8 个小组件开始', '已用 8 個小工具開始'],
  ['ui.notice.undoComplete', '되돌렸어요', 'Undone', '已撤销', '已復原'],
  ['ui.notice.editComplete', '배치를 바꿨어요', 'Layout updated', '已调整布局', '已調整版面'],
  ['ui.notice.noCapacityMore', '자리가 없어요. 패널을 줄이거나 빼거나 새 페이지를 추가해 주세요', 'No room. Shrink or remove a panel', '没有空位，请缩小或移除面板', '沒有空位，請縮小或移除面板'],
  ['ui.notice.noCapacity', '자리가 없어요. 패널을 줄이거나 빼 주세요', 'No room. Shrink or remove a panel', '没有空位，请缩小或移除面板', '沒有空位，請縮小或移除面板'],
  ['ui.notice.outsideGrid', '대시보드 안에 놓아 주세요', 'Drop it inside the dashboard', '请放在看板范围内', '請放在看板範圍內'],
  ['ui.notice.duplicate', '이미 있어요', 'Already placed', '已放置', '已放置'],
  ['ui.notice.undoUnavailable', '지금은 되돌릴 수 없어요. 패널을 줄이거나 빼 주세요', "Can't undo right now. Shrink or remove a panel", '现在无法撤销，请缩小或移除面板', '現在無法復原，請縮小或移除面板'],
  ['ui.notice.displayError', '화면을 보여 주지 못했어요. 다시 열어 주세요', "Couldn't show this screen. Please open it again", '无法显示此画面，请重新打开', '無法顯示此畫面，請重新開啟'],
  ['ui.notice.dataDone', '{text}', '{text}', '{text}', '{text}'],
  ['ui.notice.undoAction', '되돌리기', 'Undo', '撤销', '復原'],
  ['ui.notice.dismiss', '알림 닫기', 'Dismiss', '关闭通知', '關閉通知'],
  // Pages
  ['ui.page.barLabel', '페이지', 'Pages', '页面', '頁面'],
  ['ui.page.addWithText', '페이지 추가하기', 'Add page', '添加页面', '新增頁面'],
  ['ui.edge.chip', '{n}페이지로 이동', 'Go to page {n}', '前往第 {n} 页', '前往第 {n} 頁'],
  // Help and coach
  ['ui.help.panelHidden', '편집 중에는 설명 버튼이 숨겨져요', 'The help button is hidden while editing', '编辑时隐藏说明按钮', '編輯時隱藏說明按鈕'],
  ['ui.coach.progress', '{current}/{total}', '{current}/{total}', '{current}/{total}', '{current}/{total}'],
  ['ui.coach.skipAll', '남은 안내 모두 건너뛰기', 'Skip all remaining tips', '跳过剩余全部提示', '略過其餘所有提示'],
  // Settings subviews
  ['ui.settings.back', '설정으로', 'Back to settings', '返回设置', '返回設定'],
  ['ui.settings.listValue', '{label}, {value}', '{label}, {value}', '{label}，{value}', '{label}，{value}'],
  ['ui.example.chipOpen', '설정에서 예시 상태 바꾸기', 'Change the sample state in settings', '在设置中切换示例状态', '在設定中切換範例狀態'],
  // Badges
  ['ui.integration.name', '{service}, {state}', '{service}, {state}', '{service}，{state}', '{service}，{state}'],
  ['ui.splitbar.summary', '{a} {aValue}, {b} {bValue}', '{a} {aValue}, {b} {bValue}', '{a} {aValue}，{b} {bValue}', '{a} {aValue}，{b} {bValue}'],
  // Forms
  ['ui.field.required', '꼭 필요해요', 'Required', '必填', '必填'],
  ['ui.field.error', '오류: {message}', 'Error: {message}', '错误：{message}', '錯誤：{message}'],
  ['ui.date.label', '날짜', 'Date', '日期', '日期'],
  ['ui.date.previous', '이전 날짜', 'Previous date', '前一天', '前一天'],
  ['ui.date.next', '다음 날짜', 'Next date', '后一天', '後一天'],
  ['ui.time.options', '시각 제안', 'Suggested times', '建议时间', '建議時間'],
  // DateField / TimeField (K-C): the field shows the long date `{M}월 {D}일 {요일}`; the calendar and the time list open in a popover.
  ['ui.dateField.pick', '날짜 고르기', 'Pick a date', '选择日期', '選擇日期'],
  ['ui.dateField.prevMonth', '이전 달', 'Previous month', '上个月', '上個月'],
  ['ui.dateField.nextMonth', '다음 달', 'Next month', '下个月', '下個月'],
  ['ui.dateField.clear', '지우기', 'Clear', '清除', '清除'],
  ['ui.dateField.month', '{y}년 {month}', '{month} {y}', '{y}年{month}', '{y}年{month}'],
  ['ui.timeField.pick', '시각 고르기', 'Pick a time', '选择时间', '選擇時間'],
  ['ui.quantity.decrease', '줄이기', 'Decrease', '减少', '減少'],
  ['ui.quantity.increase', '늘리기', 'Increase', '增加', '增加'],
  ['ui.quantity.remaining', '잔량 {value}', 'Remaining {value}', '余量 {value}', '餘量 {value}'],
  ['ui.checklist.progress', '{done}/{total}', '{done}/{total}', '{done}/{total}', '{done}/{total}'],
  ['ui.checklist.checked', '확인함', 'Checked', '已核对', '已核對'],
  ['ui.inlineForm.open', '{title} 입력 열림', '{title} form opened', '已打开{title}', '已開啟{title}'],
  ['ui.channel.store', '매장', 'Store', '门店', '門市'],
  ['ui.channel.online', '온라인', 'Online', '线上', '線上'],
  ['ui.channel.swap', '방향 바꾸기', 'Swap direction', '切换方向', '切換方向'],
  ['ui.channel.total', '합계 {n}개', 'Total {n}', '共 {n} 个', '共 {n} 個'],
  ['ui.channel.totalSame', '합계는 그대로예요', 'The total stays the same', '总数不变', '總數不變'],
  ['ui.channel.overStock', '매장 재고보다 많이 옮길 수 없어요', "You can't move more than the store stock", '移动数量不能超过门店库存', '移動數量不能超過門市庫存'],
  ['ui.masterDetail.list', '목록', 'List', '列表', '列表'],
  ['ui.masterDetail.detail', '자세한 내용', 'Details', '详细内容', '詳細內容'],
  // Marketing kit
  ['ui.discount.name', '할인율 {p}%, 개당 남는 돈 {profit}, 한도 {max}%', 'Discount {p}%, you keep {profit} each, limit {max}%', '折扣 {p}%，每个剩余 {profit}，上限 {max}%', '折扣 {p}%，每個剩餘 {profit}，上限 {max}%'],
  ['ui.discount.decrease', '할인율 줄이기', 'Lower the discount', '降低折扣', '降低折扣'],
  ['ui.discount.increase', '할인율 늘리기', 'Raise the discount', '提高折扣', '提高折扣'],
  ['ui.discount.recommended', '추천 {p}%', 'Suggested {p}%', '推荐 {p}%', '推薦 {p}%'],
  ['ui.discount.limitText', '여기부터는 손해예요', 'Past this point you lose money', '超过此处将亏损', '超過此處將虧損'],
  ['ui.discount.summary', '할인가 {price} · 개당 남는 돈 {profit} · 모두 팔면 {total}', 'Price {price} · You keep {profit} each · If all sell {total}', '折后价 {price} · 每个剩余 {profit} · 全部售出 {total}', '折後價 {price} · 每個剩餘 {profit} · 全部售出 {total}'],
  ['ui.discount.loss', '못 팔면 원가 {amount}을 버려요', 'Unsold, you lose {amount} in cost', '卖不掉将损失成本 {amount}', '賣不掉將損失成本 {amount}'],
  ['ui.discount.setFixed', '세트는 가격이 정해져 있어요', 'Sets have a fixed price', '套餐价格固定', '套餐價格固定'],
  ['ui.benefit.group', '혜택', 'Benefit', '优惠内容', '優惠內容'],
  ['ui.benefit.recommended', '추천', 'Recommended', '推荐', '推薦'],
  ['ui.benefit.more', '{amount} 더 남아요', 'You keep {amount} more', '多剩余 {amount}', '多剩餘 {amount}'],
  ['ui.recipient.count', '받는 사람 {n}명', '{n, plural, one {# recipient} other {# recipients}}', '收件人 {n} 位', '收件人 {n} 位'],
  ['ui.recipient.listLabel', '받는 사람 고르기', 'Choose recipients', '选择收件人', '選擇收件人'],
  ['ui.recipient.sendable', '동의', 'Opted in', '已同意', '已同意'],
  ['ui.sms.line', '받는 사람 {n}명', '{n, plural, one {# recipient} other {# recipients}}', '收件人 {n} 位', '收件人 {n} 位'],
  ['ui.sms.autoFooter', '수신 거부 방법이 함께 들어가요(예시)', 'Opt-out instructions are added automatically (sample)', '将自动附上退订方法（示例）', '將自動附上退訂方法（範例）'],
  ['ui.sms.bodyLabel', '문구 내용', 'Message text', '短信内容', '簡訊內容'],
  ['ui.sms.fixedPart', '자동으로 들어가는 문구', 'Added automatically', '自动加入的文字', '自動加入的文字'],
  ['ui.send.time', '발송 시각', 'Send time', '发送时间', '發送時間'],
  ['ui.send.now', '지금', 'Now', '立即', '立即'],
  ['ui.send.schedule', '예약', 'Schedule', '预约', '預約'],
  ['ui.send.timeInput', '예약 시각', 'Scheduled time', '预约时间', '預約時間'],
  ['ui.confirm.title', '{n}명에게 쿠폰을 보낼까요?', 'Send the coupon to {n} people?', '要向 {n} 位发送优惠券吗？', '要向 {n} 位發送優惠券嗎？'],
  ['ui.confirm.send', '보내기', 'Send', '发送', '發送'],
  ['ui.confirm.notNow', '다음에', 'Not now', '暂不', '暫不'],
  ['ui.confirm.sending', '보내고 있어요', 'Sending', '正在发送', '正在發送'],
  ['ui.confirm.summaryRecipients', '받는 사람', 'Recipients', '收件人', '收件人'],
  ['ui.confirm.summaryBenefit', '혜택', 'Benefit', '优惠', '優惠'],
  ['ui.confirm.summaryTime', '시각', 'Time', '时间', '時間'],
  ['ui.copy.action', '복사하기', 'Copy', '复制', '複製'],
  ['ui.copy.then', '직접 올린 뒤 ‘올렸다고 표시하기’를 눌러 주세요', 'Post it yourself, then tap “I posted it”', '请自己发布后点按“我已发布”', '請自己發布後點按「我已發布」'],
  ['ui.copy.posted', '올렸어요', 'I posted it', '我已发布', '我已發布'],
  ['ui.usage.name', '사용 {used}, 발행 {total}', 'Used {used} of {total}', '已使用 {used}，共发放 {total}', '已使用 {used}，共發放 {total}'],
  ['ui.rate.name', '{label} {value}', '{label} {value}', '{label} {value}', '{label} {value}'],
  ['ui.formula.show', '계산 보기', 'Show calculation', '查看计算', '查看計算'],
  ['ui.insight.example', '예시', 'Sample', '示例', '範例'],
  ['ui.step.cancel', '취소', 'Cancel', '取消', '取消'],
  ['ui.step.current', '{name}, 진행 중', '{name}, in progress', '{name}，进行中', '{name}，進行中'],
  ['ui.step.done', '{name}, 완료', '{name}, done', '{name}，完成', '{name}，完成'],
  ['ui.video.alt', '장면 {n}/{total}, {range}, {caption}', 'Scene {n} of {total}, {range}, {caption}', '场景 {n}/{total}，{range}，{caption}', '場景 {n}/{total}，{range}，{caption}'],
  ['ui.video.silent', '소리 없는 미리보기예요', 'Preview without sound', '无声预览', '無聲預覽'],
  ['ui.video.play', '재생', 'Play', '播放', '播放'],
  ['ui.video.pause', '일시정지', 'Pause', '暂停', '暫停'],
  ['ui.video.replay', '다시 보기', 'Replay', '重播', '重播'],
  ['ui.video.previous', '이전 장면', 'Previous scene', '上一场景', '上一場景'],
  ['ui.video.next', '다음 장면', 'Next scene', '下一场景', '下一場景'],
  ['ui.video.sceneChip', '장면 {n} · {range}', 'Scene {n} · {range}', '场景 {n} · {range}', '場景 {n} · {range}'],
  ['ui.video.range', '{start}~{end}초', '{start}–{end}s', '{start}~{end}秒', '{start}~{end}秒'],
  ['ui.video.progress', '재생 위치', 'Playback position', '播放位置', '播放位置'],
  ['ui.video.scenes', '장면', 'Scenes', '场景', '場景'],
  // T-062 language completion
  ['ui.panel.nameBasic', '{name}, {size} 패널', '{name}, {size} panel', '{name}，{size}面板', '{name}，{size}面板'],
  ['ui.panel.nameBasicEditing', '{name}, {size} 패널, 편집 중', '{name}, {size} panel, editing', '{name}，{size}面板，编辑中', '{name}，{size}面板，編輯中'],
  ['ui.size.group', '패널 크기 바꾸기', 'Change panel size', '调整面板大小', '調整面板大小'],
  ['ui.size.widthCount', '가로 칸 수', 'Columns wide', '宽度格数', '寬度格數'],
  ['ui.size.heightCount', '세로 칸 수', 'Rows tall', '高度格数', '高度格數'],
  ['ui.size.widthValue', '가로 {n}칸', 'Width {n}', '宽 {n} 格', '寬 {n} 格'],
  ['ui.size.heightValue', '세로 {n}칸', 'Height {n}', '高 {n} 格', '高 {n} 格'],
  ['ui.move.group', '한 칸 이동', 'Move one cell', '移动一格', '移動一格'],
  ['ui.move.left', '왼쪽으로 한 칸', 'One cell left', '向左一格', '向左一格'],
  ['ui.move.right', '오른쪽으로 한 칸', 'One cell right', '向右一格', '向右一格'],
  ['ui.move.up', '위로 한 칸', 'One cell up', '向上一格', '向上一格'],
  ['ui.move.down', '아래로 한 칸', 'One cell down', '向下一格', '向下一格'],
  ['ui.resize.name', '{label} 크기 바꾸기, 현재 {size}, 가로·세로 각각 1~4칸', 'Resize {label}, now {size}, 1 to 4 cells each way', '调整{label}大小，当前{size}，宽高各 1 到 4 格', '調整{label}大小，目前{size}，寬高各 1 到 4 格'],
  ['ui.row.named', '{label}, {state}', '{label}, {state}', '{label}，{state}', '{label}，{state}'],
  ['ui.remove.name', '{label} 빼기', 'Remove {label}', '移除{label}', '移除{label}'],
  ['ui.edit.status', '배치를 바꾸고 있어요', 'Changing the layout', '正在调整布局', '正在調整版面'],
  ['ui.theme.mode', '화면 모드', 'Screen mode', '显示模式', '顯示模式'],
  ['ui.largeText.label', '큰 글자', 'Large text', '大字体', '大字體'],
  ['ui.largeText.description', '더 크게 읽어요', 'Easier to read', '文字更大，更易阅读', '文字更大，更易閱讀'],
  ['ui.business.cafe', '카페', 'Cafe', '咖啡店', '咖啡店'],
  ['ui.business.restaurant', '음식점', 'Restaurant', '餐厅', '餐廳'],
  ['ui.business.pub', '주점', 'Bar', '酒馆', '酒館'],
  ['ui.business.beauty', '미용·뷰티', 'Beauty', '美容美发', '美容美髮'],
  ['ui.business.retail', '소매', 'Retail', '零售', '零售'],
  ['ui.business.academy', '학원', 'Academy', '补习班', '補習班'],
  ['ui.business.fitness', '운동', 'Fitness', '运动健身', '運動健身'],
  ['ui.business.other', '기타', 'Other', '其他', '其他'],
  ['ui.drawer.count', '{n}개 기능', '{n, plural, one {# feature} other {# features}}', '{n} 个功能', '{n} 個功能'],
  ['ui.drawer.listName', '{title} 기능 목록', '{title} feature list', '{title}功能列表', '{title}功能列表'],
  ['ui.drawer.footer1', '누르면 추가해요', 'Tap to add.', '点按即可添加。', '點按即可新增。'],
  ['ui.drawer.footer2', '왼쪽으로 끌어 놓아도 돼요', 'You can also drag it left', '也可以向左拖动', '也可以向左拖曳'],
  ['ui.drop.checking', '놓을 자리를 확인하고 있어요', 'Checking the spot', '正在确认位置', '正在確認位置'],
  ['ui.drop.cannot', '여기에 놓을 수 없어요', "Can't drop it here", '无法放在这里', '無法放在這裡'],
  ['ui.drop.here', '여기에 놓기', 'Drop here', '放在这里', '放在這裡'],
  ['ui.drop.displaced', '패널 {n}개가 비켜나요', '{n, plural, one {# panel moves aside} other {# panels move aside}}', '{n} 个面板会让开', '{n} 個面板會讓開'],
  ['ui.skip.dashboard', '대시보드로 이동', 'Skip to dashboard', '跳到看板', '跳到看板'],
  ['ui.tools.name', '{label} 크기와 위치 바꾸기', 'Change size and position of {label}', '调整{label}的大小和位置', '調整{label}的大小和位置'],
  ['ui.tools.region', '크기와 위치 조작', 'Size and position controls', '大小和位置操作', '大小和位置操作'],
  ['ui.notice.region', '결과 알림', 'Result notices', '结果通知', '結果通知'],
  ['ui.notice.aiOne', '{label, particle, 을/를} 추가했어요', 'Placed {label}', '已放置{label}', '已放置{label}'],
  ['ui.notice.aiMany', '패널 {n}개를 추가했어요', 'Placed {n, plural, one {# panel} other {# panels}}', '已放置 {n} 个面板', '已放置 {n} 個面板'],
  ['ui.notice.aiOther', ' · 확인할 결과 {n}개', ' · {n, plural, one {# result to check} other {# results to check}}', ' · 另有 {n} 个结果待查看', ' · 另有 {n} 個結果待查看'],
  ['ui.notice.aiView', '대화 보기', 'View chat', '查看对话', '查看對話'],
  ['ui.chart.empty', '그래프에 표시할 값이 없어요', 'No values to show in the chart', '没有可显示的图表数据', '沒有可顯示的圖表資料'],
  ['ui.chart.unavailable', '확인할 수 없어요', 'Unavailable', '无法确认', '無法確認'],
  ['ui.chart.axis', '세로축 {min}–{max}{unit}', 'Vertical axis {min}–{max}{unit}', '纵轴 {min}–{max}{unit}', '縱軸 {min}–{max}{unit}'],
  ['ui.chart.axisNonZero', ' · 0부터 시작하지 않아요', ' · does not start at 0', ' · 不从 0 开始', ' · 不從 0 開始'],
  ['ui.loading', '화면을 준비하고 있어요', 'Getting the screen ready', '正在准备画面', '正在準備畫面'],
  ['ui.briefing.title', '오늘 가게 소식이에요', "Today's store news", '今天的店铺动态', '今天的店鋪動態'],
  ['ui.briefing.description', '출근 전에 가게 소식을 살펴보세요', 'Look over your store news before you start', '上班前先看看店铺动态', '上班前先看看店鋪動態'],
  ['ui.coach.close', '안내 닫기', 'Close tip', '关闭提示', '關閉提示'],
  ['ui.coach.scroll', '코칭 안내 본문', 'Tip text', '提示内容', '提示內容'],
  ['ui.coach.note', '안내', 'Tip', '提示', '提示'],
  ['ui.delta.unchanged', '— 변화 없어요', '— No change', '— 无变化', '— 無變化'],
] as const satisfies readonly Row[];

export type UiKey = (typeof rows)[number][0];

function build(index: 1 | 2 | 3 | 4): Record<UiKey, string> {
  return Object.fromEntries(rows.map((r) => [r[0], r[index]])) as Record<UiKey, string>;
}

/** The kit's own bundle. Components read it with useBundle(uiBundle). */
export const uiBundle: MessageBundle<UiKey> = {
  id: 'ui',
  ko: build(1),
  en: build(2),
  'zh-Hans': build(3),
  'zh-Hant': build(4),
};

// Rows whose en / zh text is the DS 11.7 / 11.9 / 11.11 table, LOCALES 6, or the legacy Korean value translated by the DS rows.
const uiSourcedKeys: ReadonlySet<string> = new Set([
  'ui.notice.presetStarted', 'ui.settings.back', 'ui.coach.skipAll', 'ui.coach.progress', 'ui.confirm.title', 'ui.confirm.send', 'ui.confirm.notNow',
  'ui.confirm.sending', 'ui.sms.line', 'ui.sms.autoFooter', 'ui.benefit.more', 'ui.benefit.recommended', 'ui.discount.name', 'ui.discount.limitText',
  'ui.discount.summary', 'ui.discount.loss', 'ui.discount.setFixed', 'ui.video.silent', 'ui.video.play', 'ui.video.pause', 'ui.video.replay',
  'ui.video.previous', 'ui.video.next', 'ui.video.sceneChip', 'ui.formula.show', 'ui.copy.then', 'ui.send.time', 'ui.send.now', 'ui.send.schedule',
  'ui.channel.totalSame', 'ui.channel.overStock', 'ui.notice.outsideGrid', 'ui.channel.total', 'ui.edge.chip',
]);

/** Keys whose English / Chinese text is the worker's own writing (not from DS 11.7/11.9/11.11 or LOCALES), for R2 review. */
export const uiReviewKeys: readonly UiKey[] = rows.map((r) => r[0]).filter((key) => !uiSourcedKeys.has(key));

/** Translator for non-React code (formatNotice default). */
export function createKitTranslator(locale: Locale = 'ko') {
  return createTranslator(locale, ...([uiBundle, managementUiBundle, ...baseBundles] as readonly MessageBundle<string>[]));
}

