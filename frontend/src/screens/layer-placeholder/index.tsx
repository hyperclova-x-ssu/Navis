import type { RunStore } from '../../contracts';
import { ActionButton, InlineEmpty } from '../../ui';
import { useShellT } from '../settings/use-shell-t';
import { placeholderLabelKeys, type PlaceholderLayer } from './labels';


export function LayerPlaceholder({ run, layer, onReturn }: { readonly run: RunStore; readonly layer: PlaceholderLayer; readonly onReturn: () => void }) {
  const { t } = useShellT();
  const label = t(placeholderLabelKeys[layer]);
  return <main className="order-screen">
    <header className="order-header">
      <h1 tabIndex={-1}>{label}</h1>
      <div className="order-header-actions"><ActionButton data-focus-key="settings" variant="outline" onClick={run.actions.openSettings}>{t('common.settings')}</ActionButton></div>
    </header>
    <div className="order-main"><InlineEmpty title={t('shell.soon', { layer: label })} action={<ActionButton size="primary" onClick={onReturn}>{t('shell.backToManagement')}</ActionButton>} /></div>
  </main>;
}
