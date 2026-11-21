import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import './test-setup';
import { screenPresets } from '../layout/presets';
import { UiProvider } from './UiProvider';
import { AnchoredPopover, CoachMark } from './components/overlays';
import { PanelToolsPopover } from './components/PanelToolsPopover';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
type Kind='coach'|'popover'|'tools';
function Harness({kind,open=true,onClose}:{kind:Kind;open?:boolean;onClose:(reason:string)=>void}){
  const anchor=useRef<HTMLButtonElement>(null);
  return <UiProvider screenPreset={screenPresets.A} reducedMotion><button ref={anchor}>anchor</button><button>outside</button>
    {kind==='coach'?<CoachMark open={open} anchorRef={anchor} onClose={onClose} closeLabel="Close tip">tip</CoachMark>:
      kind==='popover'?<AnchoredPopover open={open} anchorRef={anchor} onClose={onClose} label="popover"><button>inside</button></AnchoredPopover>:
      <PanelToolsPopover open={open} anchorRef={anchor} onClose={onClose} label="tools" width={1} height={1} onChange={()=>{}}/>}
  </UiProvider>;
}
function popup(kind:Kind){return kind==='coach'?screen.getByRole('note',{hidden:true}):kind==='popover'?screen.getByLabelText('popover',{selector:'.ui-popover'}):screen.getByLabelText('tools 크기와 위치 바꾸기',{selector:'.ui-popover'});}
function blurOutside(element:HTMLElement){fireEvent.blur(element,{relatedTarget:screen.getByText('outside')});}

describe('overlay close callbacks',()=>{
  it('reports a coach close button once even when closing causes focus-out',async()=>{
    vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(400);vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(90);
    const close=vi.fn();render(<Harness kind="coach" onClose={close}/>);
    const element=popup('coach');
    await userEvent.setup().click(within(element).getByText('Close tip'));
    blurOutside(element);
    expect(close).toHaveBeenCalledTimes(1);expect(close.mock.calls[0][0]).toBe('button');
  });
  it.each(['coach','popover','tools'] as const)('%s reports Escape once despite a subsequent focus-out',async kind=>{
    const close=vi.fn();render(<Harness kind={kind} onClose={close}/>);const element=popup(kind);
    fireEvent.keyDown(document,{key:'Escape',code:'Escape'});blurOutside(element);
    fireEvent.keyUp(document,{key:'Escape',code:'Escape'});
    expect(close).toHaveBeenCalledTimes(1);expect(close.mock.calls[0][0]).toBe('Esc');
  });
  it.each(['coach','popover','tools'] as const)('%s reports an outside press once despite a subsequent focus-out',async kind=>{
    const close=vi.fn();render(<Harness kind={kind} onClose={close}/>);const element=popup(kind);
    fireEvent.pointerDown(screen.getByText('outside'),{pointerType:'mouse',button:0});blurOutside(element);
    fireEvent.pointerUp(document,{pointerType:'mouse',button:0});fireEvent.click(document);
    expect(close).toHaveBeenCalledTimes(1);expect(close.mock.calls[0][0]).toBe('outside');
  });
  it.each(['coach','popover','tools'] as const)('%s closes once for a real focus move outside',kind=>{
    const close=vi.fn();render(<Harness kind={kind} onClose={close}/>);const element=popup(kind);
    blurOutside(element);blurOutside(element);
    expect(close).toHaveBeenCalledTimes(1);expect(close.mock.calls[0][0]).toBe('outside');
  });
  it.each(['coach','popover','tools'] as const)('%s ignores blur from an inert popup',kind=>{
    const close=vi.fn();render(<Harness kind={kind} onClose={close}/>);const element=popup(kind);
    element.setAttribute('inert','');blurOutside(element);
    expect(close).not.toHaveBeenCalled();
  });
  it.each(['coach','popover','tools'] as const)('%s closes for an actual focus move and can close again after reopening',kind=>{
    const close=vi.fn();const view=render(<Harness kind={kind} onClose={close}/>);const element=popup(kind);
    act(()=>{element.focus();screen.getByText('outside').focus();});
    expect(close).toHaveBeenCalledTimes(1);expect(close.mock.calls[0][0]).toBe('outside');
    view.rerender(<Harness kind={kind} open={false} onClose={close}/>);
    view.rerender(<Harness kind={kind} onClose={close}/>);blurOutside(popup(kind));
    expect(close).toHaveBeenCalledTimes(2);
  });
  it.each(['coach','popover','tools'] as const)('%s ignores focus-out while externally closed and works after reopening',kind=>{
    const close=vi.fn();const view=render(<Harness kind={kind} onClose={close}/>);const element=popup(kind);
    view.rerender(<Harness kind={kind} open={false} onClose={close}/>);blurOutside(element);
    expect(close).not.toHaveBeenCalled();
    view.rerender(<Harness kind={kind} onClose={close}/>);blurOutside(popup(kind));
    expect(close).toHaveBeenCalledTimes(1);expect(close.mock.calls[0][0]).toBe('outside');
  });
});
