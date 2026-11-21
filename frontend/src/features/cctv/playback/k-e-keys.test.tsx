import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {clearDetectionsCache} from '../../../data/cctv';
import type {DetectionsFile} from '../../../data/cctv';
import {screenPresets} from '../../../layout';
import {UiProvider} from '../../../ui';
import {CctvPlayback} from './CctvPlayback';

/** K-E 13: ←/→ move the sample video 5 s when the video itself has focus; the slider keeps its own single 5 s step. */
const real = JSON.parse(readFileSync(resolve(process.cwd(), 'public/cnn/store-sample-detections.json'), 'utf8')) as DetectionsFile;
beforeEach(() => {
  clearDetectionsCache();
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, json: async () => real})));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

function ready(at: number) {
  render(<UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion><CctvPlayback/></UiProvider>);
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'duration', {value: 86, configurable: true});
  Object.defineProperty(video, 'currentTime', {value: at, writable: true, configurable: true});
  act(() => {fireEvent.loadedMetadata(video);});
  Object.defineProperty(video, 'currentTime', {value: at, writable: true, configurable: true});
  return video;
}

describe('sample video keyboard seek', () => {
  it('moves 5 s forward and back with → and ← on the focused video', async () => {
    const video = ready(40);
    await waitFor(() => expect(screen.getByTestId('cctv-overlay')).toBeTruthy());
    const stage = screen.getByRole('group', {name: /영상|video/i});
    stage.focus();
    fireEvent.keyDown(stage, {key: 'ArrowRight'});
    expect(video.currentTime).toBe(45);
    fireEvent.keyDown(stage, {key: 'ArrowLeft'});
    fireEvent.keyDown(stage, {key: 'ArrowLeft'});
    expect(video.currentTime).toBe(35);
  });
  it('stays inside 0 and the duration', () => {
    const video = ready(2);
    const stage = screen.getByRole('group', {name: /영상|video/i});
    fireEvent.keyDown(stage, {key: 'ArrowLeft'});
    expect(video.currentTime).toBe(0);
    Object.defineProperty(video, 'currentTime', {value: 84, writable: true, configurable: true});
    fireEvent.keyDown(stage, {key: 'ArrowRight'});
    expect(video.currentTime).toBe(86);
  });
  it('seeks once, not twice, when the slider has focus (its own handler already took the key)', () => {
    const video = ready(40);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, {key: 'ArrowRight'});
    expect(video.currentTime).toBe(45);
  });
});

describe('camera setup text size (DS body 18 / caption 16)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/features/cctv/setup/setup.css'), 'utf8');
  it('draws "영상은 저장하지 않아요" and the stats line at DS sizes, not 14px', () => {
    expect(css).toMatch(/\.cs-small \{[^}]*font-size: var\(--type-body\)/);
    expect(css).toMatch(/\.cs-stats \{[^}]*font-size: var\(--type-caption\)/);
    expect(css).not.toMatch(/font-size:\s*14px/);
  });
});
