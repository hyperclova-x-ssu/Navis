/**
 * mkt-coupon message bundle (T-059): `widget.{slot-coupon|expiry-coupon|coupon-status|customer-groups}.*` except title/coach/aliases
 * (common bundle). `sourcedRows` are verbatim from LOCALES 9.3 / DESIGN_SYSTEM 11.11; `writtenRows` are written here for R2 review.
 * Row shape: key -> [ko, en, zh-Hans, zh-Hant].
 */
import { defineBundle } from '../../../i18n';
import type { MessageBundle } from '../../../i18n';

type Row = readonly [ko: string, en: string, zhHans: string, zhHant: string];

const sourcedRows = {
  // LOCALES 9.3 빈 시간
  // GD-3 (S5-129): the window is tomorrow + 6 days (10/27 Tue ~ 11/2 Mon), not the calendar ‘다음 주’ that starts 11/2, so the label says ‘내일부터 7일’ and the detail names the dates.
  'widget.slot-coupon.panelQ': ['내일부터 7일 빈 시간', 'Quiet hours, next 7 days', '未来 7 天空闲时段', '未來 7 天空閒時段'],
  'widget.slot-coupon.panelW': ['내일부터 7일 빈 시간\u00A0· 맞춤 단골 {n}명', 'Quiet hours, next 7 days\u00A0· {n} matching regulars', '未来 7 天空闲时段\u00A0· 匹配熟客 {n} 位', '未來 7 天空閒時段\u00A0· 符合熟客 {n} 位'],
  'widget.slot-coupon.keptLine': ['쿠폰 1장당 남는 돈 {amount}', 'You keep {amount} per coupon', '每张优惠券剩余利润 {amount}', '每張優惠券剩餘利潤 {amount}'],
  // LOCALES 9.3 당일 소진
  'widget.expiry-coupon.limit': ['{p}%까지 깎아도 버리는 것보다 이득이에요', 'Up to {p}% off still beats throwing it away', '折扣在 {p}% 以内也比丢弃划算', '折扣在 {p}% 以內也比丟棄划算'],
  'widget.expiry-coupon.second': ['마감 3시간 전에도 남으면 2차 할인을 제안해요', "If some are left 3 hours before closing, we'll suggest a second discount", '打烊前 3 小时若仍有剩余，将建议二次折扣', '打烊前 3 小時若仍有剩餘，將建議二次折扣'],
  // LOCALES 9.3 쿠폰 현황
  'widget.coupon-status.used': ['{issued}장 중 {used}장 사용', 'Used {used}/{issued}', '已使用 {used}/{issued}', '已使用 {used}/{issued}'],
  'widget.coupon-status.daysLeft': ['{n}일 남음', '{n, plural, one {# day left} other {# days left}}', '剩余 {n} 天', '剩餘 {n} 天'],
  'widget.coupon-status.untilToday': ['오늘까지', 'Until today', '仅限今天', '僅限今天'],
  'widget.coupon-status.total': ['이번 달 사용 {n}장 = 진행 중 {a}장 + 끝난 쿠폰 {b}장', 'Used this month: {n} = {a} active + {b} ended', '本月已使用 {n} 张 = 进行中 {a} 张 + 已结束 {b} 张', '本月已使用 {n} 張 = 進行中 {a} 張 + 已結束 {b} 張'],
  'widget.coupon-status.paused': ['일시 중지됨', 'Paused', '已暂停', '已暫停'],
  'widget.coupon-status.panelW': ['{n}장\u00A0· 곧 끝나는 쿠폰 {m}장', '{n} coupons\u00A0· {m} ending soon', '{n} 张\u00A0· 即将到期 {m} 张', '{n} 張\u00A0· 即將到期 {m} 張'],
  // LOCALES 9.3 손님 그룹
  'widget.customer-groups.panelW': ['떠날 수 있는 손님\u00A0· 첫 방문 {a}명\u00A0· 단골 {b}명', 'customers who may leave\u00A0· first-time {a}\u00A0· regulars {b}', '可能流失的顾客\u00A0· 首次到店 {a}\u00A0· 熟客 {b}', '可能流失的顧客\u00A0· 首次到店 {a}\u00A0· 熟客 {b}'],
  // DESIGN_SYSTEM 11.11 단계 제목 · 추천 차이
  'widget.slot-coupon.step1': ['1 빈 시간', '1 Quiet hours', '1 空闲时段', '1 空閒時段'],
  'widget.slot-coupon.step2': ['2 보낼 손님', '2 Who to send to', '2 发送对象', '2 發送對象'],
  'widget.slot-coupon.step3': ['3 혜택', '3 Benefit', '3 优惠内容', '3 優惠內容'],
  'widget.slot-coupon.step4': ['4 문구', '4 Message', '4 短信内容', '4 簡訊內容'],
  'widget.slot-coupon.moreKept': ['{amount} 더 남아요', 'You keep {amount} more', '多剩余 {amount}', '多剩餘 {amount}'],
  'widget.coupon-status.pausedBadge': ['일시 중지됨', 'Paused', '已暂停', '已暫停'],
} as const satisfies Record<string, Row>;

