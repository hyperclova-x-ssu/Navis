import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gestureTokens, layoutTokens, motionTokens, pageTokens } from './motion';
import { getPresetLayout } from './viewport';
import { screenPresets } from '../layout/presets';

const css = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');
describe('DS 11.6 / 11.10 tokens live in the kit', () => {
  it('has the page, gesture, motion and plan-2 values', () => {
    expect(layoutTokens).toMatchObject({ pageBar: 48, pageBarGap: 16, pageBarBottom: 24, panelAction: 44, coachFooter: 44, coachFooterGap: 8 });
    expect(pageTokens).toMatchObject({ max: 5, pageNoticeMs: 4000, dotSelectedWidth: 28, dotHeight: 12, dotSize: 12, dotHitWidth: 44, dotHitHeight: 48 });
    expect(pageTokens.videoFrame).toEqual({ A: { width: 315, height: 560 }, B: { width: 428, height: 760 } });
    expect(gestureTokens).toMatchObject({ edgeZone: 48, edgeDwellMs: 500, edgeRepeatMs: 700 });
    expect(motionTokens.duration).toMatchObject({ page: 220, band: 80, dotIn: 160, form: 120, valueFlash: 120, scene: 300 });
    expect(motionTokens.staggerRecommend).toBe(24);
    expect(motionTokens.stepMs).toBe(600);
    // 8 widgets: the last one lands at (8-1)*24 + 200 = 368 ms (DS 11.10)
    expect(7 * motionTokens.staggerRecommend + 200).toBe(368);
    expect(Math.max(...Object.values(motionTokens.duration))).toBeLessThanOrEqual(300);
  });
  it('keeps the grid dimensions of DS 11.1 in one place (A and B)', () => {
    const a = getPresetLayout(screenPresets.A), b = getPresetLayout(screenPresets.B);
    expect([a.grid.height, a.cell.height, b.grid.height, b.cell.height]).toEqual([880, 208, 1240, 235.2]);
    expect([0, 1, 2, 3].map((n) => (n + 1) * a.cell.height + n * 16)).toEqual([208, 432, 656, 880]);
    expect([0, 1, 2, 3, 4].map((n) => Math.round(((n + 1) * b.cell.height + n * 16) * 10) / 10)).toEqual([235.2, 486.4, 737.6, 988.8, 1240]);
    expect(a.pageBar).toEqual({ y: 1008, height: 48, centerX: 908 });
    expect(b.pageBar).toEqual({ y: 1368, height: 48, centerX: 1228 });
  });
  it('mirrors them as CSS custom properties', () => {
    for (const name of ['--pagebar-height: 48px', '--edge-zone: 48px', '--panel-action-height: 44px', '--coach-footer-height: 44px', '--motion-duration-scene: 300ms', '--motion-stagger-recommend: 24ms', '--page-dot-pill-width: 28px']) expect(css).toContain(name);
  });
});
describe('DS 11.3 fonts and line breaking', () => {
  it('has language font bundles that end at system CJK fonts and no font file that is missing', () => {
    const faces = [...css.matchAll(/@font-face\s*{[^}]*}/g)].map((m) => m[0]);
    for (const face of faces) {
      for (const [, url] of face.matchAll(/url\('([^']+)'\)/g)) expect(existsSync(resolve(dirname(resolve(__dirname, 'tokens.css')), url!)), `font file ${url}`).toBe(true);
    }
    expect(faces.some((face) => /Navis Han[st]/.test(face))).toBe(false);
    expect(css).toMatch(/:lang\(zh-Hans\)\s*{[^}]*--font-system: var\(--font-system-hans\)/);
    expect(css).toMatch(/:lang\(zh-Hant\)\s*{[^}]*--font-system: var\(--font-system-hant\)/);
    expect(css).toContain('"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC"');
    expect(css).toContain('"PingFang TC","Microsoft JhengHei","Noto Sans CJK TC","Source Han Sans TC"');
    // T-056/T-055: the subset faces come right after NanumSquareNeo (digits, Latin, won and % stay in it); the faces live in fonts-cjk.css only.
    expect(css).toContain('--font-system-hans: NanumSquareNeo,"Navis Hans","PingFang SC"');
    expect(css).toContain('--font-system-hant: NanumSquareNeo,"Navis Hant","PingFang TC"');
    expect(css.split('\n')[0]).toBe("@import './fonts-cjk.css';");
    const cjk = readFileSync(resolve(__dirname, 'fonts-cjk.css'), 'utf8');
    expect(cjk).not.toMatch(/:lang\(|--font-system/);
  });
  it('zeroes Chinese letter spacing and sets per-language breaking', () => {
    expect(css).toMatch(/:lang\(zh-Hans\), :lang\(zh-Hant\) {[^}]*--tracking-metric: 0[^}]*--tracking-body: 0/);
    expect(css).toMatch(/:lang\(ko\) { word-break: keep-all/);
    expect(css).toMatch(/:lang\(en\) { word-break: normal;[^}]*hyphens: manual/);
    expect(css).toMatch(/line-break: strict/);
  });
});
