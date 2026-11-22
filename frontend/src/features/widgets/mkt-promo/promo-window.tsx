/**
 * 영상 만들기 창 (T-083, SCREENS SCR-51~58, MOTION M-40~M-53): shop bar → step tabs ① 메뉴·사진 ② 분위기·컨셉 ③ 디자인 레퍼런스
 * ④ 길이·확인 → footer (estimate + [영상 만들기]) → real progress (API-23 values only) → finished video (`<video>`, API-25),
 * [저장하기] (`<a download>` + `video.save`), 올릴 곳 and [올렸어요]. Failure shows the reason and [다시 만들기] (same input).
 * The draft lives in the run's promo session, so closing the window keeps the choices (AC-343).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { WidgetDetailProps } from '../../../contracts';
import type { PromoLocale, PromoMenuModel, PromoVideoModel, PromoVideoRowModel, VideoConcept, VideoMood, VideoPostRoute } from '../../../data/widget-data';
import { useDataDispatch } from '../../../data/react';
import { useI18n } from '../../../i18n';
import { ActionButton, DetailFooterContent, Icon, MenuPhoto, SegmentedControl, useUi } from '../../../ui';
import { useNow, usePromoSession } from './promo-hooks';
import { estimateCostText, estimateTimeText, groupNumber, durationText, lookupEstimate, roundEstimateSeconds } from './promo-format';
import { inputOfDraft, MEMO_MAX, STAGES, type PromoDraft, type PromoSession, type PromoSessionState, type PromoTab } from './promo-session';
import { PromoPlayer } from './promo-player';
import { usePromoMedia } from './promo-media';
import { PromoPhotoUpload, PromoPlaceChoices, PromoPublishActions } from './promo-real-actions';
import { usePromoRealText } from './promo-real-copy';
import { ReferenceGallery } from './promo-gallery';
import { text, useT } from './shared';
import { widgetFailureKey } from '../failure-line';

const MIN_PHOTOS = 5;
const TABS: readonly PromoTab[] = [0, 1, 2, 3];
const LENGTHS = ['10', '15', '30'] as const;
const PLACES: readonly VideoPostRoute[] = ['clip', 'reels', 'shorts'];
/** SCR-55 summary chip name: "{값}, 바꾸려면 누르기, ① 메뉴·사진". */
const TAB_MARKS: Readonly<Record<PromoTab, string>> = { 0: '①', 1: '②', 2: '③', 3: '④' };

/** Closes the surrounding detail dialog through its own close button (the widget host has no close call). */
function closeWindow(from: HTMLElement | null) {
  from?.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('[data-ui-close="true"]')?.click();
}
const toggle = <V extends string>(list: readonly V[], value: V, on: boolean): V[] => (on ? (list.includes(value) ? [...list] : [...list, value]) : list.filter((x) => x !== value));
const codePoints = (value: string) => Array.from(value).length;

export function PromoWindow({ model, host, domainNote }: { readonly model: PromoVideoModel; readonly host: WidgetDetailProps['host']; readonly domainNote?: ReactNode }) {
  const t = useT();
  const ui = useUi();
  const [session, state] = usePromoSession();
  const real = session.store.real?.mode('promo') === 'http';
  const storeId = session.store.getSnapshot().tables.realPromo?.storeId;
  const [retryMessage, setRetryMessage] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { void session.loadEstimate(); void session.loadReferences(); }, [session]);
  const current = model.videos[model.videos.length - 1] ?? null;
  const phase = current?.status === 'making' ? 'making' : current?.status === 'failed' && !state.draft.composing ? 'failed' : current && !state.draft.composing ? 'done' : 'setup';
  const phaseRef = useRef(phase);
  useLayoutEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => () => { if (phaseRef.current === 'failed') session.setDraft({ composing: true }); }, [session]);
  return (
    <div ref={rootRef} className="mp-detail pv-win" data-widget="promo-video" data-state="ready" data-phase={phase} data-reduced={ui.reducedMotion ? 'true' : undefined}>
      <ShopBar model={model} storeId={storeId} />
      {domainNote}
      {phase === 'setup' ? <Setup model={model} session={session} state={state} /> : null}
      {phase === 'making' && current ? <Progress key={`${current.videoId}-${current.retryCount}`} video={current} state={state} onClose={() => closeWindow(rootRef.current)} /> : null}
      {phase === 'failed' && current ? <><Failure video={current} pending={state.writing === 'retry'} onRetry={() => {
        if (!real) { session.retry(current.videoId); return; }
        setRetryMessage(undefined);
        void session.retryConfirmed(current.videoId).then(result => { if (!result.ok) setRetryMessage(widgetFailureKey(result.messageKey)); });
      }} onChange={() => session.setDraft({ composing: true, tab: 0 })} onClose={() => { session.setDraft({ composing: true }); closeWindow(rootRef.current); }} />
        {retryMessage ? <p role="alert">{t.t(retryMessage)}</p> : null}</> : null}
      {phase === 'done' && current ? <Done key={current.videoId} model={model} video={current} session={session} state={state} host={host} onClose={() => closeWindow(rootRef.current)} /> : null}
      <span className="ui-sr-only" aria-live="polite" data-slot="promo-video.live">{phase === 'done' && current?.status === 'done' ? t.t('promo.done.title') : ''}</span>
    </div>
  );
}

/* ───────────── shop bar (SCR-51, AC-326) ───────────── */

