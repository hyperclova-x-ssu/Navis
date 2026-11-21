import './test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { UiProvider,ActionButton,AnchoredPopover,CoachMark,NoticeHost,FeaturePanel,ResizeHandle,ResizeAxisControl,ContentRecovery,MiniChart,getPresetLayout } from './index';
import { screenPresets } from '../layout/presets';
import { getChartDomain } from './chart-domain';
import { canonicalGroupId,chartToneFor } from './tones';
import { drawerContentHeight,drawerRowHeight } from './drawer-layout';
import { PanelToolsPopover } from './components/PanelToolsPopover';
import { panelToolPosition,panelContentBudget } from './panel-layout';
afterEach(cleanup);
const shell=(children:React.ReactNode)=><UiProvider screenPreset={screenPresets.A} reducedMotion>{children}</UiProvider>;
describe('v2 public kit',()=>{
  it('identifies all 16 independent sizes and selects instead of opening in edit',()=>{
    const open=vi.fn(),select=vi.fn();
    for(let width=1;width<=4;width++)for(let height=1;height<=4;height++){
      const view=render(shell(<FeaturePanel featureId="ledger" label="가계부" groupId="money" width={width} height={height} editing onOpen={open} onSelect={select}>128.4</FeaturePanel>));
      fireEvent.click(screen.getByRole('button',{name:new RegExp(`가로 ${width}칸, 세로 ${height}칸`)}));
      expect(view.container.querySelector('article')).toHaveAttribute('data-shape',width===1&&height===1?'Q':height===1?'W':width===1?'T':width===2&&height===2?'S':'L');view.unmount();
    }
    expect(open).not.toHaveBeenCalled();expect(select).toHaveBeenCalledTimes(16);
  });
  it('offers independent axis controls and explains unavailable candidates',()=>{
    const change=vi.fn();render(shell(<><ResizeHandle label="가계부" width={4} height={1}/><ResizeAxisControl width={4} height={1} onChange={change} unavailable={{width:{3:'자리가 없어요'}}}/></>));
    expect(screen.getByRole('button',{name:/가계부 크기 바꾸기, 현재 가로 4칸, 세로 1칸/})).not.toHaveAccessibleName(/다음/);
    expect(screen.getByRole('button',{name:'가로 3칸'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'세로 2칸'}));expect(change).toHaveBeenCalledWith({width:4,height:2});
  });
  it('shares recoverable content without removing an enclosing title or close action',()=>{
    let fail=true;function Body(){if(fail)throw new Error('fixture');return <p>복구된 본문</p>;}
    const quiet=vi.spyOn(console,'error').mockImplementation(()=>{});
    render(shell(<section><h2>제목</h2><button>닫기</button><ContentRecovery><Body/></ContentRecovery></section>));
    expect(screen.getByRole('heading',{name:'제목'})).toBeVisible();expect(screen.getByRole('button',{name:'닫기'})).toBeVisible();
    fail=false;fireEvent.click(screen.getByRole('button',{name:'다시 시도하기'}));expect(screen.getByText('복구된 본문')).toBeVisible();quiet.mockRestore();
  });
  it.each([AnchoredPopover,CoachMark])('closes on focus leaving the popup without consuming the next contact',Popup=>{
    const activate=vi.fn(),close=vi.fn(),anchor={current:document.createElement('button')};document.body.append(anchor.current);
    render(shell(<><ActionButton onClick={activate}>다음 행동</ActionButton><Popup open anchorRef={anchor} onClose={close}><button>팝업 행동</button></Popup></>));
    const outside=screen.getByRole('button',{name:'다음 행동'});
    fireEvent.blur(screen.getByText('팝업 행동'),{relatedTarget:outside});
    expect(close).toHaveBeenCalledExactlyOnceWith('outside',expect.any(FocusEvent));
    fireEvent.pointerDown(outside,{pointerId:1,button:0});fireEvent.pointerUp(outside,{pointerId:1});fireEvent.click(outside);
    expect(activate).toHaveBeenCalledTimes(1);expect(outside).not.toHaveAttribute('data-pressed','true');anchor.current.remove();
  });
  it('announces a notice through only one live region',async()=>{
    render(shell(<NoticeHost notice={{id:'live-test',kind:'success',messageKey:'add',featureId:'ledger',expiresAt:6000}} featureLabel="가계부"/>));
    const status=await screen.findByRole('status');expect(status.closest('section')).toHaveAttribute('aria-live','off');
    expect(status).toHaveAttribute('aria-live','polite');
  });
  it('uses current preset drawer bounds and a single canonical color mapping',()=>{
    expect(getPresetLayout(screenPresets.A).drawer).toMatchObject({x:1436,y:112,width:360,height:640});
    expect(getPresetLayout(screenPresets.B).drawer).toMatchObject({x:2036,y:112,width:400,height:760});
    expect(canonicalGroupId('recommended')).toBe('recommend');expect(canonicalGroupId('neighborhood')).toBe('local');expect(chartToneFor('morning')).toBe('var(--chart-4)');
  });
  it('keeps the same axis controls in a labelled tools popup',()=>{
    const anchor={current:document.createElement('button')};document.body.append(anchor.current);
    const view=render(shell(<PanelToolsPopover open anchorRef={anchor} label="가계부" width={1} height={4} onChange={()=>{}} onClose={()=>{}}/>));
    expect(view.container.querySelector('.ui-portal-host')).toContainElement(document.querySelector('.ui-popover--panel-tools'));
    expect(screen.getByRole('group',{name:'세로 칸 수',hidden:true})).toBeInTheDocument();anchor.current.remove();
  });
});
describe('chart domain and content fit',()=>{
  it('uses one stable padded line domain, including single and flat samples',()=>{
    const standard=getChartDomain([64.8,65.4,66,65.6,66.8,67.2,67.8],'line');expect(standard.min).toBeCloseTo(64.2);expect(standard.max).toBeCloseTo(68.4);
    const single=getChartDomain([10],'line');expect(single.min).toBeLessThan(10);expect(single.max).toBeGreaterThan(10);
    expect(getChartDomain([10,10],'line')).toEqual({...single,invalidCount:0});
    expect(getChartDomain([-8,-4],'bar')).toMatchObject({min:-8,max:0,zeroY:0});
    expect(getChartDomain([NaN,Infinity],'line').hasValues).toBe(false);
  });
  it('keeps the domain numeric: the axis sentence comes from the translator in MiniChart, not a Korean axisLabel (T-055)',()=>{
    for(const values of [[1,2],[NaN],[-3,4]])expect(getChartDomain(values,'line')).not.toHaveProperty('axisLabel');
  });
  it('shows signed bars around zero and labels invalid samples as unavailable',()=>{
    render(shell(<MiniChart data={{axisLabels:['월','화','수'],series:[{name:'변화',unit:'명',values:[-8,12,NaN]}]}}/>));
    const bars=document.querySelectorAll('.ui-chart-bar');expect(bars).toHaveLength(2);expect(bars[0]).toHaveAttribute('data-sign','negative');
    expect(screen.getByRole('img')).toHaveAccessibleName(/월 -8명.*화 12명.*수 확인할\s+수\s+없어요/);
    expect(document.querySelector('.ui-chart-zero')).toBeInTheDocument();
  });
  it('groups multiple bar series under each axis item with stable semantic colors',()=>{
    render(shell(<MiniChart seriesKeys={['revenue','cost']} data={{axisLabels:['월','화'],series:[{name:'매출',unit:'원',values:[10,20]},{name:'원가',unit:'원',values:[4,-3]}]}}/>));
    const groups=document.querySelectorAll('.ui-chart-bar-group');expect(groups).toHaveLength(2);
    expect(groups[0].querySelectorAll('.ui-chart-bar')).toHaveLength(2);
    expect((groups[0].querySelectorAll('.ui-chart-bar')[1] as HTMLElement).style.background).toBe('var(--chart-2)');
  });
  it('calculates short, wrapped, placed, search and capped drawer heights',()=>{
    expect(drawerRowHeight({titleLines:1,placed:false,textScale:100})).toBe(72);
    expect(drawerRowHeight({titleLines:2,placed:true,textScale:125})).toBe(116);
    expect(drawerContentHeight({maxHeight:640,bodyHeight:72,hintHeight:56})).toBe(234);
    expect(drawerContentHeight({maxHeight:760,bodyHeight:999,hintHeight:70})).toBe(760);
  });
  it('avoids measured header and page controls while placing the tool next to a panel',()=>{
    const blocked=[{x:0,y:24,width:1920,height:64},{x:0,y:1008,width:1920,height:48}];
    const top=panelToolPosition({x:700,y:350,width:300,height:200},{width:312,height:300},{width:1920,height:1080},blocked);
    expect(top).toMatchObject({x:700,y:562,side:'bottom'});
    const bottom=panelToolPosition({x:700,y:720,width:300,height:200},{width:312,height:300},{width:1920,height:1080},blocked);
    expect(bottom).toMatchObject({x:700,y:408,side:'top'});
    const beside=panelToolPosition({x:24,y:560,width:578,height:208},{width:312,height:480},{width:1920,height:1080},[{x:24,y:24,width:1768,height:64},{x:798,y:1008,width:220,height:48}]);
    expect(beside.side).toBe('right');expect(beside.x).toBe(614);expect(beside.y+480).toBeLessThanOrEqual(1008);
    const oversized=panelToolPosition({x:24,y:112,width:1752,height:860},{width:312,height:480},{width:1920,height:1080},blocked);
    expect(oversized.y).toBe(96);
    expect(oversized.y+480).toBeLessThanOrEqual(1008);
  });
  it('reserves real chart minima and places tools inside the canvas, using the header only as a final fallback',()=>{
    expect(panelContentBudget({width:1,height:1,textScale:125,bodyWidth:249,bodyHeight:108,primaryHeight:102}).showChart).toBe(false);
    expect(panelContentBudget({width:3,height:2,textScale:100,bodyWidth:836,bodyHeight:364,primaryHeight:82}).showChart).toBe(true);
    expect(panelToolPosition({x:24,y:112,width:281,height:224},{width:312,height:260},{width:1920,height:1080})).toMatchObject({x:24,y:348,side:'bottom'});
    expect(panelToolPosition({x:24,y:24,width:1872,height:1032},{width:312,height:260},{width:1920,height:1080})).toMatchObject({x:24,y:96,side:'header'});
  });
});
