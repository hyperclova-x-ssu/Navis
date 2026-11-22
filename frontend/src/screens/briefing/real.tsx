/**
 * REAL-PLAN F12 — what the briefing shows from the service's projection: the honest line that replaces a withheld section, and the
 * "sources and basis" card (each source with its period and state; NAVER-reported facts apart from Navis' own records and drafts).
 */
import type { ReactNode } from 'react';
import { kstLocal } from '../../data/reality/02/clock';
import { SOURCE_NAMES, type BriefingSource, type BriefingSourceState } from '../../data/reality/12/dto';
import { SECTION_SOURCES, isWithheld, type BriefingRealView, type SectionId } from '../../data/reality/12/overlay';
import { StatusBadge } from '../../ui';
import './sources.css';

/** What a screen hands in: its own translator and formatters (the arrival card and the widget detail use different bundle sets). */
export interface BriefingCopy {
  readonly t: (key: string, params?: Record<string, string | number>) => string;
  readonly date: (iso: string, style: 'short' | 'long') => string;
  readonly time: (hhmm: string) => string;
}

const BADGE: Readonly<Record<BriefingSourceState, 'done' | 'waiting' | 'warning'>> = { ready: 'done', partial: 'warning', unavailable: 'warning', 'not-connected': 'waiting' };
const KNOWN = new Set<string>(SOURCE_NAMES);
/** A source the app has no name for is shown as a generic line, never as the service's internal key. */
export const sourceLabel = ({ t }: BriefingCopy, key: string): string => t(KNOWN.has(key) ? `briefing.source.${key}` : 'briefing.source.unknown');

/** `2026-11-17 ~ 2026-11-23`, one date for a single day, or "current state" for a source without fixed bounds. */
export function periodText(copy: BriefingCopy, source: BriefingSource): string {
  const period = source.period;
  if (!period) return copy.t('briefing.period.current');
  return period.from === period.to ? copy.date(period.from, 'short') : copy.t('briefing.period.range', { from: copy.date(period.from, 'short'), to: copy.date(period.to, 'short') });
}

/** Store-local time of the source's observation, or empty when the service did not send one. */
export function asOfText(copy: BriefingCopy, source: BriefingSource): string {
  if (!source.asOf) return '';
  try { return copy.t('briefing.sources.asOf', { time: copy.time(kstLocal(source.asOf).slice(11, 16)) }); } catch { return ''; }
}

/** The state a source of this section is in when the briefing cannot show its rows: `null` when every source of the section is readable. */
export function withheldSources(model: { readonly real?: BriefingRealView }, sections: readonly SectionId[]): readonly { readonly key: string; readonly state: BriefingSourceState }[] {
  const real = model.real;
  if (!real) return [];
  const seen = new Set<string>();
  return sections.flatMap(section => SECTION_SOURCES[section]).flatMap(key => {
    if (seen.has(key)) return [];
    seen.add(key);
    const state = real.sources.find(source => source.key === key)?.state ?? 'not-connected';
    return isWithheld(state) ? [{ key, state }] : [];
  });
}

/** One honest line per source that keeps a section from being shown (not connected, or could not be read); nothing when all are readable. */
export function WithheldLines({ copy, model, sections }: { readonly copy: BriefingCopy; readonly model: { readonly real?: BriefingRealView }; readonly sections: readonly SectionId[] }): ReactNode {
  const lines = withheldSources(model, sections);
  if (!lines.length) return null;
  return <>{lines.map(({ key, state }) => <p key={key} className="briefing-withheld" role="note" data-source={key} data-state={state} lang="ko">{copy.t('briefing.withheld', { name: sourceLabel(copy, key), state: copy.t(`briefing.state.${state}`) })}</p>)}</>;
}

function Group({ copy, title, note, sources }: { readonly copy: BriefingCopy; readonly title: string; readonly note: string; readonly sources: readonly BriefingSource[] }) {
  if (!sources.length) return null;
  return <div className="mm-briefing-group" data-group={title}>
    <h4 className="mm-card__subtitle">{title}</h4>
    <p className="briefing-sources__note">{note}</p>
    <ul className="briefing-sources" role="list">
      {sources.map(source => {
        const asOf = asOfText(copy, source);
        return <li key={source.key} className="briefing-sources__row" data-source={source.key} data-state={source.state}>
          <span className="briefing-sources__text">
            <span>{sourceLabel(copy, source.key)}</span>
            <span className="briefing-sources__meta">{periodText(copy, source)}{asOf ? ` · ${asOf}` : ''}</span>
          </span>
          <StatusBadge semantic={BADGE[source.state]} label={copy.t(`briefing.state.${source.state}`)} />
        </li>;
      })}
    </ul>
  </div>;
}

const order = (source: BriefingSource): number => { const index = SOURCE_NAMES.indexOf(source.key as never); return index < 0 ? SOURCE_NAMES.length : index; };

/** One card for every source the service sent: Navis' own records and drafts first, then what NAVER itself reported, each with its period and state. */
export function SourcesCard({ copy, real }: { readonly copy: BriefingCopy; readonly real: BriefingRealView }) {
  const sorted = [...real.sources].sort((a, b) => order(a) - order(b));
  return <section className="mm-card mm-briefing-card" data-slot="briefing.sources" aria-label={copy.t('briefing.sources.title')}>
    <h3 className="mm-card__title">{copy.t('briefing.sources.title')}</h3>
    <Group copy={copy} title={copy.t('briefing.sources.navisTitle')} note={copy.t('briefing.sources.navisNote')} sources={sorted.filter(source => !source.provider)} />
    <Group copy={copy} title={copy.t('briefing.sources.naverTitle')} note={copy.t('briefing.sources.naverNote')} sources={sorted.filter(source => source.provider)} />
  </section>;
}