function ShopBar({ model, storeId }: { readonly model: PromoVideoModel; readonly storeId?: string }) {
  const t = useT();
  const store = model.store;
  const { src: resolved } = usePromoMedia(store?.exteriorUrl, storeId);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!store) return null;
  // A store with no photo address (a new cafe) or one that does not load shows the kit placeholder, never a broken image.
  const photoUrl = resolved && resolved !== failedUrl ? resolved : null;
  return (
    <section className="pv-shop" data-slot="promo-video.shop">
      {photoUrl
        ? <img className="pv-shop__photo" src={photoUrl} alt={t.t('promo.shop.photo', { name: store.name })} width={72} height={72} onError={() => setFailedUrl(photoUrl)} />
        : <span className="pv-shop__photo pv-shop__photo--empty" data-slot="promo-video.shop.placeholder" role="img" aria-label={t.t('promo.shop.photoNone', { name: store.name })}><MenuPhoto photoKey={null} name={store.name} size="thumbnail" /></span>}
      <div className="pv-shop__text">
        <p className="pv-shop__name">{store.name}</p>
        {store.location && !store.location.includes('가상 주소') ? <p className="pv-shop__location">{store.location.replace(/[ \u00a0]·[ \u00a0]/g, '\u00a0·\u00a0')}</p> : null}
      </div>
      <p className="pv-shop__caption">{t.t('promo.shop.caption')}</p>
    </section>
  );
}

/* ───────────── setup: tabs, steps, footer ───────────── */

interface Ready { readonly menus: boolean; readonly photos: boolean; readonly moods: boolean; readonly concepts: boolean; readonly reference: boolean; readonly length: boolean }
function readiness(draft: PromoDraft): Ready {
  return { menus: draft.menuIds.length > 0, photos: draft.photoIds.length >= MIN_PHOTOS, moods: draft.moods.length > 0, concepts: draft.concepts.length > 0, reference: draft.referenceId !== null, length: draft.lengthSec !== null };
}
const filled = (r: Ready, tab: PromoTab) => (tab === 0 ? r.menus && r.photos : tab === 1 ? r.moods && r.concepts : tab === 2 ? r.reference : r.length);

function Setup({ model, session, state }: { readonly model: PromoVideoModel; readonly session: PromoSession; readonly state: PromoSessionState }) {
  const { locale } = useI18n();
  const t = useT();
  const realText = usePromoRealText();
  const real = session.store.real?.mode('promo') === 'http';
  const draft = state.draft;
  const ready = readiness(draft);
  const [direction, setDirection] = useState<'next' | 'previous'>('next');
  const [photoTouched, setPhotoTouched] = useState(false);
  const [confirmation, setConfirmation] = useState<string>();
  const [message, setMessage] = useState<string>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const countId = useId();
  const moved = useRef(false);
  const goTab = (tab: PromoTab) => {
    if (tab === draft.tab) return;
    setConfirmation(undefined);
    if (draft.tab === 0) setPhotoTouched(true);
    setDirection(tab > draft.tab ? 'next' : 'previous');
    moved.current = true;
    session.setDraft({ tab });
  };
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (moved.current) { moved.current = false; if (bodyRef.current) bodyRef.current.scrollTop = 0; headingRef.current?.focus(); } }, [draft.tab]);
  const photoOrder = useMemo(() => model.menus.flatMap((m) => m.photos.map((p) => p.photoId)), [model.menus]);
  const all = ready.menus && ready.photos && ready.moods && ready.concepts && ready.reference && ready.length;
  const estimate = lookupEstimate(state.estimate.value, draft.lengthSec, draft.photoIds.length);
  const input = inputOfDraft(draft, photoOrder, locale as PromoLocale);
  const fingerprint = input && JSON.stringify(input);
  const confirming = real && !!fingerprint && confirmation === fingerprint;
  const make = () => {
    if (!all || !input) return;
    const seconds = estimate ? roundEstimateSeconds(estimate.seconds) : null;
    if (!real) { session.make(input, seconds); return; }
    if (!confirming) { setConfirmation(fingerprint ?? undefined); return; }
    setMessage(undefined);
    void session.makeConfirmed(input, seconds).then(result => { if (!result.ok) setMessage(widgetFailureKey(result.messageKey)); });
  };
  return (
    <>
      <StepTabs tab={draft.tab} ready={ready} onTab={goTab} />
      <div className="pv-body" key={draft.tab} ref={bodyRef} data-direction={direction} data-slot={`promo-video.step.${draft.tab}`}>
        {real && model.current?.status === 'done' ? <p className="pv-caption">{realText.t('promo.real.oldVideo')} <ActionButton variant="link" onClick={() => session.setDraft({ composing: false })}>{t.t('promo.btn.view')}</ActionButton></p> : null}
        {draft.tab === 0 ? <MenuPhotoStep model={model} session={session} draft={draft} headingRef={headingRef} catalog={state.catalog} photoTouched={photoTouched} onPhotoTouched={() => setPhotoTouched(true)} countId={countId} /> : null}
        {draft.tab === 1 ? <MoodStep model={model} session={session} draft={draft} headingRef={headingRef} /> : null}
        {draft.tab === 2 ? <ReferenceGallery session={session} state={state} headingRef={headingRef} /> : null}
        {draft.tab === 3 ? <LengthStep model={model} session={session} state={state} headingRef={headingRef} onTab={goTab} /> : null}
      </div>
      {real && message ? <p className="pv-caption" role="status">{message.startsWith('promo.real.') ? realText.t(message) : t.t(message)}</p> : null}
      <Footer state={state} ready={ready} tab={draft.tab} onTab={goTab} canMake={all && model.current?.status !== 'making'} onMake={make} countId={countId}
        confirmLabel={confirming ? realText.t('promo.real.generate') : undefined} saveLabel={real ? realText.t('promo.real.saveDraft') : undefined}
        onSave={real ? () => { setMessage(undefined); void session.saveDraft(locale).then(result => setMessage(result.ok ? 'promo.real.draftSaved' : widgetFailureKey(result.messageKey))); } : undefined} />
    </>
  );
}

