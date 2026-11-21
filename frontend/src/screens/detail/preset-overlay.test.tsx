import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureId, Panel } from '../../contracts';
import { getRegistration, getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { UiProvider, fitViewport, groupStyle, timePolicy } from '../../ui';
import { DetailOverlay } from './DetailOverlay';
import { DetailHost, stubDetailModules } from './test-modules';

// Control only the clock, leaving the real dialog, motion values, DOM and store intact.
const clock = vi.hoisted(() => ({ updates: [] as { onUpdate: (p: number) => void; onComplete: () => void; stop: () => void }[] }));
vi.mock('motion/react', async importOriginal => ({
  ...await importOriginal<typeof import('motion/react')>(),
  animate: (_from: number, _to: number, options: { onUpdate: (p: number) => void; onComplete: () => void }) => {
    const playback = { ...options, stop: vi.fn() };
    clock.updates.push(playback);
    return playback;
  },
}));
afterEach(() => { cleanup(); document.querySelectorAll('#source').forEach(element => element.remove()); clock.updates.length = 0; vi.restoreAllMocks(); });

const modules = stubDetailModules(getRegistry('A').map(f => f.id));
function setup(id: 'A' | 'B', fullscreen = false, reducedMotion = false, textFeature?: FeatureId, textScale: 100 | 125 = 100, source = { x: 24, y: 112, width: 576, height: 224 }, panel?: Panel) {
  const preset = screenPresets[id];
  let transform = fitViewport(preset, { width: 1600, height: 900, originX: 31, originY: 47 })!;
  const run = createRunStore({ screenPreset: preset, catalog: getRegistry(id), time: timePolicy, theme: 'light', reducedMotion, clock: () => performance.now() });
  const featureId = textFeature ?? (fullscreen ? 'inventory-booking' : 'margin');
  beginDashboard(run); if (fullscreen) run.actions.setDetailDialogFullscreen(true); if (getRegistration(featureId)?.layer === 'marketing') run.actions.switchLayer('marketing'); run.actions.setTextScale(textScale); run.actions.applyLayoutIntent(panel ? { type: 'restore', panels: [panel] } : { type: 'add-tap', featureId });
  const origin = document.createElement('button'); origin.id = 'source'; document.body.append(origin);
  vi.spyOn(origin, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ x: transform.offsetX + source.x * transform.scale, y: transform.offsetY + source.y * transform.scale, width: source.width * transform.scale, height: source.height * transform.scale }));
  const view = () => <DetailHost modules={modules}><UiProvider screenPreset={preset} transform={transform} reducedMotion={reducedMotion} textScale={textScale}><DetailOverlay run={run} /></UiProvider></DetailHost>;
  const rendered = render(view());
  act(() => { run.actions.openDetail(featureId, 'source'); rendered.rerender(view()); });
  return { run, origin, resize: () => { transform = fitViewport(preset, { width: 1200, height: 900 })!; rendered.rerender(view()); }, remove: () => origin.remove() };
}

