import './test-setup';
import '@testing-library/jest-dom/vitest';
import { useContext } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MotionConfigContext } from 'motion/react';
import { UiProvider } from './UiProvider';
import { FlyInFrame } from './components/motion-surfaces';
import { FeaturePanel } from './components/card';
import { screenPresets } from '../layout/presets';

afterEach(cleanup);
function Point({x,y}:{x:number;y:number}) {
  const {transformPagePoint} = useContext(MotionConfigContext);
  const point = transformPagePoint({x,y});
  return <output aria-label="캔버스 좌표">{point.x},{point.y}</output>;
}
describe('scaled Motion geometry (RV-UI-1)', () => {
  it.each([[0.5,80,120],[0.8,110,180],[1.5,180,320]])('passes client coordinates through the canvas transform at k=%s', (scale,x,y) => {
    render(<UiProvider screenPreset={screenPresets.A} transform={{scale,offsetX:30,offsetY:20,width:1920*scale,height:1080*scale,originX:0,originY:0}}><Point x={x} y={y}/></UiProvider>);
    expect(screen.getByLabelText('캔버스 좌표')).toHaveTextContent('100,200');
  });
});
describe('visible flying panel chrome (RV-UI-2)', () => {
  it('shows the panel surface immediately while its title and data wait for the last 80ms', () => {
    const {container} = render(<UiProvider screenPreset={screenPresets.A} reducedMotion={false}><FlyInFrame fromRect={{x:0,y:0,width:80,height:60}} toRect={{x:300,y:300,width:160,height:200}}><FeaturePanel featureId="ledger" label="가계부" width={2} height={1} groupId="money"><p>128.4만 원</p></FeaturePanel></FlyInFrame></UiProvider>);
    expect(container.querySelector('.ui-panel-surface')).toBeVisible();
    expect(screen.getByRole('heading',{name:'가계부',hidden:true})).not.toBeVisible();
    expect(screen.getByText('128.4만 원')).not.toBeVisible();
  });
});