function StepTabs({ tab, ready, onTab }: { readonly tab: PromoTab; readonly ready: Ready; readonly onTab: (tab: PromoTab) => void }) {
  const t = useT();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const bound = ((next % TABS.length) + TABS.length) % TABS.length;
    refs.current[bound]?.focus();
    onTab(TABS[bound]);
  };
  return (
    <div className="pv-tabs" role="tablist" aria-label={t.t('promo.tabs')}>
      {TABS.map((value, index) => {
        const done = filled(ready, value);
        const name = t.t(`promo.tab.${value}`);
        return (
          <button
            key={value} ref={(el) => { refs.current[index] = el; }} type="button" role="tab" className="pv-tab" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
            aria-label={t.t('promo.tab.name', { n: index + 1, name, state: t.t(done ? 'promo.tab.done' : 'promo.tab.empty') })}
            data-filled={done ? 'true' : 'false'} onClick={() => onTab(value)} onKeyDown={(event) => onKey(event, index)}
          >
            <span className="pv-tab__label" aria-hidden="true">{index + 1}. {name}</span>
            <span className="pv-tab__mark" aria-hidden="true" data-filled={done ? 'true' : 'false'}>{done ? <Icon name="check" /> : <span className="pv-ring" />}</span>
          </button>
        );
      })}
    </div>
  );
}

