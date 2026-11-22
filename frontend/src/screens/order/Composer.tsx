import { PosMenuPhoto } from './PosMenuPhoto';
import { selectPosMenu } from '../../pos/menu-projection';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import type { PosCartCommand, PosCartQuote, PosCatalogItem, PosOption, PosOptionGroup, PosOrderType } from '../../contracts/pos';
import { quoteCart } from '../../pos/domain';
import { usePosSession, usePosSnapshot } from '../../pos/react';
import { ActionButton, CategoryChips, CountBadge, ErrorPanel, Icon, MenuPhoto, PosActionButton, PosMoney, PosQuantityStepper, PosSearchField, PosStatusChip, SegmentedControl, Textarea, formatPosMoney, motionTokens, posClasses, posLayoutTokens, posTimeTokens, useSystemPreferences, useUi } from '../../ui';
import { useBundle } from '../../i18n';
import { posBundle } from '../../i18n/messages/pos';
import { OptionSheet } from './OptionSheet';
import { POS_MENU_TABS, posCategoryBundle, posMenuTab } from './categories';
import { activeOptions, choosableGroups, objectParticle, optionCaption, orderedOptions, retainActiveOptions } from './option-text';
import './composer.css';

export interface ComposerNotice { readonly message: string; readonly undoToken?: string }
export interface ComposerProps {
  readonly onCheckout?: () => void;
  readonly onRetryCatalog?: () => void;
  readonly onAddMenu?: () => void;
  /** Shared host maps undoToken to NoticeUndo { target: 'pos', token }; runtime.undo owns undo. */
  readonly onNotice?: (notice: ComposerNotice) => void;
  readonly heading?: ReactNode;
  readonly context?: ReactNode;
  readonly headerAction?: ReactNode;
  readonly beforeAction?: ReactNode;
  readonly checkoutLabel?: string;
  readonly checkoutWithoutCart?: boolean;
  readonly checkoutBlockedReason?: string;
  readonly summaryQuote?: Pick<PosCartQuote, 'totalQty' | 'gross' | 'discount' | 'payable'>;
}
type Draft = { item: PosCatalogItem; lineId?: string; selected: string[]; request: string };
type CartInput = PosCartCommand extends infer C ? C extends PosCartCommand ? Omit<C, 'meta'> : never : never;
type LineTarget = { lineId: string | null; target: number };
type FocusTarget = LineTarget | 'menu';
const reasonText = (reason: string) => ({ EMPTY_CART: '메뉴를 담아 주세요', DATA_UNAVAILABLE: '메뉴를 불러온 뒤 결제할 수 있어요', SOLD_OUT: '품절된 메뉴가 담겨 있어요', ITEM_REMOVED: '지운 메뉴가 담겨 있어요', DAY_CLOSED: '오늘 마감했어요. 마감을 되돌리면 다시 결제할 수 있어요', QTY_LIMIT: '99개까지 담을 수 있어요', BILL_LOCKED: '결제 중에는 주문을 고칠 수 없어요', REQUIRED_OPTION: '필수 옵션을 골라 주세요' } as Record<string, string>)[reason] ?? '주문을 바꾸지 못했어요. 다시 시도해 주세요';

