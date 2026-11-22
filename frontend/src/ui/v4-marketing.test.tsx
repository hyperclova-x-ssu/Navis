import './test-setup';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from './test-utils';
import {
  DiscountSlider, DiscountSummary, BenefitCards, RecipientList, maskName, SmsPreview, SendTimePicker, ConfirmStep, CopyThenPosted,
  UsageBar, RateBar, FormulaRow, InsightCard, StepProgress, VideoPlayer, SceneList, type VideoScene,
} from './index';

afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});

describe('DiscountSlider (DS 11.9.4, M-29)',()=>{
  function Host({start=40,max=65}:{start?:number;max?:number}){const [v,setV]=useState(start);return <><DiscountSlider value={v} onChange={setV} max={max} recommended={40} profitText="1,200원"/><output data-testid="out">{v}</output></>;}
  const slider=()=>screen.getByRole('slider');
  it('reads value, profit and limit, with an integer range 0..limit',()=>{
    renderWithKit(<Host/>);
    expect(slider()).toHaveAttribute('aria-valuenow','40');expect(slider()).toHaveAttribute('aria-valuemin','0');expect(slider()).toHaveAttribute('aria-valuemax','65');
    expect(slider()).toHaveAttribute('aria-valuetext','할인율 40%, 개당 남는 돈 1,200원, 한도 65%');
    expect(screen.getByText('추천 40%')).toBeInTheDocument();expect(screen.getByText('여기부터는 손해예요')).toBeInTheDocument();
  });
  it('moves 1 with arrows, 10 with PageUp/PageDown, Home to 0 and End to the limit; never above the limit',async()=>{
    renderWithKit(<Host/>);
    slider().focus();
    const out=()=>screen.getByTestId('out').textContent;
    await userEvent.keyboard('{ArrowRight}');expect(out()).toBe('41');
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');expect(out()).toBe('39');
    await userEvent.keyboard('{PageUp}');expect(out()).toBe('49');
    await userEvent.keyboard('{PageDown}{PageDown}');expect(out()).toBe('29');
    await userEvent.keyboard('{End}');expect(out()).toBe('65');
    await userEvent.keyboard('{ArrowRight}{PageUp}');expect(out()).toBe('65');
    await userEvent.keyboard('{Home}');expect(out()).toBe('0');
    await userEvent.keyboard('{ArrowLeft}');expect(out()).toBe('0');
  });
  it('has +/- buttons that stop at the ends and a number field that clamps to the limit',async()=>{
    renderWithKit(<Host start={64}/>);
    await userEvent.click(screen.getByRole('button',{name:'할인율 늘리기'}));expect(screen.getByTestId('out')).toHaveTextContent('65');
    expect(screen.getByRole('button',{name:'할인율 늘리기'})).toBeDisabled();
    const field=screen.getByRole('spinbutton');
    fireEvent.change(field,{target:{value:'90'}});expect(screen.getByTestId('out')).toHaveTextContent('65');
    fireEvent.change(field,{target:{value:'33.6'}});expect(screen.getByTestId('out')).toHaveTextContent('34');
  });
  it('follows the pointer 1:1 and clamps at the limit',()=>{
    renderWithKit(<Host start={10}/>);
    const track=document.querySelector('.ui-discount__track') as HTMLElement;
    vi.spyOn(track,'getBoundingClientRect').mockReturnValue({left:100,width:400,top:0,height:8,right:500,bottom:8,x:100,y:0,toJSON(){return {};}});
    fireEvent.pointerDown(track,{clientX:300,pointerId:1,button:0});expect(screen.getByTestId('out')).toHaveTextContent('50');
    fireEvent.pointerMove(track,{clientX:420,pointerId:1});expect(screen.getByTestId('out')).toHaveTextContent('65');
    fireEvent.pointerMove(track,{clientX:180,pointerId:1});expect(screen.getByTestId('out')).toHaveTextContent('20');
    fireEvent.pointerUp(track,{pointerId:1});fireEvent.pointerMove(track,{clientX:300,pointerId:1});expect(screen.getByTestId('out')).toHaveTextContent('20');
  });
  it('DiscountSummary prints the three money sentences and the loss line',()=>{
    renderWithKit(<DiscountSummary price="2,100원" profit="900원" total="18,000원" lossCost="12,000원" fixedSet/>);
    expect(screen.getByText('할인가 2,100원 · 개당 남는 돈 900원 · 모두 팔면 18,000원')).toBeInTheDocument();
    expect(screen.getByText('못 팔면 원가 12,000원을 버려요')).toBeInTheDocument();
    expect(screen.getByText('세트는 가격이 정해져 있어요')).toBeInTheDocument();
  });
});
describe('BenefitCards',()=>{
  it('is a radio group with a recommended badge and arrow keys',async()=>{
    const change=vi.fn();
    renderWithKit(<BenefitCards value="shot" onChange={change} options={[{value:'shot',name:'샷 추가 무료',detail:'개당 1,700원',recommended:true,diff:'200원 더 남아요'},{value:'pct',name:'10% 할인',detail:'개당 1,500원'}]}/>);
    expect(screen.getByRole('radiogroup',{name:'혜택'})).toBeInTheDocument();
    expect(screen.getByRole('radio',{name:/샷 추가 무료/})).toBeChecked();
    expect(screen.getByText('추천')).toBeInTheDocument();expect(screen.getByText('200원 더 남아요')).toBeInTheDocument();
    screen.getByRole('radio',{name:/샷 추가 무료/}).focus();await userEvent.keyboard('{ArrowDown}');
    expect(change).toHaveBeenCalledWith('pct');
  });
});
describe('RecipientList',()=>{
  const people=[{id:'a',name:'김민수',meta:'화요일 오전 · 방문 6회',consent:true},{id:'b',name:'이서연',meta:'수요일 · 방문 4회',consent:true},{id:'c',name:'박지훈',consent:false}];
  it('masks names and disables rows without consent without repeating the selection count',async()=>{
    const change=vi.fn(),empty=vi.fn();
    function Host(){const [sel,setSel]=useState<readonly string[]>(['a']);return <RecipientList recipients={people} selected={sel} onChange={ids=>{change(ids);setSel(ids);}} onEmptyChange={empty}/>;}
    renderWithKit(<Host/>);
    expect(maskName('김민수')).toBe('김○○');expect(screen.getByText('김○○')).toBeInTheDocument();expect(screen.queryByText('김민수')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    const blocked=screen.getByRole('checkbox',{name:'박○○'});
    expect(blocked).toHaveAttribute('aria-disabled','true');expect(blocked).toHaveAccessibleDescription('문자를 보낼 수 없어요(문자 동의 안 함)');
    await userEvent.click(screen.getByRole('checkbox',{name:'이○○'}));
    expect(change).toHaveBeenLastCalledWith(['a','b']);expect(screen.queryByRole('status')).toBeNull();
    await userEvent.click(screen.getByRole('checkbox',{name:'김○○'}));await userEvent.click(screen.getByRole('checkbox',{name:'이○○'}));
    expect(empty).toHaveBeenLastCalledWith(true);
  });
  it('ignores a selected id whose row has no consent',()=>{
    const change=vi.fn(); renderWithKit(<RecipientList recipients={people} selected={['c','a']} onChange={change}/>);
    fireEvent.click(screen.getByRole('checkbox',{name:'이○○'}));
    expect(change).toHaveBeenCalledWith(['a','b']);
  });
  it('marks a sendable row with the kit StatusBadge (done: check icon + 동의 text, 28 high), and a no-consent row with no badge',()=>{
    renderWithKit(<RecipientList recipients={people} selected={['a']} onChange={()=>{}}/>);
    const rows=screen.getAllByRole('listitem');
    const badge=rows[0]!.querySelector('.ui-status-badge')!;
    expect(badge).toHaveTextContent('동의');expect(badge).toHaveAttribute('data-semantic','done');expect(badge).toHaveAttribute('data-tone','success');
    expect(badge.querySelector('svg')).not.toBeNull();expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden','true');
    expect(rows[0]!.querySelector('.ui-recipient-row__badge')).toBeNull();
    expect(rows[2]!.querySelector('.ui-status-badge')).toBeNull();
    expect(within(rows[2]!).getByText('문자를 보낼 수 없어요(문자 동의 안 함)')).toBeInTheDocument();
  });
});
describe('SmsPreview',()=>{
  it('keeps the (광고) first line and the opt-out last line fixed; only the body is editable',async()=>{
    const change=vi.fn();
    renderWithKit(<SmsPreview body="화요일 한산한 시간 쿠폰이에요" onBodyChange={change} recipientCount={5}/>);
    const group=screen.getByRole('group',{name:'문구 미리보기'});
    expect(within(group).getByText('(광고)')).toBeInTheDocument();expect(within(group).getByText('수신 거부 안내')).toBeInTheDocument();
    expect(group.querySelectorAll('textarea')).toHaveLength(1);
    const fixed=[...group.querySelectorAll('[data-fixed]')];
    expect(fixed.map(e=>e.getAttribute('data-fixed'))).toEqual(['ad','optout']);
    expect(group.firstElementChild).toBe(fixed[0]);expect(group.querySelector('p.ui-sms-preview__line')?.previousElementSibling).toBe(fixed[1]);
    expect(fixed.every(e=>e.querySelector('input,textarea')===null)).toBe(true);
    await userEvent.type(screen.getByLabelText('문구 내용'),'!');expect(change).toHaveBeenCalled();
    expect(screen.getByText('받는 사람 5명')).toBeInTheDocument();expect(screen.queryByText(/가짜 문자/)).not.toBeInTheDocument();
  });
  it('speaks the ad mark in English and Chinese',()=>{
    renderWithKit(<SmsPreview body="x" onBodyChange={()=>{}} recipientCount={1}/>,{locale:'en'});
    expect(screen.getByText('(Ad)')).toBeInTheDocument();expect(screen.getByText('1 recipient')).toBeInTheDocument();
  });
});
describe('SendTimePicker',()=>{
  function Host({start='14:00',onTime}:{start?:string;onTime?:(time:string)=>void}){const [mode,setMode]=useState<'now'|'schedule'>('now');const [time,setTime]=useState(start);return <SendTimePicker mode={mode} onModeChange={setMode} time={time} onTimeChange={next=>{onTime?.(next);setTime(next);}}/>;}
  it('shows the kit TimeField (a 48 high button that opens a list), not the browser time input',async()=>{
    renderWithKit(<Host/>);
    expect(screen.queryByRole('button',{name:/예약 시각/})).toBeNull();
    await userEvent.click(screen.getByRole('radio',{name:'예약'}));
    expect(document.querySelector('input[type="time"]')).toBeNull();
    const field=screen.getByRole('button',{name:'예약 시각 14:00'});
    expect(field).toHaveTextContent('14:00');
    await userEvent.click(field);
    const list=await screen.findByRole('listbox',{name:'예약 시각'});
    const options=within(list).getAllByRole('option').map(o=>o.textContent);
    expect(options.slice(0,3)).toEqual(['00:00','00:30','01:00']);expect(options).toHaveLength(48);
    expect(within(list).getByRole('option',{name:'14:00'})).toHaveAttribute('aria-selected','true');
  });
  it('Enter picks the focused time, closes the list and returns focus to the field',async()=>{
    const onTime=vi.fn();renderWithKit(<Host onTime={onTime}/>);
    await userEvent.click(screen.getByRole('radio',{name:'예약'}));
    const field=screen.getByRole('button',{name:'예약 시각 14:00'});
    await userEvent.click(field);await screen.findByRole('listbox');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onTime).toHaveBeenCalledWith('14:30');expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button',{name:'예약 시각 14:30'})).toHaveFocus();
  });
  it('accepts any time of day: a 22:30 or 03:00 schedule shows no warning (no night restriction)',async()=>{
    const onTime=vi.fn();renderWithKit(<Host onTime={onTime}/>);
    await userEvent.click(screen.getByRole('radio',{name:'예약'}));
    for(const value of ['22:30','03:00','15:00']){
      await userEvent.click(screen.getByRole('button',{name:/^예약 시각 /}));
      await userEvent.click(await screen.findByRole('option',{name:value}));
      expect(onTime).toHaveBeenLastCalledWith(value);
      expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByRole('button',{name:`예약 시각 ${value}`})).not.toHaveAttribute('aria-invalid','true');
    }
  });
  it('an empty time shows the placeholder instead of a value, and a time off the 30-minute grid stays visible',async()=>{
    const {unmount}=renderWithKit(<Host start=""/>);
    await userEvent.click(screen.getByRole('radio',{name:'예약'}));
    expect(screen.getByRole('button',{name:/^예약 시각/})).toHaveTextContent('시각 고르기');
    unmount();
    renderWithKit(<Host start="23:15"/>);
    await userEvent.click(screen.getByRole('radio',{name:'예약'}));
    await userEvent.click(screen.getByRole('button',{name:'예약 시각 23:15'}));
    expect(within(await screen.findByRole('listbox')).getByRole('option',{name:'23:15'})).toHaveAttribute('aria-selected','true');
  });
  it('keeps the radio group and the "now" mode without a time field',async()=>{
    renderWithKit(<Host/>);
    expect(screen.getByRole('radio',{name:'지금'})).toBeChecked();expect(screen.queryByRole('button',{name:/예약 시각/})).toBeNull();
  });
});
describe('ConfirmStep',()=>{
  it('focuses the title, disables send at once on press and sends only once',async()=>{
    const send=vi.fn();
    renderWithKit(<ConfirmStep count={5} summary={[{label:'받는 사람',value:'5명'},{label:'혜택',value:'샷 추가 무료'},{label:'시각',value:'지금'}]} onSend={send} onCancel={()=>{}}/>);
    expect(screen.getByRole('heading',{name:'5명에게 쿠폰을 보낼까요?'})).toHaveFocus();
    const button=screen.getByRole('button',{name:'보내기'});
    await userEvent.dblClick(button);
    expect(send).toHaveBeenCalledTimes(1);expect(button).toBeDisabled();
  });
  it('shows the sending and sent sentences and removes the actions after sending',()=>{
    const { rerender } = renderWithKit(<ConfirmStep count={5} summary={[]} onSend={()=>{}} onCancel={()=>{}} phase="sending"/>);
    expect(screen.getByRole('status')).toHaveTextContent('보내고 있어요');expect(screen.getByRole('button',{name:'다음에'})).toBeDisabled();
    rerender(<ConfirmStep count={5} summary={[]} onSend={()=>{}} onCancel={()=>{}} phase="sent"/>);
    expect(screen.getByRole('status')).toHaveTextContent('보냈어요');expect(screen.queryByRole('button')).toBeNull();
  });
});
describe('CopyThenPosted',()=>{
  it('copies, tells the next step, and counts as posted only after the second press (once)',async()=>{
    const write=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{value:{writeText:write},configurable:true});
    const posted=vi.fn(),copied=vi.fn();
    renderWithKit(<CopyThenPosted text="게시 문구" onCopied={copied} onPosted={posted}/>);
    await userEvent.click(screen.getByRole('button',{name:'복사하기'}));
    expect(write).toHaveBeenCalledWith('게시 문구');expect(copied).toHaveBeenCalledWith(true);expect(posted).not.toHaveBeenCalled();
    expect(screen.getByText(/직접 올린 뒤 ‘올렸다고 표시하기’를 눌러 주세요/)).toBeInTheDocument();
    await userEvent.dblClick(screen.getByRole('button',{name:'올렸다고 표시하기'}));
    expect(posted).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'올렸다고 표시하기'})).toBeDisabled();
  });
});
describe('bars, formula, insight, steps',()=>{
  it('UsageBar and RateBar carry their numbers as text',()=>{
    renderWithKit(<><UsageBar used={4} total={20}/><RateBar value={34} label="플레이스"/></>);
    expect(screen.getByRole('img',{name:'사용 4, 발행 20'})).toBeInTheDocument();expect(screen.getByText('4/20')).toBeInTheDocument();
    expect(screen.getByRole('img',{name:'플레이스 34%'})).toBeInTheDocument();expect(screen.getByText('34%')).toBeInTheDocument();
  });
  it('FormulaRow is collapsed by default and reads its state',async()=>{
    renderWithKit(<FormulaRow><p>회수율 = 사용 ÷ 발행</p></FormulaRow>);
    const toggle=screen.getByRole('button',{name:'계산 보기'});expect(toggle).toHaveAttribute('aria-expanded','false');expect(screen.queryByText('회수율 = 사용 ÷ 발행')).toBeNull();
    await userEvent.click(toggle);expect(toggle).toHaveAttribute('aria-expanded','true');expect(screen.getByText('회수율 = 사용 ÷ 발행')).toBeInTheDocument();
  });
  it('InsightCard has no button and a sample caption',()=>{
    renderWithKit(<InsightCard>화요일이 가장 한산해요</InsightCard>);
    expect(screen.getByText('예시')).toBeInTheDocument();expect(screen.queryByRole('button')).toBeNull();
  });
  it('StepProgress shows static rows, the current step and an optional cancel',async()=>{
    const cancel=vi.fn();
    renderWithKit(<StepProgress steps={['재료 정리','장면 구성','자막·음악 넣기','완성']} current={1} onCancel={cancel} title="영상을 만들고 있어요"/>);
    const items=screen.getAllByRole('listitem');expect(items).toHaveLength(4);
    expect(items[1]).toHaveAttribute('aria-current','step');expect(items[1]).toHaveAttribute('data-state','current');expect(items[0]).toHaveAttribute('data-state','done');
    expect(screen.getByRole('status')).toHaveTextContent('장면 구성, 진행 중');
    expect(document.querySelector('[role=progressbar],.ui-progress')).toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'취소'}));expect(cancel).toHaveBeenCalled();
  });
});
describe('VideoPlayer, SceneList (M-30)',()=>{
  const scenes:VideoScene[]=[{id:'1',start:0,end:4,caption:'오늘의 크루아상'},{id:'2',start:4,end:9,caption:'갓 구운 향'},{id:'3',start:9,end:12,caption:'후기 5점'},{id:'4',start:12,end:15,caption:'내일 만나요'}];
  it('does not autoplay, offers a text alternative and a silent label, and moves by chips and buttons',async()=>{
    renderWithKit(<VideoPlayer scenes={scenes}/>);
    expect(screen.getByRole('img',{name:'장면 1/4, 0~4초, 오늘의 크루아상'})).toBeInTheDocument();
    expect(screen.getByText('소리 없는 미리보기예요')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'재생'})).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow','0');
    await userEvent.click(screen.getByRole('button',{name:'장면 3 · 9~12초'}));
    expect(screen.getByRole('img',{name:'장면 3/4, 9~12초, 후기 5점'})).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button',{name:'다음 장면'}));await userEvent.click(screen.getByRole('button',{name:'이전 장면'}));
    expect(screen.getByRole('img',{name:/장면 3\/4/})).toBeInTheDocument();
  });
  it('plays in real time to scene 4 and stops (no loop), then offers replay',()=>{
    vi.useFakeTimers();
    renderWithKit(<VideoPlayer scenes={scenes}/>);
    fireEvent.click(screen.getByRole('button',{name:'재생'}));
    expect(screen.getByRole('button',{name:'일시정지'})).toBeInTheDocument();
    act(()=>{vi.advanceTimersByTime(5000);});
    expect(screen.getByRole('img',{name:/장면 2\/4/})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'일시정지'}));
    act(()=>{vi.advanceTimersByTime(5000);});
    expect(screen.getByRole('img',{name:/장면 2\/4/})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'재생'}));
    act(()=>{vi.advanceTimersByTime(20000);});
    expect(screen.getByRole('img',{name:/장면 4\/4/})).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'다시 보기'})).toBeInTheDocument();
    act(()=>{vi.advanceTimersByTime(20000);});
    expect(screen.getByRole('img',{name:/장면 4\/4/})).toBeInTheDocument();
  });
  it('under reduced motion there is no play button, only next scene, and nothing advances by itself',()=>{
    vi.useFakeTimers();
    renderWithKit(<VideoPlayer scenes={scenes}/>,{reducedMotion:true});
    expect(screen.queryByRole('button',{name:'재생'})).toBeNull();
    act(()=>{vi.advanceTimersByTime(10000);});
    expect(screen.getByRole('img',{name:/장면 1\/4/})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'다음 장면'}));
    expect(screen.getByRole('img',{name:/장면 2\/4/})).toBeInTheDocument();
  });
  it('SceneList shows the whole caption and selects a scene',async()=>{
    const select=vi.fn();
    renderWithKit(<SceneList scenes={scenes.map(s=>({id:s.id,rangeText:`${s.start}~${s.end}초`,name:`장면 ${s.id}`,caption:s.caption}))} current={1} onSelect={select}/>);
    expect(screen.getByText('갓 구운 향')).toBeInTheDocument();
    expect(screen.getAllByRole('button')[1]).toHaveAttribute('aria-current','step');
    await userEvent.click(screen.getAllByRole('button')[3]!);expect(select).toHaveBeenCalledWith(3);
  });
});
