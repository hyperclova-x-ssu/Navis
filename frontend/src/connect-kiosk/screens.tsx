/**
 * KIOSK-UI — the customer screens, one component each, in the order a customer meets them. They only draw state and send
 * actions; the flow rules live in flow.ts and the timers in Kiosk.tsx.
 *
 * Source of every screen (the Npay connect mini kiosk, real screens): attract / method / menu / cart / payment from the OKPOS
 * manual; item options, 진동벨 and success-with-review cards from NAVER's design board; the payment screen from guide 2.4.4;
 * the camera scan from the 지역화폐 guide; the keyword review from the Nov 2026 build. RECONSTRUCTIONS (never seen in full,
 * built in the same visual language): the menu's cart bar, the all-categories sheet, the empty cart, the item page's option
 * rows and its edit button, the 확인 button when enabled, the camera-scan feed, the sent screens, the review's third column text.
 */
import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import type { Locale } from '../contracts';
import {
  ApplePayMark, CardArt, ContactlessHand, FaceBracket, ForkSpoon, IconBackspace, IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight,
  IconClose, IconCup, IconMinus, IconPlus, IconRefresh, NCoin, NoQrGlyph, NpayFoot, NpayInline, NpayPill, PaperBag, PayConnectLogo, PhoneN,
  ScanBrackets, TapHandIcon,
} from './icons';
import {
  cartCount, cartTotal, detailTotal, isNpayPayment, lineTotal, optionLines, requiredSatisfied, won, MAX_REVIEW_PICKS,
  type KioskAction, type KioskState, type PaymentLabel,
} from './flow';
import { itemsForTab, kioskCategoryMessages, kioskItem, kioskTabs, type KioskItem } from './menu';

export type Send = (action: KioskAction) => void;

function Head({ back, home, ink, onBack, onHome }: { readonly back?: string; readonly home?: boolean; readonly ink?: boolean; readonly onBack?: () => void; readonly onHome?: () => void }) {
  return <header className={`ck-head${ink ? ' ck-head--ink' : ''}`}>
    {onBack ? <button type="button" className="ck-back ck-press" onClick={onBack}><IconChevronLeft/>{back ?? '이전'}</button> : <span/>}
    {home && onHome ? <button type="button" className="ck-home ck-press" onClick={onHome}>처음으로<IconRefresh/></button> : <span/>}
  </header>;
}

function Photo({ item, className }: { readonly item: KioskItem; readonly className: string }) {
  const [failed, setFailed] = useState(false);
  return <span className={className}>{item.photo && !failed ? <img src={item.photo} alt="" decoding="async" draggable={false} onError={() => setFailed(true)}/> : <IconCup/>}</span>;
}

export function AttractScreen({ send }: { readonly send: Send }) {
  return <section className="ck-screen ck-attract" aria-label="주문 시작">
    <PayConnectLogo/>
    <p className="ck-attract__promo ck-attract__promo--a">네이버 리뷰 작성하면<strong>포인트 100원</strong></p>
    <div className="ck-attract__rule" aria-hidden="true"/>
    <p className="ck-attract__promo ck-attract__promo--b"><span><NpayInline/>로 결제하면</span><strong>추가 포인트 혜택까지</strong></p>
    <button type="button" className="ck-btn ck-btn--green ck-attract__start ck-press" onClick={() => send({ type: 'start' })}>주문하기</button>
    {/* The real screen also shows the campaign end date (26년 3월 31일까지); it has passed on the app clock, so only the membership condition stays. */}
    <p className="ck-attract__note">네이버페이 회원 한정</p>
    <NpayFoot/>
  </section>;
}

export function MethodScreen({ send }: { readonly send: Send }) {
  return <section className="ck-screen" aria-label="주문 방법">
    <Head onBack={() => send({ type: 'back' })}/>
    <h1 className="ck-method__title">주문 방법을 선택해 주세요</h1>
    <div className="ck-method__tiles">
      <button type="button" className="ck-method__tile ck-press" onClick={() => send({ type: 'chooseType', orderType: 'dine_in' })}><ForkSpoon/>매장 주문</button>
      <button type="button" className="ck-method__tile ck-press" onClick={() => send({ type: 'chooseType', orderType: 'takeout' })}><PaperBag/>포장 주문</button>
    </div>
    <NpayFoot/>
  </section>;
}

