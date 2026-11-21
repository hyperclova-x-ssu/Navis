/**
 * T-060/T-083 message bundle of the mkt-promo widgets (prefix widget.{marketing-today|promo-video|marketing-performance}.* and promo.*,
 * ARCHITECTURE 11.6). Rows are [ko, en, zh-Hans, zh-Hant]. `sourced` rows are taken from LOCALES 9.3 / DESIGN_SYSTEM 11.11;
 * `written` rows are new sentences in the same vocabulary and need the R2 review (counted in `mktPromoR2Review`).
 */
import type { MessageBundle } from '../../../i18n';

type Row = readonly [ko: string, en: string, hans: string, hant: string];
const PREFIX_TODAY = 'widget.marketing-today.';
const PREFIX_VIDEO = 'widget.promo-video.';
const PREFIX_PERF = 'widget.marketing-performance.';

const sourced: Readonly<Record<string, Row>> = {
  /* 오늘 할 홍보 (LOCALES 9.3) */
  [`${PREFIX_TODAY}slot.now`]: ['지금', 'Now', '现在', '現在'],
  [`${PREFIX_TODAY}slot.today`]: ['오늘', 'Today', '今天', '今天'],
  [`${PREFIX_TODAY}slot.week`]: ['이번 주', 'This week', '本周', '本週'],
  [`${PREFIX_TODAY}quiet.s1`]: ['{day} {s}~{e}시가 한산해요', '{day} {s}–{e} is quiet', '{day} {s}~{e} 点比较清闲', '{day} {s}~{e} 點比較清閒'],
  [`${PREFIX_TODAY}quiet.s2`]: [
    '그 시간에 자주 오던 단골이 {n}명 있어요',
    '{n, plural, one {# regular often comes} other {# regulars often come}} at that time.',
    '经常在这个时间来的熟客有 {n} 位。',
    '經常在這個時間來的熟客有 {n} 位。',
  ],
  [`${PREFIX_TODAY}replies.s1`]: [
    '답변 기다리는 메시지·리뷰가 {n}건 있어요',
    '{n, plural, one {# message or review is} other {# messages and reviews are}} waiting for a reply.',
    '有 {n} 条消息和评论等待回复。',
    '有 {n} 則訊息和評論等待回覆。',
  ],
  [`${PREFIX_TODAY}replies.s2`]: ['답변 초안을 써 뒀어요', 'Drafts are ready.', '已写好回复草稿。', '已寫好回覆草稿。'],
  [`${PREFIX_TODAY}video.s2`]: ['짧은 영상으로 만들어 볼까요?', 'Turn them into a short video?', '要做成短视频吗？', '要做成短影片嗎？'],
  /* 마케팅 성과 (LOCALES 9.3, DS 11.11) */
  [`${PREFIX_PERF}m.rate`]: ['쿠폰 사용률', 'Coupon redemption rate', '优惠券核销率', '優惠券核銷率'],
  [`${PREFIX_PERF}m.revenue`]: ['홍보로 생긴 매출', 'Sales from promotions', '推广带来的销售额', '推廣帶來的銷售額'],
  [`${PREFIX_PERF}m.profit`]: ['할인 후 실제 이익', 'Profit after discounts', '折扣后实际利润', '折扣後實際利潤'],
  [`${PREFIX_PERF}returnUnknown`]: ['알 수 없어요', 'Unknown', '无法确定', '無法確定'],
  [`${PREFIX_PERF}m.return`]: ['다시 온 손님', 'Returning customers', '回头顾客', '回頭顧客'],
  [`${PREFIX_PERF}profitNote`]: ['원가·할인 뺀 금액', 'After costs and discounts', '扣除成本和折扣后的金额', '扣除成本和折扣後的金額'],
  [`${PREFIX_PERF}best`]: ['가장 잘된 경로: {route} {n}%', 'Best channel: {route} {n}%', '效果最好的渠道：{route} {n}%', '效果最好的管道：{route} {n}%'],
  [`${PREFIX_PERF}th.route`]: ['경로', 'Channel', '渠道', '管道'],
  [`${PREFIX_PERF}th.issued`]: ['발행', 'Issued', '发放', '發放'],
  [`${PREFIX_PERF}th.used`]: ['사용', 'Used', '使用', '使用'],
  [`${PREFIX_PERF}th.rate`]: ['사용률', 'Rate', '核销率', '核銷率'],
  [`${PREFIX_PERF}period.this`]: ['이번 달', 'This month', '本月', '本月'],
  [`${PREFIX_PERF}period.last`]: ['지난달', 'Last month', '上月', '上月'],
  [`${PREFIX_PERF}insight`]: [
    '{best, particle, 이/가} {other}의 2배 가까이 돌아와요. 다음 쿠폰은 {best}부터 올려볼까요?',
    '{best} gets nearly twice the redemptions of {other}. Post your next coupon on {best} first?',
    '{best}的核销率接近{other}的 2 倍。下一张优惠券先发在{best}上吧？',
    '{best}的核銷率接近{other}的 2 倍。下一張優惠券先發在{best}上吧？',
  ],
  [`${PREFIX_PERF}recent`]: [
    '방금 보낸 쿠폰 {n}장이 발행에 더해졌어요. 사용은 쿠폰이 쓰이면 늘어요',
    'The {n} coupons you just sent were added to issued. Redeemed goes up when coupons are used',
    '刚发送的 {n} 张优惠券已计入发放数。优惠券被使用后使用数才会增加',
    '剛發送的 {n} 張優惠券已計入發放數。優惠券被使用後使用數才會增加',
  ],
};

