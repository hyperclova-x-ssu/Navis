import './test-setup';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from './test-utils';
import { I18nProvider } from '../i18n';
import {
  PageBar, EdgeZoneBand, HelpButton, CoachFooter, WidgetCoach, ListSelectRow, LanguageSelect, ExampleStateSelect, ExampleStateChip, IntegrationBadge, StatusBadge, SplitBar,
  DetailTabs, ChipChoice, SegmentedControl, TextField, NumberField, Textarea, DateStepper, TimeChips, QuantityStepper, ChecklistRow, InlineForm, DraftCard, ChannelTransfer, MasterDetail,
  FeaturePanel, FunctionRow, PanelAction, PanelState, MetricFit, chooseMetricStage, copyText, ActionButton,
} from './index';
import type { Locale } from '../contracts';

afterEach(()=>{cleanup();vi.restoreAllMocks();});

describe('PageBar (SCR-24)',()=>{
  it('shows only the text add button for one page and hides on request',()=>{
    const { rerender } = renderWithKit(<PageBar total={1} current={0} onSelect={()=>{}} onAdd={()=>{}}/>);
    expect(screen.getByRole('navigation',{name:'페이지'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'페이지 추가하기'})).toHaveTextContent('페이지 추가');
    expect(screen.queryByRole('button',{name:/페이지로 이동/})).toBeNull();
    rerender(<PageBar total={1} current={0} hidden onSelect={()=>{}} onAdd={()=>{}}/>);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('names dots, marks the current one, keeps both arrows in place and disables them at the ends',async()=>{
    const select=vi.fn(),add=vi.fn();
    renderWithKit(<PageBar total={3} current={0} onSelect={select} onAdd={add}/>);
    expect(screen.getByRole('button',{name:'1페이지로 이동'})).toHaveAttribute('aria-current','page');
    expect(screen.getByRole('button',{name:'2페이지로 이동'})).not.toHaveAttribute('aria-current');
    const previous=screen.getByRole('button',{name:'이전 페이지, 첫 페이지예요'});
    expect(previous).toHaveAttribute('aria-disabled','true');
    await userEvent.click(previous);expect(select).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button',{name:'다음 페이지'}));expect(select).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByRole('button',{name:'3페이지로 이동'}));expect(select).toHaveBeenLastCalledWith(2);
    await userEvent.click(screen.getByRole('button',{name:'페이지 추가하기'}));expect(add).toHaveBeenCalledTimes(1);
  });
  it('disables add at five pages and reports the limit instead of adding',async()=>{
    const add=vi.fn(),limit=vi.fn();
    renderWithKit(<PageBar total={5} current={4} onSelect={()=>{}} onAdd={add} onLimit={limit}/>);
    const button=screen.getByRole('button',{name:'페이지 추가하기'});
    expect(button).toHaveAttribute('aria-disabled','true');
    await userEvent.click(button);
    expect(add).not.toHaveBeenCalled();expect(limit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button',{name:'다음 페이지, 마지막 페이지예요'})).toHaveAttribute('aria-disabled','true');
  });
  it('switches names with the language at once',()=>{
    const view=renderWithKit(<PageBar total={2} current={0} onSelect={()=>{}} onAdd={()=>{}}/>,{locale:'en'});
    expect(screen.getByRole('navigation',{name:'Pages'})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Go to page 2'})).toBeInTheDocument();
    view.unmount();
    renderWithKit(<PageBar total={2} current={0} onSelect={()=>{}} onAdd={()=>{}}/>,{locale:'zh-Hans'});
    expect(screen.getByRole('button',{name:/2/})).toBeInTheDocument();
    expect(screen.getByRole('navigation',{name:'页面'})).toBeInTheDocument();
  });
});
describe('EdgeZoneBand (SCR-25)',()=>{
  it('is a polite status only while visible',()=>{
    const { rerender } = renderWithKit(<EdgeZoneBand side="right" targetPage={2} visible={false}/>);
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<EdgeZoneBand side="right" targetPage={2} visible/>);
    expect(screen.getByRole('status')).toHaveTextContent('2페이지로 이동');
  });
});
describe('HelpButton and coach (SCR-27)',()=>{
  it('names the button, stops the press from reaching the panel, and hides while editing',async()=>{
    const press=vi.fn(),panelClick=vi.fn(),panelDown=vi.fn();
    const { rerender } = renderWithKit(<div onClick={panelClick} onPointerDown={panelDown}><HelpButton name="가계부" onPress={press}/></div>);
    const button=screen.getByRole('button',{name:'가계부 설명 보기'});
    await userEvent.click(button);
    expect(press).toHaveBeenCalledTimes(1);expect(panelClick).not.toHaveBeenCalled();expect(panelDown).not.toHaveBeenCalled();
    rerender(<div><HelpButton name="가계부" hidden onPress={press}/></div>);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows the coach footer only with two or more tips and skips through the callback',async()=>{
    const skip=vi.fn();
    const { rerender } = renderWithKit(<CoachFooter current={1} total={1} onSkipAll={skip}/>);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<CoachFooter current={2} total={8} onSkipAll={skip}/>);
    expect(screen.getByText('2/8')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'남은 안내 모두 건너뛰기'}));
    expect(skip).toHaveBeenCalledTimes(1);
  });
  it('gives a multi-step tip a primary next button, and the last tip a confirm button without a skip link',async()=>{
    const next=vi.fn(),skip=vi.fn();
    const { rerender } = renderWithKit(<CoachFooter current={1} total={3} onSkipAll={skip} onNext={next} nextLabel="다음"/>);
    await userEvent.click(screen.getByRole('button',{name:'다음'}));expect(next).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button',{name:'남은 안내 모두 건너뛰기'})).toBeInTheDocument();
    rerender(<CoachFooter current={3} total={3} onSkipAll={skip} onNext={next} nextLabel="다음" last/>);
    expect(screen.getByText('3/3')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'남은 안내 모두 건너뛰기'})).toBeNull();expect(screen.queryByRole('button',{name:'다음'})).toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'확인'}));expect(next).toHaveBeenCalledTimes(2);
  });
  it('localizes the last-tip confirm word and keeps the footer without a next button for callers that pass none',()=>{
    const { rerender } = renderWithKit(<CoachFooter current={2} total={2} onSkipAll={()=>{}} onNext={()=>{}} last/>,{locale:'en'});
    expect(screen.getByRole('button',{name:'OK'})).toBeInTheDocument();
    rerender(<CoachFooter current={1} total={2} onSkipAll={()=>{}}/>);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
  it('renders WidgetCoach as a note with the widget name line, a localized close and the footer',()=>{
    const anchor={current:document.createElement('div')};document.body.append(anchor.current);
    renderWithKit(<WidgetCoach open anchorRef={anchor} onClose={()=>{}} title="Ledger" queue={{current:1,total:3,onSkipAll:()=>{}}}>Shows money in and out</WidgetCoach>,{locale:'en'});
    const note=document.querySelector('.ui-popover--coach') as HTMLElement;
    expect(note).toHaveAttribute('role','note');expect(note).toHaveAttribute('aria-label','Ledger');
    expect(note.querySelector('.ui-widget-coach__title')).toHaveTextContent('Ledger');expect(note).toHaveTextContent('Shows money in and out');
    // One close X for every coach: the same localized name as a step tip (the OK word belongs to the footer button).
    expect(note.querySelector('button[aria-label="Close tip"]')).not.toBeNull();
    expect(within(note).getByText('1/3')).toBeInTheDocument();
    expect(within(note).getByText('Skip all remaining tips').closest('button')).not.toBeNull();
  });
});
describe('settings views (SCR-28/29)',()=>{
  it('ListSelectRow reads label and value as one sentence and keeps the value lang',()=>{
    renderWithKit(<ListSelectRow label="언어" value="English" lang="en" onPress={()=>{}}/>);
    expect(screen.getByRole('button',{name:'언어, English'})).toBeInTheDocument();
    expect(screen.getByText('English')).toHaveAttribute('lang','en');
  });
  it('LanguageSelect lists four languages, each in its own lang, applies at once',async()=>{
    const change=vi.fn();
    function Host(){const [locale,setLocale]=useState<Locale>('ko');return <LanguageSelect locale={locale} onChange={next=>{change(next);setLocale(next);}} onBack={()=>{}} onClose={()=>{}}/>;}
    renderWithKit(<Host/>);
    const group=screen.getByRole('radiogroup',{name:'언어'});
    const radios=within(group).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(screen.getByText('English')).toHaveAttribute('lang','en');
    expect(screen.getByText('简体中文')).toHaveAttribute('lang','zh-Hans');
    expect(screen.getByText('繁體中文')).toHaveAttribute('lang','zh-Hant');
    expect(radios[0]).toBeChecked();
    await userEvent.click(radios[1]!);
    expect(change).toHaveBeenCalledWith('en');
    expect(radios[1]).toBeChecked();
  });
  it('ExampleStateSelect has no prototype notice (D-323) and describes the special state',async()=>{
    const change=vi.fn(),back=vi.fn();
    renderWithKit(<ExampleStateSelect family="normal" onChange={change} onBack={back} onClose={()=>{}}/>);
    expect(screen.queryByText('시연용 설정이에요. 실제 서비스에는 없어요')).not.toBeInTheDocument();
    expect(screen.getByText('패널마다 확인 필요·일부 자료 없음처럼 달라요')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('radio')[2]!);
    expect(change).toHaveBeenCalledWith('error');
    await userEvent.click(screen.getByRole('button',{name:'설정으로'}));expect(back).toHaveBeenCalled();
  });
  it('ExampleStateChip is a button naming the state',async()=>{
    const press=vi.fn();
    renderWithKit(<ExampleStateChip state="불러오기 실패" onPress={press}/>);
    await userEvent.click(screen.getByRole('button',{name:/예시 상태: 불러오기 실패/}));
    expect(press).toHaveBeenCalled();
  });
});
describe('badges',()=>{
  it('IntegrationBadge is static text with the sentence as its name',()=>{
    renderWithKit(<IntegrationBadge label="네이버 캘린더 연결됨(예시)"/>);
    expect(screen.getByText('네이버 캘린더 연결됨(예시)')).toBeInTheDocument();
    expect(document.querySelector('.ui-integration-badge')).not.toHaveAttribute('tabindex');
  });
  it('StatusBadge speaks words, not only colour',()=>{
    renderWithKit(<><StatusBadge kind="needsReview"/><StatusBadge kind="endingSoon"/><StatusBadge kind="recommended"/></>,{locale:'en'});
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('Ending soon')).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });
  it('SplitBar has a summary sentence and direct labels',()=>{
    renderWithKit(<SplitBar a={{label:'오전',value:22,display:'22명'}} b={{label:'오후',value:48,display:'48명'}}/>);
    expect(screen.getByRole('img',{name:'오전 22명, 오후 48명'})).toBeInTheDocument();
  });
});
describe('forms',()=>{
  it('DetailTabs switches panels with arrow keys',async()=>{
    function Host(){const [v,setV]=useState<'a'|'b'>('a');return <DetailTabs value={v} onValueChange={setV} label="보기" tabs={[{value:'a',label:'매출'},{value:'b',label:'지출'}]} panels={{a:<p>A내용</p>,b:<p>B내용</p>}}/>;}
    renderWithKit(<Host/>);
    expect(screen.getByRole('tab',{name:'매출'})).toHaveAttribute('aria-selected','true');
    await userEvent.click(screen.getByRole('tab',{name:'지출'}));
    expect(screen.getByText('B내용')).toBeVisible();
  });
  it('ChipChoice and SegmentedControl are radio groups with roving keyboard',async()=>{
    const change=vi.fn();
    function Host(){const [v,setV]=useState('7');return <><ChipChoice label="기간" value={v} onChange={x=>{change(x);setV(x);}} options={[{value:'1',label:'오늘'},{value:'7',label:'7일'},{value:'30',label:'30일'}]}/><SegmentedControl label="종류" value="a" onChange={()=>{}} options={[{value:'a',label:'일정'},{value:'b',label:'To-Do'}]}/></>;}
    renderWithKit(<Host/>);
    expect(screen.getByRole('radio',{name:'7일'})).toBeChecked();
    screen.getByRole('radio',{name:'7일'}).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(change).toHaveBeenCalledWith('30');expect(screen.getByRole('radio',{name:'30일'})).toBeChecked();
    expect(screen.getByRole('radiogroup',{name:'종류'})).toBeInTheDocument();
  });
  it('TextField labels above, reports errors as a sentence, NumberField keeps units',async()=>{
    const change=vi.fn();
    renderWithKit(<><TextField label="메모" value="" onValueChange={change} error="한 글자 이상 적어 주세요"/><NumberField label="금액" unit="원" value={null} onValueChange={change}/><Textarea label="내용" value="" onValueChange={()=>{}}/></>);
    const field=screen.getByLabelText('메모');
    expect(field).toHaveAttribute('aria-invalid','true');
    expect(field).toHaveAccessibleDescription(/한 글자 이상 적어 주세요/);
    await userEvent.type(screen.getByLabelText('금액'),'12');
    expect(change).toHaveBeenLastCalledWith(2);
    expect(screen.getByText('원')).toBeInTheDocument();
    expect(screen.getByLabelText('내용').tagName).toBe('TEXTAREA');
  });
  it('DateStepper steps with buttons and Left/Right arrows on the date',async()=>{
    const prev=vi.fn(),next=vi.fn();
    renderWithKit(<DateStepper text="10월 26일 월요일" onPrevious={prev} onNext={next} previousDisabled={false}/>);
    await userEvent.click(screen.getByRole('button',{name:'다음 날짜'}));expect(next).toHaveBeenCalledTimes(1);
    screen.getByText('10월 26일 월요일').focus();
    await userEvent.keyboard('{ArrowLeft}');expect(prev).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('group',{name:'날짜'})).toBeInTheDocument();
  });
  it('TimeChips offers the suggested times as a group',async()=>{
    const pick=vi.fn();
    renderWithKit(<TimeChips times={['14:00','15:00','16:00']} value="15:00" onChange={pick}/>);
    expect(screen.getByRole('radio',{name:'15:00'})).toBeChecked();
    await userEvent.click(screen.getByRole('radio',{name:'16:00'}));expect(pick).toHaveBeenCalledWith('16:00');
  });
  it('QuantityStepper disables the out-of-range button and says why',async()=>{
    const change=vi.fn();
    renderWithKit(<QuantityStepper label="입고량" value={0} min={0} max={5} unit="L" remaining="잔량 4 L" minReason="0보다 작게 못 줄여요" onChange={change}/>);
    const dec=screen.getByRole('button',{name:'줄이기'});
    expect(dec).toBeDisabled();expect(dec).toHaveAccessibleDescription('0보다 작게 못 줄여요');
    expect(screen.getByText('잔량 4 L')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'늘리기'}));expect(change).toHaveBeenCalledWith(1);
  });
  it('ChecklistRow reads its state and toggles with Space',async()=>{
    const change=vi.fn();
    renderWithKit(<ChecklistRow checked={false} onCheckedChange={change}>영수증 확인</ChecklistRow>);
    const box=screen.getByRole('checkbox',{name:'영수증 확인'});
    box.focus();await userEvent.keyboard(' ');
    expect(change).toHaveBeenCalledWith(true);
  });
  it('InlineForm focuses the first field, saves on submit and returns focus to the opener',async()=>{
    const save=vi.fn(),close=vi.fn();
    function Host(){const [open,setOpen]=useState(false);return <><ActionButton onClick={()=>setOpen(true)}>지출 기록</ActionButton>{open?<InlineForm title="지출 기록" onSave={save} onClose={()=>{close();setOpen(false);}}><TextField label="품목" value="" onValueChange={()=>{}}/></InlineForm>:null}</>;}
    renderWithKit(<Host/>);
    const opener=screen.getByRole('button',{name:'지출 기록'});
    await userEvent.click(opener);
    expect(screen.getByLabelText('품목')).toHaveFocus();
    await userEvent.click(screen.getByRole('button',{name:'저장하기'}));expect(save).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button',{name:'닫기'}));
    expect(close).toHaveBeenCalled();expect(screen.getByRole('button',{name:'지출 기록'})).toHaveFocus();
  });
  it('DraftCard writes the real clipboard and selects the text with an alert when it fails',async()=>{
    const copied=vi.fn();
    const write=vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator,'clipboard',{value:{writeText:write},configurable:true});
    const { unmount } = renderWithKit(<DraftCard text="공고 초안" onCopied={copied}/>);
    expect(screen.getByText('초안')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'복사하기'}));
    expect(write).toHaveBeenCalledWith('공고 초안');expect(copied).toHaveBeenCalledWith(true);expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    Object.defineProperty(navigator,'clipboard',{value:{writeText:vi.fn().mockRejectedValue(new Error('no'))},configurable:true});
    renderWithKit(<DraftCard text="공고 초안" onCopied={copied}/>);
    await userEvent.click(screen.getByRole('button',{name:'복사하기'}));
    expect(copied).toHaveBeenLastCalledWith(false);
    expect(await screen.findByRole('alert')).toHaveTextContent('복사하지 못했어요. 직접 복사해 주세요');
    expect(window.getSelection()?.toString()).toContain('공고 초안');
    await expect(copyText('x')).resolves.toBe(false);
  });
  it('ChannelTransfer keeps the total and refuses more than the store stock',async()=>{
    const move=vi.fn();
    renderWithKit(<ChannelTransfer store={3} online={5} unit="개" onTransfer={move}/>);
    expect(screen.getByText('합계 8개')).toBeInTheDocument();expect(screen.getByText('합계는 그대로예요')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'늘리기'}));await userEvent.click(screen.getByRole('button',{name:'늘리기'}));
    await userEvent.click(screen.getByRole('button',{name:'옮기기'}));
    expect(move).toHaveBeenCalledWith({from:'store',amount:3});
    expect(screen.getByRole('button',{name:'늘리기'})).toBeDisabled();
  });
  it('MasterDetail labels both regions',()=>{
    renderWithKit(<MasterDetail list={<p>목록</p>} detail={<p>상세</p>}/>);
    expect(screen.getByRole('region',{name:'목록'})).toHaveTextContent('목록');
    expect(screen.getByRole('region',{name:'자세한 내용'})).toHaveTextContent('상세');
  });
});

