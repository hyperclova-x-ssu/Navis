/**
 * T-060/T-083 message bundle of the mkt-promo widgets (prefix widget.{marketing-today|promo-video}.* and promo.*; the 마케팅 성과 rows left with the widget, D-365,
 * ARCHITECTURE 11.6). Rows are [ko, en, zh-Hans, zh-Hant]. `sourced` rows are taken from LOCALES 9.3 / DESIGN_SYSTEM 11.11;
 * `written` rows are new sentences in the same vocabulary and need the R2 review (counted in `mktPromoR2Review`).
 */
import type { MessageBundle } from '../../../i18n';

type Row = readonly [ko: string, en: string, hans: string, hant: string];
const PREFIX_TODAY = 'widget.marketing-today.';
const PREFIX_VIDEO = 'widget.promo-video.';

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
  [`${PREFIX_TODAY}replies.recorded`]: [
    '기록한 문의 {n}건이 답변을 기다려요',
    '{n, plural, one {# recorded inquiry is} other {# recorded inquiries are}} waiting for a reply.',
    '已记录的询问中，有 {n} 条等待回复。',
    '已記錄的詢問中，有 {n} 則等待回覆。',
  ],
  [`${PREFIX_TODAY}replies.s2`]: ['답변 초안을 써 뒀어요', 'Drafts are ready.', '已写好回复草稿。', '已寫好回覆草稿。'],
  [`${PREFIX_TODAY}video.s2`]: ['짧은 영상으로 만들어 볼까요?', 'Turn them into a short video?', '要做成短视频吗？', '要做成短影片嗎？'],
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
  // GD-3 (S6): the lines are this period's codes (ended coupons included) and add up to the route row.
  'promo.need.menu': ['메뉴를 하나 골라 주세요', 'Choose one menu item', '请选择一个菜单品项', '請選擇一個菜單品項'],
  'promo.error.selectionUnavailable': ['메뉴·사진에서 사용할 메뉴와 사진을 다시 골라 주세요', 'Choose the menu items and photos again in Menu & photos', '请在菜品和照片中重新选择菜品和照片', '請在品項和照片中重新選擇品項和照片'],
  'promo.error.notReady': ['완성된 홍보 영상을 골라 주세요', 'Choose a finished promo video', '请选择已完成的宣传视频', '請選擇已完成的宣傳影片'],
  /* PROMO-UI (D-326 Q12): SCR-52 PhotoCountLine "{n}장 골랐어요 · 5장 이상" and SCR-55 summary chip name "{값}, 바꾸려면 누르기, ① 메뉴·사진" */
  'promo.photo.count': ['{n}장 골랐어요 · 5장 이상', '{n} picked · 5 or more', '已选 {n} 张 · 至少 5 张', '已選 {n} 張 · 至少 5 張'],
  'promo.photo.available': ['영상에 쓸 사진 {n}장', '{n, plural, one {# photo} other {# photos}} for the video', '可用于视频的照片 {n} 张', '可用於影片的照片 {n} 張'],
  'promo.stage.look': ['미리 분석한 사진 정보', 'Pre-analyzed photo details', '预先分析的照片信息', '預先分析的照片資訊'],
  'promo.stage.story': ['HyperCLOVA X 기획', 'HyperCLOVA X planning', 'HyperCLOVA X 策划', 'HyperCLOVA X 規劃'],
  'promo.stage.scenes': ['Claude 영상 제작', 'Claude video production', 'Claude 制作视频', 'Claude 製作影片'],
  'promo.stage.merge': ['완성', 'Finish', '完成', '完成'],
  'promo.prog.looking': ['사진 {n}장', '{n, plural, one {# photo} other {# photos}}', '{n} 张照片', '{n} 張照片'],
  'promo.sum.changeName': ['{value}, 바꾸려면 누르기, {tab}', '{value}, press to change, {tab}', '{value}，点按可修改，{tab}', '{value}，點按可修改，{tab}'],
  /* Gallery and its steps (LOCALES 9.4, 20 and the D-347 approved design names used by Navis). */
  'promo.retry': ['다시 시도하기', 'Try again', '重试', '重試'],
  'promo.tabs': ['영상 만들기 단계', 'Video creation steps', '视频制作步骤', '影片製作步驟'],
  'promo.tab.0': ['메뉴·사진', 'Menu & photos', '菜品和照片', '品項和照片'],
  'promo.tab.1': ['분위기·주제', 'Mood & concept', '氛围和主题', '氛圍和主題'],
  'promo.tab.2': ['디자인', 'Design', '设计', '設計'],
  'promo.tab.3': ['길이', 'Length', '时长', '長度'],
  'promo.tab.name': ['{n}. {name}, {state}', '{n}. {name}, {state}', '{n}. {name}，{state}', '{n}. {name}，{state}'],
  'promo.tab.done': ['채움', 'Done', '已填', '已填'],
  'promo.tab.empty': ['비어 있음', 'Empty', '未填', '未填'],
  'promo.prev': ['이전', 'Back', '上一步', '上一步'],
  'promo.next': ['다음', 'Next', '下一步', '下一步'],
  'promo.need.ref': ['디자인을 하나 골라 주세요', 'Choose one design', '请选择一种设计', '請選擇一種設計'],
  'promo.ref.title': ['마음에 드는 디자인을 눌러 주세요', 'Choose a design you like', '请选择喜欢的设计', '請選擇喜歡的設計'],
  'promo.ref.group': ['디자인', 'Design', '设计', '設計'],
  'promo.ref.fit': ['어울려요', 'Good fit', '很搭', '很搭'],
  'promo.ref.fitSuffix': [', 어울려요', ', good fit', '，很搭', '，很搭'],
  'promo.ref.chooseName': ['{name}', '{name}', '{name}', '{name}'],
  'promo.ref.chosenName': ['{name}, 골랐어요', '{name}, selected', '{name}，已选', '{name}，已選'],
  'promo.ref.error': ['디자인을 불러오지 못했어요', 'Couldn’t load designs', '无法加载设计', '無法載入設計'],
  'promo.ref.ref-1.name': ['단톡방 대화 + 남은 수량 카운트다운', 'Group chat + countdown of what’s left', '群聊 + 剩余数量倒计时', '群聊 + 剩餘數量倒數'],
  'promo.ref.ref-2.name': ['디자인 2번', 'Design 2', '设计 2', '設計 2'],
  'promo.ref.ref-3.name': ['진열대 천천히 훑기', 'Slow pan across the display', '缓缓扫过展柜', '緩緩掃過展示櫃'],
  'promo.ref.ref-4.name': ['손에 든 한 입 클로즈업', 'Close-up of a bite in hand', '手持一口特写', '手持一口特寫'],
  'promo.ref.ref-5.name': ['우리 가게 하루 타임라인', 'A day at our shop timeline', '我们店的一天时间线', '我們店的一天時間軸'],
  'promo.ref.ref-6.name': ['손글씨 감성 카드', 'Handwritten-note cards', '手写感卡片', '手寫感卡片'],
  'promo.ref.ref-7.name': ['비트 컷', 'Beat cut', '节拍剪辑', '節拍剪輯'],
  'promo.ref.ref-8.name': ['줌 렌즈 투어', 'Zoom lens tour', '变焦镜头漫游', '變焦鏡頭漫遊'],
  'promo.ref.ref-9.name': ['스티커 팝', 'Sticker pop', '贴纸弹跳', '貼紙彈跳'],
  'promo.ref.ref-10.name': ['스플릿 듀오', 'Split duo', '双画面分屏', '雙畫面分割'],
  'promo.ref.ref-11.name': ['폴라로이드 스크랩북', 'Polaroid scrapbook', '即影即有剪贴簿', '即影即有剪貼簿'],
  'promo.ref.ref-12.name': ['티커 헤드라인', 'Ticker headline', '滚动头条', '跑馬燈頭條'],
  'promo.ref.ref-13.name': ['하루 타임라인', 'Day timeline', '一天的时间线', '一天的時間軸'],
  'promo.ref.ref-14.name': ['타이포 포스터 / 매거진 커버', 'Typography poster / magazine cover', '文字海报 / 杂志封面', '文字海報 / 雜誌封面'],
  'promo.ref.ref-15.name': ['메뉴판', 'Menu board', '菜单板', '菜單板'],
  'promo.ref.ref-16.name': ['필름 스트립', 'Film strip', '胶片条', '底片條'],
  'promo.ref.ref-17.name': ['패럴랙스 플로트 카드', 'Parallax float card', '视差浮动卡片', '視差浮動卡片'],
  'promo.ref.ref-18.name': ['무디 나이트 / 소프트포커스', 'Moody night / soft focus', '夜色氛围 / 柔焦', '夜色氛圍 / 柔焦'],
  'promo.sum.ref': ['디자인', 'Design', '设计', '設計'],
};

