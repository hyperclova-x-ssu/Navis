import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kiosk } from './Kiosk';
import type { ConnectOrderMessage, ConnectTransport } from './channel';

vi.mock('./facesign', () => ({ FacesignCamera: ({ amount, onApproved, onCancel }: { amount: number; onApproved: () => void; onCancel: () => void }) =>
  <div><p>얼굴 {amount}</p><button type="button" onClick={onApproved}>얼굴 승인</button><button type="button" onClick={onCancel}>얼굴 취소</button></div> }));

const posted: ConnectOrderMessage[] = [];
const transport: ConnectTransport = { post: message => { posted.push(message); }, subscribe: () => () => undefined };
const click = (name: string | RegExp) => { fireEvent.click(screen.getByRole('button', { name })); };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
function toPay() {
  click('주문하기'); click('매장 주문');
  click(/^아메리카노, /);
  fireEvent.click(screen.getByRole('radio', { name: /^ICE/ })); fireEvent.click(screen.getByRole('radio', { name: /^레귤러/ }));
  click('메뉴담기'); click(/장바구니 보기/); click(/결제하기/); click('진동벨 없음');
}

beforeEach(() => { vi.useFakeTimers(); posted.length = 0; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the kiosk screens', () => {
  it('starts on the attract screen with NAVER’s promotion lines', () => {
    render(<Kiosk transport={transport}/>);
    expect(screen.getByText('포인트 100원')).toBeInTheDocument();
    expect(screen.getByText('추가 포인트 혜택까지')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '주문하기' })).toBeInTheDocument();
  });

  it('shows the café’s real menu with real prices under the touch categories', () => {
    render(<Kiosk transport={transport}/>);
    click('주문하기'); click('포장 주문');
    expect(screen.getByRole('button', { name: '아메리카노, 3,000원' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').slice(0, 5).map(tab => tab.textContent)).toEqual(['전체', '커피', '티', '음료', '디저트']);
    expect(screen.getByRole('tab', { name: '전체', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '바스크 치즈케이크, 5,200원' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('tab', { name: '티' })[0]);
    expect(screen.queryByRole('button', { name: /^아메리카노, / })).toBeNull();
    expect(screen.getByRole('button', { name: '고흥 유자 캐모마일 티, 4,400원' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('tab', { name: '디저트' })[0]);
    expect(screen.getByRole('button', { name: '바스크 치즈케이크, 5,200원' })).toBeInTheDocument();
    expect(screen.queryByText(/샘플|데모|예시/)).toBeNull();
  });

  it.each([
    ['en', ['All', 'Coffee', 'Tea', 'Drinks', 'Desserts']],
    ['zh-Hans', ['全部', '咖啡', '茶', '饮品', '甜点']],
    ['zh-Hant', ['全部', '咖啡', '茶', '飲品', '甜點']],
  ] as const)('applies the %s category labels in the row and category sheet', (locale, labels) => {
    render(<Kiosk transport={transport} categoryLocale={locale}/>);
    click('주문하기'); click('포장 주문');
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(labels);
    click(/All categories|全部分类|全部分類/);
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([...labels, ...labels]);
  });

  it('every payment tile approves by itself (~1.5 s) and hands exactly one paid order to Navis', async () => {
    render(<Kiosk transport={transport} newId={() => 'order-A'} now={() => new Date('2026-11-22T03:00:00.000Z')}/>);
    toPay();
    expect(screen.getByRole('button', { name: /삼성페이 애플페이/ })).toBeInTheDocument();
    click(/카드를 넣거나/);
    expect(screen.getByText('결제를 요청 중이에요')).toBeInTheDocument();
    await tick(1400);
    expect(posted).toHaveLength(0);
    await tick(200);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ id: 'order-A', orderType: 'dine_in', total: 3000, payment: '카드', buzzer: null, paidAt: '2026-11-22T03:00:00.000Z' });
    expect(posted[0].lines[0]).toMatchObject({ name: '아메리카노', qty: 1 });
    expect(screen.getByText('3,000원 결제 성공!')).toBeInTheDocument();
    expect(screen.queryByText(/Npay 포인트 100원/)).toBeNull(); // the point line is for Npay methods only
  });

  it('Naver Pay goes through the camera-scan screen and shows the Npay point line on success', async () => {
    render(<Kiosk transport={transport} newId={() => 'order-B'}/>);
    toPay();
    click(/간편 결제/);
    expect(screen.getByText('QR·바코드를 화면에 보여주세요')).toBeInTheDocument();
    await tick(1500); expect(screen.getByText('결제를 요청 중이에요')).toBeInTheDocument();
    await tick(1000);
    expect(posted).toHaveLength(1);
    expect(posted[0].payment).toBe('네이버페이');
    expect(screen.getByText('Npay 포인트 100원', { exact: false })).toBeInTheDocument();
    // The real Npay success screen (K9): the point is earned by picking a keyword review, and there is no amount title.
    expect(screen.getByText('결제 성공! 키워드 리뷰 선택 시')).toBeInTheDocument();
    expect(screen.queryByText('3,000원 결제 성공!')).toBeNull();
  });

  it('페이스사인 mounts the face camera with the amount and approves when it does', async () => {
    render(<Kiosk transport={transport} newId={() => 'order-C'}/>);
    toPay();
    click(/페이스사인/);
    expect(screen.getByText('얼굴 3000')).toBeInTheDocument();
    click('얼굴 취소');
    expect(screen.getByRole('button', { name: /페이스사인/ })).toBeInTheDocument();
    click(/페이스사인/); click('얼굴 승인');
    await tick(1000);
    expect(posted).toHaveLength(1);
    expect(posted[0].payment).toBe('페이스사인');
  });

  it('끝내기 counts 10 s down and returns to the attract screen; 처음으로 resets from any screen', async () => {
    render(<Kiosk transport={transport}/>);
    toPay(); click(/카드를 넣거나/);
    await tick(1600);
    expect(screen.getByLabelText('10초')).toBeInTheDocument();
    await tick(10_000);
    expect(screen.getByRole('button', { name: '주문하기' })).toBeInTheDocument();
    click('주문하기'); click('포장 주문'); click('처음으로');
    expect(screen.getByRole('button', { name: '주문하기' })).toBeInTheDocument();
  });

  it('60 s without a touch returns to the attract screen, and a touch keeps it alive', async () => {
    render(<Kiosk transport={transport}/>);
    click('주문하기'); click('포장 주문');
    await tick(50_000);
    fireEvent.pointerDown(screen.getByRole('button', { name: '아메리카노, 3,000원' }));
    await tick(50_000);
    expect(screen.getByRole('tab', { name: '전체' })).toBeInTheDocument();
    await tick(11_000);
    expect(screen.getByRole('button', { name: '주문하기' })).toBeInTheDocument();
  });

  it('keyword review: at most five picks, and the benefit button needs one', async () => {
    render(<Kiosk transport={transport}/>);
    toPay(); click(/간편 결제/);
    await tick(1500); await tick(1000);
    click(/키워드 리뷰 남기기/);
    expect(screen.getByRole('button', { name: '선택하고 혜택 받기' })).toBeDisabled();
    for (const chip of ['음식 맛이 훌륭해요', '가성비 좋아요', '또 먹고 싶어요', '건강한 맛이에요', '재료가 신선해요', '뷰가 좋아요']) fireEvent.click(screen.getByRole('button', { name: new RegExp(chip) }));
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(5);
    click('선택하고 혜택 받기');
    expect(screen.getByText(/상세 리뷰 알림을 보냈어요/)).toBeInTheDocument();
  });
});