const writtenRows = {
  // T-063: the empty-state button of the 1x1 panel at 125 % text must fit one line, so the panel uses this short name (the detail keeps data.marketing.action.viewTodayPromotions)
  'widget.coupon-status.emptyAction': ['빈 시간 단골 쿠폰 열기', 'Open quiet-hour coupons', '打开闲时优惠券', '開啟離峰時段優惠券'],
  // ───── 빈 시간 단골 쿠폰
  'widget.slot-coupon.unitName': ['개', '{n, plural, one {slot} other {slots}}', '个时段', '個時段'],
  'widget.slot-coupon.summary': ['내일부터 7일 빈 시간 {n}개, 맞춤 단골 {m}명', '{n} quiet slots in the next 7 days, {m} matching regulars', '未来 7 天有 {n} 个空闲时段，匹配熟客 {m} 位', '未來 7 天有 {n} 個空閒時段，符合熟客 {m} 位'],
  'widget.slot-coupon.windowLine': ['내일부터 7일\u00A0· {range}', 'Next 7 days\u00A0· {range}', '未来 7 天\u00A0· {range}', '未來 7 天\u00A0· {range}'],
  'widget.slot-coupon.windowRange': ['{start}~{end}', '{start} – {end}', '{start}~{end}', '{start}~{end}'],
  'widget.slot-coupon.allSent': ['모든 빈 시간에 쿠폰을 보냈어요', 'Coupons sent for every quiet slot', '所有空闲时段都已发送优惠券', '所有空閒時段都已發送優惠券'],
  'widget.slot-coupon.slotLine': ['{slot}\u00A0· 평소의 {percent}%', '{slot}\u00A0· {percent}% of usual', '{slot}\u00A0· 平时的 {percent}%', '{slot}\u00A0· 平時的 {percent}%'],
  /** D-333: the regulars matching one quiet slot (large card only). */
  'widget.slot-coupon.slotRegulars': ['단골 {n}명', '{n, plural, one {# regular} other {# regulars}}', '熟客 {n} 位', '熟客 {n} 位'],
  'widget.slot-coupon.slotsLabel': ['빈 시간 고르기', 'Choose quiet hours', '选择空闲时段', '選擇空閒時段'],
  'widget.slot-coupon.recommendLine': ['{name} — 할인보다 남는 돈이 많아요', '{name} — you keep more than with a discount', '{name} — 比打折剩余利润更多', '{name} — 比折扣剩餘利潤更多'],
  'widget.slot-coupon.recipientMeta': ['{slot}\u00A0· 마지막 방문 {date}', '{slot}\u00A0· last visit {date}', '{slot}\u00A0· 最近到店 {date}', '{slot}\u00A0· 最近到店 {date}'],
  'widget.slot-coupon.adHelp': ['문자를 보내려면 발신 번호를 먼저 등록해 주세요', 'Register a sender number before sending texts', '发送短信前请登记发件号码', '傳送簡訊前請登記發件號碼'],
  'widget.slot-coupon.optOutHelp': ['무료 수신 거부 번호도 등록해 주세요', 'Register a free opt-out number too', '还请登记免费的退订号码', '也請登記免費的退訂號碼'],
  'widget.slot-coupon.tomorrowAtEight': ['내일 8시', '8 AM tomorrow', '明早 8 点', '明早 8 點'],
  'widget.slot-coupon.nightBlocked': ['밤 9시부터 아침 8시 전에는 문자를 보낼 수 없어요', 'Texts can only be sent between 8 AM and 9 PM.', '只能在早上 8 点至晚上 9 点前发送短信', '只能在早上 8 點至晚上 9 點前傳送簡訊'],
  'widget.slot-coupon.summaryTitle': ['보내기 전 요약', 'Before you send', '发送前摘要', '發送前摘要'],
  'widget.slot-coupon.send': ['{n}명에게 쿠폰 보내기', 'Send coupon ({n, plural, one {# recipient} other {# recipients}})', '发送优惠券（收件人 {n} 位）', '發送優惠券（收件人 {n} 位）'],
  'widget.slot-coupon.sentTitle': ['보낸 쿠폰', 'Sent coupons', '已发送的优惠券', '已發送的優惠券'],
  'widget.slot-coupon.sentLine': ['{name}\u00A0· {issued}장 중 {used}장 사용\u00A0· {left}', '{name}\u00A0· used {used}/{issued}\u00A0· {left}', '{name}\u00A0· 已使用 {used}/{issued}\u00A0· {left}', '{name}\u00A0· 已使用 {used}/{issued}\u00A0· {left}'],
  'widget.slot-coupon.again': ['다른 빈 시간도 보내기', 'Send for another quiet slot', '再为其他空闲时段发送', '再為其他空閒時段發送'],
  'widget.slot-coupon.scheduledAt': ['{date} {time} 예약', 'Scheduled {date} {time}', '预约 {date} {time}', '預約 {date} {time}'],
  // ───── 당일 소진 쿠폰
  'widget.expiry-coupon.unitName': ['개', 'pcs', '个', '個'],
  'widget.expiry-coupon.panelQ': ['{item}\u00A0· 오늘 안에 팔아야 해요', '{item}\u00A0· must sell today', '{item}\u00A0· 今天必须卖完', '{item}\u00A0· 今天必須賣完'],
  'widget.expiry-coupon.panelW': ['{item}\u00A0· 오늘 마감 전\u00A0· 추천 할인 {p}%', '{item}\u00A0· before closing today\u00A0· suggested {p}% off', '{item}\u00A0· 今日打烊前\u00A0· 推荐折扣 {p}%', '{item}\u00A0· 今日打烊前\u00A0· 推薦折扣 {p}%'],
  'widget.expiry-coupon.summary': ['{item} {qty}\u00A0· 오늘 안에 팔아야 해요', '{item}: {qty} left\u00A0· must sell today', '{item} {qty}\u00A0· 今天必须卖完', '{item} {qty}\u00A0· 今天必須賣完'],
  'widget.expiry-coupon.step1': ['1 품목', '1 Item', '1 商品', '1 商品'],
  'widget.expiry-coupon.step2': ['2 혜택', '2 Benefit', '2 优惠', '2 優惠'],
  'widget.expiry-coupon.step3': ['3 보낼 곳', '3 Where to send', '3 发送渠道', '3 發送管道'],
  'widget.expiry-coupon.itemLine': ['{item} {qty}\u00A0· {until}', '{item}: {qty}\u00A0· {until}', '{item} {qty}\u00A0· {until}', '{item} {qty}\u00A0· {until}'],
  'widget.expiry-coupon.formula': ['최대 할인율 {max}% = 1 − 원가 {cost} ÷ 판매가 {price}', 'Maximum discount {max}% = 1 − cost {cost} ÷ price {price}', '最大折扣率 {max}% = 1 − 成本 {cost} ÷ 售价 {price}', '最大折扣率 {max}% = 1 − 成本 {cost} ÷ 售價 {price}'],
  'widget.expiry-coupon.routeSms': ['단골 문자(문자 동의 {n}명)', 'Regular-customer text ({n} with consent)', '熟客短信（已同意 {n} 位）', '熟客簡訊（已同意 {n} 位）'],
  'widget.expiry-coupon.routePlace': ['플레이스 소식(새 손님)', 'Place news (new customers)', '地点动态（新顾客）', '地點動態（新顧客）'],
  'widget.expiry-coupon.confirmCreate': ['쿠폰을 만들까요?', 'Create this coupon?', '要创建这张优惠券吗？', '要建立這張優惠券嗎？'],
  'widget.expiry-coupon.create': ['만들기', 'Create', '创建', '建立'],
  'widget.expiry-coupon.notNow': ['다음에', 'Not now', '暂不', '暫不'],
  'widget.expiry-coupon.postTitle': ['게시 문구', 'Post text', '发布文案', '發布文案'],
  'widget.expiry-coupon.alreadyMade': ['오늘 쿠폰을 이미 만들었어요', "Today's coupon is already made", '今天的优惠券已创建', '今天的優惠券已建立'],
  'widget.expiry-coupon.createdTitle': ['오늘 만든 쿠폰', 'Coupons made today', '今天创建的优惠券', '今天建立的優惠券'],
  'widget.expiry-coupon.summaryItem': ['품목', 'Item', '商品', '商品'],
  'widget.expiry-coupon.summaryRoute': ['보낼 곳', 'Where to send', '发送渠道', '發送管道'],
  'widget.expiry-coupon.summaryPrice': ['혜택', 'Benefit', '优惠', '優惠'],
  'widget.expiry-coupon.kindLabel': ['혜택 종류', 'Benefit type', '优惠类型', '優惠類型'],
  'widget.expiry-coupon.kind.percent': ['정률 할인', 'Percent off', '比例折扣', '比例折扣'],
  'widget.expiry-coupon.kind.amount': ['금액 할인', 'Amount off', '金额减免', '金額減免'],
  'widget.expiry-coupon.kind.setPrice': ['세트 가격', 'Set price', '套餐价', '套餐價'],
  'widget.expiry-coupon.valueLabel.percent': ['할인율', 'Discount rate', '折扣率', '折扣率'],
  'widget.expiry-coupon.valueLabel.amount': ['할인 금액', 'Discount amount', '减免金额', '減免金額'],
  'widget.expiry-coupon.valueLabel.setPrice': ['세트 가격', 'Set price', '套餐价', '套餐價'],
  'widget.expiry-coupon.unitWon': ['원', 'KRW', '韩元', '韓元'],
  'widget.expiry-coupon.limitAmount': ['{amount}까지 깎아도 버리는 것보다 이득이에요', 'Up to {amount} off still beats throwing it away', '减免 {amount} 以内也比丢弃划算', '減免 {amount} 以內也比丟棄划算'],
  'widget.expiry-coupon.limitSetPrice': ['{price} 이상이면 버리는 것보다 이득이에요', 'A set price of {price} or more still beats throwing it away', '套餐价不低于 {price} 也比丢弃划算', '套餐價不低於 {price} 也比丟棄划算'],
  'widget.expiry-coupon.placeHint': ['쿠폰을 만들면 게시 문구와 쿠폰 코드가 함께 만들어져요', 'Creating the coupon also makes the post text and the coupon code', '创建优惠券后会同时生成发布文案和优惠码', '建立優惠券後會同時產生發布文案和優惠碼'],
  'widget.expiry-coupon.postedDone': ['올렸다고 표시했어요. 이제 쿠폰 코드 사용을 집계해요', 'Marked as posted. Coupon code use is now counted', '已发布！已开始统计优惠码', '已發布！已開始統計優惠碼'],
  // ───── 진행 중인 쿠폰
  'widget.coupon-status.unitName': ['장', 'coupons', '张', '張'],
  'widget.coupon-status.endingLine': ['곧 끝나는 쿠폰 {m}장', '{m} ending soon', '即将到期 {m} 张', '即將到期 {m} 張'],
  'widget.coupon-status.summary': ['진행 중인 쿠폰 {n}장, 곧 끝나는 쿠폰 {m}장', '{n} active coupons, {m} ending soon', '进行中的优惠券 {n} 张，即将到期 {m} 张', '進行中的優惠券 {n} 張，即將到期 {m} 張'],
  'widget.coupon-status.activeHeader': ['진행 중 {n}장', '{n} active', '进行中 {n} 张', '進行中 {n} 張'],
  // GD-3 (U-03): a paused coupon is listed (so it can be resumed) but is not counted as running; the header and the month line say so.
  'widget.coupon-status.activeHeaderPaused': ['진행 중 {n}장\u00A0· 중지 {p}장', '{n} active\u00A0· {p} paused', '进行中 {n} 张\u00A0· 已暂停 {p} 张', '進行中 {n} 張\u00A0· 已暫停 {p} 張'],
  'widget.coupon-status.pausedLine': ['중지된 쿠폰 {p}장', '{p} paused', '已暂停 {p} 张', '已暫停 {p} 張'],
  'widget.coupon-status.totalPaused': ['이번 달 사용 {n}장 = 진행·중지 중 {a}장 + 끝난 쿠폰 {b}장', 'Used this month: {n} = {a} active or paused + {b} ended', '本月已使用 {n} 张 = 进行中或已暂停 {a} 张 + 已结束 {b} 张', '本月已使用 {n} 張 = 進行中或已暫停 {a} 張 + 已結束 {b} 張'],
  'widget.coupon-status.colCoupon': ['쿠폰', 'Coupon', '优惠券', '優惠券'],
  'widget.coupon-status.colUsed': ['사용', 'Used', '使用', '使用'],
  'widget.coupon-status.colLeft': ['남은 기간', 'Time left', '剩余时间', '剩餘時間'],
  'widget.coupon-status.colActions': ['관리', 'Actions', '操作', '操作'],
  'widget.coupon-status.tableLabel': ['진행 중인 쿠폰 목록', 'Active coupons list', '进行中的优惠券列表', '進行中的優惠券列表'],
  'widget.coupon-status.resume': ['다시 시작하기', 'Resume', '恢复', '恢復'],
  'widget.coupon-status.endedTitle': ['이번 달 끝난 쿠폰 {n}장', 'Coupons ended this month: {n}', '本月已结束的优惠券 {n}', '本月已結束的優惠券 {n}'],
  'widget.coupon-status.endedLine': ['{name}\u00A0· 사용 {used}/{issued}\u00A0· {date} 종료', '{name}\u00A0· used {used}/{issued}\u00A0· ended {date}', '{name}\u00A0· 已使用 {used}/{issued}\u00A0· {date} 结束', '{name}\u00A0· 已使用 {used}/{issued}\u00A0· {date} 結束'],
  'widget.coupon-status.noUsage': ['사용 기록 없음', 'No usage data', '没有使用记录', '沒有使用紀錄'],
  'widget.coupon-status.notifyTitle': ['끝나기 전 알림', 'Ending-soon reminder', '到期前提醒', '到期前提醒'],
  'widget.coupon-status.notifyFor': ['대상 쿠폰', 'Coupon', '目标优惠券', '目標優惠券'],
  'widget.coupon-status.noEnding': ['곧 끝나는 쿠폰이 없어요', 'No coupons are ending soon', '没有即将到期的优惠券', '沒有即將到期的優惠券'],
  'widget.coupon-status.notifySend': ['알림 보내기(받는 사람 {n}명)', 'Send reminder ({n, plural, one {# recipient} other {# recipients}})', '发送提醒（收件人 {n} 位）', '發送提醒（收件人 {n} 位）'],
  'widget.coupon-status.monthLine': ['이번 달 사용 {n}장', 'Used this month: {n}', '本月已使用 {n} 张', '本月已使用 {n} 張'],
  'widget.coupon-status.pauseName': ['{name} 일시 중지하기', 'Pause {name}', '暂停 {name}', '暫停 {name}'],
  'widget.coupon-status.resumeName': ['{name} 다시 시작하기', 'Resume {name}', '恢复 {name}', '恢復 {name}'],
  'widget.coupon-status.extendName': ['{name} 7일 늘리기', 'Extend {name} by 7 days', '将 {name} 延期 7 天', '將 {name} 延長 7 天'],
  // ───── 손님 그룹
  'widget.customer-groups.unitName': ['명', 'customers', '位', '位'],
  'widget.customer-groups.summary': ['떠날 수 있는 손님 {n}명, 첫 방문 {a}명, 최근 방문 기준 단골 {b}명', '{n} customers who may leave, {a} first-time, {b} regulars by recent visits', '可能流失的顾客 {n} 位，首次到店 {a} 位，按近期到店统计的熟客 {b} 位', '可能流失的顧客 {n} 位，首次到店 {a} 位，按近期到店統計的熟客 {b} 位'],
  // GD-3 (U-07): this count follows card visits; the 회원 grade is a separate count (and can be set by hand), so the answer names its basis.
  'widget.customer-groups.recipientsTitle': ['쿠폰을 보낼 손님', 'Customers to send a coupon to', '接收优惠券的顾客', '接收優惠券的顧客'],
  'widget.customer-groups.regularAnswer': ['최근 방문 기준 단골은 {n}명이에요', 'By recent visits, you have {n} regulars', '按近期到店统计，熟客有 {n} 位', '按近期到店統計，熟客有 {n} 位'],
  'widget.customer-groups.groupLine': ['{group} {n}', '{group} {n}', '{group} {n}', '{group} {n}'],
  'widget.customer-groups.basis.churn-risk': ['평소 방문 주기보다 {days}일 넘게 안 온 손님이에요', "Customers who haven't come for over {days} days beyond their usual interval", '超过平常到店间隔 {days} 天仍未到店的顾客', '超過平常到店間隔 {days} 天仍未到店的顧客'],
  'widget.customer-groups.basis.first-visit': ['방문이 한 번뿐인 손님이에요', 'Customers who have visited only once', '只到店过一次的顾客', '只到店過一次的顧客'],
  'widget.customer-groups.basis.regular': ['최근 {days}일 안에 {n}번 이상 온 손님이에요', 'Customers who came {n} or more times in the last {days} days', '最近 {days} 天内到店 {n} 次以上的顾客', '最近 {days} 天內到店 {n} 次以上的顧客'],
  'widget.customer-groups.lastVisit': ['마지막 방문 {date}', 'Last visit {date}', '最近到店 {date}', '最近到店 {date}'],
  'widget.customer-groups.cycle': ['평소 {n}일마다', 'About every {n} days', '平常约每 {n} 天', '平常約每 {n} 天'],
  'widget.customer-groups.cycleNone': ['방문 1회', 'One visit', '到店 1 次', '到店 1 次'],
  'widget.customer-groups.consentYes': ['동의', 'Opted in', '已同意', '已同意'],
  'widget.customer-groups.consentNo': ['동의 안 함', 'No consent', '未同意', '未同意'],
  'widget.customer-groups.listLabel': ['{group} 손님 목록', '{group} customer list', '{group}顾客列表', '{group}顧客列表'],
  'widget.customer-groups.groupsLabel': ['손님 그룹', 'Customer groups', '顾客分组', '顧客分組'],
  'widget.customer-groups.send': ['{n}명에게 쿠폰 보내기', 'Send coupon ({n, plural, one {# recipient} other {# recipients}})', '发送优惠券（收件人 {n} 位）', '發送優惠券（收件人 {n} 位）'],
  'widget.customer-groups.sentTitle': ['보낸 쿠폰', 'Sent coupons', '已发送的优惠券', '已發送的優惠券'],
  'widget.customer-groups.noneHere': ['이 그룹에는 손님이 없어요', 'No customers in this group', '此分组没有顾客', '此分組沒有顧客'],
  // A10: an empty group names its next action (WV-COUPON). `seeChurn` jumps to the tab where coupons are sent; `again` goes back to the recipient list after sending.
  'widget.customer-groups.seeChurn': ['떠날 수 있는 손님 보기', 'See customers who may leave', '查看可能流失的顾客', '查看可能流失的顧客'],
  'widget.customer-groups.again': ['손님 다시 고르기', 'Choose customers again', '重新选择顾客', '重新選擇顧客'],
  'widget.customer-groups.state.no-history.next': ['결제 기록이 쌓이면 손님을 자동으로 나눠 드려요. 그동안 회원목록에서 연락처와 문자 동의를 확인해 두세요.', 'Once card payments build up, customers are sorted into groups automatically. Meanwhile, check contacts and text consent in the member list.', '刷卡记录积累后会自动为顾客分组。在此之前，请先在会员列表中确认联系方式和短信同意情况。', '刷卡紀錄累積後會自動為顧客分組。在此之前，請先在會員列表中確認聯絡方式和簡訊同意情況。'],
  'widget.customer-groups.state.no-history.action': ['회원목록 열기', 'Open the member list', '打开会员列表', '開啟會員列表'],
} as const satisfies Record<string, Row>;