export function MenuScreen({ state, send, added, categoryLocale }: { readonly state: KioskState; readonly send: Send; readonly added: string | null; readonly categoryLocale: Locale }) {
  const [sheet, setSheet] = useState(false);
  const items = itemsForTab(state.tab);
  const tabs = kioskTabs(categoryLocale);
  const messages = kioskCategoryMessages[categoryLocale];
  const count = cartCount(state.cart);
  return <section className="ck-screen" aria-label="메뉴">
    <Head back={state.orderType === 'takeout' ? '포장 주문' : '매장 주문'} home onBack={() => send({ type: 'back' })} onHome={() => send({ type: 'home' })}/>
    <div className="ck-tabs" lang={categoryLocale}>
      <div className="ck-tabs__row" role="tablist" aria-label={messages.menu}>
        {tabs.map(tab => <button key={tab.key} type="button" role="tab" aria-selected={tab.key === state.tab} className="ck-tab ck-press" onClick={() => send({ type: 'setTab', tab: tab.key })}>{tab.label}</button>)}
      </div>
      <button type="button" className="ck-tabs__more ck-press" aria-label={messages.sheet} aria-expanded={sheet} onClick={() => setSheet(open => !open)}><IconChevronDown/></button>
    </div>
    {sheet ? <div className="ck-tabs__sheet" lang={categoryLocale} role="tablist" aria-label={messages.sheet}>
      {tabs.map(tab => <button key={tab.key} type="button" role="tab" aria-selected={tab.key === state.tab} className="ck-press" onClick={() => { send({ type: 'setTab', tab: tab.key }); setSheet(false); }}>{tab.label}</button>)}
    </div> : null}
    <div className="ck-grid" role="group" aria-label="메뉴" key={state.tab}>
      {items.map(item => <button key={item.id} type="button" className="ck-item ck-press" data-soldout={item.soldOut || undefined} data-added={added === item.id || undefined}
        aria-label={`${item.name}, ${won(item.price)}${item.soldOut ? ', 품절' : ''}`} disabled={item.soldOut} onClick={() => send({ type: 'openItem', itemId: item.id })}>
        <Photo item={item} className="ck-item__photo"/>
        {item.soldOut ? <span className="ck-item__soldout">품절</span> : null}
        <span className="ck-item__name">{item.name}</span>
        <span className="ck-item__price">{won(item.price)}</span>
      </button>)}
    </div>
    {count ? <div className="ck-cartbar"><button type="button" className="ck-btn ck-btn--green ck-press" onClick={() => send({ type: 'openCart' })}>
      <span><span className="ck-cartbar__count">{count}개</span>장바구니 보기</span><span>총 {won(cartTotal(state.cart))}</span>
    </button></div> : null}
  </section>;
}

function Stepper({ value, onMinus, onPlus, minusOff, plusOff, small, label }: { readonly value: number; readonly onMinus: () => void; readonly onPlus: () => void; readonly minusOff?: boolean; readonly plusOff?: boolean; readonly small?: boolean; readonly label: string }) {
  return <span className={`ck-step${small ? ' ck-step--sm' : ''}`}>
    <button type="button" className="ck-press" aria-label={`${label} 줄이기`} disabled={minusOff} onClick={onMinus}><IconMinus/></button>
    <output aria-label={`${label} 수량`}>{value}</output>
    <button type="button" className="ck-press" aria-label={`${label} 늘리기`} disabled={plusOff} onClick={onPlus}><IconPlus/></button>
  </span>;
}

