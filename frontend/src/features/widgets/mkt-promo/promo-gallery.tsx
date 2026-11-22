/**
 * ③ 디자인 갤러리 (SCR-54, D-85, D-347). The reference list supplies the numbered designs and matching tags.
 * Cards on screen play the café previews silently on a loop, several at once (muted,
 * playsInline, loop); cards scrolled out of view, a hidden page or a reduced-motion setting leave only the poster.
 * Pressing a card chooses it (one at a time, no separate button); a video that cannot load keeps the poster and the
 * card still chooses.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ActionButton, Icon, StatusBadge, useUi } from '../../../ui';
import type { PromoReference } from './promo-api';
import { masonryColumns, POSTER_HEIGHT } from './promo-gallery-layout';
import { usePromoMedia } from './promo-media';
import type { PromoSession, PromoSessionState } from './promo-session';
import { useT } from './shared';

/** Card height for the column choice: poster + name (2 lines at most) + gap. */
const CARD_EXTRA = 56;

export function ReferenceGallery({ session, state, headingRef }: { readonly session: PromoSession; readonly state: PromoSessionState; readonly headingRef: RefObject<HTMLHeadingElement | null> }) {
  const t = useT();
  const ui = useUi();
  const reduced = ui.reducedMotion;
  const draft = state.draft;
  const list = state.references.value?.references ?? null;
  const authenticated = session.store.real?.mode('promo') === 'http';
  const storeId = authenticated ? state.references.value?.storeId ?? session.store.getSnapshot().tables.realPromo?.storeId : undefined;
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');

  // A page in the background plays nothing.
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const fits = (ref: PromoReference) => draft.moods.some((m) => ref.moods.includes(m)) || draft.concepts.some((c) => ref.concepts.includes(c));
  const ordered = list ?? [];
  const columns = masonryColumns(ordered.map((ref, index) => ({ ref, index })), ({ ref }) => (POSTER_HEIGHT[ref.cardAspect] ?? 520) + CARD_EXTRA);

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, index + delta))];
    cardRefs.current.get(next.id)?.focus();
  };

  return (
    <section className="pv-step pv-gallery-step" aria-labelledby="pv-ref-title">
      <h3 className="pv-label pv-h" id="pv-ref-title" ref={headingRef} tabIndex={-1}>{t.t('promo.ref.title')}</h3>
      {state.references.status === 'error' && !list ? (
        <p className="pv-inline-error" role="alert"><Icon name="error" aria-hidden /> {t.t('promo.ref.error')} <ActionButton variant="link" onClick={() => { void session.loadReferences(true); }}>{t.t('promo.retry')}</ActionButton></p>
      ) : null}
      {!list && state.references.status !== 'error' ? (
        <div className="pv-gallery" aria-hidden="true" data-slot="promo-video.gallery.loading">
          {[520, 312, 390, 520].map((h, i) => <div key={i} className="pv-gallery__col"><div className="pv-skeleton" style={{ height: h }} /></div>)}
        </div>
      ) : null}
      {list ? (
        <div className="pv-gallery" role="radiogroup" aria-label={t.t('promo.ref.group')} data-slot="promo-video.gallery">
          {columns.map((col, c) => (
            <div className="pv-gallery__col" key={c}>
              {col.map(({ ref, index }) => (
                <ReferenceCard
                  key={`${storeId ?? ''}:${ref.id}`} reference={ref} index={index} chosen={draft.referenceId === ref.id} fit={fits(ref)} autoplay={!reduced && !hidden}
                  authenticated={authenticated} storeId={storeId}
                  onChoose={() => session.setDraft({ referenceId: ref.id })}
                  cardRef={(el) => { if (el) cardRefs.current.set(ref.id, el); else cardRefs.current.delete(ref.id); }}
                  onArrow={moveFocus}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface CardProps {
  readonly reference: PromoReference;
  readonly index: number;
  readonly chosen: boolean;
  readonly fit: boolean;
  readonly autoplay: boolean;
  readonly authenticated: boolean;
  readonly storeId?: string;
  readonly onChoose: () => void;
  readonly cardRef: (el: HTMLButtonElement | null) => void;
  readonly onArrow: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}

function ReferenceCard({ reference, index, chosen, fit, autoplay, authenticated, storeId, onChoose, cardRef, onArrow }: CardProps) {
  const t = useT();
  const name = t.t(reference.nameKey);
  const suffix = fit ? t.t('promo.ref.fitSuffix') : '';
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [failed, setFailed] = useState(false);
  const height = POSTER_HEIGHT[reference.cardAspect] ?? 520;
  const poster = usePromoMedia(storeId ? reference.posterUrl : undefined, storeId);
  const posterUrl = authenticated ? poster.src
    : new URL(`../../../../server/promo/references/${reference.id}/poster.jpg`, import.meta.url).href;

  // Only cards at least a quarter on screen play; the video is dropped when the card leaves the view.
  useEffect(() => {
    const el = buttonRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) setVisible(entry.isIntersecting && entry.intersectionRatio >= 0.25);
    }, { threshold: [0, 0.25] });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="pv-ref" data-ref={reference.id} data-chosen={chosen ? 'true' : 'false'}>
      <button
        type="button" role="radio" aria-checked={chosen} className="pv-ref__poster" data-slot="promo-video.poster"
        aria-label={`${t.t(chosen ? 'promo.ref.chosenName' : 'promo.ref.chooseName', { name })}${suffix}`}
        ref={(el) => { buttonRef.current = el; cardRef(el); }}
        onClick={onChoose} onKeyDown={(event) => onArrow(event, index)}
      >
        <span className="pv-ref__media" style={{ height }}>
          {posterUrl ? <img className="pv-ref__img" src={posterUrl} alt="" draggable={false} /> : null}
          {autoplay && visible && !failed ? (
            <GalleryPreview reference={reference} authenticated={authenticated} storeId={storeId} onError={() => setFailed(true)} />
          ) : null}
          {fit ? <span className="pv-ref__fit"><StatusBadge semantic="recommend" label={t.t('promo.ref.fit')} /></span> : null}
          {chosen ? <span className="pv-ref__check" aria-hidden="true"><Icon name="check" /></span> : null}
        </span>
        <span className="pv-ref__name" data-chosen={chosen ? 'true' : undefined}>{name}</span>
      </button>
    </div>
  );
}

function GalleryPreview({ reference, authenticated, storeId, onError }: {
  readonly reference: PromoReference; readonly authenticated: boolean; readonly storeId?: string; readonly onError: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const media = usePromoMedia(storeId ? reference.previewUrl : undefined, storeId);
  const source = authenticated ? media.src
    : new URL(`../../../../server/promo/references/${reference.id}/preview.mp4`, import.meta.url).href;
  if (!source) return null;
  return (
    <video
      className="pv-ref__video" src={source} muted playsInline autoPlay loop preload="auto" aria-hidden="true" tabIndex={-1}
      data-shown={playing ? 'true' : 'false'} onPlaying={() => setPlaying(true)} onError={onError}
    />
  );
}