const allRows: Readonly<Record<string, Row>> = { ...sourcedRows, ...writtenRows };
/** LOCALES 11.13 / D-209: new copy has ko keys only; other languages use the normal fallback. */
const koOnly = {
  'widget.expiry-coupon.moneySummary': '할인가 {price} · 개당 남는 돈 {profit} · 모두 팔면 남는 돈 {total}',
  'widget.slot-coupon.sentResult': '{slot} 단골 {n}명에게 발송을 예약했어요',
  'widget.slot-coupon.label': '내일부터 7일 빈 시간',
  'widget.coupon-status.label': '진행 중',
  'widget.coupon.state.error.short': '불러오지 못했어요',
  'widget.coupon-status.state.none.short': '진행 중인 쿠폰이 없어요',
  'widget.customer-groups.state.no-history.short': '방문 기록이 아직 없어요',
} as const;
type TranslatedKey = keyof typeof sourcedRows | keyof typeof writtenRows;
export type MktCouponKey = TranslatedKey | keyof typeof koOnly;
const pick = (index: number) => Object.freeze(Object.fromEntries(Object.entries(allRows).map(([key, row]) => [key, row[index]]))) as Readonly<Record<TranslatedKey, string>>;

/** Duplicate keys with the common bundle (title/coach/aliases) are forbidden; widget tests check it. */
export const mktCouponBundle: MessageBundle<MktCouponKey> = defineBundle<MktCouponKey>({
  id: 'mkt-coupon', ko: { ...pick(0), ...koOnly }, en: pick(1), 'zh-Hans': pick(2), 'zh-Hant': pick(3),
});

/** “R2 검토 필요 문구 수”: en + zh-Hans + zh-Hant strings written here (not verbatim from LOCALES 9.3 / DS 11.11). */
export const r2Review = Object.freeze({ writtenRows: Object.keys(writtenRows).length, sourcedRows: Object.keys(sourcedRows).length, strings: Object.keys(writtenRows).length * 3 });
