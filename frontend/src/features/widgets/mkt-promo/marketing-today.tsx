/**
 * 오늘 할 홍보 (marketing-today, T-060): three slots (지금 · 오늘 · 이번 주) read from the other marketing widgets.
 * It has no detail of its own (API-13 v4.1: Detail = null); a body press opens the first visible slot's target
 * ("출처 열기" rule), the slot buttons open the target widget's detail with its action open.
 */
import { FitProbe, PROMO_FIT } from './fit';
import type { DetailRef, FeatureId, QueryCondition, WidgetModule, WidgetPanelProps } from '../../../contracts';
import type { Translator } from '../../../i18n';
import type { TodayCell } from '../../../data/widget-data';
import { useDomainState, useRealRetry, useWidgetView } from '../../../data/react';
import { PanelAction, PanelState } from '../../../ui';
import { NoteLine, useFit, useT } from './shared';
import { usePromoCatalogSync } from './promo-hooks';
import { koreanLang } from '../mkt-local/fit';
import './widget.css';

const FEATURE_ID = 'marketing-today' as const;
const SLOT_GROUP: Readonly<Record<TodayCell['kind'], string>> = { 'quiet-hours': 'customers', expiry: 'money', replies: 'customers', video: 'news' };
/** Where the "nothing to do" state and the empty tap lead (진행 중인 쿠폰). */
export const ACTIVE_COUPONS_REF: DetailRef = { featureId: 'slot-coupon', view: 'send' };

interface CellText { readonly first: string; readonly second: string | null; readonly long: string; readonly short: string }
const hasAudience = (cell: TodayCell) => cell.kind !== 'quiet-hours' || cell.params.regulars > 0;

/** The two sentences and the two button labels of a slot (LOCALES 9.3; the expiry cell has one sentence). */
export function cellText(t: Translator<string>, cell: TodayCell, compact = false): CellText {
  switch (cell.kind) {
    case 'quiet-hours': {
      const { quietSlot } = cell;
      return {
        first: t.t('widget.marketing-today.quiet.s1', { day: t.format.weekday(quietSlot.date, compact && t.locale === 'en' ? 'short' : 'long'), s: quietSlot.startHour, e: quietSlot.endHour }),
        second: t.t('widget.marketing-today.quiet.s2', { n: cell.params.regulars }),
        long: t.t('marketing.sendCoupon'), short: t.t('marketing.sendCoupon'),
      };
    }
    case 'expiry':
      // HTTP: the lot's own item name (`itemNameKey` is empty then).
      return { first: t.t('widget.marketing-today.expiry.s1', { item: cell.itemName ?? t.t(cell.itemNameKey), n: cell.params.count }), second: null, long: t.t('marketing.createCoupon'), short: t.t('marketing.createCoupon') };
    case 'replies':
      // HTTP: "drafts are ready" only when real drafts were saved (`drafted` is absent in fixture mode, which keeps the sentence).
      return { first: t.t(cell.params.drafted === undefined ? 'widget.marketing-today.replies.s1' : 'widget.marketing-today.replies.recorded', { n: cell.params.count }), second: cell.params.drafted === 0 ? null : t.t('widget.marketing-today.replies.s2'), long: t.t('marketing.checkReplies'), short: t.t('marketing.checkReplies') };
    case 'video':
      return { first: t.t('widget.marketing-today.video.photos', { n: cell.params.photos }), second: null, long: t.t('marketing.makeVideo'), short: t.t('marketing.makeVideo') };
  }
}

/** How many slots a shape shows, in order from the top (SCR-37: 1x1 the first, 2x1 the top two, 4x1 all three). */
export function slotCount(width: number, height: number): number {
  if (width === 1 && height === 1) return 1;
  if (height === 1) return width === 2 ? 2 : 3;
  if (width === 1) return height === 2 ? 2 : 3;
  return 3;
}

/**
 * Fitting rules (D-65, SCR-37): drop the second sentence first (English/Chinese or 125% text; narrow shapes always), then the
 * time tag (125% on preset A). The first sentence, the button name and (outside that one case) the tag always stay.
 */
export function slotFit(args: { readonly width: number; readonly height: number; readonly locale: string; readonly large: boolean; readonly presetId: string }) {
  const { width, height, locale, large, presetId } = args;
  const roomy = width === 4 || height >= 3;
  return {
    showSecond: height>=2 && roomy && locale === 'ko' && (!large || height === 4),
    showTag: locale === 'ko' || (!(large && presetId === 'A' && (height === 1 || width === 1)) && !(width === 1 && height === 1)),
    shortLabels: width <= 2,
  };
}

