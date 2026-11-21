import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, selectMenus } from '../../../data/widget-data';
import { MenuDetail, MenuPanel } from './menu';

const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const common = { featureId: 'menu' as const, condition: { kind: 'default' as const }, host };
const menuGridStyles = ['src/ui/mastermanage.css', 'src/features/widgets/mgmt-products/pos-menu.css']
  .map(path => readFileSync(path, 'utf8')).join('\n');
afterEach(cleanup);
/** The 안숭잘부 카페 menus the widget itself reads (24 on the demo day), so counts and prices are never retyped here. */
const cafeMenus = () => selectMenus(createWidgetDataStore().getSnapshot(), {}).rows;
it('renders built-in thumbnails and a readable empty photo state', () => {
  // DATA-FIX item 2 (877f99a): the cafe seed gives six menus a generated photo from /menu-photos/ (photo value 내 사진) and the other 18 the agreed empty state (the words 사진 없음), never an image.
  renderWithKit(<MenuDetail {...common} detailRef={{ featureId: 'menu' }} />);
  expect(screen.getAllByRole('gridcell', { name: /, 메뉴 사진,/ })).toHaveLength(cafeMenus().length);
  const photoCells = screen.getAllByRole('gridcell', { name: /, 메뉴 사진, 내 사진/ });
  const emptyCells = screen.getAllByRole('gridcell', { name: /, 메뉴 사진, 사진 없음/ });
  expect(photoCells).toHaveLength(6);
  expect(emptyCells).toHaveLength(18);
  for (const cell of photoCells) {
    expect(cell).toHaveAccessibleName(/, 메뉴 사진, 내 사진/);
    expect(cell.querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^\/menu-photos\//));
    expect(cell).not.toHaveTextContent('사진 없음');
  }
  for (const cell of emptyCells) {
    expect(cell).toHaveAccessibleName(/, 메뉴 사진, 사진 없음/);
    expect(cell).toHaveTextContent('사진 없음');
    expect(cell.querySelector('img, svg')).toBeNull();
  }
  cleanup();

  // A menu with a built-in picture shows its thumbnail; the 18 menus without one keep the empty state.
  const store = createWidgetDataStore();
  expect(store.dispatch({ type: 'menu.setPhoto', menuId: 'm-americano', photoKey: 'menu-photo-01' }).ok).toBe(true);
  renderWithKit(<MenuDetail {...common} detailRef={{ featureId: 'menu' }} />, { store });
  const photo = screen.getByRole('gridcell', { name: /^아메리카노, 메뉴 사진, 뜨거운 컵 그림/ });
  expect(photo.querySelector('[data-size="thumbnail"] svg')).toBeInTheDocument();
  expect(photo.querySelector('img')).toBeNull();
  expect(screen.getAllByRole('gridcell', { name: /, 메뉴 사진, 사진 없음/ })).toHaveLength(18);
});

it('uses a fixed seed-sized menu name track', () => {
  renderWithKit(<MenuDetail {...common} detailRef={{ featureId: 'menu' }} />);
  const table = screen.getByRole('grid', { name: '메뉴 목록' });
  expect(table.style.getPropertyValue('--data-grid-columns')).toMatch(/^264px /);
});

it('validates, adds, replaces and removes a local photo from the detail panel', async () => {
  const user = userEvent.setup({ applyAccept: false });
  const store = createWidgetDataStore();
  const notify = vi.fn();
  const { container } = renderWithKit(<MenuDetail {...common} host={{ ...host, notify }} detailRef={{ featureId: 'menu', itemId: 'm-americano' }} />, { store, reducedMotion: true });
  const section = within(screen.getByRole('region', { name: '메뉴 사진' }));
  const upload = section.getByRole('button', { name: '사진 바꾸기' });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(input).toHaveAttribute('accept', 'image/*');
  const before = store.getSnapshot();
  await user.upload(input, new File(['text'], 'menu.txt', { type: 'text/plain' }));
  expect(section.getByRole('alert')).toHaveTextContent('PNG, JPEG 또는 WebP 사진을 골라 주세요');
  await user.upload(input, new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }));
  expect(section.getByRole('alert')).toHaveTextContent('5MB 이하 사진을 골라 주세요');
  expect(store.getSnapshot()).toBe(before);
  expect(notify).not.toHaveBeenCalled();

  const customPhotoUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const closeBitmap = vi.fn();
  const drawImage = vi.fn();
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(customPhotoUrl);
  const previousDecoder = globalThis.createImageBitmap;
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValueOnce(new Error('Invalid image')).mockResolvedValue({ width: 1280, height: 640, close: closeBitmap }));
  try {
    const file = new File(['photo'], 'menu.webp', { type: 'image/webp' });
    await user.upload(input, file);
    expect(await section.findByRole('alert')).toHaveTextContent('사진을 열 수 없어요. 다른 사진을 골라 주세요');
    expect(store.getSnapshot()).toBe(before);
    await user.upload(input, file);
    const photoCell = await screen.findByRole('gridcell', { name: /^아메리카노, 메뉴 사진, 내 사진/ });
    expect(section.queryByRole('alert')).not.toBeInTheDocument();
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 256);
    expect(closeBitmap).toHaveBeenCalledOnce();
    expect(section.getByRole('button', { name: '사진 바꾸기' })).toBe(upload);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({
      params: { message: '메뉴 사진을 바꿨어요' }, undoToken: expect.any(String),
    }));
    expect(photoCell.querySelector('img')).toHaveAttribute('src', customPhotoUrl);
    expect(screen.getByRole('region', { name: '메뉴 사진' }).querySelector('img')).toHaveAttribute('src', customPhotoUrl);

    await user.click(section.getByRole('button', { name: '사진 빼기' }));
    expect(section.getByText('사진 없음')).toBeInTheDocument();
    expect(section.queryByRole('button', { name: '사진 빼기' })).not.toBeInTheDocument();
    expect(section.getByRole('button', { name: '사진 올리기' })).toHaveFocus();
    expect(screen.getByRole('gridcell', { name: /^아메리카노, 메뉴 사진, 사진 없음/ })).toBeInTheDocument();
    const notice = notify.mock.lastCall?.[0];
    expect(notice).toMatchObject({ kind: 'success', params: { message: '사진을 뺐어요' }, undoToken: expect.any(String) });
    act(() => { store.undo(notice.undoToken); });
    expect(selectMenus(store.getSnapshot(), {}).rows.find(row => row.menuId === 'm-americano')).toMatchObject({ photoKey: null, customPhotoUrl });
    await user.click(section.getByRole('button', { name: '사진 빼기' }));
    await user.upload(input, file);
    expect(section.getByRole('button', { name: '사진 바꾸기' })).toBeInTheDocument();
  } finally {
    context.mockRestore();
    encode.mockRestore();
    vi.stubGlobal('createImageBitmap', previousDecoder);
  }
});
it('shows the menu count at 125% with reduced motion', () => {
  renderWithKit(<MenuPanel {...common} width={1} height={1} shape="Q" presetId="A" editing={false} />, { textScale: 125, reducedMotion: true });
  expect(screen.getByText('등록한 메뉴')).toBeInTheDocument();
  expect(screen.getByText(String(cafeMenus().length))).toBeInTheDocument();
});
it('opens a menu side panel using the keyboard', async () => {
  renderWithKit(<MenuDetail {...common} detailRef={{ featureId: 'menu' }} />, { reducedMotion: true });
  const cell = screen.getByRole('gridcell', { name: '아메리카노, 메뉴 이름, 아메리카노' });
  act(() => cell.focus());
  await userEvent.keyboard('{Enter}');
  const panel = screen.getByRole('region', { name: '아메리카노' });
  expect(within(panel).getByRole('heading', { name: '아메리카노' })).toHaveFocus();
  expect(cell.closest('tr')).toHaveAttribute('aria-selected', 'true');
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('region', { name: '아메리카노' })).not.toBeInTheDocument();
  expect(cell).toHaveFocus();
});
it('keeps the name column fixed in the menu scroller when the panel is open', async () => {
  const user = userEvent.setup();
  renderWithKit(<><style>{menuGridStyles}</style><MenuDetail {...common} detailRef={{ featureId: 'menu' }} /></>, { textScale: 125, reducedMotion: true });
  const table = screen.getByRole('grid', { name: '메뉴 목록' });
  const scroller = table.parentElement!;
  const name = within(table).getByRole('gridcell', { name: '아메리카노, 메뉴 이름, 아메리카노' });
  const root = table.closest('.menu-management')!;
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1130, 400));
  const bounds = vi.spyOn(table, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1300, 330));
  const closedMask = getComputedStyle(scroller).maskImage;

  await user.click(name);
  expect(screen.getByRole('region', { name: '아메리카노' })).toBeInTheDocument();
  expect(scroller).toHaveClass('ui-data-grid__scroll');
  expect(getComputedStyle(scroller).overflowX).toBe('auto');
  expect(root).toHaveAttribute('data-more-columns');
  expect(getComputedStyle(scroller).maskImage).toContain('linear-gradient');
  for (const first of [within(table).getByRole('columnheader', { name: '메뉴 이름' }), name]) {
    expect(getComputedStyle(first).position).toBe('sticky');
    expect(getComputedStyle(first).left).toMatch(/^0(?:px)?$/);
  }
  const sold = within(scroller).getByRole('gridcell', { name: /^아메리카노, 오늘 판매량,/ });
  const remove = within(scroller).getByRole('button', { name: '아메리카노 지우기' });
  act(() => sold.focus());
  await user.keyboard('{ArrowRight}');
  expect(remove).toHaveFocus();

  bounds.mockReturnValue(new DOMRect(-170, 0, 1300, 330));
  fireEvent.scroll(scroller);
  expect(root).not.toHaveAttribute('data-more-columns');
  expect(getComputedStyle(scroller).maskImage).toBe(closedMask);
  bounds.mockReturnValue(new DOMRect(0, 0, 1300, 330));
  fireEvent.scroll(scroller);
  expect(root).toHaveAttribute('data-more-columns');
  await user.keyboard('{Escape}');
  expect(root).not.toHaveAttribute('data-more-columns');
  expect(getComputedStyle(scroller).maskImage).toBe(closedMask);
});
it('opens the side panel from every read-only row cell', async () => {
  const user = userEvent.setup();
  renderWithKit(<MenuDetail {...common} detailRef={{ featureId: 'menu' }} />, { reducedMotion: true });
  const table = within(screen.getByRole('grid', { name: '메뉴 목록' }));
  const name = table.getByRole('gridcell', { name: '아메리카노, 메뉴 이름, 아메리카노' });
  const row = name.closest('tr')!;
  for (const cell of within(row).getAllByRole('gridcell').slice(0, -1)) {
    expect(cell).toHaveAttribute('aria-readonly', 'true');
    await user.click(cell);
    expect(screen.getByRole('region', { name: '아메리카노' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
  }
  await user.click(row);
  expect(screen.getByRole('region', { name: '아메리카노' })).toBeInTheDocument();
  const latte = table.getByRole('gridcell', { name: '카페라떼, 메뉴 이름, 카페라떼' });
  await user.click(latte);
  expect(screen.getByRole('region', { name: '카페라떼' })).toBeInTheDocument();
  expect(latte).toHaveFocus();
  expect(latte.closest('tr')).toHaveAttribute('aria-selected', 'true');
});
it('edits name, status, category and price in the side panel and reports undo', async () => {
  const { createWidgetDataStore, selectMenus } = await import('../../../data/widget-data');
  const user = userEvent.setup();
  const store = createWidgetDataStore();
  const notify = vi.fn();
  const menu = () => selectMenus(store.getSnapshot(), {}).rows.find(row => row.menuId === 'm-americano');
  const originalPrice = menu()!.price;
  renderWithKit(<MenuDetail {...common} host={{ ...host, notify }} detailRef={{ featureId: 'menu', itemId: 'm-americano' }} />, { store });
  const panel = within(screen.getByRole('region', { name: '아메리카노' }));

  const menuName = panel.getByRole('textbox', { name: '메뉴 이름' });
  await user.clear(menuName);
  await user.type(menuName, '새 아메리카노');
  const revision = store.getSnapshot().revision;
  await user.click(panel.getByRole('button', { name: '메뉴 이름 저장하기' }));
  expect(store.getSnapshot().revision).toBe(revision + 1);
  expect(menu()?.name).toEqual({ raw: '새 아메리카노' });

  await user.click(within(panel.getByRole('radiogroup', { name: '판매 상태' })).getByRole('radio', { name: '품절' }));
  expect(menu()?.saleStatus).toBe('sold_out');
  await user.click(within(panel.getByRole('radiogroup', { name: '분류' })).getByRole('radio', { name: '디저트' }));
  expect(menu()?.category).toBe('dessert');

  const price = panel.getByRole('spinbutton', { name: '판매가' });
  await user.clear(price);
  await user.type(price, '0');
  const before = store.getSnapshot();
  await user.click(panel.getByRole('button', { name: '판매가 저장하기' }));
  expect(panel.getByRole('alert')).toBeInTheDocument();
  expect(store.getSnapshot()).toBe(before);
  await user.clear(price);
  await user.type(price, '4900');
  await user.click(panel.getByRole('button', { name: '판매가 저장하기' }));
  expect(menu()?.price).toBe(4900);
  expect(panel.queryByRole('alert')).not.toBeInTheDocument();
  const successfulNotices = notify.mock.calls.map(([notice]) => notice).filter(notice => notice.kind === 'success');
  expect(successfulNotices.map(notice => notice.undoToken)).toEqual(Array(4).fill(expect.any(String)));
  act(() => { store.undo(successfulNotices.at(-1).undoToken); });
  expect(menu()?.price).toBe(originalPrice);
  expect(price).toHaveValue(originalPrice);
});
it('keeps recipe content compact and frames the real ingredient rows', () => {
  renderWithKit(<><style>{menuGridStyles}</style><MenuDetail {...common} detailRef={{ featureId: 'menu', itemId: 'm-americano' }} /></>);
  const region = screen.getByRole('region', { name: '아메리카노' });
  const panel = within(region);
  const heading = panel.getByRole('heading', { level: 4, name: '레시피' });
  const recipe = panel.getByRole('grid', { name: '레시피' });
  const scroller = recipe.parentElement!;
  expect(getComputedStyle(heading).marginBlock).toMatch(/^0(?:px)?$/);
  expect(within(recipe).getAllByRole('row')).toHaveLength(3);
  expect(getComputedStyle(scroller).minHeight).toMatch(/^0(?:px)?$/);
  expect(getComputedStyle(scroller).borderBottomColor).toBe('rgba(0, 0, 0, 0)');
  expect(getComputedStyle(recipe).borderRadius).toBe('var(--radius-lg)');
  expect(panel.getByText('옵션', { selector: 'summary' }).parentElement).not.toHaveAttribute('open');
  expect(region.firstElementChild).toContainElement(panel.getByRole('button', { name: '닫기' }));
  expect(panel.getByRole('button', { name: '메뉴 지우기' }).closest('.ui-detail-side-panel__body')).toBeInTheDocument();
});
it('left-aligns the computed photo column and keeps numeric columns right-aligned', () => {
  renderWithKit(<><style>{menuGridStyles}</style><MenuDetail {...common} detailRef={{ featureId: 'menu' }} /></>);
  const table = within(screen.getByRole('grid', { name: '메뉴 목록' }));
  const photoHeading = within(table.getByRole('columnheader', { name: '메뉴 사진' })).getByText('메뉴 사진');
  expect(getComputedStyle(photoHeading).textAlign).toBe('left');
  expect(getComputedStyle(photoHeading).justifyContent).toBe('flex-start');
  for (const cell of table.getAllByRole('gridcell', { name: /, 메뉴 사진,/ })) {
    expect(getComputedStyle(cell).textAlign).toBe('left');
    expect(cell).toHaveAttribute('data-kind', 'computed');
  }

  const priceHeading = within(table.getByRole('columnheader', { name: '판매가' })).getByRole('button');
  expect(getComputedStyle(priceHeading).textAlign).toBe('right');
  expect(getComputedStyle(priceHeading).justifyContent).toBe('flex-end');
  expect(getComputedStyle(table.getByRole('gridcell', { name: /^아메리카노, 판매가,/ })).textAlign).toBe('right');
  expect(getComputedStyle(table.getByRole('gridcell', { name: /^아메리카노, 오늘 판매량,/ })).textAlign).toBe('right');
});
it('keeps only trash in the final action column and opens the recipe from the row', async () => {
  const user = userEvent.setup();
  renderWithKit(<><style>{menuGridStyles}</style><MenuDetail {...common} detailRef={{ featureId: 'menu' }} /></>);
  const table = within(screen.getByRole('grid', { name: '메뉴 목록' }));
  const headers = table.getAllByRole('columnheader');
  const actionHeader = headers.at(-1)!;
  expect(headers.at(-2)).toHaveAccessibleName('오늘 판매량');
  expect(actionHeader).toHaveAccessibleName('조작');
  expect(getComputedStyle(within(actionHeader).getByText('조작')).clipPath).toBe('inset(50%)');
  expect(table.queryByRole('button', { name: /레시피 보기/ })).not.toBeInTheDocument();

  const sold = table.getByRole('gridcell', { name: /^아메리카노, 오늘 판매량,/ });
  const row = within(sold.closest('tr')!);
  const actions = row.getAllByRole('gridcell').at(-1)!;
  expect(row.getAllByRole('gridcell').at(-2)).toBe(sold);
  expect(within(sold).queryByRole('button')).not.toBeInTheDocument();
  const remove = within(actions).getByRole('button', { name: '아메리카노 지우기' });
  expect(within(actions).getAllByRole('button')).toEqual([remove]);
  expect(remove.querySelector('svg')).toBeInTheDocument();
  expect(actions).toHaveTextContent(/^$/);

  act(() => sold.focus());
  await user.keyboard('{ArrowRight}');
  expect(remove).toHaveFocus();
  await user.click(sold);
  const panel = screen.getByRole('region', { name: '아메리카노' });
  expect(within(panel).getByRole('grid', { name: '레시피' })).toBeInTheDocument();
});
it('archives a menu from the row action and restores it with the undo token', async () => {
  const { createWidgetDataStore } = await import('../../../data/widget-data');
  const store = createWidgetDataStore();
  renderWithKit(<MenuDetail {...common} detailRef={{ featureId: 'menu' }} />, { store });
  const table = within(screen.getByRole('grid', { name: '메뉴 목록' }));
  const remove = () => table.queryByRole('button', { name: '아메리카노 지우기' });

  await userEvent.click(remove()!);
  expect(remove()).not.toBeInTheDocument();
  const notice = host.notify.mock.calls.at(-1)?.[0];
  expect(notice).toMatchObject({
    kind: 'success', messageKey: 'data.management.notice.menuDeleted', params: { name: '아메리카노' },
  });
  expect(notice?.undoToken).toBeTruthy();
  act(() => { store.undo(notice.undoToken); });
  expect(remove()).toBeInTheDocument();
});
it('saves a recipe quantity and archives a menu with undo', async () => {
  // W2-DATA rule (0bd4036): today's recorded sales keep the recipe they were sold with; the cost and the forecast follow the current recipe.
  const { createWidgetDataStore, selectMenus, deriveUsage, TODAY } = await import('../../../data/widget-data');
  const store=createWidgetDataStore();
  const americano=()=>selectMenus(store.getSnapshot(),{}).rows.find(r=>r.menuId==='m-americano')!;
  const total=selectMenus(store.getSnapshot(),{}).rows.length;
  const beans=americano().recipeLines[0]!;
  const beanName=beans.name as { raw: string };
  const usedBefore=deriveUsage(store.getSnapshot(),{date:TODAY}).byItem[beans.itemId];
  const costBefore=americano().cost!;
  renderWithKit(<MenuDetail {...common} detailRef={{featureId:'menu'}}/>,{store});
  await userEvent.click(screen.getByRole('gridcell',{name:/^아메리카노, 원가,/}));
  await userEvent.click(within(screen.getByRole('grid',{name:'레시피'})).getByRole('gridcell',{name:new RegExp(`^${beanName.raw}, 수량,`)}));
  const amount=screen.getByRole('textbox',{name:`${beanName.raw}, 수량`});
  await userEvent.clear(amount);
  await userEvent.type(amount,'20');
  await userEvent.keyboard('{Enter}');
  expect(americano().recipeLines[0]!.quantity).toBe(20);
  // The recipe is in grams now (cafe base unit) and the sold cups keep the amount they used when sold.
  expect(beans.unit).toBe('g');
  expect(americano().cost!).toBeGreaterThan(costBefore);
  expect(screen.getByText(new RegExp(`${beanName.raw} · 오늘 사용량 ${americano().recipeLines[0]!.usedToday.toLocaleString('ko-KR')}g \\(${americano().soldQty}잔\\)`))).toBeInTheDocument();
  expect(americano().recipeLines[0]!.usedToday).toBe(beans.usedToday);
  expect(screen.getByText(new RegExp(`원가 ${americano().cost!.toLocaleString('ko-KR')}원 · 마진 ${(americano().price-americano().cost!).toLocaleString('ko-KR')}원\\(${americano().rate!.toFixed(1)}%\\)`))).toBeInTheDocument();
  const usage=deriveUsage(store.getSnapshot(),{date:TODAY}).byItem[beans.itemId];
  expect(usage).toBe(usedBefore);
  await userEvent.click(screen.getByRole('button',{name:'메뉴 지우기'}));
  expect(deriveUsage(store.getSnapshot(),{date:TODAY}).byItem[beans.itemId]).toBe(usage);
  expect(selectMenus(store.getSnapshot(),{}).rows).toHaveLength(total-1);
  const notice=host.notify.mock.calls.at(-1)?.[0] as { undoToken?: string };
  expect(notice).toMatchObject({ messageKey: 'data.management.notice.menuDeleted', params: { name: '아메리카노' } });
  expect(notice.undoToken).toBeTruthy();
  store.undo(notice.undoToken!);
  expect(selectMenus(store.getSnapshot(),{}).rows).toHaveLength(total);
});

it('writes amounts with 원, the margin rate with one decimal, and a done-chip on every selling row', () => {
  renderWithKit(<MenuDetail {...common} detailRef={{ featureId: 'menu' }} />);
  const text = (menuId: string, columnId: string) => document.querySelector(`[data-grid-row-id="${menuId}"][data-grid-column-id="${columnId}"]`)!.textContent!.trim();
  for (const row of cafeMenus()) {
    expect(text(row.menuId, 'price')).toBe(`${row.price.toLocaleString('ko-KR')}원`);
    expect(text(row.menuId, 'cost')).toBe(row.cost === null ? '원가 미등록' : `${row.cost.toLocaleString('ko-KR')}원`);
    expect(text(row.menuId, 'rate')).toBe(row.rate === null ? '—' : `${row.rate.toFixed(1)}%`);
    const chip = document.querySelector(`[data-grid-row-id="${row.menuId}"][data-grid-column-id="saleStatus"] .ui-status-chip`)!;
    expect(chip).toHaveAttribute('data-semantic', 'done');
    expect(chip).toHaveTextContent('판매 중');
  }
  expect(document.querySelector('.ui-data-grid__toolbar input')).toHaveAttribute('placeholder', '메뉴 이름으로 찾아보세요');
});

it('shows the panel subtitle, margin summary, Korean units and no primary button (SCR-214, SCR-258)', () => {
  const row = cafeMenus().find(menu => menu.menuId === 'm-cafe-latte')!;
  renderWithKit(<MenuDetail {...common} detailRef={{ featureId: 'menu', itemId: row.menuId }} />);
  const panel = within(screen.getByRole('region', { name: '카페라떼' }));
  expect(panel.getByText(`음료 · ${row.price.toLocaleString('ko-KR')}원`)).toBeInTheDocument();
  expect(panel.getByText(`원가 ${row.cost!.toLocaleString('ko-KR')}원 · 마진 ${(row.price - row.cost!).toLocaleString('ko-KR')}원(${row.rate!.toFixed(1)}%)`)).toBeInTheDocument();
  const region = screen.getByRole('region', { name: '카페라떼' });
  expect(region.textContent).not.toMatch(/pcs|\d\.\d{4,}/);
  for (const line of row.recipeLines) {
    const cell = within(panel.getByRole('grid', { name: '레시피' })).getByRole('gridcell', { name: new RegExp(`^${(line.name as { raw: string }).raw}, 단위,`) });
    expect(cell).toHaveTextContent(line.unit === 'pcs' ? '개' : line.unit);
  }
  // the two save forms are secondary buttons: the panel has no primary (green) button
  expect(region.querySelectorAll('.ui-button--primary')).toHaveLength(0);
  expect(panel.getByRole('button', { name: '메뉴 이름 저장하기' })).toHaveClass('ui-button--secondary');
  expect(panel.getByRole('button', { name: '판매가 저장하기' })).toHaveClass('ui-button--secondary');
});

it('hides columns one at a time beside the side panel in the DS order, keeping 메뉴 이름 and 판매가 (DS 12.1)', () => {
  // jsdom has no layout: stub the table width and the two CSS lengths (조작 column 72, as measured in Chrome).
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const widths = { scroll: 1114 };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).classList?.contains('ui-data-grid__scroll') ? widths.scroll : 0; } });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const expression = this.getAttribute?.('data-grid-length-probe');
    if (expression) return { width: expression.includes('table-action-width') ? 72 : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    return rect.call(this);
  });
  const dropped = () => document.querySelector('.menu-management > .ui-data-grid')?.getAttribute('data-dropped-columns') ?? '';
  const headers = () => [...document.querySelectorAll('.menu-management > .ui-data-grid thead th')].map(th => th.textContent!.trim()).filter(Boolean);
  try {
    // no panel: nothing is hidden, however narrow
    widths.scroll = 400;
    renderWithKit(<><style>{menuGridStyles}</style><MenuDetail {...common} detailRef={{ featureId: 'menu' }} /></>);
    expect(dropped()).toBe('');
    expect(headers()).toEqual(['메뉴 이름', '판매 상태', '메뉴 사진', '분류', '판매가', '원가', '마진율', '오늘 판매량', '조작']);
    cleanup();

    const order: [number, string, string[]][] = [
      [1178, 'photo $actions', ['메뉴 이름', '판매 상태', '분류', '판매가', '원가', '마진율', '오늘 판매량']],
      [1064, 'photo $actions rate', ['메뉴 이름', '판매 상태', '분류', '판매가', '원가', '오늘 판매량']],
      [964, 'photo $actions rate cost', ['메뉴 이름', '판매 상태', '분류', '판매가', '오늘 판매량']],
      [764, 'photo $actions rate cost sold', ['메뉴 이름', '판매 상태', '분류', '판매가']],
      [564, 'photo $actions rate cost sold category', ['메뉴 이름', '판매 상태', '판매가']],
      [464, 'photo $actions rate cost sold category saleStatus', ['메뉴 이름', '판매가']],
      [100, 'photo $actions rate cost sold category saleStatus', ['메뉴 이름', '판매가']],
    ];
    for (const [scroll, expected, expectedHeaders] of order) {
      widths.scroll = scroll;
      renderWithKit(<><style>{menuGridStyles}</style><MenuDetail {...common} detailRef={{ featureId: 'menu', itemId: 'm-americano' }} /></>);
      expect(dropped()).toBe(expected);
      expect(headers()).toEqual(expectedHeaders);
      cleanup();
    }
    // the row tracks follow the shown columns (no hard-coded 9 tracks, no empty track)
    expect(readFileSync('src/features/widgets/mgmt-products/pos-menu.css', 'utf8')).not.toMatch(/\.menu-management[^{}]*\.ui-data-grid__table\s+tr\s*\{[^}]*grid-template-columns/);
  } finally {
    spy.mockRestore();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', descriptor); else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  }
});

// 64 renders of the 24-menu cafe list: about 3-4s on a loaded machine, so it gets its own limit (the assertions are unchanged).
it('renders every menu size in all languages at 125% without losing the primary value or exposing keys',{timeout:30_000},()=>{for(const locale of ['ko','en','zh-Hans','zh-Hant'] as const)for(const width of [1,2,3,4] as const)for(const height of [1,2,3,4] as const){const v=renderWithKit(<MenuPanel {...common} width={width} height={height} shape={width===1&&height===1?'Q':height===1?'W':width===1?'T':width===2&&height===2?'S':'L'} presetId="A" editing={false}/>,{locale,textScale:125,reducedMotion:true});expect(v.container.querySelector('[data-slot="menu.metric.value"]')).toHaveTextContent(String(cafeMenus().length));expect(v.container.textContent).not.toMatch(/widget\.|data\.|common\./);v.unmount();}});