describe('FeaturePanel v4 frame',()=>{
  const panel=(props:Partial<Parameters<typeof FeaturePanel>[0]>={})=><FeaturePanel featureId="ledger" label="가계부" groupId="money" width={1} height={1} {...props}><PanelAction label="쿠폰 보내기" widgetName="가계부" onPress={()=>{}}/></FeaturePanel>;
  it('builds the accessible name from the template and the key sentence',()=>{
    renderWithKit(panel({row:2,column:3,summary:'오늘 매출 128.4만 원, 지난주보다 ▲8.2%'}));
    expect(screen.getByRole('button',{name:'가계부, 2행 3열, 가로 1칸 세로 1칸, 오늘 매출 128.4만 원, 지난주보다 ▲8.2%, 자세히 보기'})).toBeInTheDocument();
  });
  it('builds the name in English and Chinese',()=>{
    const view=renderWithKit(panel({row:1,column:1,summary:'Today 1.28M'}),{locale:'en'});
    expect(screen.getByRole('button',{name:'가계부, row 1 column 1, 1 wide 1 tall, Today 1.28M, view details'})).toBeInTheDocument();
    view.unmount();
    renderWithKit(panel({row:1,column:1,summary:'今日 128.4万'}),{locale:'zh-Hans'});
    expect(screen.getByRole('button',{name:'가계부，第1行第1列，宽1格高1格，今日 128.4万，查看详情'})).toBeInTheDocument();
  });
  it('keeps the iteration-3 name when no summary is given',()=>{
    renderWithKit(panel());
    expect(screen.getByRole('button',{name:'가계부, 가로 1칸, 세로 1칸 패널'})).toBeInTheDocument();
  });
  it('shows (?) normally and hides it while editing, without opening the panel',async()=>{
    const help=vi.fn(),open=vi.fn();
    const { rerender } = renderWithKit(panel({onHelp:help,onOpen:open}));
    await userEvent.click(screen.getByRole('button',{name:'가계부 설명 보기'}));
    expect(help).toHaveBeenCalledTimes(1);expect(open).not.toHaveBeenCalled();
    rerender(panel({onHelp:help,onOpen:open,editing:true}));
    expect(screen.queryByRole('button',{name:'가계부 설명 보기'})).toBeNull();
  });
});
describe('PanelAction (DS 11.9.1)',()=>{
  it('presses without reaching the panel, names itself with the widget and keeps its slot when editing or waiting',async()=>{
    const press=vi.fn(),open=vi.fn();
    const { rerender } = renderWithKit(<FeaturePanel featureId="slot-coupon" label="빈 시간 단골 쿠폰" groupId="customers" width={1} height={1} onOpen={open}><PanelAction label="쿠폰 보내기" widgetName="빈 시간 단골 쿠폰" onPress={press}/></FeaturePanel>);
    const action=screen.getByRole('button',{name:'쿠폰 보내기, 빈 시간 단골 쿠폰'});
    await userEvent.click(action);
    expect(press).toHaveBeenCalledTimes(1);expect(open).not.toHaveBeenCalled();
    const slot=action.closest('.ui-panel-action-slot') as HTMLElement;
    expect(slot).not.toHaveAttribute('data-hidden');
    const rerenderPanel=(props:{editing?:boolean;waiting?:boolean})=>rerender(<FeaturePanel featureId="slot-coupon" label="빈 시간 단골 쿠폰" groupId="customers" width={1} height={1} onOpen={open} {...props}><PanelAction label="쿠폰 보내기" widgetName="빈 시간 단골 쿠폰" onPress={press}/></FeaturePanel>);
    rerenderPanel({editing:true});
    const hidden=document.querySelector('.ui-panel-action-slot') as HTMLElement;
    expect(hidden).toBe(slot);expect(hidden).toHaveAttribute('data-hidden','true');expect(hidden).toHaveAttribute('aria-hidden','true');
    expect(screen.queryByRole('button',{name:'쿠폰 보내기, 빈 시간 단골 쿠폰'})).toBeNull();
    rerenderPanel({waiting:true});
    expect(document.querySelector('.ui-panel-action-slot')).toHaveAttribute('data-hidden','true');
    rerenderPanel({});
    expect(screen.getByRole('button',{name:'쿠폰 보내기, 빈 시간 단골 쿠폰'})).toBeInTheDocument();
  });
  it('does not forward pointer or key events to ancestors (no long press)',()=>{
    const down=vi.fn(),up=vi.fn(),key=vi.fn();
    renderWithKit(<div onPointerDown={down} onPointerUp={up} onKeyDown={key}><PanelAction label="영상 만들기" widgetName="AI 홍보 영상" onPress={()=>{}}/></div>);
    const button=screen.getByRole('button',{name:'영상 만들기, AI 홍보 영상'});
    fireEvent.pointerDown(button);fireEvent.pointerUp(button);fireEvent.keyDown(button,{key:'Enter'});
    expect(down).not.toHaveBeenCalled();expect(up).not.toHaveBeenCalled();expect(key).not.toHaveBeenCalled();
  });
});
describe('PanelState and MetricFit (DS 11.5, 11.3.4)',()=>{
  it('PanelState shows icon text, message and at most one action',async()=>{
    const retry=vi.fn();
    renderWithKit(<PanelState tone="error" message="불러오지 못했어요" action={{label:'다시 시도',widgetName:'가계부',onPress:retry}}/>);
    expect(screen.getByRole('alert')).toHaveTextContent('불러오지 못했어요');
    await userEvent.click(screen.getByRole('button',{name:'다시 시도, 가계부'}));expect(retry).toHaveBeenCalled();
  });
  const wide=(text:string,px:number)=>Array.from(text).length*px*0.6;
  it('chooses the stage from the longest string: 0 metric, 1 heading, 2 heading with the unit below',()=>{
    const measure=(text:string,px:number)=>wide(text,px);
    expect(chooseMetricStage({width:300,text:'₩99,999',unit:'원',measure})).toBe(0);
    expect(chooseMetricStage({width:230,text:'₩1,284,000',unit:'원',measure})).toBe(1);
    expect(chooseMetricStage({width:170,text:'₩1,284,000',unit:'원',measure})).toBe(2);
    expect(chooseMetricStage({width:230,text:'₩1,284,000',unit:'원',measure,textScale:125})).toBe(2);
  });
  it('MetricFit fixes the stage by the longest value, so a shorter value does not change it',()=>{
    const measure=(text:string,px:number)=>wide(text,px);
    vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(230);
    const { rerender } = renderWithKit(<div><MetricFit value="₩99,999" longest="₩1,284,000" unit="원" measure={measure}/></div>);
    expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage','1');
    rerender(<div><MetricFit value="₩1,284,000" longest="₩1,284,000" unit="원" measure={measure}/></div>);
    expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage','1');
  });
});
describe('language switch is immediate and keeps state',()=>{
  it('re-renders names in the new language without remounting the control',()=>{
    const { rerender } = render(<I18nProvider locale="ko"><HelpButton name="Ledger" onPress={()=>{}}/></I18nProvider>);
    const button=screen.getByRole('button');expect(button).toHaveAccessibleName('Ledger 설명 보기');
    rerender(<I18nProvider locale="en"><HelpButton name="Ledger" onPress={()=>{}}/></I18nProvider>);
    expect(screen.getByRole('button')).toBe(button);expect(button).toHaveAccessibleName('About Ledger');
    act(()=>{});
  });
});

describe('FunctionRow accessible name (T-064)',()=>{
  it.each([['ko','장부, 이미 있어요'],['en','Ledger, Already added'],['zh-Hans','账本，已添加'],['zh-Hant','帳本，已新增']] as const)('%s joins label and placed state with its own comma',(locale,name)=>{
    const label=name.split(/[,，]/)[0]!;
    renderWithKit(<><FunctionRow label={label} icon="ledger" placed/><FunctionRow label={`${label}2`} icon="ledger"/></>,{locale});
    expect(screen.getByRole('button',{name})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:`${label}2`})).toBeInTheDocument();
  });
});
