import { getRegistration } from '../../catalog';
import type { DetailRef, FeatureId, RunState } from '../../contracts';
import { findPlacement } from '../../state';
import { dataBundles, resolveDataText, type WidgetDataStore } from '../../data/widget-data';
import { createTranslator, type Translator } from '../../i18n';
import { managementUiBundle } from '../../ui/management-messages';
import type { AgentHandoff } from './types';

export function destinationOpenLabel(destination: AgentHandoff, translator: Translator): string | undefined {
  const registration = getRegistration(destination.featureId);
  const title = registration ? translator.t(registration.nameKey)
    : destination.featureId === 'settings' ? translator.t('common.settings')
    : destination.featureId === 'pos' ? translator.t('app.layer.orders')
    : destination.featureId === 'pos-closing' ? managementUiBundle.ko['ui.closing.title']
    : undefined;
  return title ? `${title} 열기` : undefined;
}

/** Only existing, read-only history screens are offered for an unconfirmed dispatch. */
export function outboundHistoryDestination(command: string, scheduled: boolean): DetailRef | undefined {
  if (command === 'notice.send') return { featureId: 'notice-send', view: scheduled ? 'scheduled' : 'history' };
}

/** Opening a widget's detail never places or moves its panel. This says whether the widget sits on any board, so the chat can tell an owner it is not on theirs. */
export function detailBoardPlacement(state: RunState, featureId: FeatureId): 'placed' | 'off-board' {
  return findPlacement(state, featureId) ? 'placed' : 'off-board';
}

const koreanData = createTranslator('ko', ...dataBundles);

/** Only business rows an owner already reads on screen (menu items, ingredients) are named. Members and unknown ids stay out of the chat. */
function openedRowLabel(ref: DetailRef, snapshot: ReturnType<WidgetDataStore['getSnapshot']>): string | undefined {
  const { featureId, itemId } = ref;
  if (!itemId) return undefined;
  const row = featureId === 'menu' ? snapshot.tables.menuItem.find(item => item.menuId === itemId && !item.deletedAt)
    : featureId === 'inventory-booking' ? snapshot.tables.inventoryItem.find(item => item.itemId === itemId && !item.deletedAt)
    : undefined;
  return row ? resolveDataText(koreanData.t, row.name ?? { key: row.nameKey }) : undefined;
}

/** The chat line after a detail opens: which widget (and row) is now showing, and — because opening never places a panel — that an off-board widget is not on the owner's board. Fixed chat copy is Korean (D-329). */
export function openedDetailText(state: RunState, ref: DetailRef, snapshot: ReturnType<WidgetDataStore['getSnapshot']>, translator: Translator): string {
  const registration = getRegistration(ref.featureId);
  if (!registration) return translator.t('common.navis.nav.opened');
  const widget = `${translator.t(registration.nameKey)} 위젯`;
  const row = openedRowLabel(ref, snapshot);
  const opened = row ? `${widget}에서 ${row} 상세를 열었어요.` : `${widget} 화면을 열었어요.`;
  return detailBoardPlacement(state, registration.id) === 'off-board' ? `${opened} 보드에 없지만 상세는 볼 수 있어요.` : opened;
}
