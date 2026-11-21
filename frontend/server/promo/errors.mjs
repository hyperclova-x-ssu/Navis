// 작업 실패 이유 코드 10개 (ARCHITECTURE 12.6). 화면 문구는 R4 SCR-58.
export const FAIL_REASONS = Object.freeze([
  'AI_UNAVAILABLE', 'AI_TIMEOUT', 'AI_BAD_OUTPUT', 'CAPTION_TOO_LONG', 'CODE_CHECK_FAILED',
  'RENDER_FAILED', 'ENCODE_FAILED', 'TOOL_MISSING', 'BUSY', 'CANCELLED_BY_RESTART',
]);

export class PromoError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export const reasonOf = err => (err instanceof PromoError && FAIL_REASONS.includes(err.code) ? err.code : null);
