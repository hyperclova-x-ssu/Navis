/**
 * R1-F17: Navis reads the same hydrated snapshot as the widget. When a data domain runs over the real port and has not been read
 * (never loaded, still loading, or the first load failed), that snapshot still holds the fixture seed rows, which are not the store's
 * facts. Navis treats such a domain as unavailable: no widget facts, no record matches, no card for its commands.
 * A domain that loaded once and then failed a refresh is `stale` (last good data) and stays readable, like the widget.
 * Without a port, or for a fixture domain, every method is the registry's own.
 */
import type { FeatureId } from '../../contracts';
import { isDataWidgetId } from '../../data/conditions';
import { widgetDomains, type RealDomain } from '../../data/reality/00/port';
import type { WidgetDataStore } from '../../data/widget-data';
import type { CommandAdapter, DomainRegistry } from './domains/registry';
import { AGENT_COMMAND_CATALOG, type AgentKnownCommand, type AgentSourceId } from '../../../shared/navis-agent-schema.mjs';
import { realCommandFor } from '../../../shared/navis-real-commands.mjs';

export function unreadableDomain(store: Pick<WidgetDataStore, 'real'>, domain: RealDomain): boolean {
  const state = store.real?.state(domain);
  return state?.mode === 'http' && state.status !== 'ready' && state.status !== 'stale';
}

export function unreadableWidget(store: Pick<WidgetDataStore, 'real'>, feature?: FeatureId | null): boolean {
  return !!feature && isDataWidgetId(feature) && widgetDomains(feature).some(domain => unreadableDomain(store, domain));
}

export function unreadableSource(store: Pick<WidgetDataStore, 'real'>, source: AgentSourceId): boolean {
  return source === 'pos' ? unreadableDomain(store, 'pos')
    : source === 'demand' && (['staff', 'booking', 'cctv'] as const).some(domain => unreadableDomain(store, domain));
}

export function gateUnreadable(domains: DomainRegistry, store: Pick<WidgetDataStore, 'real'>): DomainRegistry {
  const unreadable = (feature?: FeatureId | null) => unreadableWidget(store, feature);
  const unavailable = () => ({ kind: 'invalid' as const, messageKey: 'data.real.error.SOURCE_UNAVAILABLE' });
  return {
    ...domains,
    projectWidget: (snapshot, featureId, condition, locale) => {
      if (unreadable(featureId)) return { status: 'unavailable' };
      const projected = domains.projectWidget(snapshot, featureId, condition, locale);
      // The briefing's closing lines are derived from POS rows, a domain the briefing widget does not list. While POS is unread those rows
      // are the seed's empty ones, so the lines would read "0원": leave them out and keep the rest of the briefing.
      if (featureId === 'briefing' && projected && 'facts' in projected && unreadableDomain(store, 'pos')) {
        return { facts: projected.facts.filter(fact => !fact.key.startsWith('briefing.closing.')) };
      }
      return projected;
    },
    command(command: string) {
      const adapter = domains.command(command);
      if (!adapter || !unreadable(adapter.featureId)) return adapter;
      const blocked: CommandAdapter = { ...adapter, preflight: unavailable };
      return blocked;
    },
    runCommand(command) {
      const adapter = domains.runCommand(command);
      if (!adapter || !store.real) return adapter;
      const feature = AGENT_COMMAND_CATALOG[command as AgentKnownCommand]?.featureId as FeatureId | undefined;
      const metadata = realCommandFor(command);
      return { ...adapter, preflight(draft, context) {
        if (!unreadable(feature)) return adapter.preflight(draft, context);
        if (metadata?.workflow !== 'optional') return unavailable();
        const prepared = adapter.preflight(draft, context);
        return prepared.kind === 'ready' && prepared.realAction && prepared.realAction.domain === metadata.domain
          && !unreadableDomain(store, prepared.realAction.domain) ? prepared : unavailable();
      } };
    },
    reader(kind) {
      const adapter = domains.reader(kind);
      if (!adapter || !domains.readFeatures(undefined, kind).some(unreadable)) return adapter;
      return { kind, unavailable: true, search: () => [] };
    },
    tool(tool) {
      const adapter = domains.tool(tool);
      return adapter && domains.readFeatures(tool, undefined).some(unreadable)
        ? { ...adapter, read: () => ({ status: 'unavailable' }) } : adapter;
    },
    sourceUnavailable: source => unreadableSource(store, source),
  };
}