const written: Readonly<Record<string, Row>> = {
  /* 오늘 할 홍보 */
  // GD-3 (S5-129): the quiet-hours window is tomorrow + 6 days, so its tag is not the calendar ‘다음 주’.
  [`${PREFIX_TODAY}slot.window`]: ['내일부터 7일', 'Next 7 days', '未来 7 天', '未來 7 天'],
  [`${PREFIX_TODAY}expiry.s1`]: [
    '{item} {n}개를 오늘 안에 팔아야 해요',
    '{item}: {n} left to sell today',
    '今天必须卖完 {n} 个{item}',
    '今天必須賣完 {n} 個{item}',
  ],
  [`${PREFIX_TODAY}stop`]: ['. ', '.', '。', '。'],
  [`${PREFIX_TODAY}group`]: ['오늘 할 홍보 항목', 'Promotions to do', '待办推广项目', '待辦推廣項目'],
  [`${PREFIX_TODAY}sr.nothing`]: ['지금 급한 홍보는 없어요', 'Nothing urgent to promote right now', '现在没有紧急的推广', '現在沒有緊急的推廣'],
  /* 마케팅 성과 */
  [`${PREFIX_PERF}usedIssued`]: ['사용 {used}장\u00A0· 발행 {issued}장', 'Used {used}\u00A0· Issued {issued}', '使用 {used}\u00A0· 发放 {issued}', '使用 {used}\u00A0· 發放 {issued}'],
  [`${PREFIX_PERF}bestLabel`]: ['가장 잘된 경로', 'Best channel', '效果最好的渠道', '效果最好的管道'],
  [`${PREFIX_PERF}bestValue`]: ['{route} {n}%', '{route} {n}%', '{route} {n}%', '{route} {n}%'],
  [`${PREFIX_PERF}tab.route`]: ['경로별', 'By channel', '按渠道', '按管道'],
  [`${PREFIX_PERF}tab.coupon`]: ['쿠폰별', 'By coupon', '按优惠券', '按優惠券'],
  [`${PREFIX_PERF}tab.video`]: ['영상별', 'By video', '按视频', '按影片'],
  [`${PREFIX_PERF}tabs`]: ['성과 보기', 'View results', '查看成效', '查看成效'],
  [`${PREFIX_PERF}period`]: ['기간', 'Period', '期间', '期間'],
  [`${PREFIX_PERF}total`]: ['합계', 'Total', '合计', '合計'],
  [`${PREFIX_PERF}th.coupon`]: ['쿠폰', 'Coupon', '优惠券', '優惠券'],
  [`${PREFIX_PERF}th.video`]: ['영상', 'Video', '视频', '影片'],
  [`${PREFIX_PERF}th.line`]: ['줄', 'Line', '项目', '項目'],
  [`${PREFIX_PERF}routeLines.usage`]: ['{total}장 중 {used}장 사용', '{used} of {total} used', '{total} 张中使用 {used} 张', '{total} 張中使用 {used} 張'],
  [`${PREFIX_PERF}empty.next`]: ['먼저 단골에게 쿠폰을 보내 보세요', 'Send a coupon to your regulars first', '先给熟客发一张优惠券吧', '先給熟客發一張優惠券吧'],
  [`${PREFIX_PERF}video.row`]: ['{route}에 올린 영상', 'Video posted to {route}', '发布到{route}的视频', '發布到{route}的影片'],
  [`${PREFIX_PERF}video.zero`]: ['올린 영상이 생기면 여기서 보여 드릴게요', 'No video posted yet. It counts as 0 until you post one', '还没有发布的视频，发布前按 0 统计', '還沒有發布的影片，發布前按 0 統計'],
  [`${PREFIX_PERF}formula.revenue`]: [
    '{total} = {a}(쿠폰 코드 사용) + {b}(홍보 후 14일 안 단골)',
    '{total} = {a} (coupon code use) + {b} (regulars within 14 days)',
    '{total} = {a}（使用优惠码）+ {b}（推广后 14 天内的熟客）',
    '{total} = {a}（使用優惠碼）+ {b}（推廣後 14 天內的熟客）',
  ],
  [`${PREFIX_PERF}formula.profit`]: [
    '{profit} = {total} − {cost}(원가) − {discount}(할인액)',
    '{profit} = {total} − {cost} (cost) − {discount} (discounts)',
    '{profit} = {total} − {cost}（成本）− {discount}（折扣额）',
    '{profit} = {total} − {cost}（成本）− {discount}（折扣額）',
  ],
  [`${PREFIX_PERF}formula.rate`]: ['{rate} = {used} ÷ {issued}', '{rate} = {used} ÷ {issued}', '{rate} = {used} ÷ {issued}', '{rate} = {used} ÷ {issued}'],
  [`${PREFIX_PERF}routeLines`]: ['{route} 쿠폰·영상', '{route}: coupons and videos', '{route}的优惠券和视频', '{route}的優惠券和影片'],
  [`${PREFIX_PERF}routeLines.none`]: ['이 경로로 나간 쿠폰이 아직 없어요', 'No coupons went out on this channel yet', '这个渠道还没有发出优惠券', '這個管道還沒有發出優惠券'],
  // GD-3 (S6): the lines are this period's codes (ended coupons included) and add up to the route row.
  [`${PREFIX_PERF}routeLines.lastMonth`]: ['지난달은 경로별 합계만 있어요', 'Last month has channel totals only', '上月只有各渠道合计', '上月只有各管道合計'],
  [`${PREFIX_PERF}routeLines.sum`]: ['합계 {issued}장 발행 · {used}장 사용', 'Total: {issued} issued · {used} used', '合计：发放 {issued} 张 · 使用 {used} 张', '合計：發放 {issued} 張 · 使用 {used} 張'],
  [`${PREFIX_PERF}routeLines.ended`]: ['{name} (끝남)', '{name} (ended)', '{name}（已结束）', '{name}（已結束）'],
  [`${PREFIX_PERF}routeLines.paused`]: ['{name} (중지)', '{name} (paused)', '{name}（已暂停）', '{name}（已暫停）'],
  [`${PREFIX_PERF}missing`]: ['확인 필요', 'Needs review', '需要确认', '需要確認'],
  [`${PREFIX_PERF}lastMonthNote`]: ['지난달은 고정 예시값이에요', 'Last month shows fixed sample values', '上月为固定示例值', '上月為固定範例值'],
  [`${PREFIX_PERF}routeTable`]: ['경로별 발행·사용·사용률', 'Issued, used and rate by channel', '各渠道发放、使用和核销率', '各管道發放、使用和核銷率'],
  [`${PREFIX_PERF}rows.rate`]: ['{label} {value}', '{label} {value}', '{label} {value}', '{label} {value}'],
  [`${PREFIX_PERF}revenueChange.up`]: ['지난달보다 {amount} 늘었어요', 'Up {amount} from last month', '比上个月增加了 {amount}', '比上個月增加了 {amount}'],
  [`${PREFIX_PERF}revenueChange.down`]: ['지난달보다 {amount} 줄었어요', 'Down {amount} from last month', '比上个月减少了 {amount}', '比上個月減少了 {amount}'],
  'promo.need.menu': ['메뉴를 하나 골라 주세요', 'Choose one menu item', '请选择一个菜单品项', '請選擇一個菜單品項'],
  /* PROMO-UI (D-326 Q12): SCR-52 PhotoCountLine "{n}장 골랐어요 · 5장 이상" and SCR-55 summary chip name "{값}, 바꾸려면 누르기, ① 메뉴·사진" */
  'promo.photo.count': ['{n}장 골랐어요 · 5장 이상', '{n} picked · 5 or more', '已选 {n} 张 · 至少 5 张', '已選 {n} 張 · 至少 5 張'],
  'promo.sum.changeName': ['{value}, 바꾸려면 누르기, {tab}', '{value}, press to change, {tab}', '{value}，点按可修改，{tab}', '{value}，點按可修改，{tab}'],
};

