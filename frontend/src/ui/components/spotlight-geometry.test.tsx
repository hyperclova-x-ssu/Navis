import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { UiProvider } from '../UiProvider';
import { screenPresets } from '../../layout/presets';
import { Spotlight } from './tour';
import { projectSpotlight } from './spotlight-geometry';
afterEach(cleanup);
it('snaps both edges of both lines to whole device pixels across fit and page raster scales',()=>{
  for(const scale of [.8,1,1.25])for(const dpr of [1,1.25,1.5,2,2.5]){
    const g=projectSpotlight({x:83.333,y:107.625,width:399.37,height:221.125},{scale,offsetX:13.37,offsetY:9.17},dpr);
    for(const n of [g.x,g.y,g.x+g.width,g.y+g.height,g.lineWidth,g.x-g.lineWidth,g.y+g.lineWidth])expect(n*dpr).toBeCloseTo(Math.round(n*dpr),8);
    expect(g.lineWidth*dpr).toBe(Math.round(2*dpr));
    expect(Math.abs(g.x-((83.333-8)*scale+13.37))).toBeLessThanOrEqual(.5/dpr);
    expect(g.radius).toBe(12*scale);
  }
});
it('renders themed rings outside every scaled canvas ancestor and keeps scrim layering in the canvas',()=>{
  const {container}=render(<div style={{transform:'scale(.8)'}}><UiProvider screenPreset={screenPresets.A} theme="dark" reducedMotion><Spotlight rect={{x:100,y:100,width:300,height:200}}/></UiProvider></div>);
  const svg=document.querySelector('[data-spotlight-rings]')!;
  expect(container.contains(svg)).toBe(false);
  expect(container.contains(document.querySelector('[data-spotlight]'))).toBe(true);
  expect(svg).toHaveAttribute('data-theme','dark');
  expect(svg).toHaveAttribute('aria-hidden','true');
  expect(document.querySelector('[data-spotlight-inner]')).toHaveAttribute('stroke-width','2');
});
it('updates whole-pixel strokes when page zoom changes devicePixelRatio',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(window,'devicePixelRatio');
  try{
    Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:1.25});
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><Spotlight rect={{x:100,y:100,width:300,height:200}}/></UiProvider>);
    expect(document.querySelector('[data-spotlight-inner]')).toHaveAttribute('stroke-width','2.4');
    Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:2});fireEvent.resize(window);
    expect(document.querySelector('[data-spotlight-inner]')).toHaveAttribute('stroke-width','2');
    expect(document.querySelector('[data-spotlight-outer]')).toHaveAttribute('stroke-width','2');
  }finally{if(descriptor)Object.defineProperty(window,'devicePixelRatio',descriptor);}
});
