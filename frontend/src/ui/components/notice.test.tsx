import '../test-setup';
import '@testing-library/jest-dom/vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {UiProvider} from '../UiProvider';
import {screenPresets} from '../../layout/presets';
import {NoticeHost} from './notice';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
const notice={id:'placement',kind:'success',messageKey:'resize',featureId:'margin',undoToken:'resize',expiresAt:6000} as const;
type Rect={x:number;y:number;width:number;height:number};
describe('D-22 notice placement inside the canvas grid',()=>{
  // These logical dimensions stay independent of browser fit and text size.
  const measure=()=>{
    vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-notice')?680:0;});
    vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-notice')?70:0;});
  };
  it.each([
    {name:'default center',avoid:[],left:568,bottom:112},
    {name:'left when the center covers the changed handle',avoid:[{x:1141,y:920,width:48,height:48}],left:48,bottom:112},
    {name:'right when the center and left cover controls',avoid:[{x:600,y:920,width:48,height:48}],left:1088,bottom:112},
    {name:'top when both edges still cover controls',avoid:[{x:600,y:920,width:48,height:48},{x:1141,y:920,width:48,height:48}],left:568,bottom:986},
    {name:'center when controls are elsewhere',avoid:[{x:600,y:200,width:48,height:48}],left:568,bottom:112},
  ])('$name',async({avoid,left,bottom})=>{
    measure();render(<UiProvider screenPreset={screenPresets.A}><NoticeHost notice={notice} avoidRects={avoid} onUndo={()=>{}}/></UiProvider>);
    const frame=await screen.findByRole('status');
    await waitFor(()=>expect(frame.closest('[data-sonner-toaster]')).toHaveStyle({left:`${left}px`,bottom:`${bottom}px`,transform:'none'}));
  });
  it('uses a free header gap measured from the actual title and buttons',async()=>{
    measure();
    const original=HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
      if(this.dataset.testid==='header-title')return DOMRect.fromRect({x:24,y:24,width:900,height:64});
      if(this.dataset.testid==='header-action')return DOMRect.fromRect({x:1650,y:24,width:166,height:64});
      return original.call(this);
    });
    render(<><header className="dashboard-header"><div data-testid="header-title">제목</div><div className="dashboard-header-actions" data-testid="header-action">완료</div></header><UiProvider screenPreset={screenPresets.A}><NoticeHost notice={notice} avoidRects={[{x:600,y:920,width:48,height:48},{x:1141,y:920,width:48,height:48}]} onUndo={()=>{}}/></UiProvider></>);
    const frame=await screen.findByRole('status');
    await waitFor(()=>{const toaster=frame.closest<HTMLElement>('[data-sonner-toaster]')!;const x=parseFloat(toaster.style.left),y=1080-parseFloat(toaster.style.bottom)-70;expect(x>=924||y>=88).toBe(true);expect(x+680<=1650||y>=88).toBe(true);});
  });
  it('repositions the same Undo when selected controls and text scale change',async()=>{
    measure();const undo=vi.fn();
    const host=(avoid:Rect[],textScale:100|125)=><UiProvider screenPreset={screenPresets.B} textScale={textScale} transform={{scale:.5,offsetX:10,offsetY:20,width:1280,height:720,originX:0,originY:0}}><NoticeHost notice={notice} avoidRects={avoid} onUndo={undo}/></UiProvider>;
    const view=render(host([],100)),frame=await screen.findByRole('status'),toast=frame.closest('[data-sonner-toast]');
    view.rerender(host([{x:1200,y:1270,width:48,height:48}],125));
    await waitFor(()=>expect(frame.closest('[data-sonner-toaster]')).toHaveStyle({left:'48px',bottom:'112px'}));
    expect(screen.getByRole('button',{name:'되돌리기'}).closest('[data-sonner-toast]')).toBe(toast);
  });
});

describe('T-055 notice sentences through the kit (dashboard copy removed)',()=>{
  it('names the marketing recommended start and keeps the management three-panel start',async()=>{
    const view=render(<UiProvider screenPreset={screenPresets.A}><NoticeHost notice={{id:'m',kind:'success',messageKey:'starter-add',layerId:'marketing',undoToken:'u',expiresAt:6000}} onUndo={()=>{}}/></UiProvider>);
    expect(await screen.findByRole('status')).toHaveTextContent('패널 7개로 시작했어요');
    view.unmount();
    render(<UiProvider screenPreset={screenPresets.A}><NoticeHost notice={{id:'g',kind:'success',messageKey:'starter-add',layerId:'management',undoToken:'u',expiresAt:6000}} onUndo={()=>{}}/></UiProvider>);
    expect(await screen.findByRole('status')).toHaveTextContent('패널 3개로 시작했어요');
  });
  it('shows a short move toast while preserving the coordinate announcement',async()=>{
    render(<UiProvider screenPreset={screenPresets.A}><NoticeHost notice={{...notice,messageKey:'move',panel:{featureId:'margin',column:1,row:0,width:2,height:1},displacedCount:0}} featureLabel="마진" onUndo={()=>{}}/></UiProvider>);
    expect(await screen.findByText('마진을 옮겼어요')).toBeVisible();
    expect(screen.getByText('마진, 1행 2열, 가로 2칸, 세로 1칸')).toHaveClass('ui-sr-only');
  });
  it('does not read the LOCALES "· 되돌리기" ending twice when the Undo button follows it',async()=>{
    render(<UiProvider screenPreset={screenPresets.A}><NoticeHost notice={{id:'p',kind:'success',messageKey:'move-page',featureId:'ledger',params:{n:2},undoToken:'u',expiresAt:6000}} featureLabel="가계부" onUndo={()=>{}}/></UiProvider>);
    const status=await screen.findByRole('status');
    expect(status.querySelector('.ui-notice__message')).toHaveTextContent(/^가계부를 2페이지로 옮겼어요$/);
    expect(screen.getAllByRole('button',{name:'되돌리기'})).toHaveLength(1);
  });
  it('routes a data notice Undo to onDataUndo with its data token and reads the data sentence from the given translator',async()=>{
    const onUndo=vi.fn(),onDataUndo=vi.fn();
    const translator={has:(key:string)=>key==='data.notice.sample',t:(key:string,params?:Readonly<Record<string,string|number>>)=>key==='data.notice.sample'?`우유 ${params?.n} L를 받았어요`:key} as unknown as import('../../i18n').Translator;
    render(<UiProvider screenPreset={screenPresets.A}><NoticeHost notice={{id:'d',kind:'success',messageKey:'data.notice.sample',params:{n:8},undo:{target:'data',token:'data-1'},expiresAt:6000}} translator={translator} onUndo={onUndo} onDataUndo={onDataUndo}/></UiProvider>);
    expect(await screen.findByRole('status')).toHaveTextContent('우유 8 L를 받았어요');
    screen.getByRole('button',{name:'되돌리기'}).click();
    expect(onDataUndo).toHaveBeenCalledWith('data-1');expect(onUndo).not.toHaveBeenCalled();
  });
});