/** DS 11.12.1 ChipChoice (여러 개 선택): checkbox meaning, check icon in front when chosen. */
function MultiChips<V extends string>({ label, options, values, onChange, columns }: { readonly columns?: number; readonly label: string; readonly options: readonly { readonly value: V; readonly label: string; readonly extra?: string }[]; readonly values: readonly V[]; readonly onChange: (value: V, on: boolean) => void }) {
  const labelId = useId();
  return (
    <div className="pv-chips-wrap">
      <p className="pv-label" id={labelId}>{label}</p>
      <div className={columns ? 'pv-chips pv-chips--cols' : 'pv-chips'} style={columns ? ({ '--cols': columns } as CSSProperties) : undefined} role="group" aria-labelledby={labelId}>
        {options.map((option) => {
          const on = values.includes(option.value);
          return (
            <button key={option.value} type="button" role="checkbox" aria-checked={on} className="pv-chip" data-on={on ? 'true' : 'false'} onClick={() => onChange(option.value, !on)}>
              {on ? <Icon name="check" aria-hidden /> : null}<span>{option.label}{option.extra ? <span className="pv-chip__extra">{`\u00a0·\u00a0${option.extra}`}</span> : null}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface StepProps { readonly model: PromoVideoModel; readonly session: PromoSession; readonly draft: PromoDraft; readonly headingRef: RefObject<HTMLHeadingElement | null> }

function MenuPhotoStep({ model, session, draft, headingRef, catalog, photoTouched, onPhotoTouched, countId }: StepProps & { readonly catalog: PromoSessionState['catalog']; readonly photoTouched: boolean; readonly onPhotoTouched: () => void; readonly countId: string }) {
  const t = useT();
  const fewId = useId();
  const chosen = draft.menuIds.map((id) => model.menus.find((m) => m.menuId === id)).filter((m): m is PromoMenuModel => !!m);
  const setMenu = (menuId: string, on: boolean) => {
    const menu = model.menus.find((m) => m.menuId === menuId);
    const own = new Set(menu?.photos.map((p) => p.photoId) ?? []);
    // Unpicking a menu closes its section and drops its photos in the same frame (AC-327).
    session.setDraft({ menuIds: toggle(draft.menuIds, menuId, on), photoIds: on ? draft.photoIds : draft.photoIds.filter((id) => !own.has(id)) });
  };
  const count = draft.photoIds.length;
  const storeId = session.store.getSnapshot().tables.realPromo?.storeId;
  // Menus that have photos come first, so the owner does not scroll past many photo-less menus to reach them (display order only).
  const menusWithPhotosFirst = useMemo(() => [...model.menus].sort((a, b) => Number(b.hasPhotos) - Number(a.hasPhotos)), [model.menus]);
  const anyPhotos = model.menus.some((m) => m.hasPhotos);
  return (
    <section className="pv-step pv-step--photos" aria-labelledby={`${fewId}-h`}>
      <h3 className="pv-h ui-sr-only" id={`${fewId}-h`} ref={headingRef} tabIndex={-1}>{t.t('promo.tab.0')}</h3>
      <MultiChips label={t.t('promo.menu.title')} values={draft.menuIds} onChange={setMenu}
        options={menusWithPhotosFirst.map((m) => ({ value: m.menuId, label: text(t, m.name), extra: m.hasPhotos ? t.t('promo.menu.photos', { n: m.photos.length }) : t.t('promo.menu.noPhotos') }))} />
      {storeId ? <PromoPhotoUpload menus={menusWithPhotosFirst} session={session} /> : null}
      <div className="pv-photos-head">
        <p className="pv-label">{chosen.length ? t.t('promo.photo.headline', { menu: chosen.map((m) => text(t, m.name)).join(', '), n: chosen.reduce((sum, m) => sum + m.photos.length, 0) }) : t.t('promo.photo.headNone')}</p>
        <p className="pv-caption" data-slot="promo-video.store-photos">{t.t('common.linked.promo.photos', { n: model.photoCount })}</p>
        <p className="pv-caption">{t.t('promo.photo.why')}</p>
        <p className="pv-count" id={countId} data-slot="promo-video.photo-count" data-enough={count >= MIN_PHOTOS ? 'true' : count === 0 && !photoTouched ? 'neutral' : 'false'}>{count > 0 || photoTouched ? <Icon name={count >= MIN_PHOTOS ? 'check' : 'warning'} aria-hidden /> : null}{t.t('promo.photo.count', { n: count })}</p>
      </div>
      {catalog === 'error' ? (
        <p className="pv-inline-error" role="alert"><Icon name="error" aria-hidden /> {t.t('promo.photo.error')} <ActionButton variant="link" onClick={() => { void session.syncCatalog(); }}>{t.t('promo.retry')}</ActionButton></p>
      ) : null}
      <div className="pv-photo-area">
        {chosen.length === 0 ? <div className="pv-section pv-section--empty"><p className="pv-hint" data-slot="promo-video.pick-menu">{t.t(anyPhotos ? 'promo.photo.pickMenu' : 'promo.photo.noneAny')}</p></div> : null}
        {chosen.map((menu) => (
          <div className={`pv-section${menu.photos.length === 0 ? ' pv-section--empty' : ''}`} key={menu.menuId} data-menu={menu.menuId}>
            {menu.photos.length === 0 ? <p className="pv-hint" data-slot="promo-video.no-photos"><Icon name="info" aria-hidden /> {t.t(anyPhotos ? 'promo.photo.none' : 'promo.photo.noneAny')}</p> : (
              <PhotoGrid menu={menu} storeId={storeId} selected={draft.photoIds} onChange={(photoIds) => { onPhotoTouched(); session.setDraft({ photoIds }); }} />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** D-87 (SCR-52, M-54): whole tile is the target; a finger (or mouse) swept over tiles sets them all to the first tile's new state, the line between two samples included.
 *  A plain press toggles one photo; Shift+arrow does the same sweep from the keyboard. Only the first pointer counts. */
function PhotoTileImage({ url, storeId }: { readonly url: string; readonly storeId?: string }) {
  const { src } = usePromoMedia(url, storeId);
  return src ? <img src={src} alt="" loading="lazy" draggable={false} /> : null;
}

function PhotoGrid({ menu, storeId, selected, onChange }: { readonly menu: PromoMenuModel; readonly storeId?: string; readonly selected: readonly string[]; readonly onChange: (photoIds: string[]) => void }) {
  const t = useT();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const live = useRef<readonly string[]>(selected);
  const sweep = useRef<{ readonly target: boolean; readonly pointer: number; readonly startX: number; readonly startY: number; x: number; y: number; direction: 'h' | null; readonly photoId: string } | null>(null);
  const scrollable = menu.photos.length > 10;
  const skipClick = useRef(false);
  const shiftTarget = useRef<boolean | null>(null);
  const [said, setSaid] = useState('');
  useEffect(() => { live.current = selected; }, [selected]);
  const name = text(t, menu.name);
  const ids = new Set(menu.photos.map((p) => p.photoId));
  const apply = (photoId: string, on: boolean) => {
    if (live.current.includes(photoId) === on) return;
    const next = toggle(live.current, photoId, on);
    live.current = next;
    onChange(next);
  };
  const say = () => setSaid(t.t('promo.photo.sweepDone', { n: live.current.length }));
  const tileAt = (x: number, y: number) => {
    const el = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    const id = el?.closest<HTMLElement>('[data-photo]')?.dataset.photo ?? null;
    return id && ids.has(id) ? id : null;
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const cols = Math.max(1, Math.round((event.currentTarget.parentElement?.clientWidth ?? 0) / Math.max(1, event.currentTarget.clientWidth)) || 5);
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? cols : event.key === 'ArrowUp' ? -cols : 0;
    if (!delta) return;
    event.preventDefault();
    if (!event.shiftKey) shiftTarget.current = null;
    const to = Math.min(menu.photos.length - 1, Math.max(0, index + delta));
    if (event.shiftKey) {
      // The first Shift move fixes the target state; it holds until Shift is released.
      const target = shiftTarget.current ?? !live.current.includes(menu.photos[index].photoId);
      shiftTarget.current = target;
      // The start tile takes the target state, every tile passed on the way too (same rule as a swipe).
      const from = Math.min(index, to); const until = Math.max(index, to);
      for (let i = from; i <= until; i += 1) apply(menu.photos[i].photoId, target);
      say();
    }
    refs.current[to]?.focus();
  };
  const endRef = useRef<(event?: { readonly pointerId?: number }) => void>(() => {});
  const onWindowEnd = useRef((event: PointerEvent) => endRef.current(event)).current;
  const endSweep = () => {
    sweep.current = null;
    window.removeEventListener('pointerup', onWindowEnd);
    window.removeEventListener('pointercancel', onWindowEnd);
  };
  function end(event?: { readonly pointerId?: number }) {
    const current = sweep.current;
    if (!current || (event?.pointerId !== undefined && event.pointerId !== current.pointer)) return;
    const painted = current.direction === 'h' || !scrollable;
    endSweep();
    if (!painted) return; // a plain press (click toggles) or a scroll
    skipClick.current = true;
    window.setTimeout(() => { skipClick.current = false; }, 0);
    say();
  }
  useEffect(() => { endRef.current = end; });
  return (
    <>
    <div
      className="pv-grid" data-scroll={scrollable ? 'true' : undefined} role="group" aria-label={name} data-count={menu.photos.length}
      onPointerMove={(event) => {
        const current = sweep.current;
        if (!current || event.pointerId !== current.pointer) return;
        const dx = event.clientX - current.startX; const dy = event.clientY - current.startY;
        if (!current.direction) {
          // More than 10 photos: the first movement decides. Sideways paints, up/down scrolls the list (D-87b).
          if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) < 8) return;
          if (Number.isFinite(dx) && Number.isFinite(dy) && Math.abs(dy) > Math.abs(dx)) { endSweep(); return; }
          current.direction = 'h';
          apply(current.photoId, current.target);
        }
        const mx = event.clientX - current.x; const my = event.clientY - current.y;
        const dist = Math.hypot(mx, my);
        const steps = Number.isFinite(dist) ? Math.max(1, Math.ceil(dist / 8)) : 1;
        for (let i = 1; i <= steps; i += 1) {
          const id = tileAt(current.x + (mx * i) / steps, current.y + (my * i) / steps);
          if (id) apply(id, current.target);
        }
        current.x = event.clientX; current.y = event.clientY;
      }}
      onPointerUp={end} onPointerCancel={end}
    >
      {menu.photos.map((photo, index) => {
        const on = selected.includes(photo.photoId);
        return (
          <button
            key={photo.photoId} ref={(el) => { refs.current[index] = el; }} type="button" role="checkbox" aria-checked={on} className="pv-tile" data-on={on ? 'true' : 'false'} data-photo={photo.photoId}
            aria-label={t.t('promo.photo.name', { menu: name, i: index + 1, n: menu.photos.length, state: t.t(on ? 'promo.photo.on' : 'promo.photo.off') })}
            onPointerDown={(event) => {
              if (event.button > 0 || sweep.current) return;
              sweep.current = { target: !live.current.includes(photo.photoId), pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, direction: scrollable ? null : 'h', photoId: photo.photoId };
              if (!scrollable) apply(photo.photoId, sweep.current.target);
              window.addEventListener('pointerup', onWindowEnd);
              window.addEventListener('pointercancel', onWindowEnd);
            }}
            onClick={() => { if (skipClick.current) { skipClick.current = false; return; } apply(photo.photoId, !live.current.includes(photo.photoId)); }}
            onKeyDown={(event) => onKey(event, index)} onKeyUp={(event) => { if (event.key === 'Shift') shiftTarget.current = null; }}
          >
            <PhotoTileImage url={photo.url} storeId={storeId} />
            <span className="pv-tile__badge" aria-hidden="true"><Icon name="check" /></span>
          </button>
        );
      })}
    </div>
    <span className="ui-sr-only" aria-live="polite" data-slot="promo-video.photo-live">{said}</span>
    </>
  );
}

function MoodStep({ model, session, draft, headingRef }: StepProps) {
  const t = useT();
  const id = useId();
  return (
    <section className="pv-step" aria-labelledby={`${id}-h`}>
      <h3 className="pv-h ui-sr-only" id={`${id}-h`} ref={headingRef} tabIndex={-1}>{t.t('promo.tab.1')}</h3>
      <MultiChips<VideoMood> columns={4} label={t.t('promo.mood.title')} values={draft.moods} onChange={(v, on) => session.setDraft({ moods: toggle(draft.moods, v, on) })}
        options={model.moods.map((value) => ({ value, label: t.t(`data.marketing.mood.${value}`) }))} />
      <MultiChips<VideoConcept> columns={5} label={t.t('promo.concept.title')} values={draft.concepts} onChange={(v, on) => session.setDraft({ concepts: toggle(draft.concepts, v, on) })}
        options={model.concepts.map((value) => ({ value, label: t.t(`data.marketing.concept.${value}`) }))} />
      <MemoField value={draft.memo} onChange={(memo) => session.setDraft({ memo })} />
    </section>
  );
}

/** DS 11.12.1 MemoField: stops at 100 code points; during IME composition the cut happens after the syllable is committed. */
function MemoField({ value, onChange }: { readonly value: string; readonly onChange: (value: string) => void }) {
  const t = useT();
  const id = useId();
  const composing = useRef(false);
  const [raw, setRaw] = useState(value);
  useEffect(() => { if (!composing.current) setRaw(value); }, [value]);
  const clip = (v: string) => Array.from(v).slice(0, MEMO_MAX).join('');
  const commit = (v: string) => { const next = clip(v); setRaw(next); if (next !== value) onChange(next); };
  const n = codePoints(raw);
  const full = n >= MEMO_MAX;
  return (
    <div className="pv-memo">
      <label className="pv-label" htmlFor={id}>{t.t('promo.memo.label')}</label>
      <textarea
        id={id} className="pv-memo__input" rows={3} value={raw} placeholder={t.t('promo.memo.why')} aria-describedby={full ? `${id}-max` : undefined}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => { composing.current = false; commit(event.currentTarget.value); }}
        onChange={(event) => { if (composing.current) setRaw(event.currentTarget.value); else commit(event.currentTarget.value); }}
      />
      <p className="pv-memo__foot">
        {full ? <span className="pv-warn" id={`${id}-max`}><Icon name="warning" aria-hidden /> {t.t('promo.memo.max')}</span> : <span />}
        <span className="pv-memo__count" aria-hidden="true" data-full={full ? 'true' : undefined}>{t.t('promo.memo.count', { n: Math.min(n, MEMO_MAX) })}</span>
      </p>
    </div>
  );
}

function EstimateBlock({ state, large = false, brief = false }: { readonly state: PromoSessionState; readonly large?: boolean; readonly brief?: boolean }) {
  const t = useT();
  const session = usePromoSession()[0];
  const model = state.estimate.value;
  const cell = lookupEstimate(model, state.draft.lengthSec, state.draft.photoIds.length);
  if (state.estimate.status === 'error' && !cell) {
    return <div className={`pv-estimate ${large ? 'pv-estimate--large' : ''}`} data-slot="promo-video.estimate"><p className="pv-inline-error"><Icon name="error" aria-hidden /> {t.t('promo.est.error')} <ActionButton variant="link" onClick={() => { void session.loadEstimate(true); }}>{t.t('promo.retry')}</ActionButton></p></div>;
  }
  if (state.draft.lengthSec === null) {
    return <div className={`pv-estimate ${large ? 'pv-estimate--large' : ''}`} data-slot="promo-video.estimate"><p className="pv-caption" data-slot="promo-video.estimate.pending">{t.t('promo.est.pick')}</p></div>;
  }
  const time = cell ? t.t('promo.est.time', { t: estimateTimeText(t, cell.seconds) }) : t.t('promo.est.time', { t: '–' });
  const cost = cell ? t.t('promo.est.cost', { c: estimateCostText(t, cell.costKrw) }) : t.t('promo.est.cost', { c: '–' });
  return (
    <div className={`pv-estimate ${large ? 'pv-estimate--large' : ''} ${brief ? 'pv-estimate--brief' : ''}`} data-slot="promo-video.estimate">
      <div className="pv-estimate__col">
        <p className="pv-estimate__value" data-slot="promo-video.estimate.time"><FlashValue value={time} /></p>
        {brief ? null : <p className="pv-caption">{t.t('promo.est.timeNote')}</p>}
      </div>
      <div className="pv-estimate__col">
        <p className="pv-estimate__value" data-slot="promo-video.estimate.cost"><FlashValue value={cost} /></p>
        {brief ? null : <p className="pv-caption">{t.t('promo.est.costNote')}{model && large ? `\u00a0·\u00a0${t.t('promo.est.fx', { r: groupNumber(model.fx.krwPerUsd), d: t.format.date(model.fx.checkedOn, 'short') })}` : ''}</p>}
      </div>
    </div>
  );
}

/** M-44: the value is swapped in the same frame; a changed value gets the 800 ms selection tint (none under reduced motion). */
function FlashValue({ value }: { readonly value: string }) {
  const previous = useRef(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (previous.current === value) return undefined;
    previous.current = value;
    setOn(true);
    const timer = window.setTimeout(() => setOn(false), 800);
    return () => window.clearTimeout(timer);
  }, [value]);
  return <span className="pv-flash" data-flash={on ? 'true' : undefined}>{value}</span>;
}

function Footer({ state, ready, tab, onTab, canMake, onMake, countId, confirmLabel, saveLabel, onSave }: { readonly state: PromoSessionState; readonly ready: Ready; readonly tab: PromoTab; readonly onTab: (tab: PromoTab) => void; readonly canMake: boolean; readonly onMake: () => void; readonly countId: string; readonly confirmLabel?: string; readonly saveLabel?: string; readonly onSave?: () => void }) {
  const t = useT();
  const reasonId = useId();
  const last = tab === 3;
  const onlyPhotos = ready.menus && !ready.photos && ready.moods && ready.concepts && ready.reference;
  const canNext = filled(ready, tab);
  // SCR-51: ② and ③ give the reason beside the disabled button; ① has no reason line (the photo count line is its one place and describes [다음]).
  const nextReasons = [null, 'promo.need.mood', 'promo.need.ref'] as const;
  const reason = last
    ? (canMake ? null : !ready.length && ready.menus && ready.photos && ready.moods && ready.concepts && ready.reference ? t.t('promo.need.len') : onlyPhotos ? t.t('promo.photo.few', { n: state.draft.photoIds.length }) : t.t('promo.need'))
    : canNext || tab === 0 ? null : t.t(nextReasons[tab]!);
  const describedBy = tab === 0 ? countId : reason ? reasonId : undefined;
  const enabled = last ? canMake : canNext;
  return (
    <DetailFooterContent>
      <div className="pv-footbar" data-slot="promo-video.footer">
        <p className="pv-footer__reason" id={reasonId} data-slot="promo-video.reason" title={reason ?? undefined}>{reason}</p>
        <div className="pv-footer__buttons">
          {onSave ? <ActionButton variant="secondary" disabled={!!state.writing} aria-busy={state.writing === 'draft' || undefined} onClick={onSave}>{saveLabel}</ActionButton> : null}
          {tab !== 0 ? <ActionButton variant="secondary" size="primary" className="pv-prev" onClick={() => onTab(Math.max(0, tab - 1) as PromoTab)}>{t.t('promo.prev')}</ActionButton> : null}
          {last ? (
            <ActionButton size="primary" className="pv-make" disabled={!enabled || !!state.writing} aria-busy={state.writing === 'generate' || undefined} aria-describedby={describedBy} onClick={onMake}>{confirmLabel ?? t.t('marketing.makeVideo')}</ActionButton>
          ) : (
            <ActionButton size="primary" className="pv-make pv-next" disabled={!enabled} aria-disabled={!enabled} aria-describedby={describedBy} onClick={() => onTab((tab + 1) as PromoTab)}>{t.t('promo.next')}</ActionButton>
          )}
        </div>
        <span aria-hidden="true" />
      </div>
    </DetailFooterContent>
  );
}

function LengthStep({ model, session, state, headingRef, onTab }: Omit<StepProps, 'draft'> & { readonly state: PromoSessionState; readonly onTab: (tab: PromoTab) => void }) {
  const t = useT();
  const id = useId();
  const draft = state.draft;
  const refs = state.references.value?.references ?? [];
  const ref = refs.find((r) => r.id === draft.referenceId);
  const menus = draft.menuIds.map((mid) => model.menus.find((m) => m.menuId === mid)).filter((m): m is PromoMenuModel => !!m).map((m) => text(t, m.name));
  const join = (items: readonly string[]) => (items.length ? items.join(', ') : t.t('promo.sum.none'));
  const rows: readonly { readonly key: string; readonly label: string; readonly value: string; readonly tab: PromoTab }[] = [
    { key: 'menu', label: t.t('promo.sum.menu'), value: join(menus), tab: 0 },
    { key: 'photos', label: t.t('promo.sum.photos'), value: t.t('promo.sum.photoN', { n: draft.photoIds.length }), tab: 0 },
    { key: 'mood', label: t.t('promo.sum.mood'), value: join(draft.moods.map((m) => t.t(`data.marketing.mood.${m}`))), tab: 1 },
    { key: 'concept', label: t.t('promo.sum.concept'), value: join(draft.concepts.map((c) => t.t(`data.marketing.concept.${c}`))), tab: 1 },
    ...(draft.memo.trim() ? [{ key: 'memo', label: t.t('promo.sum.memo'), value: draft.memo, tab: 1 as PromoTab }] : []),
    { key: 'ref', label: t.t('promo.sum.ref'), value: ref ? t.t(ref.nameKey) : t.t('promo.sum.none'), tab: 2 },
  ];
  return (
    <section className="pv-step pv-step--length" aria-labelledby={`${id}-h`}>
      <h3 className="pv-h ui-sr-only" id={`${id}-h`} ref={headingRef} tabIndex={-1}>{t.t('promo.tab.3')}</h3>
      <div className="pv-chips-wrap pv-length">
        {/* The radiogroup below carries the name; this is the visible label (SCR-55), so it is not read twice. */}
        <p className="pv-label" aria-hidden="true">{t.t('promo.len.title')}</p>
        <SegmentedControl label={t.t('promo.len.title')} value={(draft.lengthSec === null ? '' : String(draft.lengthSec)) as typeof LENGTHS[number]} onChange={(v) => session.setDraft({ lengthSec: Number(v) as 10 | 15 | 30 })}
          options={LENGTHS.map((v) => ({ value: v, label: t.t('promo.len.sec', { n: v }) }))} />
      </div>
      <EstimateBlock state={state} large />
      <div className="pv-summary" data-slot="promo-video.summary">
        <p className="pv-label">{t.t('promo.sum.title')}</p>
        <div className="pv-summary__chips">
          {rows.map((row) => (
            <button type="button" className="pv-summary__row" key={row.key} data-row={row.key} aria-label={t.t('promo.sum.changeName', { value: row.value, tab: `${TAB_MARKS[row.tab]} ${t.t(`promo.tab.${row.tab}`)}` })} onClick={() => onTab(row.tab)}>
              <span className="pv-summary__label">{row.label}</span><span className="pv-summary__value">{row.value}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────── making (SCR-56) ───────────── */

function Progress({ video, state, onClose }: { readonly video: PromoVideoRowModel; readonly state: PromoSessionState; readonly onClose: () => void }) {
  const t = useT();
  const now = useNow(true);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const stageIndex = video.stage ? STAGES.indexOf(video.stage) : 0;
  const started = state.startedAt[video.videoId] ?? now;
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const expected = state.estimateAtStart[video.videoId] ?? null;
  const stepName = t.t(`promo.stage.${video.stage ?? 'look'}`);
  return (
    <section className="pv-progress" data-slot="promo-video.progress" aria-labelledby="pv-progress-title">
      <h3 className="pv-progress__title" id="pv-progress-title" ref={titleRef} tabIndex={-1}>{t.t('promo.prog.title')}</h3>
      <ol className="pv-stages">
        {STAGES.map((stage, index) => {
          const s = index < stageIndex || (index === stageIndex && video.stageState === 'done') ? 'done' : index === stageIndex ? 'current' : 'left';
          return (
            <li key={stage} className="pv-stage" data-state={s} data-stage={stage} aria-current={s === 'current' ? 'step' : undefined}>
              <span className="pv-stage__mark" aria-hidden="true">{s === 'done' ? <Icon name="check" /> : <span className={s === 'current' ? 'pv-dot' : 'pv-ring'} />}</span>
              <span className="pv-stage__name">{t.t(`promo.stage.${stage}`)}<span className="ui-sr-only">{`, ${t.t(s === 'done' ? 'promo.prog.stateDone' : s === 'current' ? 'promo.prog.stateNow' : 'promo.prog.stateLeft')}`}</span></span>
              {stage === 'look' && s === 'current' ? <span className="pv-stage__aside">{t.t('promo.prog.looking', { n: video.lookCount ?? video.photoCount })}</span> : null}
            </li>
          );
        })}
      </ol>
      <p className="pv-elapsed" aria-hidden="true">
        <span className="pv-tabular">{t.t('promo.prog.elapsed', { t: durationText(t, elapsed) })}</span>
        {expected !== null ? <span>{`\u00a0·\u00a0${t.t('promo.est.time', { t: durationText(t, expected) })}`}</span> : null}
      </p>
      {expected !== null && elapsed > expected ? <p className="pv-caption" data-slot="promo-video.slow">{t.t('promo.prog.slow')}</p> : null}
      <span className="ui-sr-only" aria-live="polite">{t.t('promo.prog.now', { step: stepName })}</span>
      <DetailFooterContent>
        <div className="pv-footbar pv-footbar--progress">
          <p className="pv-footer__reason">{t.t('promo.prog.keep')}</p>
          <ActionButton variant="secondary" size="primary" className="pv-make" onClick={onClose}>{t.t('promo.btn.closeWindow')}</ActionButton>
          <span aria-hidden="true" />
        </div>
      </DetailFooterContent>
    </section>
  );
}

/* ───────────── failure (SCR-58) ───────────── */

function Failure({ video, pending, onRetry, onChange, onClose }: { readonly video: PromoVideoRowModel; readonly pending?: boolean; readonly onRetry: () => void; readonly onChange: () => void; readonly onClose: () => void }) {
  const t = useT();
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { retryRef.current?.focus(); }, []);
  const reason = video.failReason ? t.t(`promo.fail.${video.failReason}`) : '';
  return (
    <section className="pv-failure" role="alert" data-slot="promo-video.failure" data-reason={video.failReason ?? undefined}>
      <span className="pv-failure__icon" aria-hidden="true"><Icon name="warning" /></span>
      <h3 className="pv-failure__title">{t.t('promo.fail.title')}</h3>
      <p>{video.failReason === 'AI_UNAVAILABLE' ? t.t('promo.fail.network') : t.t('promo.fail.detail', { reason })}</p>
      <DetailFooterContent>
        <div className="pv-footbar pv-footbar--failure" data-slot="promo-video.footer">
          <span aria-hidden="true" />
          <div className="pv-footer__buttons"><ActionButton ref={retryRef} size="primary" className="pv-make" disabled={pending} aria-busy={pending || undefined} onClick={onRetry}>{t.t('promo.btn.retry')}</ActionButton><ActionButton variant="secondary" size="primary" onClick={onChange}>{t.t('promo.btn.change')}</ActionButton><ActionButton variant="secondary" size="primary" onClick={onClose}>{t.t('promo.btn.close')}</ActionButton></div>
          <span aria-hidden="true" />
        </div>
      </DetailFooterContent>
    </section>
  );
}

/* ───────────── done (SCR-57) ───────────── */

function Done({ model, video, session, state, host, onClose }: { readonly model: PromoVideoModel; readonly video: PromoVideoRowModel; readonly session: PromoSession; readonly state: PromoSessionState; readonly host: WidgetDetailProps['host']; readonly onClose: () => void }) {
  const t = useT();
  const realText = usePromoRealText();
  const dispatch = useDataDispatch();
  const needId = useId();
  const result = video.result;
  const storeId = session.store.getSnapshot().tables.realPromo?.storeId;
  const media = usePromoMedia(result?.fileUrl, storeId);
  const place = state.draft.place;
  const posted = video.status === 'posted';
  const saved = state.saved[video.videoId] ?? 'idle';
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { titleRef.current?.focus(); }, []);
  if (!result) return null;
  const seconds = Math.round(result.durationSec);
  const fileName = `${model.store?.name ?? 'navis'}-${video.lengthSec}s.mp4`;
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const status = await session.save(video.videoId, fileName);
    setSaving(false);
    if (status === 'saved') host.notify({ kind: 'success', messageKey: 'data.marketing.notice.saveStarted' });
  };
  const markPosted = () => {
    if (!place || posted) return;
    const outcome = dispatch({ type: 'video.markPosted', videoId: video.videoId, route: place, idempotencyKey: `post-${video.videoId}` });
    if (outcome.ok) { if (outcome.noticeKey) host.notify({ kind: 'success', messageKey: outcome.noticeKey }); }
    else host.notify({ kind: 'error', messageKey: outcome.messageKey });
  };
  const postedRoute = video.postedRoute ?? place;
  const postedLine = `${t.t('promo.posted.line', { n: model.postedCount, place: t.t(`promo.place.${postedRoute ?? 'clip'}`) })}${postedRoute === 'clip' ? t.t('widget.promo-video.counting') : ''}`;
  return (
    <section className="pv-done" data-slot="promo-video.done" data-posted={posted ? 'true' : undefined}>
      {media.src ? <PromoPlayer src={media.src} name={t.t('promo.player.name', { s: seconds })} /> : <div role="status" className="pv-caption">
        {t.t(media.failed ? 'data.real.error' : 'data.real.loading')}
        {media.failed ? <ActionButton variant="link" onClick={media.retry}>{t.t('common.retry')}</ActionButton> : null}
      </div>}
      <div className="pv-done__side">
        <h3 className="pv-done__title" ref={titleRef} tabIndex={-1}><span className="pv-done__check" aria-hidden="true"><Icon name="check" /></span>{t.t('promo.done.title')}</h3>
        <p className="pv-done__meta">{t.t('promo.done.meta', { s: seconds, n: video.photoCount })}</p>
        {result.music.title ? <p className="pv-done__music" data-slot="promo-video.music">{t.t('promo.done.music', { name: result.music.title })}</p> : null}
        <div className="pv-save">
          <ActionButton size="primary" onClick={() => { void save(); }} disabled={saving} aria-busy={saving || undefined}>{saved === 'failed' ? t.t('promo.save.again') : storeId ? realText.t('promo.real.download') : t.t('promo.btn.save')}</ActionButton>
          {saved === 'saved' ? <p className="pv-save__ok" role="status"><span className="pv-pop"><Icon name="check" aria-hidden /></span> {t.t('promo.save.ok')} <span className="pv-caption">{state.savedName[video.videoId] ?? fileName}</span></p> : null}
          {saved === 'failed' ? <p className="pv-save__fail" role="alert"><Icon name="error" aria-hidden /> {t.t('promo.save.fail')}</p> : null}
        </div>
        {storeId ? <PromoPublishActions video={video} session={session} /> : posted ? (
          <div className="pv-posted" data-slot="promo-video.posted-done">
            <p className="pv-posted__line" role="status"><Icon name="check" aria-hidden /> {postedLine}</p>
          </div>
        ) : (
          <div className="pv-place">
            <PromoPlaceChoices places={PLACES} selected={place} label={t.t('promo.place.title')}
              placeLabel={route => t.t(`promo.place.${route}`)} onSelect={route => session.setDraft({ place: route })} />
            <p className="pv-caption">{t.t('promo.place.note')}</p>
            <ActionButton size="primary" className="pv-posted-button" disabled={!place} aria-disabled={!place} aria-describedby={place ? undefined : needId} onClick={markPosted}>{t.t('promo.btn.posted')}</ActionButton>
            {place ? null : <p className="pv-hint" id={needId}>{t.t('promo.place.need')}</p>}
          </div>
        )}
      </div>
      <DetailFooterContent>
        <div className="pv-footbar pv-footbar--done" data-slot="promo-video.footer">
          <span aria-hidden="true" />
          {posted || storeId
            ? <ActionButton variant="secondary" size="primary" className="pv-make" onClick={() => session.startNew()}>{t.t('promo.btn.newLong')}</ActionButton>
            : <ActionButton variant="secondary" size="primary" className="pv-make" onClick={onClose}>{t.t('promo.btn.closeWindow')}</ActionButton>}
          <span aria-hidden="true" />
        </div>
      </DetailFooterContent>
    </section>
  );
}

