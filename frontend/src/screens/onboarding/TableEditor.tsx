import { useId, useState } from 'react';
import type { TableLayout } from '../../contracts';
import { moveTable, resizeTableCount, setTableSeats } from '../../layout/table-layout';
import { TableGridEditor, TableSettingsPanel } from '../../ui';
import type { TableSettingsPanelProps } from '../../ui/components/table-grid-editor';
import { useBundle } from '../../i18n';
import { iteration5Bundle } from './messages';
export function TableEditor({value,onChange,linkPicker}:{value:TableLayout;onChange:(next:TableLayout)=>void;linkPicker?:TableSettingsPanelProps['linkPicker']}) {
  // Only screen glue: selection and the pure layout commands. Inputs, drag,
  // limits, list focus/scroll and announcements all belong to the shared kit.
  const editorId=useId();
  const [selected,setSelected]=useState<string|null>(null);
  const {t}=useBundle(iteration5Bundle);
  const update=(next:TableLayout|null)=>{if(next)onChange(next);};
  const selectedId=value.tables.some(table=>table.tableId===selected)?selected:null;
  const getListRowId=(id:string)=>`${editorId}-tables-${id}`;
  return <><div className="t207-tables">
    <TableGridEditor layout={value} selectedTableId={selectedId} getListRowId={getListRowId}
      onSelect={id=>setSelected(id===selectedId?null:id)}
      onMove={(id,x,y)=>update(moveTable(value,id,x,y))}
      onSeatsChange={(id,n)=>update(setTableSeats(value,id,n))}/>
    <TableSettingsPanel layout={value} selectedTableId={selectedId} getListRowId={getListRowId} linkPicker={linkPicker}
      onSelect={setSelected} onCountChange={n=>update(resizeTableCount(value,n))}
      onSeatsChange={(id,n)=>update(setTableSeats(value,id,n))}/>
  </div><p className="t207-table-hint">{t('tables.hint')}</p></>;
}