/**
 * F-50 D-80 screen text (LOCALES 9.4·9.3, DS 11.12.3, SCREENS SCR-50~58), Korean only by D-83 (외국어 작업은 나중에):
 * these keys have no en/zh values yet, so other languages fall back to Korean until the translation work resumes.
 */
const koOnly: Readonly<Record<string, string>> = {
  /* LOCALES 11.13 / D-218: the kit selects these only for 1x1 and 2x1. */
  'widget.marketing-performance.state.error.short': '불러오지 못했어요',
  [`${PREFIX_TODAY}state.error.short`]: '불러오지 못했어요',
  [`${PREFIX_VIDEO}state.error.short`]: '불러오지 못했어요',
  [`${PREFIX_TODAY}state.none.short`]: '지금 급한 홍보는 없어요',
  [`${PREFIX_VIDEO}state.few-photos.short`]: '사진이 5장 필요해요',
  /* 오늘 할 홍보 이번 주 칸 (LOCALES 9.3 D-80) */
  [`${PREFIX_TODAY}video.photos`]: '리뷰 사진 {n}장이 모였어요',
  /* 위젯 (SCR-50) */
  [`${PREFIX_VIDEO}materials.label`]: '사진',
  [`${PREFIX_VIDEO}materials.unit`]: '장',
  [`${PREFIX_VIDEO}materials.sr`]: '사진 {n}장',
  [`${PREFIX_VIDEO}ready`]: '{menu} 준비됨',
  [`${PREFIX_VIDEO}making`]: '영상 만드는 중',
  [`${PREFIX_VIDEO}makingMeta`]: '{s}초 · 사진 {n}장',
  [`${PREFIX_VIDEO}makingName`]: 'AI 홍보 영상, 만드는 중, {step}, 진행 보기',
  [`${PREFIX_VIDEO}done`]: '영상 1편 완성',
  [`${PREFIX_VIDEO}doneW`]: '영상 1편 완성 · {s}초',
  [`${PREFIX_VIDEO}postedLabel`]: '올린 영상',
  [`${PREFIX_VIDEO}postedUnit`]: '편',
  [`${PREFIX_VIDEO}postedTo`]: '{place}에 올림',
  [`${PREFIX_VIDEO}counting`]: ' · 쿠폰 코드 세는 중',
  [`${PREFIX_VIDEO}failed`]: '만들지 못했어요',
  [`${PREFIX_VIDEO}bar`]: '진행 {n}/4단계',
  /* 버튼 */
  'promo.btn.view': '영상 보기',
  'promo.btn.retry': '다시 만들기',
  'promo.btn.change': '고른 것 바꾸기',
  'promo.fail.detail': '{reason}. 다시 만들어 주세요. 고른 내용은 그대로 있어요',
  'promo.fail.network': 'AI에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 만들어 주세요. 고른 내용은 그대로 있어요',
  'promo.btn.save': '저장하기',
  'promo.btn.posted': '올렸다고 표시하기',
  'promo.btn.new': '새 영상',
  'promo.btn.newLong': '새 영상 만들기',
  'promo.btn.closeWindow': '창 닫기',
  'promo.btn.close': '닫기',
  'promo.retry': '다시 시도하기',
  /* 창 골격 (SCR-51) */
  'promo.shop.caption': '가게 정보에서 가져왔어요',
  'promo.shop.photo': '{name} 외관 사진',
  'promo.shop.photoNone': '{name} 외관 사진이 아직 없어요',
  'promo.tabs': '영상 만들기 단계',
  'promo.tab.0': '메뉴·사진',
  'promo.tab.1': '분위기·주제',
  'promo.tab.2': '디자인',
  'promo.tab.3': '길이',
  'promo.tab.name': '{n}. {name}, {state}',
  'promo.tab.done': '채움',
  'promo.tab.empty': '비어 있음',
  'promo.prev': '이전',
  'promo.next': '다음',
  'promo.need.mood': '분위기와 주제를 하나 이상 골라 주세요',
  'promo.need.ref': '디자인을 하나 골라 주세요',
  'promo.need.len': '길이를 골라 주세요',
  'promo.need': '메뉴·사진, 분위기, 주제, 디자인을 모두 골라 주세요',
  /* ① 메뉴·사진 (SCR-52) */
  'promo.menu.title': '메뉴 고르기',
  'promo.menu.photos': '사진 {n}장',
  'promo.menu.noPhotos': '사진 없음',
  'promo.photo.title': '사진 고르기 · 영상에 쓸 사진을 직접 골라 주세요',
  'promo.photo.why': '고른 사진만 AI가 살펴봐요',
  'promo.photo.headline': '사진 고르기 · {menu} {n}장',
  'promo.photo.headNone': '사진 고르기',
  'promo.photo.sweepDone': '{n}장 골랐어요',
  'promo.photo.few': '사진을 5장 이상 골라 주세요 · {n}장 골랐어요',
  'promo.photo.none': '이 메뉴는 사진이 아직 없어요. 사진이 있는 메뉴를 골라 주세요',
  'promo.photo.noneAny': '사진이 있는 메뉴가 아직 없어요. 사진이 준비되면 여기서 고를 수 있어요',
  'promo.photo.section': '{menu}({n}장)',
  'promo.photo.pickMenu': '메뉴를 고르면 그 메뉴의 사진이 보여요. 사진이 있는 메뉴가 먼저 나와요',
  'promo.photo.some': '길이와 디자인에 따라 고른 사진 중 일부만 쓰일 수 있어요',
  'promo.photo.name': '{menu} 사진 {i}/{n}, {state}',
  'promo.photo.on': '선택됨',
  'promo.photo.off': '선택 안 됨',
  'promo.photo.error': '사진을 불러오지 못했어요',
  /* ② 분위기·컨셉·메모 (SCR-53) */
  'promo.mood.title': '분위기',
  'promo.concept.title': '영상 주제',
  'promo.memo.label': '원하는 느낌(안 써도 돼요)',
  'promo.memo.why': '적으면 영상에 반영해요',
  'promo.memo.max': '100자까지 쓸 수 있어요',
  'promo.memo.count': '{n}/100',
  /* ③ 디자인 레퍼런스 (SCR-54, D-85) */
  'promo.ref.title': '마음에 드는 디자인을 눌러 주세요',
  'promo.ref.note': '예시 사진으로 만든 미리보기예요. 실제 영상은 고른 사진으로 만들어져요',
  'promo.ref.group': '디자인',
  'promo.ref.fit': '어울려요',
  'promo.ref.fitSuffix': ', 어울려요',
  'promo.ref.chooseName': '{name}',
  'promo.ref.chosenName': '{name}, 골랐어요',
  'promo.ref.error': '디자인을 불러오지 못했어요',
  'promo.ref.ref-1.name': '단톡방 대화 + 남은 수량 카운트다운',
  'promo.ref.ref-2.name': '리뷰 말풍선 모음',
  'promo.ref.ref-3.name': '진열대 천천히 훑기',
  'promo.ref.ref-4.name': '손에 든 한 입 클로즈업',
  'promo.ref.ref-5.name': '우리 가게 하루 타임라인',
  'promo.ref.ref-6.name': '손글씨 감성 카드',
  /* ④ 길이·예상·확인 (SCR-55) */
  'promo.len.title': '영상 길이',
  'promo.len.sec': '{n}초',
  'promo.est.pick': '길이를 고르면 예상 시간과 비용이 보여요',
  'promo.est.time': '예상 시간 약 {t}',
  'promo.est.timeNote': '여러 번 만들어 본 평균으로 계산한 예상 시간이에요',
  'promo.est.cost': '예상 비용 약 {c}',
  'promo.est.costNote': '예상 비용이에요. 지금은 비용이 들지 않아요',
  'promo.est.fx': '{d} 환율 기준',
  'promo.est.error': '예상 값을 불러오지 못했어요',
  'promo.sum.title': '고른 것',
  'promo.sum.change': '바꾸기',
  'promo.sum.noMemo': '적지 않았어요',
  'promo.sum.none': '고르지 않았어요',
  'promo.sum.menu': '메뉴',
  'promo.sum.photos': '사진 수',
  'promo.sum.photoN': '{n}장',
  'promo.sum.mood': '분위기',
  'promo.sum.concept': '주제',
  'promo.sum.memo': '메모',
  'promo.sum.ref': '디자인',
  'promo.list': '{a}, {b}',
  /* 만드는 중 (SCR-56) */
  'promo.prog.title': '영상을 만들고 있어요',
  'promo.stage.look': '사진 살펴보기',
  'promo.stage.story': '이야기 짜기',
  'promo.stage.scenes': '장면 만들기',
  'promo.stage.merge': '영상 합치기',
  'promo.prog.looking': '{n}장 살펴보는 중',
  'promo.prog.elapsed': '{t} 지났어요',
  'promo.prog.slow': '조금 더 걸리고 있어요',
  'promo.prog.keep': '창을 닫아도 계속 만들어요',
  'promo.prog.now': '{step} 단계예요',
  'promo.prog.stateDone': '끝남',
  'promo.prog.stateNow': '지금',
  'promo.prog.stateLeft': '남음',
  /* 완성·저장·올릴 곳 (SCR-57) */
  'promo.done.title': '영상이 완성됐어요',
  'promo.done.meta': '{s}초 · 사진 {n}장',
  'promo.done.music': '음악: {name} · 무료 기본 음원',
  'promo.save.note': '내 기기에 영상 파일로 저장돼요',
  'promo.save.ok': '저장했어요',
  'promo.save.fail': '저장하지 못했어요',
  'promo.save.again': '다시 저장하기',
  'promo.place.title': '올릴 곳',
  'promo.place.clip': '클립',
  'promo.place.reels': '릴스',
  'promo.place.shorts': '쇼츠',
  'promo.place.note': '이 앱은 대신 올리지 않아요. 직접 올린 뒤 ‘올렸다고 표시하기’를 눌러 주세요',
  'promo.place.need': '올릴 곳을 먼저 골라 주세요',
  'promo.posted.line': '{n}편 · {place}에 올림',
  'promo.player.name': '{s}초 세로 영상, 마지막 장면에 가게 이름과 위치',
  'promo.player.play': '재생',
  'promo.player.pause': '일시정지',
  'promo.player.replay': '다시 보기',
  'promo.player.mute': '소리 끄기',
  'promo.player.unmute': '소리 켜기',
  'promo.player.seek': '재생 위치',
  'promo.player.time': '{now} / {total}',
  /* 실패 (SCR-58, LOCALES 9.4 실패 이유 10종) */
  'promo.fail.title': '영상을 만들지 못했어요',
  'promo.fail.AI_UNAVAILABLE': 'AI에 연결하지 못했어요',
  'promo.fail.AI_TIMEOUT': 'AI 응답이 너무 오래 걸렸어요',
  'promo.fail.AI_BAD_OUTPUT': 'AI가 영상 구성을 잘못 만들었어요',
  'promo.fail.CAPTION_TOO_LONG': '자막이 너무 길어 줄이지 못했어요',
  'promo.fail.RENDER_FAILED': '장면을 그리지 못했어요',
  'promo.fail.ENCODE_FAILED': '영상 파일로 합치지 못했어요',
  'promo.fail.CODE_CHECK_FAILED': '장면을 만들다 문제가 생겼어요',
  'promo.fail.TOOL_MISSING': '영상 만드는 도구를 찾지 못했어요',
  'promo.fail.BUSY': '다른 영상을 만드는 중이에요',
  'promo.fail.CANCELLED_BY_RESTART': '앱이 다시 시작돼서 만들기가 멈췄어요',
  /* 시간·금액 표기 (SCR-55 Q-42, R3·R4가 정한 형식) */
  'promo.dur.sec': '{s}초',
  'promo.dur.min': '{m}분',
  'promo.dur.minSec': '{m}분 {s}초',
  'promo.won': '{n}원',
};

const toBundle = (rows: Readonly<Record<string, Row>>, extra: Readonly<Record<string, Row>>, ko: Readonly<Record<string, string>>): MessageBundle<string> => {
  const all = { ...rows, ...extra };
  const pick = (index: 0 | 1 | 2 | 3) => Object.fromEntries(Object.entries(all).map(([key, row]) => [key, row[index]])) as Record<string, string>;
  return { id: 'mkt-promo', ko: { ...pick(0), ...ko }, en: pick(1), 'zh-Hans': pick(2), 'zh-Hant': pick(3) };
};

/** The bundle the three widgets add with `useBundle` (API-12). */
export const mktPromoBundle: MessageBundle<string> = toBundle(sourced, written, koOnly);

/** D-83: the Korean-only F-50 keys (no en/zh values until the translation work resumes). */
export const MKT_PROMO_KO_ONLY_KEYS: readonly string[] = Object.freeze(Object.keys(koOnly));

/** “R2 검토 필요 문구 수”: en + zh-Hans + zh-Hant strings of the `written` rows (3 per row). */
export const mktPromoR2Review = Object.freeze({
  writtenRows: Object.keys(written).length,
  strings: Object.keys(written).length * 3,
  sourcedRows: Object.keys(sourced).length,
});
