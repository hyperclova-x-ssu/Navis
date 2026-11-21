import './test-setup';
import '@testing-library/jest-dom/vitest';
import { afterEach,describe,expect,it } from 'vitest';
import { cleanup,render,screen } from '@testing-library/react';
import { MiniChart,Metric,PanelBody,FeaturePanel,UiProvider } from './index';
import { screenPresets } from '../layout/presets';
afterEach(cleanup);
const trend={axisLabels:['10/19','10/20','10/21','10/22','10/23','10/24','10/25'],series:[{name:'평균 마진',values:[64.8,65.4,66,65.6,66.8,67.2,67.8],unit:'%'}]};
describe('shared panel chart domain',()=>{
 it('retains all seven points and nonzero axis meaning in compact and full charts',()=>{
  for(const compact of [false,true]){
   const view=render(<MiniChart compact={compact} kind="line" data={trend}/>),dots=view.container.querySelectorAll('circle');
   expect(dots).toHaveLength(7);expect(Number(dots[0].getAttribute('cy'))).toBeCloseTo(85.714,2);expect(Number(dots[6].getAttribute('cy'))).toBeCloseTo(14.286,2);
   expect(screen.getByRole('img')).toHaveAccessibleName(/10\/19 64.8%.*10\/25 67.8%.*64.2–68.4%.*0부터 시작하지 않아요/);view.unmount();
  }
 });
 it.each([{values:[0]},{values:[67.8,67.8]},{values:[-3,-1]},{values:[NaN,Infinity]}])('handles flat, negative, single and invalid samples %j',({values})=>{
  const view=render(<MiniChart kind="line" data={{axisLabels:[],series:[{name:'추이',values,unit:'%'}]}}/>);
  for(const dot of view.container.querySelectorAll('circle')){expect(Number(dot.getAttribute('cy'))).toBeGreaterThan(0);expect(Number(dot.getAttribute('cy'))).toBeLessThan(100);}
  if(values.every(v=>!Number.isFinite(v)))expect(screen.getByText('그래프에 표시할 값이 없어요')).toBeVisible();
 });
 it('does not replace an invalid sample with zero or connect the gap',()=>{
  const view=render(<MiniChart kind="line" data={{axisLabels:['월','화','수'],series:[{name:'추이',values:[10,NaN,20],unit:'명'}]}}/>);
  expect(view.container.querySelectorAll('circle')).toHaveLength(2);expect(view.container.querySelectorAll('line')).toHaveLength(0);expect(screen.getByRole('img')).toHaveAccessibleName(/화 확인할 수 없어요/);
 });
 it('retains zero-based relative bar heights and dates',()=>{
  const view=render(<MiniChart data={{axisLabels:['월','화','수'],series:[{name:'매출',values:[0,50,100],unit:'원'}]}}/>);
  expect([...view.container.querySelectorAll<HTMLElement>('.ui-chart-bar')].map(bar=>bar.style.height)).toEqual(['0%','50%','100%']);expect(screen.getByText('수')).toBeVisible();
 });
});
it.each(['A','B'] as const)('%s 16 shapes retain primary identity through theme and text changes',id=>{
 for(let width=1;width<=4;width++)for(let height=1;height<=4;height++){
  const content=<FeaturePanel featureId="ledger" label="가계부" groupId="money" width={width} height={height}><PanelBody width={width} height={height} primary={<Metric data={{label:'오늘 매출',value:128.4,unit:'만 원'}}/>} chart={<MiniChart kind="line" data={trend}/>} list={<p>지출 46.2만 원</p>}/></FeaturePanel>;
  const view=render(<UiProvider screenPreset={screenPresets[id]} theme="light">{content}</UiProvider>),metric=screen.getByText('128.4');
  view.rerender(<UiProvider screenPreset={screenPresets[id]} theme="dark" textScale={125} reducedMotion>{content}</UiProvider>);expect(screen.getByText('128.4')).toBe(metric);view.unmount();
 }
});

