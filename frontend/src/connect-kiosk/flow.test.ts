import { describe, expect, it } from 'vitest';
import { cartCount, cartTotal, initialKioskState, kioskReducer, optionLines, requiredSatisfied, won, MAX_REVIEW_PICKS, type KioskAction, type KioskState } from './flow';
import { itemsForTab, kioskItem, kioskItems, kioskTabs } from './menu';

const run = (actions: readonly KioskAction[], from: KioskState = initialKioskState): KioskState => actions.reduce(kioskReducer, from);
const americano = kioskItem('m-americano')!;
const pick = (groupName: string, optionName: string): KioskAction => {
  const group = americano.groups.find(g => g.name === groupName)!;
  return { type: 'detailOption', groupId: group.id, optionId: group.options.find(o => o.name === optionName)!.id, delta: 1 };
};
const toDetail: readonly KioskAction[] = [{ type: 'start' }, { type: 'chooseType', orderType: 'takeout' }, { type: 'openItem', itemId: 'm-americano' }];
const iceRegular: readonly KioskAction[] = [pick('온도', 'ICE'), pick('사이즈', '레귤러')];

describe('menu data', () => {
  it('is the café’s 24 real menus with their real prices and photos', () => {
    expect(kioskItems).toHaveLength(24);
    expect(americano.price).toBe(3000);
    expect(americano.photo).toBe('/menu-photos/cafe-americano-01.jpeg');
    expect(kioskTabs('ko').map(tab => [tab.key, tab.label])).toEqual([['all', '전체'], ['coffee', '커피'], ['tea', '티'], ['beverage', '음료'], ['dessert', '디저트']]);
    expect(initialKioskState.tab).toBe('all');
  });
  it('D-353: assigns all 24 menus to their designated categories and keeps season separate', () => {
    expect(itemsForTab('all')).toHaveLength(24);
    expect((['coffee', 'tea', 'beverage', 'dessert'] as const).map(key => itemsForTab(key).length)).toEqual([8, 4, 8, 4]);
    const nameOf = (key: 'coffee' | 'tea' | 'beverage' | 'dessert') => itemsForTab(key).map(item => item.name);
    expect(nameOf('tea')).toEqual(expect.arrayContaining(['캐모마일 티', '얼그레이 홍차', '얼그레이 밀크티', '고흥 유자 캐모마일 티']));
    expect(nameOf('coffee')).toEqual(expect.arrayContaining(['아메리카노', '더치 콜드브루']));
    expect(nameOf('beverage')).toEqual(expect.arrayContaining(['딥 초코 라떼', '제주 말차 라떼', '자몽 에이드', '공주 보늬밤 라떼', '단호박 크림 라떼']));
    expect(nameOf('dessert')).toHaveLength(4);
    expect(kioskItems.filter(item => item.seasonal).map(item => [item.id, item.seasonal]).sort()).toEqual([
      ['m-chestnut-latte', 'autumn'], ['m-pumpkin-einspanner', 'autumn'], ['m-yuja-chamomile', 'autumn'],
    ]);
  });
  it('shows no description line for a menu without a memo (nothing is made up)', () => {
    expect(kioskItems.every(item => item.description === null)).toBe(true);
  });
});

