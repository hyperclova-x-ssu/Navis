/**
 * Failure reasons shared by the NAVER Calendar card (SCR-224) and the WORKS team schedule card (SCR-271): `추가하지 못했어요 · {이유}` /
 * `보내지 못했어요 · {이유}`. Plain short Korean (DS §7) in all four locales; server text never reaches the screen.
 */
export const exportReasonBundle = {
  id: 'data.reality.07.export-reasons',
  ko: {
    'export.reason.grant': '네이버 로그인이 필요해요',
    'export.reason.team': '팀 캘린더가 연결되지 않았어요',
    'export.reason.card': '확인 시간이 지났어요. 다시 눌러 주세요',
    'export.reason.already': '이미 WORKS로 보냈거나 WORKS에서 지운 근무예요',
    'export.reason.missing': '일정을 찾지 못했어요',
    'export.reason.session': '다시 로그인해 주세요',
    'export.reason.pending': '앞서 보낸 결과를 아직 확인하고 있어요',
    'export.reason.retry': '잠시 뒤 다시 시도해 주세요',
  },
  en: {
    'export.reason.grant': 'Sign in with NAVER first',
    'export.reason.team': 'No team calendar is connected',
    'export.reason.card': 'The confirmation expired. Press again',
    'export.reason.already': 'This shift was already sent to or removed from WORKS',
    'export.reason.missing': 'Could not find this entry',
    'export.reason.session': 'Please sign in again',
    'export.reason.pending': 'Still checking the result of an earlier send',
    'export.reason.retry': 'Try again in a moment',
  },
  'zh-Hans': {
    'export.reason.grant': '请先登录 NAVER',
    'export.reason.team': '尚未连接团队日历',
    'export.reason.card': '确认已过期，请重新点按',
    'export.reason.already': '该班次已发送到 WORKS 或已从 WORKS 删除',
    'export.reason.missing': '找不到该日程',
    'export.reason.session': '请重新登录',
    'export.reason.pending': '仍在确认之前发送的结果',
    'export.reason.retry': '请稍后重试',
  },
  'zh-Hant': {
    'export.reason.grant': '請先登入 NAVER',
    'export.reason.team': '尚未連結團隊行事曆',
    'export.reason.card': '確認已過期，請重新點按',
    'export.reason.already': '這個班次已傳送到 WORKS 或已從 WORKS 刪除',
    'export.reason.missing': '找不到這筆行程',
    'export.reason.session': '請重新登入',
    'export.reason.pending': '仍在確認先前傳送的結果',
    'export.reason.retry': '請稍後再試',
  },
} as const;

export type ExportReasonKey = keyof typeof exportReasonBundle.ko;

const reasons: Readonly<Record<string, ExportReasonKey>> = {
  NAVER_GRANT_REQUIRED: 'export.reason.grant',
  WORKS_CALENDAR_REQUIRED: 'export.reason.team',
  CARD_REQUIRED: 'export.reason.card', APPROVAL_EXPIRED: 'export.reason.card', APPROVAL_CONFLICT: 'export.reason.card',
  PENDING_OR_USED_APPROVAL: 'export.reason.card', EXTRA_CONFIRMATION_REQUIRED: 'export.reason.card',
  WORKS_ALREADY_EXPORTED: 'export.reason.already',
  NOT_FOUND: 'export.reason.missing',
  SESSION_ENDED: 'export.reason.session',
  NAVER_OUTCOME_PENDING: 'export.reason.pending',
};

/** The reason line for a definite failure; anything unlisted (network, provider, unreadable answer) is a plain retry. */
export const exportReasonKey = (reason: string | undefined): ExportReasonKey => reasons[reason ?? ''] ?? 'export.reason.retry';
