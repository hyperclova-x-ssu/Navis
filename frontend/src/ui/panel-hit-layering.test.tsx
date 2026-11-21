import './test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionButton, FeaturePanel, PanelAction } from './index';
import { renderWithKit } from './test-utils';

/**
 * P-1 PANEL-HIT-OVERLAY. The whole-card hit button (class ui-panel-hit) used to sit above the panel surface, so a click on a
 * control inside the body (a retry or add button, a PanelAction, the (?) help button) only opened the detail. It now sits BEHIND the surface:
 * the surface lets pointer events through to it, and only real controls take them back. jsdom has no hit testing, so this applies the
 * real tokens.css rules and checks the cascade plus what user-event (which honours pointer-events) can reach; the browser measurement
 * (.evidence/p-1/measure.mjs: elementFromPoint at the centre of every control of all 30 widgets) proves the geometry.
 */
let style: HTMLStyleElement;
beforeAll(() => {
  const css = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  style = document.createElement('style');
  style.textContent = [...css.matchAll(/([^{}]*(?:\.ui-panel-hit|\.ui-panel-surface)[^{}]*)\{([^{}]*)\}/g)].map(match => `${match[1]}{${match[2]}}`).join('\n');
  document.head.append(style);
});
afterAll(() => style.remove());
afterEach(cleanup);

const panel = (props: { editing?: boolean; interactive?: boolean; onOpen?: () => void; onHelp?: () => void; onRetry?: () => void; onAction?: () => void } = {}) => (
  <FeaturePanel featureId="coupon-status" groupId="customers" label="쿠폰 현황" width={2} height={1} row={1} column={1} summary="진행 중 3개"
    editing={props.editing} interactive={props.interactive} onOpen={props.onOpen} onHelp={props.onHelp}>
    <p>진행 중인 쿠폰이 없어요.</p>
    <ActionButton onClick={props.onRetry}>다시 시도하기</ActionButton>
    <PanelAction label="쿠폰 보내기" widgetName="쿠폰 현황" onPress={props.onAction ?? (() => {})}/>
  </FeaturePanel>
);
const hit = () => document.querySelector<HTMLButtonElement>('.ui-panel-hit')!;
const surface = () => document.querySelector<HTMLElement>('.ui-panel-surface')!;
const pe = (node: Element) => getComputedStyle(node).pointerEvents;

describe('FeaturePanel hit layer sits behind the panel surface', () => {
  it('renders the hit button before the surface as its sibling, with no z-index, so the surface paints above it', () => {
    renderWithKit(panel());
    expect(hit().nextElementSibling).toBe(surface());
    expect(hit().parentElement).toBe(surface().parentElement);
    expect(hit().contains(screen.getByRole('button', { name: '다시 시도하기' }))).toBe(false);
    expect(['', 'auto']).toContain(getComputedStyle(hit()).zIndex);
    expect(getComputedStyle(hit()).position).toBe('absolute');
    expect(hit()).toHaveAccessibleName(/쿠폰 현황, 1행 1열.*진행 중 3개/);
  });

  it('keeps the surface click-through but gives every control in it the pointer back', () => {
    renderWithKit(panel({ onHelp: () => {} }));
    expect(pe(surface())).toBe('none');
    expect(pe(screen.getByRole('button', { name: '다시 시도하기' }))).toBe('auto');
    expect(pe(screen.getByRole('button', { name: /쿠폰 보내기/ }))).toBe('auto');
    expect(pe(screen.getByRole('button', { name: '쿠폰 현황 설명 보기' }))).toBe('auto');
    expect(pe(hit())).not.toBe('none');
  });

  it('mouse: controls get the click and never open the detail; the hit button still opens it', async () => {
    const onOpen = vi.fn(), onHelp = vi.fn(), onRetry = vi.fn(), onAction = vi.fn();
    renderWithKit(panel({ onOpen, onHelp, onRetry, onAction }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '다시 시도하기' }));
    await user.click(screen.getByRole('button', { name: /쿠폰 보내기/ }));
    await user.click(screen.getByRole('button', { name: '쿠폰 현황 설명 보기' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onHelp).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(hit());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('text is not a pointer target (it falls through to the hit layer behind it), so pressing it opens the detail', async () => {
    renderWithKit(panel());
    const text = screen.getByText('진행 중인 쿠폰이 없어요.');
    expect(pe(text)).toBe('none');
    await expect(userEvent.setup().click(text)).rejects.toThrow(/pointer-events: none/);
  });

  it('keyboard: Tab goes hit button, (?) help, body controls in that order; Enter and Space reach the control, not the detail', async () => {
    const onOpen = vi.fn(), onHelp = vi.fn(), onRetry = vi.fn(), onAction = vi.fn();
    renderWithKit(panel({ onOpen, onHelp, onRetry, onAction }));
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(hit());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '쿠폰 현황 설명 보기' }));
    await user.keyboard('{Enter}');
    expect(onHelp).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '다시 시도하기' }));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onRetry).toHaveBeenCalledTimes(2);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('moves the focus ring to the surface (the hit button is hidden behind it): hit outline off, surface outline on', () => {
    const css = style.textContent!;
    expect(css).toMatch(/\.ui-panel-hit:focus-visible\s*\{\s*outline:\s*none/);
    expect(css).toMatch(/\.ui-panel-hit:focus-visible~\.ui-panel-surface\s*\{[^}]*outline:\s*var\(--stroke-focus\) solid var\(--ring\)/);
  });
});

describe('layout editing keeps the body inert', () => {
  it('while editing a press on a body control or the text must not fire; it falls through to the hit layer (select, drag, resize)', async () => {
    const onRetry = vi.fn();
    renderWithKit(panel({ editing: true, onRetry }));
    const retry = screen.getByRole('button', { name: '다시 시도하기' });
    expect(pe(retry)).toBe('none');
    expect(pe(surface())).toBe('none');
    await expect(userEvent.setup().click(retry)).rejects.toThrow(/pointer-events: none/);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('selects the panel from the hit button while editing', async () => {
    const onSelect = vi.fn(), onOpen = vi.fn();
    renderWithKit(<FeaturePanel featureId="ledger" groupId="money" label="손익" width={1} height={1} editing onSelect={onSelect} onOpen={onOpen}><p>내용</p></FeaturePanel>);
    await userEvent.setup().click(hit());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('a panel without a detail has no hit layer and keeps ordinary pointer behaviour', () => {
  it('does not make its surface click-through', () => {
    renderWithKit(panel({ interactive: false }));
    expect(document.querySelector('.ui-panel-hit')).toBeNull();
    expect(pe(surface())).not.toBe('none');
    expect(pe(screen.getByRole('button', { name: '다시 시도하기' }))).not.toBe('none');
  });
});
