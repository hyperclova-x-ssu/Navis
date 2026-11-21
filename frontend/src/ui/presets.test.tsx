import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './test-setup';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { screenPresets } from '../layout/presets';
import { UiProvider, useUi, DashboardGrid, DetailDialog, FunctionDrawer, FunctionRow, NoticeHost, OverlayExitSurface, MiniChart } from './index';
import { fitViewport } from './viewport';
afterEach(cleanup);
function Probe(){const ui=useUi();return <output data-testid="context">{ui.screenPreset?.id}:{ui.transform?.scale}</output>;}
describe.each(['A','B'] as const)('%s canvas UI',id=>{
  const preset=()=>screenPresets[id];
  it('publishes the supplied preset/transform and draws 24/40 cells',()=>{
    const transform=fitViewport(preset(),{width:1280,height:720})!;
    const view=render(<UiProvider screenPreset={preset()} transform={transform} theme="light"><Probe/><DashboardGrid/></UiProvider>);
    const root=view.container.querySelector<HTMLElement>('.ui-root')!;
    expect(root).toHaveAttribute('data-screen-preset',id);
    expect(root.style.getPropertyValue('--canvas-width')).toBe(`${preset().baselineWidth}px`);
    expect(root.style.getPropertyValue('--grid-columns')).toBe(String(preset().grid.columns));
    expect(root.style.getPropertyValue('--drawer-width')).toBe(id==='A'?'360px':'400px');
    expect(root.style.getPropertyValue('--settings-height')).toBe('640px');
    expect(root.style.getPropertyValue('--settings-max-height')).toBe(id==='A'?'920px':'1120px');
    expect(root.style.getPropertyValue('--detail-inset')).toBe(id==='A'?'64px':'96px');
    expect(view.container.querySelectorAll('.ui-grid-cell')).toHaveLength(id==='A'?24:40);
    expect(screen.getByTestId('context')).toHaveTextContent(`${id}:${transform.scale}`);
  });
  it('keeps dialog, notice and transparent exit layers in the same logical portal host',async()=>{
    const view=render(<UiProvider screenPreset={preset()} theme="dark" reducedMotion><DetailDialog open title="자세히 보기" onClose={vi.fn()}>내용</DetailDialog><NoticeHost notice={{id:'notice-1',kind:'success',messageKey:'add',expiresAt:Infinity}} featureLabel="가계부"/><OverlayExitSurface token="old" kind="drawer" onComplete={vi.fn()}>퇴장</OverlayExitSurface></UiProvider>);
    const host=view.container.querySelector('.ui-portal-host')!;
    expect(host).toContainElement(await screen.findByRole('dialog'));
    expect(host).toContainElement(screen.getByTestId('ui-overlay-exit'));
    await waitFor(()=>expect(host.querySelector('[data-sonner-toaster]')).not.toBeNull());
    expect(screen.getByTestId('ui-overlay-exit')).toHaveAttribute('inert');
  });
  it('preserves DOM, input value and focus through transform/theme/text changes',()=>{
    const content=<><Probe/><FunctionDrawer open title="검색" onClose={vi.fn()}><input aria-label="검색어" defaultValue="원가"/><FunctionRow label="가계부" icon="ledger"/></FunctionDrawer></>;
    const view=render(<UiProvider screenPreset={preset()} transform={fitViewport(preset(),{width:preset().baselineWidth,height:preset().baselineHeight})!}>{content}</UiProvider>);
    const input=screen.getByRole('textbox');input.focus();
    view.rerender(<UiProvider screenPreset={preset()} transform={fitViewport(preset(),{width:960,height:540})!} theme="dark" textScale={125}>{content}</UiProvider>);
    expect(screen.getByRole('textbox')).toBe(input);expect(input).toHaveValue('원가');expect(input).toHaveFocus();
  });
  it('retains chart samples/axis text and adds only first/last dates in a compact chart',()=>{
    render(<UiProvider screenPreset={preset()}><MiniChart compact kind="line" data={{axisLabels:['10/19','10/20','10/25'],series:[{name:'마진',unit:'%',values:[64.8,66,67.8]}]}}/></UiProvider>);
    expect(screen.getByRole('img')).toHaveAccessibleName(/세로축 64.2–68.4% · 0부터 시작하지 않아요/);
    expect(screen.getByText('10/19')).toBeInTheDocument();expect(screen.getByText('10/25')).toBeInTheDocument();expect(screen.queryByText('10/20')).toBeNull();
  });
});
it('does not use physical viewport dimensions for preset portal sizes',()=>{
  const css=readFileSync('src/ui/tokens.css','utf8');
  expect(css).toContain('.ui-root[data-screen-preset]');
  expect(css).toContain('--canvas-height');
});
