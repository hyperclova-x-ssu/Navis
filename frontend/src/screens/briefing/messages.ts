import { defineBundle } from '../../i18n/bundles';

/** `briefing.*` — arrival briefing card (SCR-17). Owner: T-053. */
export const briefingBundle = defineBundle({
  id: 'briefing',
  ko: {
    'briefing.title': '오늘 가게 소식이에요',
    'briefing.description': '출근 전에 가게 소식을 살펴보세요',
    'briefing.region': '출근 브리핑 내용',
    'briefing.list': '오늘 가게 소식 {count}개',
    'briefing.openSource': '{title}, 자세히 보기',
    'briefing.fullscreenLabel': '자세히 보기 전체 화면으로 보기',
    'briefing.restoreLabel': '자세히 보기 원래 크기로 보기',
    'briefing.fullscreenDone': '전체 화면으로 바꿨어요',
    'briefing.restoreDone': '원래 크기로 바꿨어요',
    'briefing.staffCount': '오늘 근무 {n}명',
    'briefing.staffHandoff': '오늘 근무 {n}명 · {time} 교대',
    'briefing.pickupToday': '오늘 픽업 {n}건',
    'briefing.pickupTomorrow': '내일 픽업 {n}건',
    'briefing.customPending': '주문제작 승인 대기 {n}건 · 오늘 미완료 {m}건',
  },
  en: {
    'briefing.title': "Here's today's shop news",
    'briefing.description': 'Take a look before you start the day',
    'briefing.region': 'Arrival briefing',
    'briefing.list': '{count, plural, one {# update for today} other {# updates for today}}',
    'briefing.openSource': '{title}, view details',
  },
  'zh-Hans': {
    'briefing.title': '今天的店铺消息',
    'briefing.description': '开店前先看一下店里的消息',
    'briefing.region': '到店简报内容',
    'briefing.list': '今日店铺消息 {count} 条',
    'briefing.openSource': '{title}，查看详情',
  },
  'zh-Hant': {
    'briefing.title': '今天的店鋪消息',
    'briefing.description': '開店前先看一下店裡的消息',
    'briefing.region': '到店簡報內容',
    'briefing.list': '今日店鋪消息 {count} 則',
    'briefing.openSource': '{title}，查看詳情',
  },
});