describe('preset detail frame projection', () => {
  it.each([
    ['A', false, 'translate3d(-40px, 48px, 0px) scale(0.32142857142857145, 0.23529411764705882)'],
    ['B', false, 'translate3d(-72px, 16px, 0px) scale(0.24324324324324326, 0.1794871794871795)'],
    ['A', true, 'translate3d(24px, 112px, 0px) scale(0.3, 0.2074074074074074)'],
    ['B', true, 'translate3d(24px, 112px, 0px) scale(0.225, 0.15555555555555556)'],
  ] as const)('opens %s fullscreen=%s from its panel in logical canvas coordinates', async (id, full, expected) => {
    const fixture = setup(id, full);
    await waitFor(() => expect(screen.getByRole('dialog').style.transform).toBe(expected));
    fixture.remove();
  });

  it.each(getRegistry('A').map(feature=>[feature.id,feature.groupId] as const))('keeps %s on its catalog group title accent (%s)', (featureId, group) => {
    const fixture = setup('A', false, false, featureId);
    expect(screen.getByRole('dialog').style.getPropertyValue('--group-color')).toBe(groupStyle(group)['--group-color' as keyof ReturnType<typeof groupStyle>]);
    fixture.remove();
  });

  it.each((['A', 'B'] as const).flatMap(id => {
    const columns = id === 'A' ? 6 : 8, rows = id === 'A' ? 4 : 5;
    return [
      ...Array.from({ length: 16 }, (_, index) => [id, index % 4 + 1, Math.floor(index / 4) + 1, columns - (index % 4 + 1), rows - (Math.floor(index / 4) + 1)] as const),
      ...Array.from({ length: columns * rows }, (_, index) => [id, 1, 1, index % columns, Math.floor(index / columns)] as const),
    ];
  }))('returns to the current %s %s×%s panel at column %s, row %s with gaps', async (id, width, height, column, row) => {
    const source = id === 'A'
      ? { x: 24 + column * 892 / 3, y: 112 + row * 240, width: width * 892 / 3 - 16, height: height * 240 - 16 }
      : { x: 24 + column * 303, y: 112 + row * 264, width: width * 303 - 16, height: height * 264 - 16 };
    const panel = { featureId: 'margin' as const, width, height, column, row };
    const fixture = setup(id, false, false, undefined, 100, source, panel);
    expect(fixture.run.getState().panels).toEqual([panel]);
    const base = id === 'A' ? { x: 64, y: 64, width: 1792, height: 952 } : { x: 96, y: 96, width: 2368, height: 1248 };
    const checkFrame = async (element: HTMLElement) => {
      await waitFor(() => {
        const values = element.style.transform.match(/-?[\d.]+/g)!.map(Number);
        expect(base.x + values[1]!).toBeCloseTo(source.x, 5);
        expect(base.y + values[2]!).toBeCloseTo(source.y, 5);
        expect(base.width * values[4]!).toBeCloseTo(source.width, 5);
        expect(base.height * values[5]!).toBeCloseTo(source.height, 5);
      });
    };
    await checkFrame(screen.getByRole('dialog'));
    act(() => clock.updates.at(-1)!.onUpdate(1));
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(fixture.origin).toHaveFocus();
    act(() => clock.updates.at(-1)!.onUpdate(1));
    await checkFrame(screen.getByTestId('ui-overlay-exit'));
    expect(fixture.run.getState().panels).toEqual([panel]);
    fixture.remove();
  });

  it('keeps the current frame and original animation deadline when only fit changes', async () => {
    const fixture = setup('B');
    act(() => clock.updates.at(-1)!.onUpdate(.5));
    await waitFor(() => expect(screen.getByRole('dialog').style.transform).toContain('translate3d(-36px, 8px'));
    const frame = screen.getByRole('dialog').style.transform;
    const playback = clock.updates.at(-1)!;
    fixture.resize();
    expect(screen.getByRole('dialog').style.transform).toBe(frame);
    expect(playback.stop).not.toHaveBeenCalled();
    act(() => playback.onUpdate(1));
    await waitFor(() => expect(screen.getByRole('dialog').style.transform).toContain('scale(1, 1)'));
    fixture.remove();
  });

  it('closes to the transformed panel after resize and releases only its current exit token', async () => {
    const fixture = setup('B');
    act(() => clock.updates.at(-1)!.onUpdate(1));
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    const token = fixture.run.getState().exitPendingToken;
    expect(token).not.toBeNull();
    const exit = clock.updates.at(-1)!;
    act(() => exit.onUpdate(.5));
    fixture.resize();
    expect(exit.stop).not.toHaveBeenCalled();
    act(() => exit.onUpdate(1));
    await waitFor(() => expect(screen.getByTestId('ui-overlay-exit').style.transform).toBe('translate3d(-72px, 16px, 0px) scale(0.24324324324324326, 0.1794871794871795)'));
    expect(fixture.run.getState().idle.blockedReasons).toContain('overlay-exit');
    act(() => exit.onComplete());
    expect(fixture.run.getState().exitPendingToken).toBeNull();
    fixture.remove();
  });

  it('preserves the exact in-progress reduced opacity when reopening after fit changes', async () => {
    const fixture = setup('B', false, true);
    act(() => clock.updates.at(-1)!.onUpdate(1));
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    const exit = clock.updates.at(-1)!;
    act(() => exit.onUpdate(.6));
    await waitFor(() => expect(Number(screen.getByTestId('ui-overlay-exit').style.opacity)).toBeCloseTo(.4));
    fixture.resize();
    act(() => fixture.run.actions.openDetail('margin', 'source'));
    await waitFor(() => expect(Number(screen.getByRole('dialog').style.opacity)).toBeCloseTo(.4));
    expect(screen.getByRole('dialog').style.transform).toContain('scale(1, 1)');
    act(() => exit.onComplete());
    expect(fixture.run.getState().overlay.type).toBe('detail');
    fixture.remove();
  });


  it.each([
    ['A', '960px', 'translate3d(-456px, -68px, 0px) scale(0.6, 0.3111111111111111)'],
    ['B', '1040px', 'translate3d(-736px, -208px, 0px) scale(0.5538461538461539, 0.28)'],
  ] as const)('opens a %s text detail from its panel into the compact minimum frame', async (id, width, expected) => {
    const fixture = setup(id, false, false, 'briefing');
    expect(screen.getByRole('dialog').style.width).toBe(width);
    await waitFor(() => expect(screen.getByRole('dialog').style.height).toBe(id==='A'?'720px':'800px'));
    await waitFor(() => expect(screen.getByRole('dialog').style.transform).toBe(expected));
    fixture.remove();
  });


  it.each(['A', 'B'] as const)('uses the larger compact minimum on %s with 125% text', async id => {
    const fixture = setup(id, false, false, 'briefing', 125);
    await waitFor(() => expect(screen.getByRole('dialog').style.height).toBe(id==='A'?'720px':'800px'));
    const expected = id === 'A' ? 'translate3d(-456px, -68px, 0px) scale(0.6, 0.3111111111111111)' : 'translate3d(-736px, -208px, 0px) scale(0.5538461538461539, 0.28)';
    await waitFor(() => expect(screen.getByRole('dialog').style.transform).toBe(expected));
    fixture.remove();
  });

  it('reverses a compact close from its current logical frame after fit changes', async () => {
    const fixture = setup('B', false, false, 'briefing');
    act(() => clock.updates.at(-1)!.onUpdate(1));
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    const exit = clock.updates.at(-1)!;
    act(() => exit.onUpdate(.5));
    fixture.resize();
    act(() => fixture.run.actions.openDetail('briefing', 'source'));
    await waitFor(() => expect(screen.getByRole('dialog').style.transform).toBe('translate3d(-368px, -104px, 0px) scale(0.7769230769230769, 0.64)'));
    act(() => exit.onComplete());
    expect(fixture.run.getState().overlay.type).toBe('detail');
    fixture.remove();
  });

});
