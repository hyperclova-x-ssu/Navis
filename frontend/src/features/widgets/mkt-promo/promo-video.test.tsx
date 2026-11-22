/**
 * T-083 AI 홍보 영상 widget and create window (SCR-50~58, D-80·D-82) against a fake promo server (promo-test-server.ts).
 * AC-323·324·327~335·342·343·345~349 (screen parts), API-20~27 client and the per-store job watcher.
 */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan, ContentShape, FeatureId, Locale, PreviewSelection } from '../../../contracts';
import { PUBLIC_ISSUE_LIMIT, createWidgetDataStore, selectWidget, type ModelOf, type WidgetDataStore } from '../../../data/widget-data';
import { createSeedTables } from '../../../data/db/seed';
import { dispatchOk, makeDone } from '../../../data/marketing/promo-fixtures';
import { renderWithKit } from '../../../ui/test-utils';
import { MarketingTodayPanel } from './marketing-today';
import { mktPromoBundle } from './messages';
import { promoRealBundle } from './promo-real-copy';
import { estimateCostText, estimateTimeText, lookupEstimate, roundEstimateSeconds, roundEstimateWon } from './promo-format';
import { masonryColumns } from './promo-gallery-layout';
import { MAX_NETWORK_ERRORS, promoSession } from './promo-session';
import { createFakeServer, fakeEstimate, type FakeServer } from './promo-test-server';
import { PromoVideoDetail, PromoVideoPanel } from './promo-video';
import { useT } from './shared';
import { NO_PHOTO_MENU, PHOTO_MENU, cafeCatalog, cafeModel, makeHost, rawOf, syncedCafeStore } from './test-helpers';

const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
let server: FakeServer;
let stores: WidgetDataStore[] = [];
/**
 * The 안숭잘부 카페 seed has the cafe's own 24 menus and, in the unit tests, the photos the test gives it: the fake server answers a cafe catalog
 * with `PHOTOS` photos for one menu (아메리카노) and none for the others, so a test does not depend on which photos the real catalog carries.
 * Names and the shop come from the model, not from literals.
 */
const PHOTOS = 10;
const promoModel = cafeModel('promo-video');
const menuName = (menuId: string): string => rawOf(promoModel.menus.find((m) => m.menuId === menuId)!.name);
const PM = menuName(PHOTO_MENU);
const NPM = menuName(NO_PHOTO_MENU);
const shop = promoModel.store!;
/** A menu chip ("아메리카노 · 사진 10장"); the name is anchored so 디카페인 아메리카노 is not matched. */
const chip = (name: string) => new RegExp(`^${name}\\s·\\s`);
const tilesOf = (name: string) => new RegExp(`^${name} 사진`);
/** `synced` = the run already took the catalog (what a store holds after the first surface synced); `false` leaves the sync to the mounted widget. */
const newStore = (photos: number = PHOTOS, synced = true) => {
  const s = createWidgetDataStore(); stores.push(s);
  server.catalog = cafeCatalog(s, { [PHOTO_MENU]: photos });
  return synced ? syncedCafeStore(s, { [PHOTO_MENU]: photos }) : s;
};
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

function panel(store: WidgetDataStore, w: number, h: number, options: { readonly preview?: PreviewSelection; readonly host?: ReturnType<typeof makeHost> } = {}) {
  return renderWithKit(<PromoVideoPanel featureId="promo-video" condition={{ kind: 'default' }} width={w as CellSpan} height={h as CellSpan} shape={shapeOf(w, h)} presetId="A" editing={false} host={options.host ?? makeHost()} />, { store, preview: options.preview });
}
function both(store: WidgetDataStore, options: { readonly reducedMotion?: boolean; readonly locale?: Locale } = {}) {
  const host = makeHost();
  return { host, ...renderWithKit(
    <>
      <div data-testid="w"><PromoVideoPanel featureId="promo-video" condition={{ kind: 'default' }} width={2} height={1} shape="W" presetId="A" editing={false} host={host} /></div>
      <div data-testid="win"><PromoVideoDetail featureId="promo-video" condition={{ kind: 'default' }} detailRef={{ featureId: 'promo-video', view: 'create', focus: 'action' }} host={host} /></div>
    </>, { store, ...options }) };
}
function modelOf<F extends FeatureId>(store: WidgetDataStore, id: F): ModelOf<F> {
  const view = selectWidget(store.getSnapshot(), id, { kind: 'default' }, 'normal');
  if (view.status !== 'ready') throw new Error(`${id} ${view.status}`);
  return view.model as ModelOf<F>;
}
const win = () => within(screen.getByTestId('win'));
const widget = () => screen.getByTestId('w');
const press = (el: HTMLElement) => act(() => { fireEvent.click(el); });
const tab = (n: number) => press(win().getAllByRole('tab')[n]);
const makeButton = () => win().getByRole('button', { name: '영상 만들기' });

