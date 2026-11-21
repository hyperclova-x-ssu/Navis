import { createRef, useRef, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './test-setup';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { UiProvider, ActionButton, IconButton, SearchField, FunctionRow, DialogFrame, FunctionDrawer, CoachMark, LargeTextControl, ThemeTabs, ResizeAxisControl, CellMoveControl, ResizeHandle, FeaturePanel, NoticeHost, MiniChart, InlineError, Icon, PanelMotionFrame, OverlayExitSurface, FlyInFrame, timePolicy, motionTokens, transitionFor } from './index';
import { screenPresets } from '../layout/presets';

const shell=(children:ReactNode,reducedMotion=false)=><UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion={reducedMotion}>{children}</UiProvider>;
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('tablet controls and immediate press feedback',()=>{
  it('keeps its hit box fixed and presses on down, release, cancel and keyboard',()=>{
    const activate=vi.fn();render(shell(<ActionButton onClick={activate}>완료</ActionButton>));
    const button=screen.getByRole('button',{name:'완료'});
    fireEvent.pointerDown(button,{pointerId:1,button:0});expect(button).toHaveAttribute('data-pressed','true');
    expect(button.style.transform).toBe('');expect(button.querySelector('.ui-press-surface')).toBeTruthy();
    fireEvent.pointerCancel(button,{pointerId:1});expect(button).not.toHaveAttribute('data-pressed','true');
    fireEvent.keyDown(button,{key:' '});expect(button).toHaveAttribute('data-pressed','true');
    fireEvent.keyUp(button,{key:' '});expect(button).not.toHaveAttribute('data-pressed','true');
    fireEvent.click(button);expect(activate).toHaveBeenCalledTimes(1);
  });
  it('does not activate disabled/loading controls and preserves their names',async()=>{
    const activate=vi.fn();const user=userEvent.setup();
    render(shell(<><ActionButton disabled onClick={activate}>빼기</ActionButton><ActionButton loading onClick={activate}>다시 열기</ActionButton><IconButton label="닫기" icon="close" /></>));
    await user.click(screen.getByRole('button',{name:'빼기'}));
    expect(screen.getByRole('button',{name:/다시 열기/})).toBeDisabled();
    expect(screen.getByRole('button',{name:/다시 열기/})).toHaveAttribute('aria-busy','true');
    expect(screen.getByRole('button',{name:'닫기'})).toBeInTheDocument();expect(activate).not.toHaveBeenCalled();
  });
  it('labels search independently of its placeholder and clears through the same input callback',async()=>{
    function Search(){const [value,set]=useState('매뉴얼');return <SearchField value={value} onValueChange={set}/>;}
    render(shell(<Search/>));const input=screen.getByRole('searchbox',{name:'기능 찾기'});
    expect(input).toHaveValue('매뉴얼');await userEvent.setup().click(screen.getByRole('button',{name:'검색어 지우기'}));expect(input).toHaveValue('');expect(input).toHaveFocus();
  });
  it('keeps an already placed long feature interactive and its complete name accessible',async()=>{
    const add=vi.fn();render(shell(<FunctionRow label="CCTV 손님분석(알바 효율 포함)" icon="customer-analysis" placed onClick={add}/>));
    const row=screen.getByRole('button',{name:/CCTV 손님분석.*이미 있어요/});
    expect(row).not.toBeDisabled();expect(row).toHaveClass('ui-function-row');await userEvent.setup().click(row);expect(add).toHaveBeenCalledTimes(1);
  });
  it('offers independent size and four-direction cell alternatives without feature restrictions',async()=>{
    const size=vi.fn(),move=vi.fn();
    render(shell(<><ResizeAxisControl width={2} height={1} onChange={size}/><CellMoveControl unavailable={{left:'격자 끝이에요'}} onMove={move}/><ResizeHandle label="세금계산" width={1} height={1}/></>));
    expect(screen.getByRole('button',{name:/세금계산 크기/})).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button',{name:'가로 3칸'}));expect(size).toHaveBeenCalledWith({width:3,height:1});
    expect(screen.getByRole('button',{name:'왼쪽으로 한 칸'})).toBeDisabled();await userEvent.setup().click(screen.getByRole('button',{name:'오른쪽으로 한 칸'}));expect(move).toHaveBeenCalledWith({column:1,row:0});
  });
});

function DialogHarness(){
  const [open,set]=useState(false);const trigger=useRef<HTMLButtonElement>(null);
  return <><ActionButton ref={trigger} onClick={()=>set(true)}>마진 자세히 보기</ActionButton><DialogFrame open={open} title="마진·원가분석" description="가게 수치를 살펴봐요" returnFocusRef={trigger} onClose={()=>set(false)}><ActionButton>내용 행동</ActionButton></DialogFrame></>;
}
describe('Base UI focus, dismissal and nonmodal layers',()=>{
  it('names a modal, focuses close, traps tab and restores focus immediately on Escape',async()=>{
    const user=userEvent.setup();render(shell(<DialogHarness/>));const trigger=screen.getByRole('button',{name:'마진 자세히 보기'});
    await user.click(trigger);const dialog=await screen.findByRole('dialog',{name:'마진·원가분석'});
    await waitFor(()=>expect(within(dialog).getByRole('button',{name:'닫기'})).toHaveFocus());
    await user.tab({shift:true});await waitFor(()=>expect(within(dialog).getByRole('button',{name:'내용 행동'})).toHaveFocus());
    await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();await waitFor(()=>expect(trigger).toHaveFocus());
  });
  it('closes on its button and outside press, consuming the closing pointer sequence',async()=>{
    const user=userEvent.setup();const behind=vi.fn();render(shell(<><DialogHarness/><ActionButton onClick={behind}>뒤 패널</ActionButton></>));const behindButton=screen.getByRole('button',{name:'뒤 패널'});
    await user.click(screen.getByRole('button',{name:'마진 자세히 보기'}));await user.click(screen.getByRole('button',{name:'닫기'}));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'마진 자세히 보기'}));
    await user.pointer([{target:screen.getByTestId('ui-dialog-backdrop'),keys:'[MouseLeft>]'}, {target:behindButton,keys:'[/MouseLeft]'}]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(behind).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'뒤 패널'}));expect(behind).toHaveBeenCalledTimes(1);
  });
  it('keeps the drawer nonmodal and skips return focus for drag close',async()=>{
    const user=userEvent.setup();const target=vi.fn();
    function Drawer(){const [open,set]=useState(true);return <><ActionButton onClick={target}>대시보드 행동</ActionButton><FunctionDrawer open={open} title="추천" suppressReturnFocus onClose={()=>set(false)}><ActionButton onClick={()=>set(false)}>끌기 시작</ActionButton></FunctionDrawer></>;}
    render(shell(<Drawer/>));expect(screen.getByRole('dialog',{name:'추천'})).not.toHaveAttribute('aria-modal','true');
    await user.click(screen.getByRole('button',{name:'대시보드 행동'}));expect(target).toHaveBeenCalledTimes(1);expect(screen.getByRole('dialog',{name:'추천'})).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'끌기 시작'}));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('shows a coach at a real anchor without moving focus into it',async()=>{
    const bounds=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(()=>({x:1816,y:128,width:72,height:72,left:1816,top:128,right:1888,bottom:200,toJSON:()=>({})}));
    const w=vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(400),h=vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(90);
    const close=vi.fn();
    function Coach(){const anchor=useRef<HTMLButtonElement>(null);return <><ActionButton ref={anchor}>추천</ActionButton><CoachMark open anchorRef={anchor} id="first-coach" onClose={close}>{'필요한 기능을 여기서 눌러 추가해요'}</CoachMark></>;}
    render(shell(<Coach/>));const anchor=screen.getByRole('button',{name:'추천'});anchor.focus();
    expect(await screen.findByText('필요한 기능을 여기서 눌러 추가해요')).toBeInTheDocument();expect(anchor).toHaveFocus();
    await userEvent.setup().click(screen.getByRole('button',{name:'확인'}));expect(close).toHaveBeenCalledTimes(1);bounds.mockRestore();w.mockRestore();h.mockRestore();
  });
  it('lets the actual coached target work while outside dismiss consumes its own input',async()=>{
    const activate=vi.fn();const close=vi.fn();
    function Coach(){const anchor=useRef<HTMLButtonElement>(null);return <><ActionButton ref={anchor} onClick={activate}>안내 대상</ActionButton><CoachMark open anchorRef={anchor} id="target-coach" onClose={close}>{'필요한 기능을 여기서 눌러 추가해요'}</CoachMark></>;}
    render(shell(<Coach/>));const anchor=screen.getByRole('button',{name:'안내 대상'});
    await userEvent.setup().click(anchor);expect(activate).toHaveBeenCalledTimes(1);expect(close).not.toHaveBeenCalled();expect(anchor).toHaveAttribute('aria-describedby','target-coach-text');
  });
  it('draws exactly one coach target ring and a directional tail, removing the ring immediately on close',async()=>{
    const rect={x:1816,y:128,width:72,height:72};
    const bounds=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(()=>({...rect,top:rect.y,left:rect.x,right:rect.x+rect.width,bottom:rect.y+rect.height,toJSON:()=>rect}));
    const width=vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(400);
    const height=vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(90);
    function Coach({open,target=true}:{open:boolean;target?:boolean}){const anchor=useRef<HTMLButtonElement>(null);return <>{target?<ActionButton ref={anchor}>추천</ActionButton>:null}<CoachMark open={open} anchorRef={anchor} coachStep="choose-feature" onClose={()=>{}}>{'필요한 기능을 여기서 눌러 추가해요'}</CoachMark></>;}
    const view=render(<UiProvider screenPreset={screenPresets.A} theme="light"><Coach open/></UiProvider>);
    try{
      const ring=await waitFor(()=>{const ring=document.querySelector('.ui-coach-target-highlight');expect(ring).toBeInTheDocument();return ring!;});
      expect(ring).toHaveAttribute('aria-hidden','true');expect(ring).toHaveStyle({left:'1816px',top:'128px',width:'72px',height:'72px'});
      expect(document.querySelectorAll('.ui-coach-target-highlight')).toHaveLength(1);
      expect(document.querySelector('svg.ui-coach-tail')).toHaveAttribute('data-side','left');
      expect(document.querySelector('.ui-coach-positioner')).toHaveStyle({left:'1404px',top:'119px'});
      view.rerender(<UiProvider screenPreset={screenPresets.A} theme="light"><Coach open={false}/></UiProvider>);
      expect(document.querySelector('.ui-coach-target-highlight')).not.toBeInTheDocument();
      view.rerender(<UiProvider screenPreset={screenPresets.A} theme="light"><Coach open/></UiProvider>);
      await waitFor(()=>expect(document.querySelector('.ui-coach-target-highlight')).toBeInTheDocument());
      view.rerender(<UiProvider screenPreset={screenPresets.A} theme="light"><Coach open target={false}/></UiProvider>);
      await waitFor(()=>expect(document.querySelector('.ui-coach-target-highlight')).not.toBeInTheDocument());
    }finally{view.unmount();bounds.mockRestore();width.mockRestore();height.mockRestore();}
  });
  it('makes only overflowing coach text keyboard scrollable and keeps close outside that region',async()=>{
    const close=vi.fn();
    const bounds=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(()=>({x:24,y:112,width:590,height:248,left:24,top:112,right:614,bottom:360,toJSON:()=>({})}));
    const width=vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(400);
    const height=vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(280);
    const scroll=vi.spyOn(HTMLElement.prototype,'scrollHeight','get').mockReturnValue(400);
    const client=vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(238);
    function Coach(){const anchor=useRef<HTMLButtonElement>(null);return <><ActionButton ref={anchor}>패널</ActionButton><CoachMark open anchorRef={anchor} coachStep="resize-panel" onClose={close}>긴 안내{'길게 누른 뒤 모서리를 끌면 크기가 바뀌어요'}</CoachMark></>;}
    const view=render(<UiProvider screenPreset={screenPresets.B} theme="light"><Coach/></UiProvider>);
    try{const body=await screen.findByRole('region',{name:'코칭 안내 본문'});expect(body).toHaveAttribute('tabindex','0');expect(body).not.toContainElement(screen.getByRole('button',{name:'확인'}));expect(document.querySelector('.ui-coach-positioner')).toHaveStyle({top:'372px'});body.focus();const target=screen.getByRole('button',{name:'패널'});await userEvent.setup().click(target);expect(close).not.toHaveBeenCalled();fireEvent.keyDown(target,{key:'Escape'});expect(close).toHaveBeenCalledWith('Esc',expect.any(KeyboardEvent));}
    finally{view.unmount();bounds.mockRestore();width.mockRestore();height.mockRestore();scroll.mockRestore();client.mockRestore();}
  });
  it('completes reduced visual exit and returns its exact token',async()=>{
    const complete=vi.fn();render(shell(<OverlayExitSurface token="exit-reduced" kind="detail" onComplete={complete}>닫히는 창</OverlayExitSurface>,true));
    await waitFor(()=>expect(complete).toHaveBeenCalledWith('exit-reduced'),{timeout:1500});
  });
  it('cancels a superseded exit callback instead of completing a newer token early',async()=>{
    const complete=vi.fn();const view=render(shell(<OverlayExitSurface token="old-exit" kind="detail" onComplete={complete}>이전 창</OverlayExitSurface>,true));
    view.rerender(shell(<OverlayExitSurface token="new-exit" kind="detail" onComplete={complete}>새 창</OverlayExitSurface>,true));
    await waitFor(()=>expect(complete).toHaveBeenCalledWith('new-exit'),{timeout:1500});expect(complete).not.toHaveBeenCalledWith('old-exit');
  });
  it('leaves only an inert, pointer-transparent visual surface on exit',()=>{
    const complete=vi.fn();render(shell(<OverlayExitSurface token="exit-1" kind="detail" onComplete={complete}>닫히는 창</OverlayExitSurface>));
    const surface=screen.getByTestId('ui-overlay-exit');expect(surface).toHaveAttribute('aria-hidden','true');expect(surface).toHaveAttribute('inert');expect(surface).toHaveStyle({pointerEvents:'none'});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('theme, type scale, reduced motion and content policy',()=>{
  it('updates roots and portal theme without remounting the content',async()=>{
    const view=render(<UiProvider screenPreset={screenPresets.A} theme="light" textScale={100} reducedMotion={false}><DialogHarness/></UiProvider>);
    await userEvent.setup().click(screen.getByRole('button',{name:'마진 자세히 보기'}));const dialog=screen.getByRole('dialog');
    view.rerender(<UiProvider screenPreset={screenPresets.A} theme="dark" textScale={125} reducedMotion><DialogHarness/></UiProvider>);
    expect(document.documentElement).toHaveAttribute('data-theme','dark');expect(document.documentElement.style.fontSize).toBe('20px');
    expect(document.documentElement).toHaveAttribute('data-reduced-motion','true');expect(screen.getByRole('dialog')).toBe(dialog);
    expect(dialog.closest('[data-theme]')).toHaveAttribute('data-theme','dark');
  });
  it('responds to live system reduced-motion changes without creating a new screen',()=>{
    let reduced=false;const listeners=new Set<()=>void>();
    const media=vi.fn((query:string)=>({get matches(){return query.includes('reduced-motion')&&reduced;},media:query,addEventListener:(_type:string,listener:()=>void)=>{listeners.add(listener);},removeEventListener:(_type:string,listener:()=>void)=>{listeners.delete(listener);}}));
    vi.stubGlobal('matchMedia',media);
    const view=render(<UiProvider screenPreset={screenPresets.A} theme="light"><ActionButton>상태 유지</ActionButton></UiProvider>);const button=screen.getByRole('button',{name:'상태 유지'});
    expect(document.documentElement).toHaveAttribute('data-reduced-motion','false');act(()=>{reduced=true;listeners.forEach(listener=>listener());});
    expect(document.documentElement).toHaveAttribute('data-reduced-motion','true');expect(screen.getByRole('button',{name:'상태 유지'})).toBe(button);view.unmount();vi.stubGlobal('matchMedia',undefined);
  });
  it('exposes R4 injected grid/time and bounded, non-bouncy motion policies',()=>{
    expect(timePolicy).toMatchObject({idleMs:30000,undoMs:6000,briefingSafeMs:1200});
    for(const ms of Object.values(motionTokens.duration))expect(ms).toBeLessThanOrEqual(300);
    expect(transitionFor('layout',false)).toMatchObject({type:'spring',bounce:0,duration:.22});
    expect(transitionFor('detailIn',true)).toMatchObject({duration:.08});expect(motionTokens.duration.fly+2*motionTokens.staggerStart).toBeLessThanOrEqual(300);
  });
  it('connects adapter refs to the layout, panel and actual input hosts',()=>{
    const layoutRef=createRef<HTMLDivElement>();const panelRef=createRef<HTMLElement>();const inputRef=createRef<HTMLButtonElement>();
    render(shell(<PanelMotionFrame ref={layoutRef}><FeaturePanel ref={panelRef} featureId="ledger" label="가계부" width={2} height={1} groupId="money" interactionProps={{ref:inputRef}}>128.4만 원</FeaturePanel></PanelMotionFrame>));
    expect(layoutRef.current).toBe(screen.getByTestId('ui-layout-layer'));expect(panelRef.current?.tagName).toBe('ARTICLE');expect(inputRef.current).toBe(screen.getByRole('button',{name:/가계부, 가로 2칸, 세로 1칸 패널/}));
  });
  it('keeps direct drag in its own immediate transform layer while reduced motion removes automatic layout',()=>{
    render(shell(<PanelMotionFrame dragging offset={{x:37,y:-12}}><FeaturePanel featureId="ledger" label="가계부" width={2} height={1} groupId="money">128.4만 원</FeaturePanel></PanelMotionFrame>,true));
    const layer=screen.getByTestId('ui-drag-layer');expect(layer).toHaveStyle({transform:'translate3d(37px, -12px, 0px)'});expect(layer.style.transition).toBe('none');
    expect(screen.getByTestId('ui-layout-layer')).toHaveAttribute('data-auto-motion','false');
  });
  it('finishes reduced fly-in without stagger and preserves content',async()=>{
    const settled=vi.fn();render(shell(<FlyInFrame index={2} onSettled={settled}>도착한 패널</FlyInFrame>,true));
    expect(screen.getByText('도착한 패널')).toBeInTheDocument();await waitFor(()=>expect(settled).toHaveBeenCalledTimes(1),{timeout:1500});
  });
  it('supports keyboard switch and exclusive theme tabs with stateful names',async()=>{
    function Settings(){const [large,setLarge]=useState(false);const [theme,setTheme]=useState<'light'|'dark'>('light');return <><LargeTextControl checked={large} onChange={setLarge}/><ThemeTabs value={theme} onChange={setTheme}/></>;}
    render(shell(<Settings/>));const toggle=screen.getByRole('switch',{name:'큰 글자'});toggle.focus();await userEvent.setup().keyboard(' ');expect(toggle).toHaveAttribute('aria-checked','true');
    await userEvent.setup().click(screen.getByRole('tab',{name:'다크'}));expect(screen.getByRole('tab',{name:'다크'})).toHaveAttribute('aria-selected','true');expect(screen.getByRole('tab',{name:'라이트'})).toHaveAttribute('aria-selected','false');
  });
  it('renders fixed charts with text alternatives and empty/extreme values safely',()=>{
    render(shell(<><MiniChart data={{axisLabels:['월','화'],series:[{name:'매출',unit:'만 원',values:[0,128.4]}]}}/><MiniChart data={{axisLabels:[],series:[]}}/><InlineError onRetry={vi.fn()}/><Icon name="recommended"/></>));
    expect(screen.getByRole('img',{name:/매출.*0.*128.4/})).toBeInTheDocument();expect(screen.getByText('그래프에 표시할 값이 없어요')).toBeInTheDocument();expect(screen.getByRole('alert')).toHaveTextContent('화면을 보여 주지 못했어요. 다시 열어 주세요');
  });
});

describe('controlled Sonner guidance',()=>{
  it('retires a superseded snapshot even when Sonner has not mounted its queued content yet',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','requestAnimationFrame','cancelAnimationFrame']});
    const undo=vi.fn();
    const added={id:'notice-1',kind:'success',messageKey:'add',featureId:'ledger',undoToken:'queued-add',expiresAt:6000} as const;
    try{
      const view=render(shell(<NoticeHost notice={added} featureLabel="가계부" onUndo={undo}/>));
      view.rerender(shell(<NoticeHost notice={{...added,id:'current-add',featureId:'grants',undoToken:'current-add'}} featureLabel="정부지원" onUndo={undo}/>));
      await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
      expect(screen.getAllByRole('button',{name:'되돌리기'})).toHaveLength(1);
      fireEvent.click(screen.getByRole('button',{name:'되돌리기'}));expect(undo).toHaveBeenCalledExactlyOnceWith('current-add');
    }finally{act(()=>{cleanup();vi.runOnlyPendingTimers();});vi.useRealTimers();}
  });
  it('keeps a new Undo visible after the previous notice has started its asynchronous exit',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','requestAnimationFrame','cancelAnimationFrame']});
    const advance=async(ms:number)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
    const undo=vi.fn();
    const duplicate={id:'notice-2',kind:'duplicate',messageKey:'DUPLICATE',featureId:'ledger',expiresAt:800} as const;
    const added={id:'notice-3',kind:'success',messageKey:'add',featureId:'grants',undoToken:'new-add',expiresAt:6800} as const;
    try{
      const view=render(shell(<NoticeHost notice={duplicate} featureLabel="가계부" onUndo={undo}/>));
      await advance(1);expect(screen.getByRole('status')).toHaveTextContent('이미 있어요');
      view.rerender(shell(<NoticeHost notice={null} onUndo={undo}/>));
      await advance(64);
      expect(document.querySelector('[data-sonner-toast]')).toHaveAttribute('data-removed','true');
      view.rerender(shell(<NoticeHost notice={added} featureLabel="정부지원" onUndo={undo}/>));
      await advance(1);await advance(300);
      const action=screen.getByRole('button',{name:'되돌리기'});
      expect(action.closest('[data-sonner-toast]')).toHaveAttribute('data-removed','false');
      fireEvent.click(action);expect(undo).toHaveBeenCalledExactlyOnceWith('new-add');
    }finally{act(()=>{cleanup();vi.runOnlyPendingTimers();});vi.useRealTimers();}
  });
  it('updates the same undo lifetime through pause/resume and retires only the replaced notice',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','requestAnimationFrame','cancelAnimationFrame']});
    const advance=async(ms:number)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
    const undo=vi.fn();
    const added={id:'notice-4',kind:'success',messageKey:'add',featureId:'ledger',undoToken:'first-add',expiresAt:6000} as const;
    try{
      const view=render(shell(<NoticeHost notice={added} featureLabel="가계부" onUndo={undo}/>));
      await advance(1);
      const action=screen.getByRole('button',{name:'되돌리기'});const frame=action.closest('.ui-notice')!;const toast=action.closest('[data-sonner-toast]');
      for(const expiresAt of [Infinity,9000]){
        view.rerender(shell(<NoticeHost notice={{...added,expiresAt}} featureLabel="가계부" onUndo={undo}/>));await advance(1);
        expect(screen.getByRole('button',{name:'되돌리기'}).closest('[data-sonner-toast]')).toBe(toast);
      }
      const removed={id:'notice-5',kind:'success',messageKey:'remove',featureId:'ledger',undoToken:'new-remove',expiresAt:10000} as const;
      view.rerender(shell(<NoticeHost notice={removed} featureLabel="가계부" onUndo={undo}/>));await advance(1);
      expect(frame).toHaveAttribute('aria-hidden','true');expect(frame).toHaveAttribute('inert');
      expect(screen.getAllByRole('button',{name:'되돌리기'})).toHaveLength(1);
      fireEvent.click(screen.getByRole('button',{name:'되돌리기'}));expect(undo).toHaveBeenCalledExactlyOnceWith('new-remove');
      await advance(400);expect(screen.getByRole('status')).toHaveTextContent('가계부를 뺐어요');
      view.rerender(shell(<NoticeHost notice={{id:'notice-6',kind:'error',messageKey:'NO_CAPACITY',expiresAt:14000}}/>));await advance(1);
      expect(screen.getByRole('alert')).toHaveTextContent('자리가 없어요. 패널을 줄이거나 빼거나 새 페이지를 추가해 주세요');expect(screen.queryByRole('button',{name:'되돌리기'})).toBeNull();
      view.rerender(shell(<NoticeHost notice={{id:'notice-7',kind:'complete',messageKey:'undo-complete',expiresAt:16000}}/>));await advance(1);await advance(400);
      expect(screen.getByRole('status')).toHaveTextContent('되돌렸어요');expect(screen.queryByRole('alert')).toBeNull();
    }finally{act(()=>{cleanup();vi.runOnlyPendingTimers();});vi.useRealTimers();}
  });
  it('does not expire independently; reports focus/touch pause and calls undo once per click',async()=>{
    const undo=vi.fn();const pause=vi.fn();const resume=vi.fn();
    const notice={id:'notice-8',kind:'success',messageKey:'add',featureId:'ledger',undoToken:'undo-one',expiresAt:6000} as const;
    render(shell(<NoticeHost notice={notice} featureLabel="가계부" onUndo={undo} onPause={pause} onResume={resume}/>));
    const action=await screen.findByRole('button',{name:'되돌리기'});expect(screen.getByRole('status')).toHaveTextContent('가계부를 추가했어요');
    fireEvent.focusIn(action);expect(pause).toHaveBeenCalledWith('toast-focus');fireEvent.blur(action,{relatedTarget:document.body});expect(resume).toHaveBeenCalledWith('toast-focus');
    fireEvent.pointerDown(action,{pointerId:1});expect(pause).toHaveBeenCalledWith('toast-touch');fireEvent.pointerUp(document,{pointerId:1});expect(resume).toHaveBeenCalledWith('toast-touch');
    fireEvent.click(action);expect(undo).toHaveBeenCalledWith('undo-one');
    expect(screen.getByRole('status').closest('[data-sonner-toast]')).toHaveAttribute('data-dismissible','false');
  });
});
