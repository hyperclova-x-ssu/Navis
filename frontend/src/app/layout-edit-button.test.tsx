// U-B: the header button "배치 편집" enters the same edit mode as the panel long-press (run.actions.enterEditing), next to 마감 정산.
import {beginDashboard} from './test-session';
import '../ui/test-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { createRunStore } from '../state';
import { timePolicy } from '../ui';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { App } from './App';

const OriginalWorker=globalThis.Worker;
class ReadyWorker {onmessage:((e:{data:{type:string}})=>void)|null=null;postMessage(message:{type:string}){if(message.type==='ready')queueMicrotask(()=>this.onmessage?.({data:{type:'ready'}}));}terminate(){}}
beforeEach(()=>vi.stubGlobal('Worker',ReadyWorker));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.stubGlobal('Worker',OriginalWorker);document.documentElement.removeAttribute('lang');});
const makeRun=()=>createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light',reducedMotion:true});
const withPanels=()=>{const run=makeRun();beginDashboard(run,'cafe');run.actions.startWithThree();run.actions.dismissCoach();return run;};
const emptyPage=()=>{const run=makeRun();beginDashboard(run,'cafe');run.actions.dismissCoach();return run;};
const header=()=>document.querySelector<HTMLElement>('.app-closing-header')!;

describe('배치 편집 header button',()=>{
 it('sits in the closing header next to 마감 정산, with an icon and the same kit surface',()=>{
  render(<App run={withPanels()}/>);
  const edit=within(header()).getByRole('button',{name:'배치 편집하기'});
  expect(edit).toBeEnabled();expect(edit).toHaveTextContent('배치 편집');
  expect(edit.querySelector('svg.ui-icon')).not.toBeNull();
  const closing=within(header()).getByRole('button',{name:'마감 정산 열기'});
  expect(edit.closest('.app-layout-edit')!.nextElementSibling).toBe(closing);
  expect(edit.className).toContain('ui-button--secondary');expect(closing.className).toContain('ui-button--secondary');
  expect(edit).toHaveClass('app-layout-edit-button');
 });
 it('enters the existing edit mode, hides itself like 마감 정산 and comes back after 완료',async()=>{
  const run=withPanels();const user=userEvent.setup();render(<App run={run}/>);
  expect(run.getState().edit.mode).toBe('view');
  await user.click(screen.getByRole('button',{name:'배치 편집하기'}));
  expect(run.getState().edit.mode).toBe('edit');
  expect(screen.queryByRole('button',{name:'배치 편집하기'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'마감 정산 열기'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'완료'}));
  expect(run.getState().edit.mode).toBe('view');
  expect(screen.getByRole('button',{name:'배치 편집하기'})).toBeEnabled();
 });
 it('works from the keyboard like the neighbouring button (Tab reaches it, Enter and Space press it)',async()=>{
  const run=withPanels();const user=userEvent.setup();render(<App run={run}/>);
  const edit=screen.getByRole('button',{name:'배치 편집하기'});edit.focus();expect(edit).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(run.getState().edit.mode).toBe('edit');
  await user.click(screen.getByRole('button',{name:'완료'}));
  const again=screen.getByRole('button',{name:'배치 편집하기'});again.focus();
  await user.keyboard(' ');
  expect(run.getState().edit.mode).toBe('edit');
 });
 it('keeps keyboard focus in the flow: into the toolbar 완료 on entering, back to the button after 완료',async()=>{
  const run=withPanels();const user=userEvent.setup();render(<App run={run}/>);
  const edit=screen.getByRole('button',{name:'배치 편집하기'});edit.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button',{name:'완료'})).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(run.getState().edit.mode).toBe('view');
  expect(screen.getByRole('button',{name:'배치 편집하기'})).toHaveFocus();
 });
 it('stays visible but disabled with a short reason when the page has no panel',async()=>{
  const run=emptyPage();const user=userEvent.setup();render(<App run={run}/>);
  expect(run.getState().panels).toHaveLength(0);
  const edit=screen.getByRole('button',{name:'배치 편집하기'});
  expect(edit).toBeDisabled();
  const reason=screen.getByText('먼저 패널을 추가해 주세요');
  expect(reason).toBeVisible();expect(reason).not.toHaveClass('ui-sr-only');
  expect(edit.getAttribute('aria-describedby')).toBe(reason.id);
  await user.click(edit);
  expect(run.getState().edit.mode).toBe('view');
 });
 it('shows no reason while there is something to edit, and the reason leaves once a panel is added',()=>{
  const run=emptyPage();render(<App run={run}/>);
  expect(screen.getByText('먼저 패널을 추가해 주세요')).toBeInTheDocument();
  act(()=>{expect(run.actions.applyLayoutIntent({type:'add-tap',featureId:'tax'}).status).not.toBe('rejected');});
  expect(screen.queryByText('먼저 패널을 추가해 주세요')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'배치 편집하기'})).toBeEnabled();
 });
 it('is not offered on the order layer, where there is no layout to edit',async()=>{
  const run=withPanels();const user=userEvent.setup();render(<App run={run}/>);
  await user.click(screen.getByRole('button',{name:'주문/결제'}));
  expect(screen.queryByRole('button',{name:'배치 편집하기'})).not.toBeInTheDocument();
  expect(run.getState().edit.mode).toBe('view');
  await user.click(screen.getByRole('button',{name:'관리'}));
  expect(await screen.findByRole('button',{name:'배치 편집하기'})).toBeEnabled();
 });
 it.each([
  ['en','Edit layout','Add a panel first'],
  ['zh-Hans','编辑布局','请先添加面板'],
  ['zh-Hant','編輯版面','請先新增面板'],
 ] as const)('is translated in %s',(locale,label,reason)=>{
  const run=emptyPage();run.actions.setLocale(locale);render(<App run={run}/>);
  const edit=screen.getByRole('button',{name:label});
  expect(edit).toBeDisabled();expect(edit).toHaveTextContent(label);
  expect(screen.getByText(reason)).toBeVisible();
  expect(document.body.textContent).not.toMatch(/closing\.layoutEdit/u);
 });
 it('is enabled in the other languages once a panel exists and enters edit mode',async()=>{
  const run=withPanels();run.actions.setLocale('en');const user=userEvent.setup();render(<App run={run}/>);
  await user.click(screen.getByRole('button',{name:'Edit layout'}));
  expect(run.getState().edit.mode).toBe('edit');
 });
});