/** Menus · 5 photos · mood · concept · reference, in the window. */
async function fill(photos = 5, length: 10 | 15 | 30 | null = 15) {
  press(win().getByRole('checkbox', { name: chip(PM) }));
  const tiles = win().getAllByRole('checkbox', { name: tilesOf(PM) });
  for (let i = 0; i < photos; i += 1) press(tiles[i]);
  tab(1);
  press(win().getByRole('checkbox', { name: '따뜻한' }));
  press(win().getByRole('checkbox', { name: '매장 소개' }));
  tab(2);
  await flush();
  press(win().getByRole('radio', { name: /단톡방 대화 \+ 남은 수량 카운트다운/ }));
  tab(3);
  if (length) press(win().getByRole('radio', { name: `${length}초` }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-10T10:00:00+09:00'));
  server = createFakeServer();
  vi.stubGlobal('fetch', vi.fn(server.fetch));
});
afterEach(() => {
  cleanup();
  for (const s of stores) promoSession(s).dispose();
  stores = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('widget states (SCR-50, AC-323·344)', () => {
  it('1×1 and 2×1 before making: the photo count, the menu that is ready, [영상 만들기]; no old 14·칭찬 리뷰·사진 8장', async () => {
    const host = makeHost();
    const store = newStore();
    panel(store, 1, 1, { host });
    await flush();
    expect(screen.getByText(`사진 ${PHOTOS}장`)).toBeInTheDocument();
    expect(screen.getByText(String(PHOTOS))).toBeInTheDocument();
    press(screen.getByRole('button', { name: '영상 만들기, AI 홍보 영상' }));
    expect(host.openDetail).toHaveBeenCalledWith({ featureId: 'promo-video', view: 'create', focus: 'action' });
    cleanup();
    panel(store, 2, 1);
    expect(screen.getByText(`${PM} 준비됨`)).toBeInTheDocument();
    for (const old of [/14/, /칭찬 리뷰/, /사진 8장/]) expect(document.body.textContent).not.toMatch(old);
  });
  it('fewer than 5 photos: the sentence and a disabled [영상 만들기] described by it (few-photos)', () => {
    panel(newStore(), 2, 1, { preview: { family: 'normal', overrides: { 'promo-video': 'few-photos' } } });
    expect(screen.getByText('사진이 5장 이상 모이면 영상을 만들 수 있어요', { selector: '.ui-panel-state__message' })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '영상 만들기' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/사진이 5장 이상 모이면 영상을 만들\s수\s있어요/);
  });
});

describe('D-231 panel layouts', () => {
  it('shows the posted label at 1×1', () => {
    const store = newStore();
    dispatchOk(store, { type: 'video.markPosted', videoId: makeDone(store, 'mk', 5, { menuIds: [PHOTO_MENU] }), route: 'clip', idempotencyKey: 'posted-test' });
    panel(store, 1, 1);
    expect(document.querySelector('[data-slot="promo-video.metric.label"]')).toHaveTextContent('올린 영상');
    expect(document.querySelector('[data-slot="promo-video.metric.value"]')).toHaveTextContent('1편');
  });
  it('uses the available 3×2 height for the photo summary and state', () => {
    panel(newStore(), 3, 2);
    expect(document.querySelector('.pv-panel')).toHaveAttribute('data-roomy', 'true');
    expect(document.querySelector('[data-slot="promo-video.catalog"]')).toHaveTextContent(`${PM} 준비됨`);
    // a menu without photos is listed with the sentence that says so
    expect(document.querySelector('[data-slot="promo-video.catalog"]')).toHaveTextContent(`${NPM} · 사진 없음`);
    // a cafe has dozens of menus: a few rows (photo menus first), then `외 n개`, so the card never scrolls
    const rows = document.querySelectorAll('[data-slot="promo-video.catalog"] li:not(.pv-panel__more)');
    expect(rows.length).toBe(4);
    expect(rows[0]).toHaveTextContent(`${PM} 준비됨`);
    expect(document.querySelector('[data-slot="promo-video.catalog.more"]')).toHaveTextContent(`외 ${promoModel.menus.length - 4}개`);
  });
});

describe('one photo number (AC-324)', () => {
  it('widget, window and 오늘 할 홍보 read the same count; a 7-photo and 4-photo catalog change all three', async () => {
    for (const n of [7, 4] as const) {
      const store = newStore(n, false);
      renderWithKit(<>
        <PromoVideoPanel featureId="promo-video" condition={{ kind: 'default' }} width={2} height={1} shape="W" presetId="A" editing={false} host={makeHost()} />
        <MarketingTodayPanel featureId="marketing-today" condition={{ kind: 'default' }} width={4} height={1} shape="L" presetId="A" editing={false} host={makeHost()} />
      </>, { store });
      await flush();
      expect(store.getSnapshot().tables.marketing.promoPhoto).toHaveLength(n);
      if (n >= 5) {
        expect(screen.getByText(`${PM} 준비됨`)).toBeInTheDocument();
        expect(screen.getByText(`영상에 쓸 매장 사진 ${n}장이 있어요`, { exact: false })).toBeInTheDocument();
      } else {
        // DATA-FIX item 12 (877f99a): the state follows the photos available (saved drafts no longer bypass the 5-photo threshold),
        // so a synced 4-photo catalog shows the few-photos state with a disabled [영상 만들기]; 오늘 할 홍보 omits its video cell.
        // AC-344 / DS 12.14.1: the short copy 사진이 5장 필요해요 shows only on 1×1·2×1 panels inside a FeaturePanel; this standalone panel keeps the full sentence.
        expect(document.querySelector('[data-widget="promo-video"]')).toHaveAttribute('data-promo-state', 'few-photos');
        expect(screen.getByText('사진이 5장 이상 모이면 영상을 만들 수 있어요', { selector: '.ui-panel-state__message' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '영상 만들기' })).toBeDisabled();
        expect(document.body.textContent).not.toMatch(/영상에 쓸 매장 사진 \d+장/);
      }
      cleanup();
    }
    const store = newStore();
    store.dispatch({ type: 'promo.syncCatalog', catalog: cafeCatalog(store, { [PHOTO_MENU]: 7 }) });
    both(store);
    press(win().getByRole('checkbox', { name: chip(PM) }));
    expect(win().getByText(`사진 고르기 · ${PM} 7장`)).toBeInTheDocument();
    expect(win().getAllByRole('checkbox', { name: tilesOf(PM) })).toHaveLength(7);
    // T-52 (D-381/D-382, W26-F1): step ① says how many store photos the video can use, whatever menu is picked.
    expect(win().getByText('영상에 쓸 매장 사진 7장')).toBeInTheDocument();
  });
});

describe('choices (AC-326~332)', () => {
  it('shop info is filled with no input; menus pick several; a menu without photos says so; unpicking a menu drops its photos', async () => {
    both(newStore());
    await flush();
    expect(win().getByText(shop.name)).toBeInTheDocument();
    expect(win().queryByText(/가상 주소/)).not.toBeInTheDocument();
    // the storefront photo the catalog names is shown (the placeholder is for a store without one)
    expect(win().getByRole('img', { name: `${shop.name} 외관 사진` })).toHaveAttribute('src', '/api/promo/photos/cafe-storefront');
    expect(win().queryAllByRole('textbox')).toHaveLength(0);
    expect(win().getByText('메뉴를 고르면 그 메뉴의 사진이 보여요. 사진이 있는 메뉴가 먼저 나와요')).toBeInTheDocument();
    press(win().getByRole('checkbox', { name: chip(PM) }));
    press(win().getByRole('checkbox', { name: chip(NPM) }));
    expect(win().getAllByRole('checkbox', { name: tilesOf(PM) })).toHaveLength(10);
    // a menu without photos says what to do next, in the window and beside the disabled button
    expect(win().getByText('이 메뉴는 사진이 아직 없어요. 사진이 있는 메뉴를 골라 주세요', { selector: '[data-slot="promo-video.no-photos"]' })).toBeInTheDocument();
    // SCR-51: step ① has no reason line (the count line is the one place); SCR-52 count line is "{n}장 골랐어요 · 5장 이상"
    expect(document.querySelector('[data-slot="promo-video.reason"]')?.textContent).toBe('');
    // nothing is chosen for the owner (AC-329)
    expect(win().queryAllByRole('checkbox', { name: /선택됨$/ })).toHaveLength(0);
    press(win().getByRole('checkbox', { name: `${PM} 사진 1/${PHOTOS}, 선택 안 됨` }));
    press(win().getByRole('checkbox', { name: `${PM} 사진 2/${PHOTOS}, 선택 안 됨` }));
    expect(document.querySelector('[data-slot="promo-video.photo-count"]')).toHaveTextContent('2장 골랐어요');
    press(win().getByRole('checkbox', { name: chip(PM) }));
    expect(win().getByText('0장 골랐어요 · 5장 이상')).toBeInTheDocument();
    expect(win().queryAllByRole('checkbox', { name: tilesOf(PM) })).toHaveLength(0);
  });
  it('shows the kit placeholder, never a broken image, when the store has no photo address or its photo does not load', async () => {
    server.down = true; // the catalog never arrives
    // DATA-FIX item 12 (877f99a): the cafe startup snapshot now carries /api/promo/photos/cafe-storefront independently of the catalog fetch,
    // so the missing-address placeholder is tested on the default store row stripped of its exteriorUrl.
    const seeded = createSeedTables();
    const unsynced = createWidgetDataStore({ marketing: { ...seeded.marketing, promoStore: seeded.marketing.promoStore.map(({ exteriorUrl: _address, ...row }) => row) } }); stores.push(unsynced);
    expect(unsynced.getSnapshot().tables.marketing.promoStore[0]).not.toHaveProperty('exteriorUrl');
    const first = both(unsynced);
    await flush();
    expect(document.querySelector('.pv-shop img')).toBeNull();
    expect(win().getByRole('img', { name: `${shop.name} 외관 사진이 아직 없어요` })).toBeInTheDocument();
    expect(document.querySelector('.pv-shop .ui-menu-photo')).not.toBeNull();
    first.unmount(); cleanup();
    server.down = false;
    both(newStore());
    await flush();
    const photo = document.querySelector('.pv-shop img') as HTMLImageElement;
    expect(photo).toHaveAttribute('src', '/api/promo/photos/cafe-storefront');
    act(() => { fireEvent.error(photo); });
    expect(document.querySelector('.pv-shop img')).toBeNull();
    expect(win().getByRole('img', { name: `${shop.name} 외관 사진이 아직 없어요` })).toBeInTheDocument();
  });
  it('without a length the button is off with 길이를 골라 주세요; choosing turns it on and the draft keeps it (D-87g)', async () => {
    const store = newStore();
    const view = both(store);
    await fill(5, null);
    expect(makeButton()).toBeDisabled();
    expect(win().getByText('길이를 골라 주세요')).toBeInTheDocument();
    press(win().getByRole('radio', { name: '30초' }));
    expect(makeButton()).toBeEnabled();
    expect(win().queryByText('길이를 골라 주세요')).toBeNull();
    view.unmount();
    both(store);
    tab(3);
    expect(win().getByRole('radio', { name: '30초' })).toBeChecked();
  });
  it('4 photos → disabled with the reason, 5 → enabled, back to 4 → disabled (AC-329)', async () => {
    both(newStore());
    await fill(4);
    expect(makeButton()).toBeDisabled();
    expect(win().getByText('사진을 5장 이상 골라 주세요 · 4장 골랐어요')).toBeInTheDocument();
    tab(0);
    press(win().getByRole('checkbox', { name: `${PM} 사진 5/${PHOTOS}, 선택 안 됨` }));
    expect(win().getByText('5장 골랐어요 · 5장 이상')).toBeInTheDocument();
    tab(3);
    expect(makeButton()).toBeEnabled();
    tab(0);
    press(win().getByRole('checkbox', { name: `${PM} 사진 5/${PHOTOS}, 선택됨` }));
    tab(3);
    expect(makeButton()).toBeDisabled();
  });
  it('moods and concepts pick several; none left → disabled with the reason; memo stops at 100 (AC-330)', async () => {
    both(newStore());
    await fill(5);
    expect(makeButton()).toBeEnabled();
    tab(1);
    press(win().getByRole('checkbox', { name: '활기찬' }));
    expect(win().getAllByRole('checkbox', { checked: true }).map((c) => c.textContent)).toEqual(['따뜻한', '활기찬', '매장 소개']);
    press(win().getByRole('checkbox', { name: '따뜻한' }));
    press(win().getByRole('checkbox', { name: '활기찬' }));
    expect(win().getByRole('tab', { name: /2\. 분위기·주제, 비어 있음/ })).toBeInTheDocument();
    tab(3);
    expect(makeButton()).toBeDisabled();
    expect(win().getByText('메뉴·사진, 분위기, 주제, 디자인을 모두 골라 주세요')).toBeInTheDocument();
    tab(1);
    press(win().getByRole('checkbox', { name: '고급스러운' }));
    tab(3);
    expect(makeButton()).toBeEnabled();
    tab(1);
    const memo = win().getByRole('textbox', { name: '원하는 느낌(안 써도 돼요)' });
    act(() => { fireEvent.change(memo, { target: { value: '가'.repeat(130) } }); });
    expect((memo as HTMLTextAreaElement).value).toHaveLength(100);
    expect(win().getByText('100자까지 쓸 수 있어요')).toBeInTheDocument();
    expect(win().getByText('100/100')).toBeInTheDocument();
  });
  it('the gallery: six cards in 4 staggered columns, all previews play at once, pressing a card chooses it (D-85)', async () => {
    both(newStore());
    tab(2);
    await flush();
    const radios = win().getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect(document.querySelectorAll('.pv-gallery__col')).toHaveLength(4);
    // no separate [고르기] button
    expect(win().queryByText('고르기')).toBeNull();
    // every visible card plays silently on a loop, several at once
    const videos = [...document.querySelectorAll<HTMLVideoElement>('.pv-ref__video')];
    expect(videos).toHaveLength(6);
    for (const video of videos) { expect(video.muted).toBe(true); expect(video.loop).toBe(true); expect(video.autoplay).toBe(true); expect(video.playsInline).toBe(true); }
    expect(win().queryAllByRole('radio', { checked: true })).toHaveLength(0);
    press(win().getByRole('radio', { name: '디자인 2번' }));
    expect(win().getByRole('radio', { name: '디자인 2번, 골랐어요', checked: true }).closest('[data-ref]')).toHaveAttribute('data-ref', 'ref-2');
    // pressing another card moves the choice (one at a time); previews keep playing
    press(win().getByRole('radio', { name: '진열대 천천히 훑기' }));
    expect(win().getAllByRole('radio', { checked: true }).map((r) => r.getAttribute('aria-label'))).toEqual(['진열대 천천히 훑기, 골랐어요']);
    expect(document.querySelectorAll('.pv-ref__video')).toHaveLength(6);
    // a video that fails keeps the poster and the card still chooses
    act(() => { fireEvent.error(document.querySelector('[data-ref="ref-2"] .pv-ref__video') as HTMLVideoElement); });
    expect(document.querySelector('[data-ref="ref-2"] .pv-ref__video')).toBeNull();
    expect(document.querySelector('[data-ref="ref-2"] .pv-ref__img')).not.toBeNull();
    press(win().getByRole('radio', { name: '디자인 2번' }));
    expect(win().getAllByRole('radio', { checked: true }).map((r) => r.getAttribute('aria-label'))).toEqual(['디자인 2번, 골랐어요']);
    // the masonry rule: next card into the lowest column
    expect(masonryColumns([520, 312, 390, 520, 390, 312], (h) => h).map((c) => c.length)).toEqual([1, 2, 2, 1]);
  });
  it('serves each café design poster and loop without requesting the retired reference media', async () => {
    both(newStore());
    tab(2);
    await flush();
    for (const tag of ['img', 'video']) {
      const urls = [...document.querySelectorAll(`.pv-ref__media ${tag}`)].map((media) => media.getAttribute('src'));
      expect(new Set(urls).size).toBe(6);
      for (const url of urls) {
        expect(url).toBeTruthy();
        expect(url).not.toContain('/api/promo/references/');
      }
    }
  });
  it.each([
    ['ko', '디자인', '디자인 2번'],
    ['en', 'Design', 'Design 2'],
    ['zh-Hans', '设计', '设计 2'],
    ['zh-Hant', '設計', '設計 2'],
  ] as const)('uses approved gallery wording in %s', async (locale, label, secondDesign) => {
    both(newStore(), { locale });
    tab(2);
    await flush();
    const group = win().getByRole('radiogroup', { name: label });
    expect(within(group).getByRole('radio', { name: secondDesign })).toBeInTheDocument();
    expect(win().queryByText(/예시 사진|sample photos|示例照片|範例照片/)).toBeNull();
  });
  it('length is 10 / 15 / 30 with nothing chosen at first (D-87g); the summary lists five chips (memo only when written) that go to their step (AC-332)', async () => {
    both(newStore());
    await fill(5, null);
    await flush();
    const group = win().getByRole('radiogroup', { name: '영상 길이' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['10초', '15초', '30초']);
    expect(within(group).queryAllByRole('radio', { checked: true })).toHaveLength(0);
    expect(win().getByRole('tab', { name: /4\. 길이, 비어 있음/ })).toHaveAttribute('data-filled', 'false');
    expect(win().getByText('길이를 고르면 예상 시간과 비용이 보여요')).toBeInTheDocument();
    expect(win().queryByText(/예상 시간 약/)).toBeNull();
    expect(makeButton()).toBeDisabled();
    press(within(group).getByRole('radio', { name: '15초' }));
    expect(within(group).getByRole('radio', { name: '15초' })).toBeChecked();
    expect(win().getByRole('tab', { name: /4\. 길이, 채움/ })).toHaveAttribute('data-filled', 'true');
    expect(win().queryByText('길이를 고르면 예상 시간과 비용이 보여요')).toBeNull();
    expect(document.querySelectorAll('.pv-summary__row')).toHaveLength(5);
    expect(win().queryByText('적지 않았어요')).toBeNull();
    expect(document.querySelector('[data-row="memo"]')).toBeNull();
    // SCR-55: visible 영상 길이 label, chip name "{값}, 바꾸려면 누르기, ① 메뉴·사진"
    expect(win().getByText('영상 길이', { selector: '.pv-label' })).toBeVisible();
    expect(win().getByRole('button', { name: `${PM}, 바꾸려면 누르기, ① 메뉴·사진` })).toBeInTheDocument();
    expect(win().getByRole('button', { name: '5장, 바꾸려면 누르기, ① 메뉴·사진' })).toBeInTheDocument();
    expect(win().getByRole('button', { name: '따뜻한, 바꾸려면 누르기, ② 분위기·주제' })).toBeInTheDocument();
    expect(win().getByRole('button', { name: '매장 소개, 바꾸려면 누르기, ② 분위기·주제' })).toBeInTheDocument();
    expect(win().getByRole('button', { name: /^단톡방 대화 \+ 남은 수량 카운트다운, 바꾸려면 누르기, ③ 디자인$/ })).toBeInTheDocument();
    press(win().getByRole('button', { name: '따뜻한, 바꾸려면 누르기, ② 분위기·주제' }));
    expect(win().getByRole('tab', { selected: true })).toHaveAccessibleName(/2\. 분위기·주제/);
  });
});

describe('window matches SCREENS SCR-51~55 (PROMO-UI, D-326 Q12)', () => {
  const css = () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'promo.css'), 'utf8');
    document.body.prepend(style);
  };
  it('the menu chip reads "{menu} · 사진 {n}장" in one text flow (no flex gap before the dot: one space, not two)', async () => {
    both(newStore());
    await flush();
    const el = win().getByRole('checkbox', { name: chip(PM) });
    expect(el.querySelectorAll(':scope > span')).toHaveLength(1);
    expect(el.textContent).toBe(`${PM}\u00a0·\u00a0사진 ${PHOTOS}장`);
    expect(el.textContent).not.toMatch(/\s{2,}/);
    expect(win().getByRole('checkbox', { name: new RegExp(`^${NPM}\\s·\\s사진 없음$`) }).textContent).toBe(`${NPM}\u00a0·\u00a0사진 없음`);
  });
  it('the memo input takes the full width of the chip rows (no 720 px cap)', async () => {
    both(newStore());
    css();
    await flush();
    tab(1);
    const memo = document.querySelector('.pv-memo') as HTMLElement;
    expect(memo).not.toBeNull();
    expect(getComputedStyle(memo).maxWidth).not.toBe('720px');
  });
  it('③ shows the design instruction and keeps the fit badge at the bottom-left of the card', async () => {
    both(newStore());
    css();
    await flush();
    tab(1);
    press(win().getByRole('checkbox', { name: '따뜻한' }));
    press(win().getByRole('checkbox', { name: '매장 소개' }));
    tab(2);
    await flush();
    expect(win().getByRole('heading', { name: '마음에 드는 디자인을 눌러 주세요' })).toBeInTheDocument();
    const badge = document.querySelector('.pv-ref__fit .ui-status-badge') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute('data-tone', 'success');
    expect(badge).toHaveAttribute('data-semantic', 'recommend');
    expect(badge).toHaveTextContent('어울려요');
    expect(badge.querySelector('svg')).not.toBeNull();
    const place = getComputedStyle(badge.parentElement as HTMLElement);
    expect(place.bottom).toBe('var(--space-2)');
    expect(place.left).toBe('var(--space-2)');
    expect(place.top).toBe('');
    expect(win().getByRole('radio', { name: /단톡방 대화 \+ 남은 수량 카운트다운, 어울려요$/ })).toBeInTheDocument();
  });
});

describe('easy pressing (D-87)', () => {
  const tileEl = (n: number) => win().getByRole('checkbox', { name: new RegExp(`${PM} 사진 ${n}/${PHOTOS}`) });
  const down = (el: HTMLElement) => act(() => { fireEvent.pointerDown(el, { button: 0, pointerId: 1 }); });
  const over = (el: HTMLElement) => {
    const original = document.elementFromPoint;
    document.elementFromPoint = () => el;
    act(() => { fireEvent.pointerMove(el.parentElement as HTMLElement, { pointerId: 1 }); });
    document.elementFromPoint = original;
  };
  const up = (el: HTMLElement) => act(() => { fireEvent.pointerUp(el, { pointerId: 1 }); fireEvent.click(el); });

  it('all ten photos sit in one 10-column row (no scroll) and the count shows above the tiles only', async () => {
    both(newStore());
    press(win().getByRole('checkbox', { name: chip(PM) }));
    expect(document.querySelector('.pv-grid')).toHaveAttribute('data-count', '10');
    expect(win().getAllByText('0장 골랐어요 · 5장 이상')).toHaveLength(1);
    press(win().getByRole('checkbox', { name: chip(PM) }));
  });
  it('sweeping a finger over tiles selects them all; starting on a chosen tile clears the swept ones; a plain press still toggles', async () => {
    both(newStore());
    if (win().queryAllByRole('checkbox', { name: tilesOf(PM) }).length === 0) press(win().getByRole('checkbox', { name: chip(PM) }));
    for (const c of win().queryAllByRole('checkbox', { name: new RegExp(`${PM} 사진.*, 선택됨`) })) press(c);
    down(tileEl(1)); over(tileEl(2)); over(tileEl(3)); up(tileEl(3));
    expect(document.querySelector('[data-slot="promo-video.photo-count"]')).toHaveTextContent('3장 골랐어요');
    expect(tileEl(2)).toBeChecked();
    // sweep starting on a chosen tile (2) clears 2 and 3, and leaves 1 as is
    down(tileEl(2)); over(tileEl(3)); up(tileEl(3));
    expect(document.querySelector('[data-slot="promo-video.photo-count"]')).toHaveTextContent('1장 골랐어요');
    expect(tileEl(1)).toBeChecked();
    // a plain press (pointer down + click on the same tile) toggles once
    down(tileEl(5)); up(tileEl(5));
    expect(tileEl(5)).toBeChecked();
    expect(document.querySelector('[data-slot="promo-video.photo-count"]')).toHaveTextContent('2장 골랐어요');
    // keyboard / plain click with no pointer still works
    press(tileEl(5));
    expect(tileEl(5)).not.toBeChecked();
  });
  it('Shift+arrow keys sweep from the start tile with its target state and say the count once', async () => {
    both(newStore());
    if (win().queryAllByRole('checkbox', { name: tilesOf(PM) }).length === 0) press(win().getByRole('checkbox', { name: chip(PM) }));
    for (const c of win().queryAllByRole('checkbox', { name: new RegExp(`${PM} 사진.*, 선택됨`) })) press(c);
    tileEl(1).focus();
    act(() => { fireEvent.keyDown(tileEl(1), { key: 'ArrowRight', shiftKey: true }); });
    act(() => { fireEvent.keyDown(tileEl(2), { key: 'ArrowRight', shiftKey: true }); });
    expect([1, 2, 3].map((n) => tileEl(n).getAttribute('aria-checked'))).toEqual(['true', 'true', 'true']);
    expect(document.querySelector('[data-slot="promo-video.photo-live"]')).toHaveTextContent('3장 골랐어요');
  });
  it('13 photos: same tiles, only the photo area scrolls; sideways paints, up/down scrolls (D-87b)', async () => {
    const store = newStore();
    both(store);
    await flush();
    act(() => { store.dispatch({ type: 'promo.syncCatalog', catalog: cafeCatalog(store, { [PHOTO_MENU]: 13 }) }); });
    const tl = (n: number) => win().getByRole('checkbox', { name: new RegExp(`${PM} 사진 ${n}/13`) });
    if (win().queryAllByRole('checkbox', { name: tilesOf(PM) }).length === 0) press(win().getByRole('checkbox', { name: chip(PM) }));
    for (const c of win().queryAllByRole('checkbox', { name: new RegExp(`${PM} 사진.*, 선택됨`) })) press(c);
    expect(win().getAllByRole('checkbox', { name: tilesOf(PM) })).toHaveLength(13);
    expect(document.querySelector('.pv-grid')).toHaveAttribute('data-scroll', 'true');
    const move = (type: string, el: Element, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })); });
    const at = (el: HTMLElement) => { const original = document.elementFromPoint; document.elementFromPoint = () => el; return () => { document.elementFromPoint = original; }; };
    // vertical first move: scrolls, nothing is chosen
    move('pointerdown', tl(1), 100, 100);
    let restore = at(tl(6));
    move('pointermove', document.querySelector('.pv-grid')!, 102, 160);
    restore();
    move('pointerup', tl(6), 102, 160);
    expect(win().getByText('0장 골랐어요 · 5장 이상')).toBeInTheDocument();
    // sideways first move: paints from the first tile
    move('pointerdown', tl(1), 100, 100);
    restore = at(tl(2));
    move('pointermove', document.querySelector('.pv-grid')!, 160, 102);
    restore();
    move('pointerup', tl(2), 160, 102);
    expect(document.querySelector('[data-slot="promo-video.photo-count"]')).toHaveTextContent('2장 골랐어요');
    // a plain press still toggles (after the click guard timer)
    await flush();
    press(tl(13));
    expect(tl(13)).toBeChecked();
  });
  it('the bar shows no estimate on ①~④; numbers and both sentences are only on ④ (D-87c)', async () => {
    both(newStore());
    await flush();
    for (const n of [1, 2, 3]) { tab(n); expect(document.querySelector('.pv-footer .pv-estimate')).toBeNull(); }
    expect(win().queryByText(/예상 시간 약/)).toBeNull();
    press(win().getByRole('radio', { name: '15초' }));
    expect(win().getAllByText(/예상 시간 약/)).toHaveLength(1);
    expect(win().getAllByText(/예상 비용 약/)).toHaveLength(1);
  });
  it('a reference card name is part of the card: pressing it chooses the card', async () => {
    both(newStore());
    tab(2);
    await flush();
    const name = document.querySelector('.pv-ref__name') as HTMLElement;
    press(name);
    expect(win().getAllByRole('radio', { checked: true })).toHaveLength(1);
  });
});

