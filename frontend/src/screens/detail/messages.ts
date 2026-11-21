import { defineBundle } from '../../i18n/bundles';

/** `detail.*` — detail overlay frame (SCR-31). Owner: T-053. */
export const detailBundle = defineBundle({
  id: 'detail',
  ko: {
    'detail.error': '화면을 보여 주지 못했어요. 다시 열어 주세요',
    'detail.chartEmpty': '그래프에 표시할 값이 없어요',
    'detail.fullscreen': '전체 화면',
    'detail.restore': '원래 크기로',
    'detail.fullscreenName': '자세히 보기 전체 화면으로 보기',
    'detail.restoreName': '자세히 보기 원래 크기로 보기',
  },
  en: {
    'detail.error': "Couldn't show this screen. Please open it again",
    'detail.chartEmpty': 'No values to show in the chart',
  },
  'zh-Hans': {
    'detail.error': '无法显示此画面，请重新打开',
    'detail.chartEmpty': '图表没有可显示的数值',
  },
  'zh-Hant': {
    'detail.error': '無法顯示此畫面，請重新開啟',
    'detail.chartEmpty': '圖表沒有可顯示的數值',
  },
});