/**
 * F-50 D-80 screen text (LOCALES 9.4·9.3, DS 11.12.3, SCREENS SCR-50~58), Korean only by D-83 (외국어 작업은 나중에):
 * these keys have no en/zh values yet, so other languages fall back to Korean until the translation work resumes.
 */
const koOnly: Readonly<Record<string, string>> = {
  /* LOCALES 11.13 / D-218: the kit selects these only for 1x1 and 2x1. */
  [`${PREFIX_TODAY}state.error.short`]: '불러오지 못했어요',
  [`${PREFIX_VIDEO}state.error.short`]: '불러오지 못했어요',
  [`${PREFIX_TODAY}state.none.short`]: '지금 급한 홍보는 없어요',
  [`${PREFIX_VIDEO}state.few-photos.short`]: '사진이 5장 필요해요',
  /* 오늘 할 홍보 이번 주 칸 (LOCALES 9.3 D-347: the video uses the shop's own photos, not review photos) */
  [`${PREFIX_TODAY}video.photos`]: '영상에 쓸 사진 {n}장이 있어요',
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
  /* 창 골격 (SCR-51) */
  'promo.shop.caption': '가게 정보에서 가져왔어요',
  'promo.shop.photo': '{name} 외관 사진',
  'promo.shop.photoNone': '{name} 외관 사진이 아직 없어요',
  'promo.need.mood': '분위기와 주제를 하나 이상 골라 주세요',
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
  /* ④ 길이·예상·확인 (SCR-55) */
  'promo.len.title': '영상 길이',
  'promo.len.sec': '{n}초',
  'promo.est.pick': '길이를 고르면 예상 시간과 비용이 보여요',
  'promo.est.time': '예상 시간 약 {t}',
  'promo.est.timeNote': '여러 번 만들어 본 평균으로 계산한 예상 시간이에요',
  'promo.est.cost': '예상 비용 약 {c}',
  'promo.est.costNote': '예상 비용이에요',
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
  'promo.list': '{a}, {b}',
  /* 만드는 중 (SCR-56) */
  'promo.prog.title': '영상을 만들고 있어요',
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