describe('estimate (AC-333·334)', () => {
  it('looks up the table with no request, rounds up (time 10 s / 30 s, cost 10 won), and shows both notes before and after choosing', async () => {
    const model = fakeEstimate();
    expect(lookupEstimate(model, 15, 5)).toMatchObject({ photoCount: 5 });
    expect([roundEstimateSeconds(31), roundEstimateSeconds(60), roundEstimateSeconds(61), roundEstimateSeconds(95)]).toEqual([40, 60, 90, 120]);
    expect([roundEstimateWon(151), roundEstimateWon(160)]).toEqual([160, 160]);
    both(newStore());
    await flush();
    const t = (secs: number) => `예상 시간 약 ${secs < 60 ? `${secs}초` : secs % 60 ? `${Math.floor(secs / 60)}분 ${secs % 60}초` : `${secs / 60}분`}`;
    // ①~③: no estimate at all in the bar (D-87c); it is on ④ only
    for (const n of [0, 1, 2]) { tab(n); expect(win().queryByText(/예상 시간/)).toBeNull(); expect(win().queryByText(/예상 비용/)).toBeNull(); }
    tab(3);
    press(win().getByRole('radio', { name: '15초' }));
    expect(screen.getAllByText(t(roundEstimateSeconds(70)))[0]).toBeInTheDocument(); // 15 s, 0 photos
    expect(screen.getAllByText('여러 번 만들어 본 평균으로 계산한 예상 시간이에요')).toHaveLength(1);
    expect(screen.getAllByText('예상 비용이에요', { exact: false })).toHaveLength(1);
    tab(0);
    await fill(5);
    const calls = server.calls.length;
    const value = () => document.querySelector('[data-slot="promo-video.estimate"] [data-slot="promo-video.estimate.time"]')?.textContent;
    const cost = () => document.querySelector('[data-slot="promo-video.estimate"] [data-slot="promo-video.estimate.cost"]')?.textContent;
    const at15 = [value(), cost()];
    expect(at15).toEqual([t(roundEstimateSeconds(85)), `예상 비용 약 ${roundEstimateWon(195)}원`]);
    press(win().getByRole('radio', { name: '30초' }));
    expect([value(), cost()]).toEqual([t(roundEstimateSeconds(115)), `예상 비용 약 ${roundEstimateWon(255)}원`]);
    press(win().getByRole('radio', { name: '15초' }));
    expect([value(), cost()]).toEqual(at15);
    expect(server.calls.length).toBe(calls);
    expect(win().getByText(/11\/10\(화\) 환율 기준/)).toBeInTheDocument();
  });
  it('a failed table says so with 다시 시도 and still lets the video be made', async () => {
    const original = server.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => (String(input).endsWith('/estimate-model') ? Promise.reject(new TypeError('x')) : original(input, init))));
    both(newStore());
    await fill(5);
    expect(win().getAllByText('예상 값을 불러오지 못했어요').length).toBeGreaterThan(0);
    expect(makeButton()).toBeEnabled();
  });
  it('formats in won with grouping', () => {
    const t = { t: (key: string, p?: Record<string, unknown>) => (key === 'promo.won' ? `${p?.n}원` : key === 'promo.dur.min' ? `${p?.m}분` : key === 'promo.dur.minSec' ? `${p?.m}분 ${p?.s}초` : `${p?.s}초`) } as unknown as ReturnType<typeof useT>;
    expect(estimateCostText(t, 1191)).toBe('1,200원');
    expect(estimateTimeText(t, 72)).toBe('1분 30초');
  });
});

