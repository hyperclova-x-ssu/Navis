import type { MessageBundle } from '../i18n/types';

/** RunStore shell notices; new copy uses the Korean fallback in every locale (D-209). */
export const runMessages={
  id:'run',
  ko:{
    'run.template.A.completed':'하루 운영 중심으로 시작했어요',
    'run.template.B.completed':'재고·발주 중심으로 시작했어요',
    'run.template.C.completed':'손님·예약 중심으로 시작했어요',
    'run.session.conflict':'화면이 바뀌었어요. 다시 시도해 주세요',
    'run.session.validation':'입력한 내용을 다시 확인해 주세요',
  },
  en:{},'zh-Hans':{},'zh-Hant':{},
} as const satisfies MessageBundle<string>;
