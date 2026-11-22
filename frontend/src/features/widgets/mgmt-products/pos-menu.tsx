import { useRef, useState } from 'react';
import type { WidgetHost } from '../../../contracts';
import type { PosOption, PosOptionGroup, PosRecipePart } from '../../../contracts/pos';
import { dataBundles, resolveDataText } from '../../../data/widget-data';
import { useBundle } from '../../../i18n';
import { ActionButton, DataGrid, InlineForm, NumberField, SegmentedControl, TextField, type DataGridHandle, type GridColumn, type GridFocus } from '../../../ui';
import { menuError, menuPosBundle, menuPosKo as ko, reportMenuResult } from './pos-menu-messages';
import { menuGridResult, onMenuResult, useMenuCommand, useMenuIngredients, type MenuResult } from './menu-controls';
import './pos-menu.css';

type Save = (groups: readonly PosOptionGroup[]) => MenuResult;
const active = (groups: readonly PosOptionGroup[]) => groups.filter(g => !g.archivedAt).map(g => ({ ...g, options: g.options.filter(o => !o.archivedAt) }));

function RecipePartEditor({ part, label, unit, onSave, onRemove }: { part: PosRecipePart; label: string; unit: string; onSave: (part: PosRecipePart) => MenuResult; onRemove: () => void }) {
  const [draft, setDraft] = useState<number | null | undefined>(undefined), [error, setError] = useState('');
  const quantity = draft === undefined ? part.quantityBase : draft;
  const commit = () => {
    if (quantity === part.quantityBase) { setDraft(undefined); setError(''); return; }
    onMenuResult(onSave({ ...part, quantityBase: quantity ?? NaN }), result => {
      setError(result.ok ? '' : ko.unit);
      if (result.ok) setDraft(undefined);
    });
  };
  return <div className="menu-pos-actions"><div onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}>
    <NumberField label={label} value={quantity} onValueChange={setDraft} unit={unit} error={error || undefined}/>
  </div><ActionButton variant="ghost" onClick={onRemove}>{label} 지우기</ActionButton></div>;
}

function OptionRecipe({ option, onSave }: { option: PosOption; onSave: (option: PosOption) => MenuResult }) {
  const text = useBundle(menuPosBundle, ...dataBundles);
  const ingredients = useMenuIngredients();
  const available = ingredients.filter(item => !option.extraRecipe.some(p => p.itemId === item.itemId));
  const [adding, setAdding] = useState(false), [itemId, setItemId] = useState(''), [quantity, setQuantity] = useState<number | null>(null), [error, setError] = useState('');
  const itemName = (id: string) => { const item = ingredients.find(i => i.itemId === id); return item ? resolveDataText(text.t, item.name ?? { key: item.nameKey }) : text.t('data.state.inventory-booking.partial-data'); };
  const dimension = (id: string) => { const unit = ingredients.find(i => i.itemId === id)?.unit; return unit === 'L' || unit === 'mL' ? 'mL' as const : unit === 'kg' || unit === 'g' ? 'g' as const : 'pcs' as const; };
  const unit = (id: string) => dimension(id) === 'pcs' ? '개' : dimension(id);
  return <div className="menu-pos-recipe">
    {option.extraRecipe.map(part => <RecipePartEditor key={part.itemId} part={part} label={itemName(part.itemId)} unit={part.unitDimension === 'pcs' ? '개' : part.unitDimension} onSave={next => onSave({ ...option, extraRecipe: option.extraRecipe.map(p => p.itemId === part.itemId ? next : p) })} onRemove={() => onSave({ ...option, extraRecipe: option.extraRecipe.filter(p => p.itemId !== part.itemId) })}/>)}
    {!option.extraRecipe.length ? <p>{ko.none}</p> : null}
    <ActionButton variant="secondary" disabled={!available.length} onClick={() => { setItemId(available[0]?.itemId ?? ''); setQuantity(null); setError(''); setAdding(true); }}>재료 추가</ActionButton>
    {adding ? <InlineForm title={ko.extraRecipe} saveLabel="재료 넣기" onClose={() => setAdding(false)} onSave={() => {
      onMenuResult(onSave({ ...option, extraRecipe: [...option.extraRecipe, { itemId, quantityBase: quantity ?? NaN, unitDimension: dimension(itemId) }] }), result => {
        if (result.ok) setAdding(false); else setError(menuError(result, text.t));
      });
    }}><label className="ui-field">재료 선택<select className="ui-text-input" value={itemId} onChange={e => setItemId(e.target.value)}>{available.map(item => <option key={item.itemId} value={item.itemId}>{itemName(item.itemId)}</option>)}</select></label>
      <NumberField label={ko.extraRecipe} value={quantity} onValueChange={setQuantity} unit={unit(itemId)} error={error || undefined}/>
    </InlineForm> : null}
  </div>;
}