/** Keep only the departing presentation for M-241; quotes already reflect removal. */
function CartLine({ id, label, highlighted, reducedMotion, children }: {
  id: string; label: string; highlighted: boolean; reducedMotion: boolean; children: ReactNode;
}) {
  const present = useIsPresent();
  return <motion.div role="listitem" aria-label={label} data-line-id={id}
    aria-hidden={!present || undefined} inert={!present || undefined} data-exiting={!present}
    data-highlighted={highlighted} className={`${posClasses.orderLine} order-composer__line`}
    initial={reducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    transition={{ duration: reducedMotion ? 0 : motionTokens.duration[present ? 'cartIn' : 'cartOut'] / 1000, ease: motionTokens.ease.out }}>
    {children}
  </motion.div>;
}

export function Composer({ onCheckout, onRetryCatalog, onAddMenu, onNotice, heading, context, headerAction, beforeAction, checkoutLabel = '결제하기', checkoutWithoutCart = false, checkoutBlockedReason, summaryQuote }: ComposerProps) {
  const { t } = useBundle(posBundle, posCategoryBundle);
  const issueText = (reason: string) => reason === 'INVALID_OPTION' ? t('pos.invalidOptionCaption') : reasonText(reason);
  const runtime = usePosSession();
  const read = usePosSnapshot();
  const ui = useUi();
  const system = useSystemPreferences();
  const reducedMotion = ui.reducedMotion || system.reducedMotion;
  const quote = quoteCart(read);
  const summary = summaryQuote ?? quote;
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [requestLimit, setRequestLimit] = useState(false);
  const [memoOpen, setMemoOpen] = useState(false);
  const [memo, setMemo] = useState('');
  const [memoLimit, setMemoLimit] = useState(false);
  const [highlight, setHighlight] = useState<readonly string[]>([]);
  const [gridIndex, setGridIndex] = useState(0);
  const [lineTarget, setLineTarget] = useState<LineTarget>({ lineId: null, target: 0 });
  const serial = useRef(0);
  const instance = useId();
  const opener = useRef<HTMLElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const linesRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLElement | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeFrame = useRef<number | undefined>(undefined);
  const scrollFrame = useRef<number | undefined>(undefined);
  const pendingFocus = useRef<FocusTarget | null>(null);
  const undoFocus = useRef<{ token: string; focus: FocusTarget } | null>(null);
  const previousRead = useRef(read);
  useEffect(() => () => {
    clearTimeout(highlightTimer.current);
    if (noticeFrame.current !== undefined) cancelAnimationFrame(noticeFrame.current);
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
  }, []);
  // D-353: five fixed tabs (전체·커피·티·음료·디저트); legacy `drink` is 음료. Filtering is by tab, not by the raw catalog category.
  const allMenu = selectPosMenu(read, 'all');
  const catalog = { ...allMenu, items: allMenu.items.filter(item => (category === 'all' || posMenuTab(item.category) === category) && item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) };
  const announce = (message: string, undoToken?: string) => {
    if (noticeFrame.current !== undefined) cancelAnimationFrame(noticeFrame.current);
    noticeFrame.current = undefined;
    onNotice?.({ message, undoToken });
  };
  const highlightLines = useCallback((ids: readonly string[]) => {
    setHighlight(ids);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight([]), posTimeTokens.cartHighlightMs);
  }, []);
  const rowElement = useCallback((lineId: string | null) =>
    Array.from(linesRef.current?.querySelectorAll<HTMLElement>('[data-line-id]') ?? []).find(row => row.dataset.lineId === lineId && row.dataset.exiting !== 'true'), []);
  const focusElement = useCallback((focus: FocusTarget) => {
    if (focus !== 'menu') {
      const buttons = Array.from(rowElement(focus.lineId)?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const index = buttons[focus.target] && !buttons[focus.target].disabled ? focus.target : buttons[1] && !buttons[1].disabled ? 1 : buttons.findIndex(button => !button.disabled);
      if (index >= 0) return { element: buttons[index], focus: { lineId: focus.lineId, target: index } };
    }
    return { element: grid.current?.querySelector<HTMLButtonElement>('[data-menu-card][tabindex="0"]') ?? menuRef.current?.querySelector<HTMLInputElement>('input'), focus: null };
  }, [rowElement]);

  // Undo comes from the shell, so synchronize its focus and presentation here.
  useLayoutEffect(() => {
    const previous = previousRead.current;
    previousRead.current = read;
    const saved = undoFocus.current;
    if (saved && previous.posUi.cartUndo?.token === saved.token && read.posUi.cartUndo === null && read.pos.cart.lines === previous.posUi.cartUndo.before.lines) {
      pendingFocus.current = saved.focus;
      undoFocus.current = null;
      highlightLines(quote.lines.filter(line => previous.pos.cart.lines.find(old => old.lineId === line.lineId) !== read.pos.cart.lines.find(current => current.lineId === line.lineId)).map(line => line.lineId));
    }
    if (!dialogOpen && pendingFocus.current) {
      const { element, focus } = focusElement(pendingFocus.current);
      pendingFocus.current = null;
      if (focus) setLineTarget(focus);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    }
    // Native disabled [+] at 99 must not strand keyboard focus outside the list.
    const active = document.activeElement;
    if (!dialogOpen && active instanceof HTMLButtonElement && active.disabled && linesRef.current?.contains(active)) {
      const row = active.closest<HTMLElement>('[data-line-id]');
      const { element, focus } = focusElement({ lineId: row?.dataset.lineId ?? null, target: 1 });
      if (focus) setLineTarget(focus);
      element?.focus({ preventScroll: true });
    }
  }, [read, quote, dialogOpen, focusElement, highlightLines]);
  const dispatch = (input: CartInput, message?: string) => {
    const current = runtime.read();
    const result = runtime.execute({ ...input, meta: { runId: current.runId, idempotencyKey: `composer-${instance}-${++serial.current}` } } as PosCartCommand);
    if (!result.ok) { announce(result.reason === 'INVALID_OPTION' ? t('pos.invalidOptionNotice') : reasonText(result.reason)); return false; }
    if (result.status === 'applied') {
      if (noticeFrame.current !== undefined) cancelAnimationFrame(noticeFrame.current);
      noticeFrame.current = undefined;
      const next = runtime.read();
      const removed = current.pos.cart.lines.filter(line => !next.pos.cart.lines.some(after => after.lineId === line.lineId));
      const changed = next.pos.cart.lines.find(line => current.pos.cart.lines.find(before => before.lineId === line.lineId) !== line);
      const beforeFocus = input.type === 'cart.remove' || input.type === 'cart.quantity' ? { lineId: input.lineId, target: lineTarget.target } : { ...lineTarget, lineId: lineTarget.lineId ?? current.pos.cart.lines[0]?.lineId ?? null };
      if (result.undoToken) undoFocus.current = { token: result.undoToken, focus: beforeFocus.lineId ? beforeFocus : 'menu' };
      if (removed.length || input.type === 'cart.clear') {
        const index = current.pos.cart.lines.findIndex(line => line.lineId === removed[0]?.lineId);
        const survivor = changed ?? next.pos.cart.lines[Math.min(Math.max(index, 0), next.pos.cart.lines.length - 1)];
        pendingFocus.current = survivor ? { lineId: survivor.lineId, target: beforeFocus.target } : 'menu';
        // Base UI also needs a live finalFocus when the edited line disappeared.
        if (dialogOpen) opener.current = focusElement(pendingFocus.current).element ?? null;
      } else if (input.type === 'cart.quantity' && input.qty >= posLayoutTokens.common.quantityMax && beforeFocus.target === 2) {
        pendingFocus.current = { lineId: input.lineId, target: 1 };
      }
      if (changed && (input.type === 'cart.add' || input.type === 'cart.replaceOptions')) {
        highlightLines([changed.lineId]);
        if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = requestAnimationFrame(() => rowElement(changed.lineId)?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' }));
      }
      if (message) announce(message, result.undoToken);
      else if (changed && ['cart.add', 'cart.quantity', 'cart.replaceOptions'].includes(input.type)) {
        // One polite result for a burst of adds; no independent local toast/live region.
        if (noticeFrame.current !== undefined) cancelAnimationFrame(noticeFrame.current);
        const name = quoteCart(next).lines.find(line => line.lineId === changed.lineId)?.name ?? '';
        noticeFrame.current = requestAnimationFrame(() => { noticeFrame.current = undefined; onNotice?.({ message: `${name} ${changed.qty}개`, undoToken: result.undoToken }); });
      }
    }
    return true;
  };
  const openItem = (item: PosCatalogItem, button: HTMLButtonElement, lineId?: string) => {
    if (read.pos.cart.lock) { announce(reasonText('BILL_LOCKED')); return; }
    if (item.saleStatus === 'sold_out' && !lineId) { announce(`${item.name}은 품절이에요`); return; }
    const line = read.pos.cart.lines.find(l => l.lineId === lineId);
    if (!lineId && !choosableGroups(item).length && !item.groups.some(group => group.required)) {
      dispatch({ type: 'cart.add', menuId: item.menuId, optionIds: [] });
      return;
    }
    opener.current = button; setRequestLimit(false);
    setDraft({ item, lineId, selected: retainActiveOptions(item, line?.selectedOptionIds), request: line?.request ?? '' }); setDialogOpen(true);
  };
  const choose = (group: PosOptionGroup, option: PosOption) => {
    if (!draft) return;
    const groupIds = group.options.map(candidate => candidate.optionId);
    const chosen = draft.selected.includes(option.optionId);
    setDraft({ ...draft, selected: group.required ? [...draft.selected.filter(id => !groupIds.includes(id)), option.optionId] : chosen ? draft.selected.filter(id => id !== option.optionId) : [...draft.selected, option.optionId] });
  };
  const missingGroups = draft?.item.groups.filter(group =>
    group.required && !activeOptions(group).some(option => draft.selected.includes(option.optionId)),
  ) ?? [];
  const submitDraft = () => {
    if (!draft || missingGroups.length) return;
    const command: CartInput = draft.lineId ? { type: 'cart.replaceOptions', lineId: draft.lineId, optionIds: draft.selected, request: draft.request } : { type: 'cart.add', menuId: draft.item.menuId, optionIds: draft.selected };
    if (dispatch(command)) setDialogOpen(false);
  };
  const preview = draft ? quoteCart({ ...read, pos: { ...read.pos, cart: { ...read.pos.cart, lines: [{ lineId: 'preview', menuId: draft.item.menuId, selectedOptionIds: draft.selected, qty: 1, request: draft.request }] } } }) : null;
  const previewLine = preview?.lines[0];
  const checkoutReason = checkoutBlockedReason ?? (!quote.canSubmit && !(checkoutWithoutCart && !quote.lines.length) ? issueText(quote.issues[0]?.reason ?? 'EMPTY_CART') : undefined);
  const moveGrid = (event: KeyboardEvent<HTMLDivElement>) => {
    const columns = getComputedStyle(event.currentTarget).gridTemplateColumns.split(' ').length || 1;
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : 0;
    if (!delta) return;
    event.preventDefault(); const next = Math.max(0, Math.min(catalog.items.length - 1, gridIndex + delta)); setGridIndex(next);
    grid.current?.querySelectorAll<HTMLButtonElement>('[data-menu-card]')[next]?.focus();
  };
  const moveLine = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-line-id]');
    const index = quote.lines.findIndex(line => line.lineId === row?.dataset.lineId);
    if (index < 0 || !row) return;
    const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('button'));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    let next: LineTarget;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      next = { lineId: quote.lines[Math.max(0, Math.min(quote.lines.length - 1, index + step))].lineId, target: current };
    } else {
      const available = buttons.flatMap((button, target) => button.disabled ? [] : [target]);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      next = { lineId: row.dataset.lineId!, target: available[Math.max(0, Math.min(available.length - 1, available.indexOf(current) + step))] };
    }
    const { element, focus } = focusElement(next);
    if (focus) setLineTarget(focus);
    element?.focus({ preventScroll: true }); element?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
  };
  const activeLineId = quote.lines.some(line => line.lineId === lineTarget.lineId) ? lineTarget.lineId : quote.lines[0]?.lineId;
  return <div lang="ko" className={`order-composer ${posClasses.body}`}>
    <section ref={menuRef} className="order-composer__menu" aria-label="메뉴">
      <div className="order-composer__tools"><CategoryChips label="메뉴 분류" value={category} onChange={value => { setCategory(value); setGridIndex(0); }} options={POS_MENU_TABS.map(value => ({ value, label: t(`pos.category.${value}`) }))}/><PosSearchField value={query} onValueChange={value => { setQuery(value); setGridIndex(0); }}/></div>
      {catalog.status === 'error' ? <ErrorPanel title="메뉴를 불러오지 못했어요" actions={<ActionButton onClick={onRetryCatalog}>다시 시도</ActionButton>}/> : catalog.status === 'empty' ? <div className="order-composer__empty"><p>아직 등록한 메뉴가 없어요</p><ActionButton onClick={onAddMenu}>메뉴 추가하기</ActionButton></div> : !catalog.items.length ? <div className="order-composer__empty"><p>찾는 메뉴가 없어요</p><ActionButton variant="secondary" onClick={() => { setQuery(''); setCategory('all'); }}>검색어 지우기</ActionButton></div> : <div ref={grid} className={posClasses.menuGrid} onKeyDown={moveGrid}>
        {catalog.items.map((item, index) => { const count = read.pos.cart.lines.filter(line => line.menuId === item.menuId).reduce((sum, line) => sum + line.qty, 0); const status = item.saleStatus === 'sold_out' ? '품절' : item.shortageItems.length ? '재료 부족' : ''; return <ActionButton key={item.menuId} data-menu-card data-added={count > 0} className={posClasses.menuCard} tabIndex={index === Math.min(gridIndex, catalog.items.length - 1) ? 0 : -1} aria-disabled={item.saleStatus === 'sold_out'} aria-label={`${item.name}, ${formatPosMoney(item.price)}${status ? `, ${status}` : ''}${count ? `, ${count}개 담았어요` : ''}`} onFocus={() => setGridIndex(index)} onClick={event => openItem(item, event.currentTarget)}>
          {item.photoFileId ? <PosMenuPhoto photoFileId={item.photoFileId} photoKey={item.photoKey} customPhotoUrl={item.customPhotoUrl} name={item.name} size="card"/> : <MenuPhoto photoKey={item.photoKey} customPhotoUrl={item.customPhotoUrl} name={item.name} size="card"/>}{count ? <CountBadge count={count} tone="cart" aria-hidden="true"/> : null}<span className={posClasses.menuCardBody}><span className={posClasses.menuCardName}>{item.name}</span><span className={posClasses.menuCardPrice}><PosMoney amount={item.price}/>{status ? <PosStatusChip tone={item.saleStatus === 'sold_out' ? 'danger' : 'warning'}>{status}</PosStatusChip> : null}</span></span>
        </ActionButton>; })}
      </div>}
    </section>
    <section className={`${posClasses.cart} ui-glass-card`} aria-label="주문 내역"><div className="order-composer__header"><strong>{heading ?? '주문 내역'} <small>{quote.totalQty}개</small></strong>{headerAction}<ActionButton variant="ghost" disabled={!quote.lines.length} onClick={() => dispatch({ type: 'cart.clear' }, '주문을 비웠어요')}>주문 비우기</ActionButton></div>
      {context}
      <SegmentedControl label="주문 유형" value={read.pos.cart.type} onChange={(orderType: PosOrderType) => dispatch({ type: 'cart.type', orderType })} options={[{ value: 'dine_in', label: '매장' }, { value: 'takeout', label: '포장' }]}/>
      <div ref={linesRef} role="list" aria-label="담은 메뉴" className={posClasses.cartLines} onKeyDown={moveLine} onFocusCapture={event => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-line-id]');
        if (!row || row.dataset.exiting === 'true') return;
        if (!(event.target instanceof HTMLButtonElement)) return;
        const target = Array.from(row.querySelectorAll('button')).indexOf(event.target);
        if (target >= 0) setLineTarget({ lineId: row.dataset.lineId!, target });
      }}>
        <AnimatePresence initial={false}>
          {quote.lines.map(line => {
            const item = read.data.catalog.items.find(i => i.menuId === line.menuId);
            const issue = quote.issues.find(i => i.lineId === line.lineId);
            const removed = issue?.reason === 'ITEM_REMOVED';
            const name = line.name || item?.name || line.menuId;
            // Compact caption in the menu's group order with price deltas: "ICE · 사이즈업 +500원".
            const options = optionCaption(orderedOptions(item, line.options));
            const editable = !!item && choosableGroups(item).length > 0;
            const target = lineTarget.target === 2 && (removed || line.qty >= posLayoutTokens.common.quantityMax) ? 1 : lineTarget.target;
            const tabIndex = (control: number) => line.lineId === activeLineId && target === control ? 0 : -1;
            const issueId = `${instance}-line-${line.lineId}-issue`;
            return <CartLine key={line.lineId} id={line.lineId} label={`${name}${options ? `, ${options}` : ''}, ${line.qty}개, ${formatPosMoney(line.gross)}`} highlighted={highlight.includes(line.lineId)} reducedMotion={reducedMotion}>
              <ActionButton variant="ghost" className={posClasses.lineButton} tabIndex={tabIndex(0)} aria-label={`${name} 옵션 바꾸기`} aria-disabled={removed || !!read.pos.cart.lock} aria-describedby={issue ? issueId : undefined}
                onClick={event => removed ? announce(reasonText('ITEM_REMOVED')) : item && openItem(item, event.currentTarget, line.lineId)}>
                <span className="order-composer__line-name">{name}{editable && !removed ? <Icon name="pencil" className="order-composer__line-edit" aria-hidden="true"/> : null}</span>{removed ? <PosStatusChip>지운 메뉴예요</PosStatusChip> : issue?.reason === 'SOLD_OUT' ? <PosStatusChip tone="danger">품절</PosStatusChip> : null}
                {options ? <span className={posClasses.lineDetail}>{options}</span> : null}{line.request ? <span className={posClasses.lineDetail}>요청: {line.request}</span> : null}
                {issue ? <span id={issueId} className={posClasses.lineDetail}>{issueText(issue.reason)}</span> : null}
              </ActionButton>
              <PosQuantityStepper name={name} value={line.qty} removeOnly={removed} disabledReason={read.pos.cart.lock ? reasonText('BILL_LOCKED') : undefined} onBlocked={announce}
                decreaseTabIndex={tabIndex(1)} increaseTabIndex={tabIndex(2)}
                onChange={qty => dispatch({ type: 'cart.quantity', lineId: line.lineId, qty }, qty === 0 ? `${name}${objectParticle(name)} 뺐어요` : undefined)}/>
              <PosMoney className={posClasses.lineAmount} amount={line.gross} size="control"/>
            </CartLine>;
          })}
        </AnimatePresence>
        {!quote.lines.length ? <div className="order-composer__empty">메뉴를 눌러 담아 주세요</div> : null}
      </div>
      {memoOpen ? <div><Textarea label="주문 메모" value={memo} onValueChange={value => { setMemoLimit([...value].length > 100); setMemo([...value].slice(0, 100).join('')); }} hint={`${[...memo].length}/100`} error={memoLimit ? '100자까지 쓸 수 있어요' : undefined}/><ActionButton onClick={() => { if (dispatch({ type: 'cart.note', text: memo })) setMemoOpen(false); }}>저장하기</ActionButton><ActionButton variant="secondary" onClick={() => setMemoOpen(false)}>닫기</ActionButton></div> : <ActionButton variant="ghost" onClick={() => { setMemo(read.pos.cart.memo); setMemoOpen(true); }}>{read.pos.cart.memo ? `주문 메모: ${read.pos.cart.memo}` : '주문 메모'}</ActionButton>}
      <div className={posClasses.summary}><div>총 수량 {summary.totalQty}개</div><div className={posClasses.summaryRow}><span>상품 금액</span><PosMoney amount={summary.gross}/></div><div className={posClasses.summaryRow}><span>할인</span><PosMoney amount={summary.discount}/></div><div className={posClasses.summaryTotal}><PosMoney amount={summary.payable} size="display" aria-live="polite"/><span>결제 금액</span></div></div>
      {beforeAction}
      <PosActionButton reason={checkoutReason} onBlocked={announce} onAction={() => onCheckout?.()}>{checkoutLabel}</PosActionButton>
    </section>
    <OptionSheet open={dialogOpen} item={draft?.item ?? null} editing={!!draft?.lineId} selected={draft?.selected ?? []} request={draft?.request ?? ''} requestLimit={requestLimit} missingGroups={missingGroups}
      prices={previewLine ? { base: previewLine.basePrice, option: previewLine.optionPrice, unit: previewLine.unitPrice } : null} returnFocusRef={opener} idPrefix={instance}
      onChoose={choose} onClose={() => setDialogOpen(false)} onSubmit={submitDraft}
      onRequest={value => { if (!draft) return; setRequestLimit([...value].length > 100); setDraft({ ...draft, request: [...value].slice(0, 100).join('') }); }}
      onRemove={() => { if (draft?.lineId && dispatch({ type: 'cart.remove', lineId: draft.lineId }, `${draft.item.name}${objectParticle(draft.item.name)} 뺐어요`)) setDialogOpen(false); }}/>
  </div>;
}