describe('order flow', () => {
  it('walks attract → 매장/포장 → menu → item → cart → 진동벨 → payment → processing → success → review → attract', () => {
    let s = run(toDetail);
    expect(s.screen).toBe('detail');
    expect(s.orderType).toBe('takeout');
    s = run([...iceRegular, { type: 'detailAdd' }], s);
    expect(s.screen).toBe('menu');
    expect(cartCount(s.cart)).toBe(1);
    s = run([{ type: 'openCart' }, { type: 'cartPay' }, { type: 'buzzerDigit', digit: '1' }, { type: 'buzzerDigit', digit: '2' }, { type: 'buzzerDigit', digit: '3' }, { type: 'buzzerConfirm' }], s);
    expect(s.screen).toBe('pay');
    expect(s.buzzer).toBe('123');
    s = run([{ type: 'choosePayment', label: '카드' }], s);
    expect(s.screen).toBe('processing');
    s = run([{ type: 'approved', orderId: 'o-1' }], s);
    expect(s.screen).toBe('success');
    expect(s.paid).toEqual({ orderId: 'o-1', total: 3000, label: '카드', buzzer: '123' });
    s = run([{ type: 'reviewStart' }, { type: 'toggleChip', chip: '가성비 좋아요' }, { type: 'reviewSubmit' }], s);
    expect(s.screen).toBe('reviewSent');
    expect(run([{ type: 'home' }], s)).toEqual({ ...initialKioskState, serial: s.serial });
  });

  it('keeps the item page closed to the cart until every 필수 option group has its pick', () => {
    let s = run(toDetail);
    expect(requiredSatisfied(americano, s.detail!.picked)).toBe(false);
    expect(run([{ type: 'detailAdd' }], s)).toBe(s);
    s = run([pick('온도', 'HOT'), { type: 'detailAdd' }], s);
    expect(s.screen).toBe('detail');
    s = run([pick('사이즈', '레귤러'), { type: 'detailAdd' }], s);
    expect(s.screen).toBe('menu');
  });

  it('prices options and quantity into the line and the cart total', () => {
    let s = run([...toDetail, pick('온도', 'ICE'), pick('사이즈', '라지(벤티)'), { type: 'detailQty', delta: 1 }, { type: 'detailAdd' }]);
    expect(cartTotal(s.cart)).toBe((3000 + 800) * 2);
    expect(optionLines(s.cart[0]).map(o => o.name)).toEqual(['ICE', '라지(벤티)']);
    s = run([{ type: 'openCart' }, { type: 'cartQty', key: s.cart[0].key, delta: 1 }], s);
    expect(cartCount(s.cart)).toBe(3);
    expect(won(cartTotal(s.cart))).toBe('11,400원');
  });

  it('merges an identical item and options line, as the POS cart does, and replaces a size inside its group', () => {
    const add = [...iceRegular, { type: 'detailAdd' } as const];
    let s = run([...toDetail, ...add]);
    s = run([{ type: 'openItem', itemId: 'm-americano' }, ...add], s);
    expect(s.cart).toHaveLength(1);
    expect(s.cart[0].qty).toBe(2);
    s = run([{ type: 'openItem', itemId: 'm-americano' }, pick('온도', 'ICE'), pick('사이즈', '레귤러'), pick('사이즈', '라지(벤티)')], s);
    expect(s.detail!.picked).toHaveLength(2);
  });

  it('옵션 변경 edits the line in place and 메뉴 추가 returns to the menu', () => {
    let s = run([...toDetail, ...iceRegular, { type: 'detailAdd' }, { type: 'openCart' }]);
    const key = s.cart[0].key;
    s = run([{ type: 'cartEdit', key }], s);
    expect(s.detail?.editKey).toBe(key);
    s = run([pick('사이즈', '라지(벤티)'), { type: 'detailAdd' }], s);
    expect(s.screen).toBe('cart');
    expect(s.cart).toHaveLength(1);
    expect(cartTotal(s.cart)).toBe(3800);
    expect(run([{ type: 'cartMore' }], s).screen).toBe('menu');
  });

  it('removes a line with ✕ and refuses to go on with an empty cart', () => {
    let s = run([...toDetail, ...iceRegular, { type: 'detailAdd' }, { type: 'openCart' }]);
    s = run([{ type: 'cartRemove', key: s.cart[0].key }], s);
    expect(s.cart).toHaveLength(0);
    expect(run([{ type: 'cartPay' }], s)).toBe(s);
  });

  it('진동벨: up to 3 digits, ⌫, 확인 needs a number, 없음 skips it', () => {
    let s = run([...toDetail, ...iceRegular, { type: 'detailPayNow' }]);
    expect(s.screen).toBe('buzzer');
    expect(run([{ type: 'buzzerConfirm' }], s)).toBe(s);
    s = run([{ type: 'buzzerDigit', digit: '4' }, { type: 'buzzerDigit', digit: '5' }, { type: 'buzzerDigit', digit: '6' }, { type: 'buzzerDigit', digit: '7' }, { type: 'buzzerBackspace' }], s);
    expect(s.buzzerDraft).toBe('45');
    expect(run([{ type: 'buzzerNone' }], s)).toMatchObject({ screen: 'pay', buzzer: null });
  });

  it('every payment tile ends in processing; the camera ones go through their own screen first', () => {
    const atPay = run([...toDetail, ...iceRegular, { type: 'detailPayNow' }, { type: 'buzzerNone' }]);
    expect(run([{ type: 'choosePayment', label: '삼성·애플·NFC' }], atPay).screen).toBe('processing');
    expect(run([{ type: 'choosePayment', label: '카드' }], atPay).screen).toBe('processing');
    const scan = run([{ type: 'choosePayment', label: '네이버페이' }], atPay);
    expect(scan.screen).toBe('scan');
    expect(run([{ type: 'paymentRequested', label: '네이버페이' }], scan).screen).toBe('processing');
    const face = run([{ type: 'choosePayment', label: '페이스사인' }], atPay);
    expect(face.screen).toBe('face');
    expect(run([{ type: 'back' }], face).screen).toBe('pay');
    expect(run([{ type: 'paymentRequested', label: '페이스사인' }], face)).toMatchObject({ screen: 'processing', payment: '페이스사인' });
  });

  it('the payment screen has no back; < 이전 walks back one screen elsewhere', () => {
    const atPay = run([...toDetail, ...iceRegular, { type: 'detailPayNow' }, { type: 'buzzerNone' }]);
    expect(run([{ type: 'back' }], atPay)).toBe(atPay);
    expect(run([{ type: 'start' }, { type: 'back' }]).screen).toBe('attract');
    expect(run([{ type: 'start' }, { type: 'chooseType', orderType: 'dine_in' }, { type: 'back' }]).screen).toBe('method');
  });

  it('처음으로 resets from any screen and the next customer starts clean', () => {
    const atPay = run([...toDetail, ...iceRegular, { type: 'detailPayNow' }, { type: 'buzzerDigit', digit: '9' }, { type: 'buzzerConfirm' }]);
    const home = run([{ type: 'home' }], atPay);
    expect(home).toEqual({ ...initialKioskState, serial: atPay.serial });
    expect(home.cart).toHaveLength(0);
  });

  it('keyword review allows at most 5 picks and submits only with one', () => {
    const chips = ['음식 맛이 훌륭해요', '가성비 좋아요', '또 먹고 싶어요', '건강한 맛이에요', '재료가 신선해요', '뷰가 좋아요'];
    let s = run([...toDetail, ...iceRegular, { type: 'detailPayNow' }, { type: 'buzzerNone' }, { type: 'choosePayment', label: '카드' }, { type: 'approved', orderId: 'x' }, { type: 'reviewStart' }]);
    expect(run([{ type: 'reviewSubmit' }], s)).toBe(s);
    s = run(chips.map(chip => ({ type: 'toggleChip', chip }) as const), s);
    expect(s.reviewPicks).toHaveLength(MAX_REVIEW_PICKS);
    expect(s.reviewPicks).not.toContain('뷰가 좋아요');
    s = run([{ type: 'toggleChip', chip: '가성비 좋아요' }], s);
    expect(s.reviewPicks).toHaveLength(MAX_REVIEW_PICKS - 1);
  });
});