function GroupName({ group, save }: { group: PosOptionGroup; save: (group: PosOptionGroup) => MenuResult }) {
  const [draft, setDraft] = useState<string | null>(null), [error, setError] = useState('');
  const value = draft ?? group.name;
  const commit = () => {
    if (value.trim() === group.name) { setDraft(null); setError(''); return; }
    onMenuResult(save({ ...group, name: value }), result => {
      setError(result.ok ? '' : ko.groupEmpty);
      if (result.ok) setDraft(null);
    });
  };
  return <div onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } else if (event.key === 'Escape') { setDraft(null); setError(''); } }}>
    <TextField label={ko.groupName} value={value} onValueChange={setDraft} error={error || undefined}/>
  </div>;
}

function OptionGroupEditor({ group, groups, save, pending, http }: { group: PosOptionGroup; groups: readonly PosOptionGroup[]; save: Save; pending: boolean; http: boolean }) {
  const text = useBundle(menuPosBundle, ...dataBundles);
  const [focus, setFocus] = useState<GridFocus>(null), [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false), [newName, setNewName] = useState(''), [price, setPrice] = useState<number | null>(0), [error, setError] = useState('');
  const grid = useRef<DataGridHandle>(null);
  const saveGroup = (next: PosOptionGroup) => save(groups.map(g => g.groupId === group.groupId ? next : g));
  const update = (option: PosOption) => saveGroup({ ...group, options: group.options.map(o => o.optionId === option.optionId ? option : o) });
  const ingredients = useMenuIngredients();
  const columns: GridColumn<PosOption>[] = [
    { id: 'name', header: ko.optionName, kind: 'text', value: o => o.name, minWidth: 120, editable: () => true },
    { id: 'price', header: ko.extraPrice, kind: 'number', value: o => o.extraPrice, minWidth: 96, editable: () => true, editor: 'number', unit: '원' },
    { id: 'recipe', header: ko.extraRecipe, kind: 'computed', value: o => o.extraRecipe.length ? o.extraRecipe.map(p => {
      const item = ingredients.find(i => i.itemId === p.itemId);
      return `${item ? resolveDataText(text.t, item.name ?? { key: item.nameKey }) : ''} ${p.quantityBase} ${p.unitDimension === 'pcs' ? '개' : p.unitDimension}`;
    }).join(' · ') : ko.none, minWidth: 120, expandOnActivate: () => true },
  ];
  return <article className="menu-pos-group" aria-label={group.name} data-menu-option-group={group.groupId}>
    <div className="menu-pos-group-header"><GroupName group={group} save={saveGroup}/>
      <SegmentedControl label={`${group.name} ${ko.required}`} value={group.required ? 'required' : 'optional'} options={[{ value: 'required', label: ko.required }, { value: 'optional', label: ko.optional }]} onChange={value => {
        onMenuResult(saveGroup({ ...group, required: value === 'required' }), result => setError(result.ok ? '' : menuError(result, text.t)));
      }}/>
      <ActionButton variant="ghost" onClick={() => save(groups.filter(g => g.groupId !== group.groupId))}>{group.name} 지우기</ActionButton>
    </div>
    <DataGrid id={`menu-options-${group.groupId}`} ref={grid} label={`${group.name} 옵션`} rows={group.options} columns={columns} getRowId={o => o.optionId} getRowLabel={o => o.name}
      sort={null} onSortChange={() => {}} selectedRowId={null} expandedRowIds={expanded} onExpandedChange={setExpanded} getExpandAction={o => ({ label: `${o.name} ${ko.extraRecipe}` })}
      renderExpanded={o => <OptionRecipe option={o} onSave={update}/>} focus={focus} onFocusChange={setFocus}
      onCommit={edit => {
        const option = group.options.find(o => o.optionId === edit.rowId)!;
        const result = update(edit.columnId === 'price' ? { ...option, extraPrice: edit.raw.trim() ? Number(edit.raw) : NaN } : { ...option, name: edit.raw });
        return menuGridResult(result, edit.editToken, text.t);
      }} getRowActions={option => [{ id: 'delete', label: `${option.name} 지우기`, onPress: () => {
        onMenuResult(saveGroup({ ...group, options: group.options.filter(o => o.optionId !== option.optionId) }),
          result => setError(result.ok ? '' : menuError(result, text.t)));
      } }]} emptyContent={ko.none}/>
    <ActionButton variant="ghost" disabled={pending} onClick={() => { setNewName(''); setPrice(0); setError(''); setAdding(true); }}>{ko.addOption}</ActionButton>
    {adding ? <InlineForm title={ko.addOption} saveLabel="저장하기" saving={pending} onClose={() => setAdding(false)} onSave={() => {
      const uuid = crypto.randomUUID();
      const option: PosOption = { optionId: http ? uuid : `option-${uuid}`, groupId: group.groupId, name: newName, extraPrice: price ?? NaN, extraRecipe: [], extraCost: null };
      onMenuResult(saveGroup({ ...group, options: [...group.options, option] }), result => {
        if (result.ok) { setAdding(false); setError(''); } else setError(menuError(result, text.t));
      });
    }}><TextField label={ko.optionName} value={newName} onValueChange={setNewName} error={error === ko.optionEmpty ? error : undefined}/><NumberField label={ko.extraPrice} value={price} onValueChange={setPrice} unit="원" error={error === ko.amount ? error : undefined}/></InlineForm> : null}
    {error && error !== ko.optionEmpty && error !== ko.amount ? <p role="alert">{error}</p> : null}
  </article>;
}