export function MarketingTodayPanel({ featureId, condition, width, height, shape, host: shellHost }: WidgetPanelProps) {
  const t = useT();
  usePromoCatalogSync();
  const view = useWidgetView(FEATURE_ID, condition);
  // HTTP groups domain: the error state's retry re-reads the service instead of resetting a sample state.
  const retry = useRealRetry('groups');
  const host = useDomainState('groups').mode === 'http' ? { ...shellHost, resetPreview: retry } : shellHost;
  const fit = useFit();
  const name = t.t('widget.marketing-today.title');
  const rule = slotFit({ width, height, locale: fit.locale, large: fit.large, presetId: fit.presetId });
  const shown = view.status === 'ready' ? view.model.cells.filter(hasAudience).slice(0, slotCount(width, height)) : [];

  if (view.status === 'error') {
    return <div className="mp-root" data-widget={featureId} data-shape={shape} data-state="error"><PanelState tone="error" shape={shape} message={t.locale === 'ko' && (shape === 'Q' || (shape === 'W' && width <= 2)) ? t.t('widget.marketing-today.state.error.short') : t.t(view.messageKey)} shortMessage={t.t('widget.marketing-today.state.error.short')} action={{ label: t.t('common.retry'), widgetName: name, onPress: () => host.resetPreview() }} /></div>;
  }
  if (view.status === 'empty') {
    const action = view.actionKey ? { label: t.t(view.actionKey), widgetName: name, onPress: () => host.openDetail(ACTIVE_COUPONS_REF) } : undefined;
    return <div className="mp-root" data-widget={featureId} data-shape={shape} data-state="empty" data-slot="marketing-today.empty"><PanelState tone="info" shape={shape} message={t.t(view.messageKey)} shortMessage={view.messageKey === 'data.state.marketing-today.none' ? t.t('widget.marketing-today.state.none.short') : undefined} action={action} /></div>;
  }
  if (view.status === 'ready' && shown.length === 0) {
    const notes = view.notes ?? [];
    return <div className="mp-root" data-widget={featureId} data-shape={shape} data-state="empty" data-slot="marketing-today.empty">
      {notes.length ? <NoteLine notes={notes} slot="marketing-today.note" mode="full" /> : <PanelState tone="info" shape={shape} message={t.t('data.state.marketing-today.none')} shortMessage={t.t('widget.marketing-today.state.none.short')} />}
    </div>;
  }
  const notes = view.notes ?? [];
  const compact = width === 1 && height === 1;
  const columns = height === 1 && width >= 2;
  return (
    <div className="mp-root mp-today" data-widget={featureId} data-shape={shape} data-state="ready" data-w={width} data-h={height} data-layout={columns ? 'columns' : width === 1 ? 'stack' : 'rows'} data-slots={shown.length}><FitProbe order={PROMO_FIT} />
      <div className="mp-today__slots" role="group" aria-label={t.t('widget.marketing-today.group')}>
        {shown.map((cell, index) => {
          const text = cellText(t, cell, compact);
          const tag = cell.kind === 'quiet-hours' ? t.t('widget.marketing-today.slot.window') : t.t(`widget.marketing-today.slot.${cell.slot}`);
          const label = rule.shortLabels ? text.short : text.long;
          return (
            <section key={cell.slot} className="mp-slot" data-slot={`marketing-today.slot.${cell.slot}`} data-kind={cell.kind} data-first={index === 0 ? 'true' : undefined} aria-label={`${tag}: ${text.first}`}>
              {rule.showTag ? <span className="mp-slot__tag" style={{ color: `var(--group-${SLOT_GROUP[cell.kind]})` }} data-slot="marketing-today.slot.tag">{tag}</span> : <span className="ui-sr-only">{tag}</span>}
              {compact && !fit.large ? <span className="mp-slot__big" hidden /> : null}
              <p className="mp-slot__text" data-slot="marketing-today.slot.text"><span className="mp-slot__first" lang={koreanLang(text.first)}>{text.first.replace('메시지·리뷰', '메시지\u2060·\u2060리뷰')}{rule.showSecond && text.second && t.locale === 'ko' ? '.' : ''}</span>{rule.showSecond && text.second ? <span className="mp-slot__second" lang={koreanLang(text.second)}> {text.second}</span> : null}</p>
              <PanelAction label={label} widgetName={name} onPress={() => host.openDetail(cell.ref)} className="mp-slot__action" />
            </section>
          );
        })}
      </div>
      <NoteLine notes={notes} slot="marketing-today.note" mode={compact ? 'sr' : width === 4 || height >= 2 ? 'full' : 'badge'} />
    </div>
  );
}

/** Accessible key sentence: the first visible slot's first sentence (the state text when nothing is left). */
export function useMarketingTodaySummary({ condition }: { readonly featureId: FeatureId; readonly condition: QueryCondition }): string {
  const t = useT();
  const view = useWidgetView(FEATURE_ID, condition);
  if (view.status !== 'ready') return t.t(view.messageKey);
  const first = view.model.cells.find(hasAudience);
  return first ? cellText(t, first).first : t.t('widget.marketing-today.sr.nothing');
}

/** A body press opens the first visible slot's target; with every slot empty it opens the active coupons (SCR-37). */
export function useMarketingTodayTapTarget({ condition }: { readonly featureId: FeatureId; readonly condition: QueryCondition }): DetailRef | null {
  void condition;
  return null;
}

export const marketingTodayModule: WidgetModule = {
  id: FEATURE_ID,
  Panel: MarketingTodayPanel,
  Detail: null,
  useSummary: useMarketingTodaySummary,
  useTapTarget: () => null,
};