describe('making, finishing, saving and posting (AC-335·336·337·345~347)', () => {
  it('two presses make one job; the steps follow the server; closing the window keeps polling and reopening shows progress (AC-335·343)', async () => {
    const store = newStore();
    const view = both(store);
    await fill(5);
    const button = makeButton();
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await flush();
    expect(server.calls.filter((c) => c.method === 'POST' && c.path === '/api/promo/jobs')).toHaveLength(1);
    expect(store.getSnapshot().tables.marketing.promoVideo).toHaveLength(1);
    const body = server.calls.find((c) => c.method === 'POST')?.body as { input: { photoIds: string[]; moods: string[]; referenceId: string; lengthSec: number; locale: string } };
    expect(body.input).toMatchObject({ photoIds: Array.from({ length: 5 }, (_, i) => `${PHOTO_MENU}-${String(i + 1).padStart(2, '0')}`), moods: ['warm'], referenceId: 'ref-1', lengthSec: 15, locale: 'ko' });
    expect(win().getByRole('heading', { name: '영상을 만들고 있어요' })).toBeInTheDocument();
    const current = () => document.querySelector('.pv-stage[data-state="current"]')?.getAttribute('data-stage');
    expect(current()).toBe('look');
    expect(win().getByText('5장 살펴보는 중')).toBeInTheDocument();
    expect(within(widget()).getByText('15초 · 사진 5장')).toBeInTheDocument();
    // no timetable: time alone never moves the step
    await flush(5000);
    expect(current()).toBe('look');
    expect(win().getByText('5초 지났어요')).toBeInTheDocument();
    server.advance();
    await flush(1000);
    expect(current()).toBe('story');
    expect(within(widget()).getByText('이야기 짜기')).toBeInTheDocument();
    // close the window: the watcher keeps going without it
    view.unmount();
    server.advance();
    await flush(1000);
    expect(modelOf(store, 'promo-video').current?.stage).toBe('scenes');
    both(store);
    expect(win().getByRole('heading', { name: '영상을 만들고 있어요' })).toBeInTheDocument();
    expect(current()).toBe('scenes');
    server.advance();
    await flush(1000);
    server.advance();
    await flush(1000);
    expect(win().getByRole('heading', { name: '영상이 완성됐어요' })).toBeInTheDocument();
    expect(within(widget()).getByText('영상 1편 완성 · 15초')).toBeInTheDocument();
    expect(within(widget()).getByRole('button', { name: '영상 보기, AI 홍보 영상' })).toBeInTheDocument();
    expect(win().getByText('음악: Cozy Puzzle In-Game 3 · 무료 기본 음원')).toBeInTheDocument();
    const video = document.querySelector('video.pv-player__video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/api/promo/jobs/pj-000000000001/video.mp4');
    expect(video.autoplay).toBe(false);
    expect(win().getByRole('group', { name: '15초 세로 영상, 마지막 장면에 가게 이름과 위치' })).toBeInTheDocument();
  });
  it('[저장하기] downloads the real file and does not change any number; [올렸어요] waits for a place; a clip post adds the public codes (AC-337·345·346)', async () => {
    const store = newStore();
    const { host } = both(store);
    await fill(5);
    press(makeButton());
    await flush();
    for (let i = 0; i < 4; i += 1) { server.advance(); await flush(1000); }
    const clicks: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(`${this.getAttribute('href')} ${this.download}`); });
    const clip = () => modelOf(store, 'marketing-performance').routes.find((r) => r.route === 'clip')!.issued;
    const clipBefore = clip();
    const couponRows = () => modelOf(store, 'coupon-status').rows;
    const rowsBefore = couponRows();
    const videoCouponId = () => store.getSnapshot().tables.marketing.couponCode.find((c) => c.route === 'clip' && c.videoId)?.couponId;
    expect(videoCouponId()).toBeUndefined();
    press(win().getByRole('button', { name: '저장하기' }));
    await flush();
    expect(clicks).toEqual(['/api/promo/jobs/pj-000000000001/video.mp4?download=1 미학당-20261110-1.mp4']);
    expect(win().getByText('미학당-20261110-1.mp4')).toBeInTheDocument();
    expect(win().getByText('저장했어요')).toBeInTheDocument();
    expect(host.notify).toHaveBeenCalledWith({ kind: 'success', messageKey: 'data.marketing.notice.saveStarted' });
    expect(clip()).toBe(clipBefore);
    spy.mockRestore();
    const posted = win().getByRole('button', { name: '올렸다고 표시하기' });
    expect(posted).toBeDisabled();
    expect(win().getByText('올릴 곳을 먼저 골라 주세요')).toBeInTheDocument();
    press(win().getByRole('radio', { name: '릴스' }));
    press(win().getByRole('radio', { name: '클립' }));
    expect(win().getAllByRole('radio', { checked: true })).toHaveLength(1);
    expect(posted).toBeEnabled();
    press(posted);
    expect(win().getByText('1편 · 클립에 올림 · 쿠폰 코드 세는 중')).toBeInTheDocument();
    expect(within(widget()).getByText('클립에 올림 · 쿠폰 코드 세는 중')).toBeInTheDocument();
    expect(within(widget()).getByRole('button', { name: '새 영상 만들기, AI 홍보 영상' })).toBeInTheDocument();
    // posting to the clip adds the public codes (PUBLIC_ISSUE_LIMIT) to the clip route and to the coupon they belong to; no use is added
    expect(clip()).toBe(clipBefore + PUBLIC_ISSUE_LIMIT);
    const couponBefore = rowsBefore.find((r) => r.couponId === videoCouponId())!;
    expect(couponRows().find((r) => r.couponId === videoCouponId())).toMatchObject({ issued: couponBefore.issued + PUBLIC_ISSUE_LIMIT, used: couponBefore.used });
  });
  it('[새 영상 만들기] starts empty; a shorts post makes 2편 · 쇼츠에 올림 and the clip route keeps its number (AC-347)', async () => {
    const store = newStore();
    both(store);
    const clipOf = () => modelOf(store, 'marketing-performance').routes.find((r) => r.route === 'clip')!.issued;
    const clipBefore = clipOf();
    const run = async (place: string) => {
      await fill(5);
      press(makeButton());
      await flush();
      for (let i = 0; i < 4; i += 1) { server.advance(); await flush(1000); }
      press(win().getByRole('radio', { name: place }));
      press(win().getByRole('button', { name: '올렸다고 표시하기' }));
    };
    await run('클립');
    expect(win().getAllByRole('button', { name: '새 영상 만들기' })).toHaveLength(1);
    expect(document.querySelector('[data-slot="promo-video.footer"] button')).toHaveTextContent('새 영상 만들기');
    expect(document.body).not.toHaveTextContent('가짜 데이터');
    press(win().getByRole('button', { name: '새 영상 만들기' }));
    expect(win().getByText('0장 골랐어요 · 5장 이상')).toBeInTheDocument();
    expect(win().queryAllByRole('checkbox', { checked: true })).toHaveLength(0);
    await run('쇼츠');
    expect(within(widget()).getByText('2')).toBeInTheDocument();
    expect(within(widget()).getByText('쇼츠에 올림')).toBeInTheDocument();
    expect(clipOf()).toBe(clipBefore + PUBLIC_ISSUE_LIMIT); // only the clip post added codes, the shorts post did not
  });
});

