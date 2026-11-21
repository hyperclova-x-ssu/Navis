/**
 * ③ 디자인 레퍼런스 갤러리 (T-083d, SCR-54 with D-85). Four-column staggered cards (next card into the lowest column),
 * poster from API-27 `posterUrl`. Cards on screen play `previewUrl` silently on a loop, several at once (muted,
 * playsInline, loop); cards scrolled out of view, a hidden page or a reduced-motion setting leave only the poster.
 * Pressing a card chooses it (one at a time, no separate button); a video that cannot load keeps the poster and the
 * card still chooses.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ActionButton, Icon, StatusBadge, useUi } from '../../../ui';
import type { PromoReference } from './promo-api';
import type { PromoSession, PromoSessionState } from './promo-session';
import { useT } from './shared';

export const POSTER_HEIGHT: Readonly<Record<string, number>> = { '9:16': 520, '3:5': 520, '4:5': 390, '1:1': 312 };
/** Card height for the column choice: poster + name (2 lines at most) + gap. */
const CARD_EXTRA = 56;

/** PROMO_TEMPLATES 1: card i goes into the lowest column (leftmost on ties). */
export function masonryColumns<T>(items: readonly T[], height: (item: T) => number, columns = 4): T[][] {
  const out: T[][] = Array.from({ length: columns }, () => []);
  const heights = new Array<number>(columns).fill(0);
  for (const item of items) {
    let target = 0;
    for (let c = 1; c < columns; c += 1) if (heights[c] < heights[target]) target = c;
    out[target].push(item);
    heights[target] += height(item) + 16;
  }
  return out;
}

export function ReferenceGallery({ session, state, headingRef }: { readonly session: PromoSession; readonly state: PromoSessionState; readonly headingRef: RefObject<HTMLHeadingElement | null> }) {
  const t = useT();
  const ui = useUi();
  const reduced = ui.reducedMotion;
  const draft = state.draft;
  const list = state.references.value?.references ?? null;
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
  const columns = useMemo(() => masonryColumns(ordered.map((ref, index) => ({ ref, index })), ({ ref }) => (POSTER_HEIGHT[ref.cardAspect] ?? 520) + CARD_EXTRA), [ordered]);

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, index + delta))];
    cardRefs.current.get(next.id)?.focus();
  };

  return (
    <section className="pv-step pv-gallery-step" aria-labelledby="pv-ref-title">
      {/* SCR-54: the title (bold) and the preview note follow each other on one line. */}
      <div className="pv-gallery-head">
        <h3 className="pv-label pv-h" id="pv-ref-title" ref={headingRef} tabIndex={-1}>{t.t('promo.ref.title')}</h3>
        <span className="pv-gallery-head__dot" aria-hidden="true">·</span>
        <p className="pv-caption" data-slot="promo-video.ref-note">{t.t('promo.ref.note')}</p>
      </div>
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
                  key={ref.id} reference={ref} index={index} chosen={draft.referenceId === ref.id} fit={fits(ref)} autoplay={!reduced && !hidden}
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
  readonly onChoose: () => void;
  readonly cardRef: (el: HTMLButtonElement | null) => void;
  readonly onArrow: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}

function ReferenceCard({ reference, index, chosen, fit, autoplay, onChoose, cardRef, onArrow }: CardProps) {
  const t = useT();
  const name = t.t(reference.nameKey);
  const suffix = fit ? t.t('promo.ref.fitSuffix') : '';
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const height = POSTER_HEIGHT[reference.cardAspect] ?? 520;

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

  const showVideo = autoplay && visible && !failed;
  useEffect(() => { if (!showVideo) setPlaying(false); }, [showVideo]);

  return (
    <div className="pv-ref" data-ref={reference.id} data-chosen={chosen ? 'true' : 'false'}>
      <button
        type="button" role="radio" aria-checked={chosen} className="pv-ref__poster" data-slot="promo-video.poster"
        aria-label={`${t.t(chosen ? 'promo.ref.chosenName' : 'promo.ref.chooseName', { name })}${suffix}`}
        ref={(el) => { buttonRef.current = el; cardRef(el); }}
        onClick={onChoose} onKeyDown={(event) => onArrow(event, index)}
      >
        <span className="pv-ref__media" style={{ height }}>
          <img className="pv-ref__img" src={reference.posterUrl} alt="" draggable={false} />
          {showVideo ? (
            <video
              className="pv-ref__video" src={reference.previewUrl} muted playsInline autoPlay loop preload="auto" aria-hidden="true" tabIndex={-1}
              data-shown={playing ? 'true' : 'false'}
              onPlaying={() => setPlaying(true)}
              onError={() => setFailed(true)}
            />
          ) : null}
          {fit ? <span className="pv-ref__fit"><StatusBadge semantic="recommend" label={t.t('promo.ref.fit')} /></span> : null}
          {chosen ? <span className="pv-ref__check" aria-hidden="true"><Icon name="check" /></span> : null}
        </span>
        <span className="pv-ref__name" data-chosen={chosen ? 'true' : undefined}>{name}</span>
      </button>
    </div>
  );
}