export function DetailScreen({ state, send }: { readonly state: KioskState; readonly send: Send }) {
  const draft = state.detail;
  const item = draft ? kioskItem(draft.itemId) : undefined;
  if (!draft || !item) return null;
  const ready = requiredSatisfied(item, draft.picked);
  const total = detailTotal(draft);
  return <section className="ck-screen" aria-label={`${item.name} 옵션`}>
    <div className="ck-detail__photo">{item.photo ? <img src={item.photo} alt="" decoding="async" draggable={false}/> : null}</div>
    <Head ink home onBack={() => send({ type: 'back' })} onHome={() => send({ type: 'home' })}/>
    <div className="ck-detail__scroll">
      <h1 className="ck-detail__name">{item.name}</h1>
      {item.description ? <p className="ck-detail__desc">{item.description}</p> : null}
      <div className="ck-detail__row">
        <span className="ck-detail__price">{won(item.price)}</span>
        <Stepper label={item.name} value={draft.qty} minusOff={draft.qty <= 1} onMinus={() => send({ type: 'detailQty', delta: -1 })} onPlus={() => send({ type: 'detailQty', delta: 1 })}/>
      </div>
      {item.groups.map(group => <div key={group.id} className="ck-group" role="group" aria-label={group.name}>
        <div className="ck-group__head">
          <span className="ck-group__name">{group.name}</span>
          {group.required ? <span className="ck-group__need">필수</span> : null}
          <span className="ck-group__rule">{group.required ? '최소 1개 ~ 최대 1개' : '최대 1개'}</span>
        </div>
        {group.options.map(option => {
          const on = draft.picked.includes(option.id);
          return <button key={option.id} type="button" role={group.required ? 'radio' : 'checkbox'} aria-checked={on} className="ck-opt ck-press"
            onClick={() => send({ type: 'detailOption', groupId: group.id, optionId: option.id, delta: on && !group.required ? -1 : 1 })}>
            <span className="ck-opt__name">{option.name}{option.extraPrice ? <small>+{won(option.extraPrice)}</small> : null}</span>
            <span className="ck-step ck-step--sm" aria-hidden="true">
              <span className="ck-step__btn" data-off={!on || group.required || undefined}><IconMinus/></span>
              <output>{on ? 1 : 0}</output>
              <span className="ck-step__btn" data-off={on || undefined}><IconPlus/></span>
            </span>
          </button>;
        })}
      </div>)}
    </div>
    <div className="ck-detail__foot">
      <p className="ck-detail__total">총 {won(total)}</p>
      <div className={`ck-detail__ctas${draft.editKey ? ' ck-one' : ''}`}>
        {draft.editKey
          ? <button type="button" className={`ck-btn ck-press ${ready ? 'ck-btn--green' : 'ck-btn--off'}`} disabled={!ready} onClick={() => send({ type: 'detailAdd' })}>변경하기</button>
          : <>
            <button type="button" className={`ck-btn ck-press ${ready ? 'ck-btn--mint' : 'ck-btn--off'}`} disabled={!ready} onClick={() => send({ type: 'detailPayNow' })}>바로 결제</button>
            <button type="button" className={`ck-btn ck-press ${ready ? 'ck-btn--green' : 'ck-btn--off'}`} disabled={!ready} onClick={() => send({ type: 'detailAdd' })}>메뉴담기</button>
          </>}
      </div>
    </div>
  </section>;
}

