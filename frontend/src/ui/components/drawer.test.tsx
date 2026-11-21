import '../test-setup';
import '@testing-library/jest-dom/vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {screenPresets} from '../../layout/presets';
import {UiProvider} from '../UiProvider';
import {FunctionDrawer} from './overlays';
import {FunctionRow,SearchField} from './controls';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
it.each(['A','B'] as const)('%s recalculates search → closed → group → search from mounted content',async preset=>{
  vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){
    if(this.classList.contains('ui-function-list'))return Number(this.firstElementChild?.getAttribute('data-natural-height')??0);
    if(this.classList.contains('ui-drawer__query'))return 88;
    if(this.classList.contains('ui-overlay-header'))return 48;
    if(this.classList.contains('ui-drawer__footer'))return 56;
    return 0;
  });
  const host=(open:boolean,search:boolean,height=72)=><UiProvider screenPreset={screenPresets[preset]} reducedMotion><FunctionDrawer open={open} title={search?'검색':'소식'} search={search?<SearchField value="" onValueChange={()=>{}}/>:undefined} onClose={()=>{}}><div data-natural-height={height}><FunctionRow label="가계부" icon="ledger"/></div></FunctionDrawer></UiProvider>;
  const view=render(host(true,true));
  await waitFor(()=>expect(screen.getByRole('dialog')).toHaveStyle({height:'334px'}));
  view.rerender(host(false,true));expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(host(true,false));
  await waitFor(()=>expect(screen.getByRole('dialog')).toHaveStyle({height:'234px'}));
  view.rerender(host(true,true));
  await waitFor(()=>expect(screen.getByRole('dialog')).toHaveStyle({height:'334px'}));
  view.rerender(host(true,true,152));
  await waitFor(()=>expect(screen.getByRole('dialog')).toHaveStyle({height:'414px'}));
  view.rerender(host(true,false,999));
  await waitFor(()=>expect(screen.getByRole('dialog')).toHaveStyle({height:preset==='A'?'640px':'760px'}));
});
