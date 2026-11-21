import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import './test-setup';
import { ActionButton, CoachMark, DetailDialog, UiProvider } from './index';
import { screenPresets } from '../layout/presets';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
function measureCoach(){
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(()=>({x:1816,y:128,width:72,height:72,left:1816,top:128,right:1888,bottom:200,toJSON:()=>({})}));
  vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(90);
}
function CoachHarness({activate,close}:{activate:()=>void;close:(reason:string)=>void}){
  const [open,setOpen]=useState(true);const anchor=useRef<HTMLButtonElement>(null);
  return <UiProvider screenPreset={screenPresets.A} reducedMotion><ActionButton ref={anchor}>안내 대상</ActionButton><ActionButton onClick={activate}>되돌리기</ActionButton><CoachMark open={open} anchorRef={anchor} onClose={reason=>{close(reason);setOpen(false);}}>안내 내용</CoachMark></UiProvider>;
}
describe('coach dismissal',()=>{
  it('closes and activates an outside control on the same press exactly once',async()=>{
    measureCoach();const activate=vi.fn(),close=vi.fn();render(<CoachHarness activate={activate} close={close}/>);
    expect(await screen.findByRole('note',{name:'안내'})).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button',{name:'되돌리기'}));
    expect(close).toHaveBeenCalledExactlyOnceWith('outside');expect(activate).toHaveBeenCalledTimes(1);expect(screen.queryByRole('note',{name:'안내'})).not.toBeInTheDocument();
  });
  it('closes on Escape without activating the outside control',async()=>{
    measureCoach();const activate=vi.fn(),close=vi.fn();render(<CoachHarness activate={activate} close={close}/>);
    await screen.findByRole('note',{name:'안내'});await userEvent.setup().keyboard('{Escape}');
    expect(close).toHaveBeenCalledExactlyOnceWith('Esc');expect(activate).not.toHaveBeenCalled();expect(screen.queryByRole('note',{name:'안내'})).not.toBeInTheDocument();
  });
  it('still consumes the outside press that closes a modal',async()=>{
    const behind=vi.fn();function Modal(){const [open,setOpen]=useState(true);return <UiProvider screenPreset={screenPresets.A} reducedMotion><ActionButton onClick={behind}>뒤 패널</ActionButton><DetailDialog open={open} title="상세" onClose={()=>setOpen(false)}>내용</DetailDialog></UiProvider>;}
    const user=userEvent.setup();render(<Modal/>);const button=screen.getByText('뒤 패널').closest('button')!;
    await user.pointer([{target:screen.getByTestId('ui-dialog-backdrop'),keys:'[MouseLeft>]'}, {target:button,keys:'[/MouseLeft]'}]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(behind).not.toHaveBeenCalled();
    await user.click(button);expect(behind).toHaveBeenCalledTimes(1);
  });
});
