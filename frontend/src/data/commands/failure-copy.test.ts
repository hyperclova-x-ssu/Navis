import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../i18n';
import { dataBundles } from '../messages';
import { errorResult, PortError } from '../reality/00';
import { commandFailureText, withWidgetFailureCopy } from './failure-copy';

const { t } = createTranslator<string>('ko', ...dataBundles);

describe('command failure copy', () => {
  it('gives existing message-key consumers a reason and a next step even for an unmapped validation error', () => {
    const result = errorResult(new PortError(400, 'VALIDATION', 'UNMAPPED_REJECTION'));
    const widget = withWidgetFailureCopy(result);
    expect(widget.ok ? '' : t(widget.messageKey)).toBe('실행하지 못했어요 · 입력한 내용이 맞지 않아요. 입력값을 확인해 주세요');
    expect(commandFailureText(t, result)).toBe(widget.ok ? '' : t(widget.messageKey));
  });

  it('formats an existing domain reason without repeating its action button', () => {
    const result = errorResult(new PortError(409, 'CONFLICT', 'STAFF_SHIFT_OVERLAP'), {
      STAFF_SHIFT_OVERLAP: 'data.staff.error.STAFF_SHIFT_OVERLAP',
    });
    expect(commandFailureText(t, result, { next: '' })).toBe('실행하지 못했어요 · 같은 직원의 근무 시간이 겹쳐요');
  });

  it('uses the action-specific next step when available', () => {
    const result = errorResult(new PortError(409, 'CONFLICT', 'REFUND_LIMIT'));
    expect(commandFailureText(t, result, {
      reason: '충전금을 이미 사용했어요', next: '남은 환불 금액을 확인해 주세요',
    })).toBe('실행하지 못했어요 · 충전금을 이미 사용했어요. 남은 환불 금액을 확인해 주세요');
  });

  it('asks the owner to check an unconfirmed write without calling it a rejection', () => {
    const result = errorResult(new PortError(503, 'SERVICE_UNAVAILABLE', 'STOCK_UNAVAILABLE', undefined, true));
    expect(commandFailureText(t, result)).toBe('처리 결과를 확인해 주세요');
    expect(t(result.messageKey)).toBe('처리 결과를 확인해 주세요');
  });
});