export function MenuOptions({ menuId, name, groups, host }: { menuId: string; name: string; groups: readonly PosOptionGroup[]; host: WidgetHost }) {
  const { send, pending, http } = useMenuCommand(), text = useBundle(menuPosBundle, ...dataBundles);
  const [adding, setAdding] = useState(false), [newName, setNewName] = useState(''), [error, setError] = useState('');
  const root = useRef<HTMLElement>(null), add = useRef<HTMLButtonElement>(null);
  const live = active(groups);
  const save: Save = next => {
    const focused = document.activeElement?.closest<HTMLElement>('[data-menu-option-group]')?.dataset.menuOptionGroup;
    const command = { type: 'menu.setOptions' as const, menuId, groups: next };
    const result = send(command);
    onMenuResult(result, response => {
      reportMenuResult(host, response, command, name, text.t);
      if (response.ok && focused && !next.some(g => g.groupId === focused)) queueMicrotask(() => {
        if (root.current) (root.current.querySelector<HTMLInputElement>('.menu-pos-group input') ?? add.current)?.focus();
      });
    });
    return result;
  };
  return <section ref={root} className="menu-pos-section" aria-label={ko.options} aria-busy={pending || undefined}><h4>{ko.options}</h4>
    {live.map(group => <OptionGroupEditor key={group.groupId} group={group} groups={live} save={save} pending={pending} http={http}/>)}
    <ActionButton ref={add} variant="secondary" disabled={pending} onClick={() => { setNewName(''); setError(''); setAdding(true); }}>{ko.addGroup}</ActionButton>
    {adding ? <InlineForm title={ko.addGroup} saveLabel="저장하기" saving={pending} onClose={() => setAdding(false)} onSave={() => {
      const uuid = crypto.randomUUID();
      onMenuResult(save([...live, { groupId: http ? uuid : `group-${uuid}`, menuId, name: newName, required: false, options: [] }]),
        result => { if (result.ok) setAdding(false); else setError(menuError(result, text.t)); });
    }}><TextField label={ko.groupName} value={newName} onValueChange={setNewName} error={error || undefined}/></InlineForm> : null}
  </section>;
}
