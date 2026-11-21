/**
 * Test and dev-host harness for the mgmt-supply widgets (not used by the app). It frames a module panel the way
 * the dashboard does (kit FeaturePanel) and emulates the T-053 detail stack: `openLinked` keeps the first detail
 * and shows the linked one with ‘돌아가기’, `openDetail` opens a new root. Notifications are listed with the
 * data undo (`useDataUndo`), as the dashboard's notice host does.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { CellSpan, DetailRef, FeatureId, MessageParams, QueryCondition, WidgetHost, WidgetModule } from '../../../contracts';
import { useDataUndo } from '../../../data/react';
import { ActionButton, FeaturePanel, panelShape, RemoveButton, ResizeHandle, useKitT, useUi } from '../../../ui';
import { useI18n } from '../../../i18n';
import { widgets } from './index';
import { useSupplyText } from './shared';

const DEFAULT: QueryCondition = Object.freeze({ kind: 'default' });
export const moduleOf = (id: FeatureId): WidgetModule => {
  const found = widgets.find((m) => m.id === id);
  if (!found) throw new Error(`No mgmt-supply module for ${id}`);
  return found;
};

export interface HostNotice { readonly kind: 'success' | 'complete' | 'error'; readonly messageKey: string; readonly params?: MessageParams; readonly undoToken?: string }
export interface HostEvents {
  readonly onLinked?: (ref: DetailRef) => void;
  readonly onDetail?: (ref: DetailRef) => void;
  readonly onReset?: (featureId: FeatureId) => void;
  readonly onNotify?: (notice: HostNotice) => void;
  readonly onBriefing?: () => void;
}

export function createTestHost(featureId: FeatureId, events: HostEvents = {}): WidgetHost {
  return {
    layer: 'management',
    openClosing: () => false,
    resetPreview: () => events.onReset?.(featureId),
    openLinked: (ref) => events.onLinked?.(ref),
    openDetail: (ref) => events.onDetail?.(ref),
    notify: (n) => events.onNotify?.(n),
    acknowledgeBriefing: () => events.onBriefing?.(),
  };
}

/** A module panel inside the kit FeaturePanel (dashboard frame: title, (?) slot, accessible name with the key sentence). */
export function SupplyPanel({ id, width, height, editing = false, host, condition = DEFAULT, row = 1, column = 1 }: { readonly id: FeatureId; readonly width: CellSpan; readonly height: CellSpan; readonly editing?: boolean; readonly host?: WidgetHost; readonly condition?: QueryCondition; readonly row?: number; readonly column?: number }) {
  const module = moduleOf(id);
  const { t } = useI18n();
  const args = useMemo(() => ({ featureId: id, condition }), [id, condition]);
  const summary = module.useSummary(args);
  const {screenPreset}=useUi();
  const panelHost = host ?? createTestHost(id);
  const name = t(`widget.${id}.title`);
  return <FeaturePanel featureId={id} label={name} groupId={id==='calendar'?'schedule':'stock'} width={width} height={height} row={row} column={column} summary={summary} editing={editing} onHelp={() => {}} controls={editing?<><RemoveButton label={name} onClick={()=>{}}/><ResizeHandle label={name} width={width} height={height} onClick={()=>{}}/></>:undefined}>
    <module.Panel featureId={id} condition={condition} width={width} height={height} shape={panelShape(width, height)} presetId={screenPreset.id} editing={editing} host={panelHost} />
  </FeaturePanel>;
}

/** Frame for a detail (the dev host passes the kit DialogFrame; tests use plain markup). */
export type DetailFrameRender = (args: { readonly title: string; readonly featureId: FeatureId; readonly back: ReactNode; readonly body: ReactNode }) => ReactNode;

/** The detail stack (max 2, ‘돌아가기’ to the first). Every module host maps to this stack and the events. */
export function DetailStack({ root, events = {}, children, frame, modules=widgets }: { readonly root: DetailRef; readonly events?: HostEvents; readonly children?: ReactNode; readonly frame?: DetailFrameRender;readonly modules?:readonly WidgetModule[] }) {
  const [stack, setStack] = useState<readonly DetailRef[]>([root]);
  const [notices, setNotices] = useState<readonly HostNotice[]>([]);
  const undo = useDataUndo();
  const kit = useKitT();
  const { t } = useI18n();
  const x = useSupplyText();
  const top = stack[stack.length - 1]!;

  const title = t(`widget.${top.featureId}.title`);
  const back = stack.length > 1 ? <ActionButton variant="secondary" data-action="back" onClick={() => setStack((s) => [s[0]!])}>{t('common.back')}</ActionButton> : null;
  const body = <>{stack.map((ref,index)=>{
    const Detail=modules.find(m=>m.id===ref.featureId)?.Detail;
    const host=createTestHost(ref.featureId,{
      ...events,
      onLinked:next=>{events.onLinked?.(next);setStack(s=>[s[0]!,next]);},
      onDetail:next=>{events.onDetail?.(next);setStack([next]);},
      onNotify:n=>{events.onNotify?.(n);setNotices(list=>[...list,n]);},
    });
    return <div key={`${ref.featureId}:${ref.itemId??''}:${ref.view??''}`} hidden={index!==stack.length-1} inert={index!==stack.length-1||undefined}>{Detail?<Detail featureId={ref.featureId} condition={DEFAULT} detailRef={ref} host={host}/>:null}</div>;
  })}</>;
  const noticeList = <ul className="ms-harness__notices" aria-label="notices">{notices.map((n, i) => <li key={i} data-key={n.messageKey}>
    <span>{x.tk(n.messageKey, n.params)}</span>
    {n.undoToken ? <ActionButton variant="link" onClick={() => undo(n.undoToken!)}>{kit.t('ui.notice.undoAction')}</ActionButton> : null}
  </li>)}</ul>;
  return <div className="ms-harness">
    <section className="ms-harness__detail" aria-label={`detail:${top.featureId}`} data-detail={top.featureId}>
      {frame ? frame({ title, featureId: top.featureId, back, body: <>{body}{noticeList}</> }) : <>
        <header className="ms-harness__head">{back}<h2 className="ms-harness__title">{title}</h2></header>
        {body}
      </>}
    </section>
    {frame ? null : noticeList}
    {children}
  </div>;
}
