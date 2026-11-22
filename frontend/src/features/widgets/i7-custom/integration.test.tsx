import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { selectCustomAccounting, selectCustomOrders } from '../../../data/iteration7/custom-orders';
import type { WidgetDetailProps } from '../../../contracts';
import { CustomOrderProvider } from './port';
import { createCustomTestSource } from './test-source';
import { pickDateTime } from './test-pickers';
import { CustomOrderDetail } from './widget';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() } as const;
const props: WidgetDetailProps = { featureId: 'voice-booking', condition: { kind: 'default' }, detailRef: { featureId: 'voice-booking' }, host };
describe('custom UI consumes the real M2 planners', () => {
  it('revises sixty thousand to sixty-five thousand and approves one canonical pickup', () => {
    const { port } = createCustomTestSource({ fixture: 'legacy' });
    renderWithKit(<CustomOrderProvider port={port}><CustomOrderDetail {...props} /></CustomOrderProvider>);
    fireEvent.click(screen.getByRole('button', { name: /CO-002/ }));
    fireEvent.click(screen.getByRole('button', { name: '수정 요청으로 바꾸기' }));
    fireEvent.change(screen.getByLabelText('견적 금액'), { target: { value: '65000' } });
    fireEvent.click(screen.getByRole('button', { name: '견적 저장하기' }));
    fireEvent.click(screen.getByRole('button', { name: '승인으로 바꾸기' }));
    const order = selectCustomOrders(port.read()).orders.find(row => row.customOrderId === 'CO-002');
    expect(order).toMatchObject({ quoteAmount: 65000, stage: 'in_production', payment: { status: 'unpaid' }, pickup: { date: '2026-10-27', time: '14:00' } });
    expect(selectCustomOrders(port.read()).summary.tomorrowPickup).toBe(1);
  });
  it('recognizes a paid handover once without a second deposit', () => {
    const { port } = createCustomTestSource({ fixture: 'legacy' });
    renderWithKit(<CustomOrderProvider port={port}><CustomOrderDetail {...props} /></CustomOrderProvider>);
    fireEvent.click(screen.getByRole('button', { name: /CO-001/ }));
    fireEvent.click(screen.getByRole('button', { name: '수령 완료로 바꾸기' }));
    expect(selectCustomAccounting(port.read())).toMatchObject({ customPickup: 45000, realDeposits: 45000, rows: [{ cost: null }] });
    expect(screen.queryByRole('button', { name: '수령 완료로 바꾸기' })).not.toBeInTheDocument();
  });
  it('generates an editable example template and reuses it for a visit-channel receipt', async () => {
    vi.useFakeTimers();
    const { port } = createCustomTestSource();
    renderWithKit(<CustomOrderProvider port={port}><CustomOrderDetail {...props} /></CustomOrderProvider>);
    fireEvent.click(screen.getByRole('tab', { name: '템플릿 관리' }));
    fireEvent.change(screen.getByLabelText('상품 종류'), { target: { value: '꽃 케이크' } });
    fireEvent.click(screen.getByRole('button', { name: '양식 견본 만들기' }));
    expect(screen.getByRole('button', { name: '양식 견본을 만들고 있어요' })).toBeDisabled();
    act(() => vi.advanceTimersByTime(1000));
    const editor = screen.getByRole('form', { name: '템플릿 고치기' });
    fireEvent.change(within(editor).getByLabelText('템플릿 이름'), { target: { value: '꽃 주문서' } });
    fireEvent.click(within(editor).getByRole('button', { name: '템플릿 저장하기' }));
    const template = selectCustomOrders(port.read()).templates.find(row => row.name === '꽃 주문서')!;
    expect(template).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: '주문제작 목록' }));
    fireEvent.click(screen.getByRole('button', { name: '주문 접수하기' }));
    fireEvent.change(screen.getByLabelText('주문서 템플릿'), { target: { value: template.templateId } });
    fireEvent.change(screen.getByLabelText('접수 경로'), { target: { value: 'visit' } });
    fireEvent.change(screen.getByLabelText('손님 이름'), { target: { value: '박하늘' } });
    fireEvent.change(screen.getByLabelText('연락처'), { target: { value: '01012345678' } });
    fireEvent.change(screen.getByLabelText('상품'), { target: { value: '꽃 케이크' } });
    vi.useRealTimers();
    await pickDateTime(/^희망 픽업 날짜 /, /^희망 픽업 시각 /, '2026-10-28', '15:00');
    for (const field of template.fields.filter(field => field.required && field.input === 'text')) fireEvent.change(screen.getByLabelText(`${field.label} (필수 입력)`), { target: { value: '생일 축하해요' } });
    for (const field of template.fields.filter(field => field.required && field.input === 'single')) fireEvent.change(screen.getByLabelText(`${field.label} (필수 입력)`), { target: { value: field.options[0]!.optionId } });
    const form = screen.getByRole('form', { name: '주문 접수' });
    const refs = within(form).getByRole('group', { name: '참고 사진' });
    expect(within(refs).getByRole('checkbox', { name: '레터링 생크림 케이크 1호' })).toBeInTheDocument();
    fireEvent.click(within(refs).getByRole('checkbox', { name: '답례 쿠키 세트 20박스' }));
    fireEvent.click(within(form).getByRole('button', { name: '주문 접수하기' }));
    expect(selectCustomOrders(port.read()).orders.find(row => row.productLabel === '꽃 케이크')).toMatchObject({
      channel: 'visit', stage: 'received', guest: { name: '박하늘' }, referencePhotoKeys: ['gift-reference'],
    });
  });
});
