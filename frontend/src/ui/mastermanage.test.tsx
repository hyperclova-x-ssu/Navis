import './test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UiProvider } from './UiProvider';
import { screenPresets } from '../layout/presets';
import { I18nProvider } from '../i18n';
import { createTableLayout } from '../layout/table-layout';
import { TableGridEditor } from './components/table-grid-editor';
import { ChoiceCard, TemplateCard } from './components/onboarding';
import { Spotlight, TourCard, placeTourCard } from './components/tour';
import { ClosingButton, ClosedDayState } from './components/management';
import { templateFlightTiming, motionTokens } from './motion';
import { createVisibleSlotRegistry } from './visible-slots';
afterEach(cleanup);
const wrap=(body:React.ReactNode)=><UiProvider screenPreset={screenPresets.A} reducedMotion>{body}</UiProvider>;
it('defines template fly200/stagger20/last300 and simultaneous reduced80 once',()=>{
  expect(templateFlightTiming(5,false)).toEqual({delay:100,duration:200,settledAt:300});
  expect(templateFlightTiming(4,false).settledAt).toBe(280);
  expect(templateFlightTiming(5,true)).toEqual({delay:0,duration:80,settledAt:80});
  expect(motionTokens.staggerTemplate).not.toBe(motionTokens.staggerRecommend);
});
it('uses Korean fallback for new kit copy in every locale, preserving old translations',()=>{
  render(<I18nProvider locale="en">{wrap(<><ClosingButton closed/><ClosedDayState closed/><ChoiceCard value="prepaid" label="선불형" description="먼저 계산해요" selected onSelect={()=>{}}/><TemplateCard id="A" name="하루 운영 중심" description="하루를 운영해요" panelNames={['메뉴','재고']} selected onSelect={()=>{}}/></>)}</I18nProvider>);
  expect(screen.getByRole('button',{name:'마감 정산 열기'})).toHaveAttribute('aria-describedby');
  expect(screen.getByRole('button',{name:'마감 정산 열기'})).toHaveAttribute('lang','ko');
  expect(screen.getAllByText(/15:45/).length).toBeGreaterThan(0);
  expect(screen.getByRole('radio',{name:/선불형/})).toHaveAttribute('aria-checked','true');
});
it('keeps the full template panel list in its accessible name',()=>{
  render(wrap(<TemplateCard id="A" name="추천" description="설명" panelNames={['브리핑','손익','CCTV 현황']} selected onSelect={()=>{}}/>));
  expect(screen.getByRole('radio',{name:/브리핑 · 손익 · CCTV 현황/})).toBeInTheDocument();
  expect(document.querySelector('.ui-template-card__names')).toBeNull();
});
it('renders all 54 cells and exposes keyboard table movement/seat callbacks',()=>{
  const onMove=vi.fn(),onSeatsChange=vi.fn();render(wrap(<TableGridEditor layout={createTableLayout()} selectedTableId="T1" onSelect={()=>{}} onMove={onMove} onSeatsChange={onSeatsChange}/>));
  expect(document.querySelectorAll('[data-table-cell]')).toHaveLength(54);
  const tile=screen.getByRole('button',{name:'T1, 2석, 가로 2번째 세로 2번째 칸'});
  fireEvent.keyDown(tile,{key:'ArrowRight'});expect(onMove).toHaveBeenCalledWith('T1',2,1);
  fireEvent.keyDown(tile,{key:'+'});expect(onSeatsChange).toHaveBeenCalledWith('T1',3);
});
it('keeps the opaque double ring and prevents scrim dismissal',()=>{
  const onNext=vi.fn(),onClose=vi.fn();render(wrap(<><Spotlight rect={{x:100,y:100,width:300,height:200}}/><TourCard title="메뉴" description="메뉴를 관리해요" current={1} total={2} onNext={onNext} onClose={onClose}/></>));
  expect(document.querySelector('[data-spotlight-inner]')).toBeInTheDocument();
  expect(document.querySelector('[data-spotlight-outer]')).toBeInTheDocument();
  fireEvent.click(document.querySelector('[data-spotlight]')!);expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'다음'}));expect(onNext).toHaveBeenCalledOnce();
});
it('places the tour inside the canvas and outside the toast',()=>{
  const p=placeTourCard({x:100,y:100,width:300,height:200},{width:400,height:260},{width:1920,height:1080},[{x:24,y:320,width:600,height:80}]);
  expect(p.x).toBeGreaterThanOrEqual(24);expect(p.y).toBeGreaterThanOrEqual(24);
  expect(p.side).not.toBe('bottom');
});
it('registers semantic visible slots and removes stale registrations without choosing six',()=>{
  const registry=createVisibleSlotRegistry();const remove=registry.register({slotId:'menu:price',featureId:'menu',scope:'detail',semanticValue:5000,visible:true});
  expect(registry.getSnapshot()).toHaveLength(1);remove();expect(registry.getSnapshot()).toHaveLength(0);
});
it('selects radio cards with arrow keys and keeps one Tab entry per group',()=>{
  const select=vi.fn();render(wrap(<div role="radiogroup" aria-label="결제 방식"><ChoiceCard value="prepaid" label="선불형" description="먼저 계산해요" selected={false} onSelect={select}/><ChoiceCard value="postpaid" label="후불형" description="나중에 계산해요" selected={false} onSelect={select}/></div>));
  const first=screen.getByRole('radio',{name:/선불형/}),second=screen.getByRole('radio',{name:/후불형/});
  expect(first).toHaveAttribute('tabindex','0');expect(second).toHaveAttribute('tabindex','-1');
  fireEvent.keyDown(first,{key:'ArrowRight'});expect(second).toHaveFocus();expect(select).toHaveBeenCalledWith('postpaid');
});
