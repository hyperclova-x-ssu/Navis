import type { RunStore } from '../../contracts';
import type { PosPreferences, PosTab } from '../../contracts/pos';
import { useBundle } from '../../i18n';
import { posBundle } from '../../i18n/messages/pos';
import { usePosSession, usePosSnapshot } from '../../pos/react';
import { selectPosPreferences, selectUnpaidBills, tablesEnabled } from '../../pos/tables';
import { ActionButton, ChoiceSubview } from '../../ui';
import { useTableCommands } from '../order/tables/actions';
import { openUnpaidOrders } from './start-view';

export function OrderPreferences({ run, onBack, onClose, interactive = true }: { run: RunStore; onBack: () => void; onClose: () => void; interactive?: boolean }) {
  const runtime = usePosSession(), read = usePosSnapshot(), { t } = useBundle(posBundle), preferences = selectPosPreferences(read.settings);
  const execute = useTableCommands(({ message, undoToken }) => run.actions.showNotice({ kind: 'complete', messageKey: 'pos.notice', params: { message }, ...(undoToken ? { undo: { target: 'pos', token: undoToken } } : {}) }));
  const hasTables = tablesEnabled(read.settings), unpaid = selectUnpaidBills(read).length > 0;
  const options = ['order' as const, ...(preferences.showStatus ? ['status' as const] : []), ...(hasTables && preferences.showTables ? ['tables' as const] : [])];
  const toggle = (key: 'showStatus' | 'showTables', value: boolean) => {
    if (!interactive) return;
    const result = execute({ type: 'pos.setPreferences', [key]: value });
    if (result.ok && !value && read.posUi.tab === (key === 'showTables' ? 'tables' : 'status')) runtime.setTab('order');
  };
  return <div lang="ko"><ChoiceSubview<PosTab> title={t('pos.settingsTitle')} groupLabel={t('pos.startScreen')} value={preferences.startTab} options={options.map(value => ({ value, label: t(`pos.${value}`) }))} onBack={onBack} onClose={onClose} onChange={startTab => { if (interactive) execute({ type: 'pos.setPreferences', startTab }); }}/>
    <h3>{t('pos.showTabs')}</h3><div className="ui-setting-row"><div>{t('pos.order')}<p className="ui-setting-description">{t('pos.orderAlways')}</p></div></div>
    {(['showStatus', ...(hasTables ? ['showTables'] : [])] as (keyof Pick<PosPreferences, 'showStatus' | 'showTables'>)[]).map(key => <div key={key} className="ui-setting-row"><span>{t(key === 'showStatus' ? 'pos.status' : 'pos.tables')}</span><ActionButton className="ui-switch pos-settings-switch" role="switch" aria-label={t(key === 'showStatus' ? 'pos.status' : 'pos.tables')} aria-checked={preferences[key]} data-checked={preferences[key] ? '' : undefined} disabled={!interactive || key === 'showTables' && unpaid} aria-describedby={key === 'showTables' && unpaid ? 'pos-settings-unpaid' : undefined} onClick={() => toggle(key, !preferences[key])}><span className="ui-switch-track"><span className="ui-switch-thumb"/></span></ActionButton></div>)}
    {unpaid ? <div><p id="pos-settings-unpaid">{t('pos.settingsBlocked')}</p><ActionButton variant="secondary" onClick={() => { if (interactive) openUnpaidOrders(run); }}>{t('pos.showOrders')}</ActionButton></div> : null}
  </div>;
}