describe('failure (AC-342)', () => {
  it('a server failure shows the reason in the window and the widget, keeps every choice, and 다시 만들기 retries the same input', async () => {
    const store = newStore();
    both(store);
    await fill(5);
    press(makeButton());
    await flush();
    server.advance();
    await flush(1000);
    server.fail('CODE_CHECK_FAILED');
    await flush(1000);
    expect(win().getByRole('alert')).toHaveTextContent('영상을 만들지 못했어요장면을 만들다 문제가 생겼어요. 다시 만들어 주세요. 고른 내용은 그대로 있어요');
    expect(win().getAllByRole('button', { name: '다시 만들기' })).toHaveLength(1);
    expect(win().getByRole('button', { name: '닫기' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('가짜 데이터');
    expect(within(widget()).getByText('만들지 못했어요')).toBeInTheDocument();
    expect(within(widget()).getByText('장면을 만들다 문제가 생겼어요')).toBeInTheDocument();
    expect(modelOf(store, 'promo-video').postedCount).toBe(0);
    expect(win().getByRole('button', { name: '다시 만들기' })).toHaveFocus();
    press(win().getByRole('button', { name: '다시 만들기' }));
    await flush();
    const retry = server.calls.find((c) => c.path.endsWith('/retry'));
    expect(retry?.path).toBe('/api/promo/jobs/pj-000000000001/retry');
    expect(win().getByRole('heading', { name: '영상을 만들고 있어요' })).toBeInTheDocument();
    const row = store.getSnapshot().tables.marketing.promoVideo[0];
    expect(row).toMatchObject({ status: 'making', jobId: 'pj-000000000002', retryCount: 1 });
    expect(row.input.photoIds).toHaveLength(5);
  });
  it('closing a failure returns to the retained choices on reopening', async () => {
    const store = newStore();
    const view = both(store);
    await fill(5);
    server.startStatus = 500;
    press(makeButton());
    await flush();
    press(win().getByRole('button', { name: '닫기' }));
    view.unmount();
    both(store);
    await flush();
    expect(win().getByRole('radio', { name: '15초' })).toHaveAttribute('aria-checked', 'true');
    tab(0);
    expect(win().getAllByRole('checkbox', { name: tilesOf(PM) }).filter((e) => e.getAttribute('aria-checked') === 'true')).toHaveLength(5);
  });
  it('maps start errors and lost jobs: 409 BUSY, unknown job → CANCELLED_BY_RESTART, five network errors → AI_UNAVAILABLE', async () => {
    server.startStatus = 409;
    let store = newStore();
    let view = both(store);
    await fill(5);
    press(makeButton());
    await flush();
    expect(win().getByRole('alert')).toHaveTextContent('다른 영상을 만드는 중이에요');
    view.unmount();
    server.startStatus = 202;
    store = newStore();
    view = both(store);
    await fill(5);
    press(makeButton());
    await flush();
    server.job = null;
    await flush(1000);
    expect(win().getByRole('alert')).toHaveTextContent('앱이 다시 시작돼서 만들기가 멈췄어요');
    view.unmount();
    store = newStore();
    both(store);
    await fill(5);
    press(makeButton());
    await flush();
    server.down = true;
    for (let i = 0; i < MAX_NETWORK_ERRORS; i += 1) await flush(1000);
    expect(win().getByRole('alert')).toHaveTextContent('AI에 연결하지 못했어요');
  });
});

describe('fixed bar (D-87d)', () => {
  it('[이전] and [다음]/[영상 만들기] keep one screen position on ①→②→③→④ and the bar keeps its height', async () => {
    both(newStore());
    await fill(5);
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    const prevBtn = () => win().getByRole('button', { name: '이전' });
    const main = () => document.querySelector('.pv-footbar .pv-make') as HTMLElement;
    const bar = () => document.querySelector('.pv-footbar') as HTMLElement;
    const seen: { prev: number[]; main: number[]; bar: number[] }[] = [];
    for (const n of [1, 2, 3]) { tab(n); await flush(); seen.push({ prev: rect(prevBtn()), main: rect(main()), bar: rect(bar()) }); }
    for (const s of seen) { expect(s.prev).toEqual(seen[0].prev); expect(s.main).toEqual(seen[0].main); expect(s.bar).toEqual(seen[0].bar); }
    expect(win().getByRole('button', { name: '이전' })).toBeEnabled();
    tab(0);
    expect(win().queryByRole('button', { name: '이전' })).toBeNull();
  });
});

describe('step moves [이전]·[다음] (D-84)', () => {
  const next = () => win().getByRole('button', { name: '다음' });
  const prev = () => win().getByRole('button', { name: '이전' });
  it('step ① has no reason line: the photo count line is the one place and describes the disabled [다음]; ②~④ keep the reason beside the button', async () => {
    both(newStore());
    await flush();
    const count = () => document.querySelector('[data-slot="promo-video.photo-count"]') as HTMLElement;
    const reasonLine = () => document.querySelector('[data-slot="promo-video.reason"]') as HTMLElement;
    expect(win().queryByText('메뉴를 하나 골라 주세요')).toBeNull();
    expect(reasonLine().textContent).toBe('');
    expect(next()).toBeDisabled();
    expect(count().id).not.toBe('');
    expect(next()).toHaveAttribute('aria-describedby', count().id);
    expect(next()).toHaveAccessibleDescription(/^0장 골랐어요\s·\s5장 이상$/);
    press(win().getByRole('checkbox', { name: chip(PM) }));
    const tiles = win().getAllByRole('checkbox', { name: tilesOf(PM) });
    tiles.slice(0, 3).forEach(press);
    expect(win().queryByText('사진을 5장 이상 골라 주세요')).toBeNull();
    expect(reasonLine().textContent).toBe('');
    expect(next()).toBeDisabled();
    expect(next()).toHaveAccessibleDescription(/^3장 골랐어요\s·\s5장 이상$/);

    tiles.slice(3, 5).forEach(press);
    expect(next()).toBeEnabled();
    expect(win().queryByText('사진을 5장 이상 골라 주세요')).toBeNull();
    expect(server.calls.every(call => call.method === 'GET')).toBe(true);
    // ② keeps the SCR-51 reason line, tied to the button by aria-describedby
    press(next());
    const reason = win().getByText('분위기와 주제를 하나 이상 골라 주세요');
    expect(reason).toHaveClass('pv-footer__reason');
    expect(next()).toHaveAttribute('aria-describedby', reason.id);
  });
  it('has no extra multi-select hint line (SCR-52·53: one line of guidance per step): the tabs are followed directly by the step body', async () => {
    both(newStore());
    await flush();
    const tabs = win().getByRole('tablist');
    for (const step of [0, 1, 2, 3]) {
      tab(step);
      expect(win().queryByText('여러 개 고를 수 있어요')).toBeNull();
      expect(tabs.nextElementSibling).toHaveClass('pv-body');
    }
  });
  it('[다음] is enabled only when the step is filled, with the step reason; ④ shows [이전] + [영상 만들기]', async () => {
    both(newStore());
    expect(win().queryByRole('button', { name: '이전' })).toBeNull();
    expect(next()).toBeDisabled();
    expect(win().getAllByText(/사진을 5장 이상 골라 주세요|0장 골랐어요/).length).toBeGreaterThan(0);
    press(win().getByRole('checkbox', { name: chip(PM) }));
    const tiles = win().getAllByRole('checkbox', { name: tilesOf(PM) });
    for (let i = 0; i < 4; i += 1) press(tiles[i]);
    expect(next()).toBeDisabled();
    press(tiles[4]);
    expect(next()).toBeEnabled();
    press(next());
    expect(win().getByRole('tab', { selected: true })).toHaveAccessibleName(/2\. 분위기·주제/);
    expect(document.activeElement).toHaveTextContent('분위기·주제');
    expect(prev()).toBeEnabled();
    expect(next()).toBeDisabled();
    expect(win().getByText('분위기와 주제를 하나 이상 골라 주세요')).toBeInTheDocument();
    press(win().getByRole('checkbox', { name: '따뜻한' }));
    expect(next()).toBeDisabled();
    press(win().getByRole('checkbox', { name: '매장 소개' }));
    expect(next()).toBeEnabled();
    (document.querySelector('.pv-body') as HTMLElement).scrollTop = 80;
    press(next());
    await flush();
    expect(win().getByRole('tab', { selected: true })).toHaveAccessibleName(/3\. /);
    expect((document.querySelector('.pv-body') as HTMLElement).scrollTop).toBe(0);
    expect(next()).toBeDisabled();
    expect(win().getByText('디자인을 하나 골라 주세요')).toBeInTheDocument();
    press(win().getByRole('radio', { name: /단톡방 대화 \+ 남은 수량 카운트다운/ }));
    press(next());
    expect(win().queryByRole('button', { name: '다음' })).toBeNull();
    expect(makeButton()).toBeDisabled();
    press(win().getByRole('radio', { name: '15초' }));
    expect(makeButton()).toBeEnabled();
    press(prev());
    expect(win().getByRole('tab', { selected: true })).toHaveAccessibleName(/3\. /);
  });
  it('tabs still jump directly', () => {
    both(newStore());
    tab(2);
    expect(win().getByRole('tab', { selected: true })).toHaveAccessibleName(/3\. /);
    expect(prev()).toBeInTheDocument();
  });
});

describe('choices survive closing; reduced motion; keys (AC-343·348·349)', () => {
  it('closing while choosing keeps the draft for the run and the widget stays 만들기 전', async () => {
    const store = newStore();
    const view = both(store);
    await fill(5);
    view.unmount();
    both(store);
    expect(within(widget()).getByText(`사진 ${PHOTOS}장`)).toBeInTheDocument();
    tab(0);
    expect(win().getByText('5장 골랐어요 · 5장 이상')).toBeInTheDocument();
  });
  it('reduced motion marks the window and shows posters only; pressing still chooses', async () => {
    both(newStore(), { reducedMotion: true });
    expect(document.querySelector('.pv-win')).toHaveAttribute('data-reduced', 'true');
    tab(2);
    await flush();
    expect(document.querySelectorAll('.pv-ref__video')).toHaveLength(0);
    expect(document.querySelectorAll('.pv-ref__img')).toHaveLength(6);
    press(win().getByRole('radio', { name: '디자인 2번' }));
    expect(win().getAllByRole('radio', { checked: true })).toHaveLength(1);
  });
  it('every promo.* and widget.promo-video.* key used in this folder has a Korean value', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const used = new Set<string>();
    for (const file of readdirSync(here).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))) {
      for (const m of readFileSync(join(here, file), 'utf8').matchAll(/['`]((?:promo|widget\.promo-video)\.[\w.-]+)['`]/g)) used.add(m[1]);
    }
    for (const reason of ['AI_UNAVAILABLE', 'AI_TIMEOUT', 'AI_BAD_OUTPUT', 'CAPTION_TOO_LONG', 'RENDER_FAILED', 'ENCODE_FAILED', 'CODE_CHECK_FAILED', 'TOOL_MISSING', 'BUSY', 'CANCELLED_BY_RESTART']) used.add(`promo.fail.${reason}`);
    for (const s of ['look', 'story', 'scenes', 'merge']) used.add(`promo.stage.${s}`);
    for (const p of ['clip', 'reels', 'shorts']) used.add(`promo.place.${p}`);
    for (let i = 1; i <= 6; i += 1) used.add(`promo.ref.ref-${i}.name`);
    // commands and the widget name (common widget-names bundle) are not this folder's messages
    for (const k of ['promo.syncCatalog', 'promo.addPhoto', 'promo.saveDraft', 'promo.publishPlaceNews', 'promo.publishClip', 'promo.attestLink', 'widget.promo-video.title']) used.delete(k);
    const missing = [...used].filter((k) => !k.endsWith('.') && !mktPromoBundle.ko[k] && !promoRealBundle.ko[k]);
    expect(missing).toEqual([]);
  });
});

it('D231 starts with neutral photo count and no previous button', async () => {
  both(newStore());
  await flush();
  expect(win().queryByRole('button', { name: '이전' })).toBeNull();
  expect(document.querySelector('[data-slot="promo-video.photo-count"]')).not.toContainHTML('ui-icon--warning');
  expect(win().getByRole('tab', { name: /2\. 분위기·주제/ })).toBeInTheDocument();
});