export function CartScreen({ state, send }: { readonly state: KioskState; readonly send: Send }) {
  const count = cartCount(state.cart);
  return <section className="ck-screen" aria-label="주문상품 확인">
    <Head onBack={() => send({ type: 'back' })} home onHome={() => send({ type: 'home' })}/>
    <div className="ck-cart__card">
      {state.cart.length === 0 ? <p className="ck-cart__empty">담긴 메뉴가 없어요</p> : state.cart.map(line => {
        const item = kioskItem(line.itemId);
        if (!item) return null;
        const options = optionLines(line);
        return <article key={line.key} className="ck-line">
          <Photo item={item} className="ck-line__thumb"/>
          <div className="ck-line__main">
            <h2 className="ck-line__name">{item.name}</h2>
            {options.length ? <p className="ck-line__opts">{options.map(o => <span key={o.id}><span aria-hidden="true">{'ㄴ '}</span>{'옵션 '}{o.name}{o.extraPrice ? `(+${won(o.extraPrice)})` : ''}<br/></span>)}</p> : null}
            <p className="ck-line__price">{won(lineTotal(line))}</p>
            {item.groups.length ? <button type="button" className="ck-line__edit ck-press" onClick={() => send({ type: 'cartEdit', key: line.key })}>옵션 변경</button> : null}
          </div>
          <button type="button" className="ck-line__x ck-press" aria-label={`${item.name} 빼기`} onClick={() => send({ type: 'cartRemove', key: line.key })}><IconClose/></button>
          <span className="ck-line__step"><Stepper small label={item.name} value={line.qty} minusOff={line.qty <= 1} onMinus={() => send({ type: 'cartQty', key: line.key, delta: -1 })} onPlus={() => send({ type: 'cartQty', key: line.key, delta: 1 })}/></span>
        </article>;
      })}
      <button type="button" className="ck-more ck-press" onClick={() => send({ type: 'cartMore' })}>메뉴 추가<IconChevronRight/></button>
    </div>
    <button type="button" className="ck-btn ck-btn--green ck-cta ck-press" disabled={!count} onClick={() => send({ type: 'cartPay' })}>
      <span className="ck-cta__count">{count}개</span>총 {won(cartTotal(state.cart))} 결제하기
    </button>
  </section>;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'] as const;
export function BuzzerScreen({ state, send }: { readonly state: KioskState; readonly send: Send }) {
  const draft = state.buzzerDraft;
  return <section className="ck-screen" aria-label="진동벨 번호">
    <Head home onBack={() => send({ type: 'back' })} onHome={() => send({ type: 'home' })}/>
    <h1 className="ck-buzzer__title">선택한 <em>진동벨 번호를 입력</em>하면<br/>메뉴 준비 시 알려드릴게요</h1>
    <p className="ck-buzzer__field" data-filled={!!draft || undefined} role="status" aria-label="진동벨 번호 입력">
      {draft ? draft : <><span className="ck-buzzer__caret" aria-hidden="true"/>진동벨 번호 입력</>}
    </p>
    <div className="ck-keypad">
      {KEYS.map((key, index) => key === '' ? <span key={`blank-${index}`}/> : key === 'back'
        ? <button key={key} type="button" className="ck-press" aria-label="지우기" onClick={() => send({ type: 'buzzerBackspace' })}><IconBackspace/></button>
        : <button key={key} type="button" className="ck-press" onClick={() => send({ type: 'buzzerDigit', digit: key })}>{key}</button>)}
    </div>
    <div className="ck-bottom2">
      <button type="button" className="ck-btn ck-btn--mint ck-press" onClick={() => send({ type: 'buzzerNone' })}>진동벨 없음</button>
      <button type="button" className={`ck-btn ck-press ${draft ? 'ck-btn--green' : 'ck-btn--off'}`} disabled={!draft} onClick={() => send({ type: 'buzzerConfirm' })}>확인</button>
    </div>
    <NpayFoot/>
  </section>;
}

export function PayScreen({ state, send }: { readonly state: KioskState; readonly send: Send }) {
  const choose = (label: PaymentLabel) => send({ type: 'choosePayment', label });
  return <section className="ck-screen ck-pay" aria-label="결제 방법">
    <Head home onHome={() => send({ type: 'home' })}/>
    <button type="button" className="ck-nfc ck-press" aria-label="삼성페이 애플페이 여기에 대 주세요" onClick={() => choose('삼성·애플·NFC')}>
      <ContactlessHand className="ck-nfc__hand"/>
      <span className="ck-nfc__brands"><b>SAMSUNG</b> Pay<span aria-hidden="true">·</span><ApplePayMark/>Pay</span>
      <span className="ck-nfc__text">여기에 대 주세요</span>
    </button>
    <p className="ck-pay__amount"><span>결제 금액</span><strong>{won(cartTotal(state.cart))}</strong></p>
    <div className="ck-pay__tiles">
      <button type="button" className="ck-pay__tile ck-press" onClick={() => choose('네이버페이')}>
        <span className="ck-pay__disc"><NoQrGlyph/></span><span><NpayPill/>간편 결제</span>
      </button>
      <button type="button" className="ck-pay__tile ck-press" onClick={() => choose('페이스사인')}>
        <span className="ck-pay__disc"><FaceBracket/></span><span><NpayPill/>페이스사인</span>
      </button>
    </div>
    <button type="button" className="ck-pay__card" aria-label="카드를 넣거나 대 주세요" onClick={() => choose('카드')}><CardArt/></button>
    <NpayFoot/>
  </section>;
}

export function ScanScreen({ state, send }: { readonly state: KioskState; readonly send: Send }) {
  return <section className="ck-screen ck-scan" aria-label="QR 바코드 인식">
    <div className="ck-scan__feed" aria-hidden="true"/><div className="ck-scan__shade" aria-hidden="true"/>
    <div className="ck-scan__view" aria-hidden="true"/><ScanBrackets/>
    <Head onBack={() => send({ type: 'back' })}/>
    <h1 className="ck-scan__title">QR·바코드를 화면에 보여주세요</h1>
    <p className="ck-scan__amount">결제 금액 {won(cartTotal(state.cart))}</p>
    <NpayFoot/>
  </section>;
}

export function ProcessingScreen({ state }: { readonly state: KioskState }) {
  return <section className="ck-screen" aria-label="결제 요청 중" aria-live="polite">
    <div className="ck-spin" aria-hidden="true"><svg viewBox="0 0 92 92"><circle cx="46" cy="46" r="42" fill="none" stroke="#1d241f" strokeWidth="5"/><path d="M46 4a42 42 0 0 1 42 42" fill="none" stroke="#00de5a" strokeWidth="5" strokeLinecap="round"/></svg></div>
    <h1 className="ck-proc__title">결제를 요청 중이에요</h1>
    {state.buzzer ? <p className="ck-proc__pill">진동벨 {state.buzzer}번</p> : null}
    <NpayFoot/>
  </section>;
}

/** Counts down whole seconds and calls `onZero` once; the screen remounts for every new customer, so it starts fresh. */
function useCountdown(seconds: number, onZero: () => void): number {
  const [left, setLeft] = useState(seconds);
  const done = useEffectEvent(onZero);
  useEffect(() => {
    const timer = window.setInterval(() => setLeft(value => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { if (left === 0) done(); }, [left]);
  return left;
}
function Countdown({ left }: { readonly left: number }) { return <span className="ck-ok__count" aria-label={`${left}초`}>{left}</span>; }

export function SuccessScreen({ state, send, seconds }: { readonly state: KioskState; readonly send: Send; readonly seconds: number }) {
  const left = useCountdown(seconds, () => send({ type: 'home' }));
  const paid = state.paid;
  if (!paid) return null;
  const npay = isNpayPayment(paid.label);
  // Npay payers: the real K9 screen, a small "결제 성공! 키워드 리뷰 선택 시" line over the point line (the point needs a review).
  // Other methods: no public screen exists, so the reconstructed check badge and amount title stay.
  return <section className={`ck-screen${npay ? ' ck-ok--npay' : ''}`} aria-label="결제 성공">
    {npay ? <>
      <h1 className="ck-ok__lead">결제 성공! 키워드 리뷰 선택 시</h1>
      <p className="ck-ok__point"><NCoin/>Npay 포인트 100원 <b>적립</b></p>
    </> : <>
      <div className="ck-ok__disc"><IconCheck/></div>
      <h1 className="ck-ok__title">{won(paid.total)} 결제 성공!</h1>
    </>}
    <div className="ck-ok__cards">
      <button type="button" className="ck-ok__card ck-press" onClick={() => send({ type: 'reviewStart' })}><TapHandIcon/>3초면 끝! 키워드 리뷰 남기기<IconChevronRight className="ck-ok__chev"/></button>
      <button type="button" className="ck-ok__card ck-press" onClick={() => send({ type: 'reviewLater' })}><PhoneN style={{ width: 38, height: 54 }}/>나중에 휴대폰으로 리뷰하기<IconChevronRight className="ck-ok__chev"/></button>
    </div>
    <button type="button" className="ck-ok__end ck-press" onClick={() => send({ type: 'home' })}><Countdown left={left}/>끝내기</button>
    <p className="ck-legal">네이버 서비스 제공을 위해 결제정보를 수집합니다</p>
  </section>;
}

const CHIP_COLUMNS: readonly { readonly title: string; readonly chips: readonly (readonly [string, string])[] }[] = [
  { title: '음식/가격', chips: [['😋', '음식 맛이 훌륭해요'], ['💰', '가성비 좋아요'], ['👫', '또 먹고 싶어요'], ['🍹', '건강한 맛이에요'], ['🍚', '재료가 신선해요']] },
  { title: '분위기', chips: [['💎', '인테리어가 멋져요'], ['📸', '사진이 잘 나와요'], ['🖼️', '뷰가 좋아요'], ['🗣️', '대화하기 좋아요'], ['🤩', '감성이 좋아요']] },
  // The third column was only seen cut off at the screen edge ("친절…", "매장…", "좌석…", "룸이…", "주차…"): completed here.
  { title: '기타', chips: [['🤩', '친절해요'], ['📸', '매장이 청결해요'], ['🛋️', '좌석이 편해요'], ['🍰', '룸이 있어요'], ['🅿️', '주차하기 편해요']] },
];

export function ReviewScreen({ state, send }: { readonly state: KioskState; readonly send: Send }) {
  const [nope, setNope] = useState<string | null>(null);
  const picked = state.reviewPicks.length;
  const press = (chip: string) => {
    if (!state.reviewPicks.includes(chip) && picked >= MAX_REVIEW_PICKS) { setNope(chip); window.setTimeout(() => setNope(null), 300); return; }
    send({ type: 'toggleChip', chip });
  };
  return <section className="ck-screen ck-review" aria-label="키워드 리뷰">
    <div className="ck-review__bubble">리뷰 고르고</div>
    <h1 className="ck-review__title"><em>Npay 포인트</em> 받으세요</h1>
    <div className="ck-review__cols">
      {CHIP_COLUMNS.map(column => <div key={column.title} className="ck-review__col" role="group" aria-label={column.title}>
        <h2>{column.title}</h2>
        {column.chips.map(([emoji, text]) => <button key={text} type="button" className="ck-chip ck-press" aria-pressed={state.reviewPicks.includes(text)} data-nope={nope === text || undefined} onClick={() => press(text)}>
          <span aria-hidden="true">{emoji}</span><span>{text}</span>
        </button>)}
      </div>)}
    </div>
    <div className="ck-review__foot">
      <button type="button" className="ck-btn ck-btn--dark ck-press" onClick={() => send({ type: 'home' })}>끝내기</button>
      <button type="button" className={`ck-btn ck-press ${picked ? 'ck-btn--green' : 'ck-btn--off'}`} disabled={!picked} onClick={() => send({ type: 'reviewSubmit' })}>선택하고 혜택 받기</button>
    </div>
    <p className="ck-legal">네이버 서비스 제공을 위해 결제정보를 수집합니다</p>
  </section>;
}

export function SentScreen({ state, send, seconds }: { readonly state: KioskState; readonly send: Send; readonly seconds: number }) {
  const left = useCountdown(seconds, () => send({ type: 'home' }));
  const npay = state.paid ? isNpayPayment(state.paid.label) : true;
  const text: ReactNode = state.screen === 'laterSent' && !npay ? <>리뷰 작성<br/>링크를 보냈어요!</> : <>네이버 앱으로<br/>{state.screen === 'laterSent' ? '리뷰 알림을 보냈어요' : '상세 리뷰 알림을 보냈어요'}</>;
  return <section className="ck-screen" aria-label="알림 전송">
    <h1 className="ck-sent__title">{text}</h1>
    <p className="ck-sent__sub"><b>{left}초</b> 후 종료됩니다.</p>
    <button type="button" className="ck-btn ck-btn--green ck-sent__ok ck-press" onClick={() => send({ type: 'home' })}>확인</button>
    <NpayFoot/>
  </section>;
}
