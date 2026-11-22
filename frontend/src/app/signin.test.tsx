import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignIn } from './SignIn';

/** SCR-352 / DESIGN_SYSTEM §21.2: one centered card, tokens only, OS theme before any run exists. */
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stubScheme = (dark: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: dark && query === '(prefers-color-scheme: dark)', media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }));

describe('SCR-352 로그인 화면 구조', () => {
  it('한 장의 카드에 브랜드·제목·도움말·아이디·비밀번호·주 버튼이 순서대로 있다', () => {
    const { container } = render(<SignIn onSignIn={async () => {}} />);
    const screenRoot = container.querySelector('main.app-signin')!;
    expect(screenRoot).toHaveAttribute('lang', 'ko');
    const card = screenRoot.querySelector('form.app-signin__card')!;
    expect(card).toBeInTheDocument();
    const order = [...card.children].map(node => node.tagName + ':' + (node.className || ''));
    expect(order).toEqual(['P:app-signin__brand', 'H1:', 'P:app-signin__help', 'LABEL:app-signin__field', 'LABEL:app-signin__field', 'BUTTON:app-signin__submit']);
    expect(card.querySelector('.app-signin__brand')).toHaveTextContent('Navis');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('로그인');
    expect(screen.getByLabelText('아이디')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('비밀번호')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: '들어가기' })).toHaveAttribute('type', 'submit');
  });

  it('운영체제가 다크일 때만 다크 토큰을 쓰고 나머지는 라이트다', () => {
    stubScheme(true);
    const dark = render(<SignIn onSignIn={async () => {}} />);
    expect(dark.container.querySelector('main')).toHaveAttribute('data-theme', 'dark');
    dark.unmount();
    stubScheme(false);
    const light = render(<SignIn onSignIn={async () => {}} />);
    expect(light.container.querySelector('main')).toHaveAttribute('data-theme', 'light');
  });

  it('matchMedia가 없는 환경에서도 라이트로 그린다', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { container } = render(<SignIn onSignIn={async () => {}} />);
    expect(container.querySelector('main')).toHaveAttribute('data-theme', 'light');
  });
});

describe('SCR-352 로그인 동작은 그대로다', () => {
  it('자격 증명 오류는 role=alert로 한 번 알리고 비밀번호를 비운다', async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn().mockRejectedValue({ reason: 'BAD_CREDENTIALS' });
    render(<SignIn onSignIn={onSignIn} />);
    await user.type(screen.getByLabelText('아이디'), ' owner ');
    await user.type(screen.getByLabelText('비밀번호'), 'wrong');
    await user.click(screen.getByRole('button', { name: '들어가기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아이디나 비밀번호를 확인해 주세요');
    expect(onSignIn).toHaveBeenCalledExactlyOnceWith('owner', 'wrong');
    expect(screen.getByLabelText('비밀번호')).toHaveValue('');
    expect(screen.getByRole('button', { name: '들어가기' })).toBeEnabled();
  });

  it('서버·네트워크 오류는 다른 문구로 알린다', async () => {
    const user = userEvent.setup();
    render(<SignIn onSignIn={vi.fn().mockRejectedValue({ status: 503 })} />);
    await user.type(screen.getByLabelText('아이디'), 'owner');
    await user.type(screen.getByLabelText('비밀번호'), 'pw');
    await user.click(screen.getByRole('button', { name: '들어가기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('지금은 들어갈 수 없어요. 잠시 뒤 다시 해 주세요');
  });

  it('전송 중에는 버튼이 잠기고 진행 문구와 aria-busy가 보이며 Enter를 거듭 눌러도 한 번만 보낸다', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const onSignIn = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const { container } = render(<SignIn onSignIn={onSignIn} />);
    await user.type(screen.getByLabelText('아이디'), 'owner');
    await user.type(screen.getByLabelText('비밀번호'), 'pw{Enter}{Enter}{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: '확인하는 중이에요' })).toBeDisabled());
    expect(container.querySelector('form')).toHaveAttribute('aria-busy', 'true');
    expect(onSignIn).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(screen.getByLabelText('비밀번호')).toHaveValue(''));
  });
});

describe('SCR-352 스타일은 토큰만 쓴다 (BLUEPRINT §9.3)', () => {
  const css = readFileSync('src/app/app.css', 'utf8');
  const rules = css.split('\n').filter(line => line.startsWith('.app-signin'));
  const block = rules.join('\n');

  it('카드·입력·버튼·오류 규칙이 모두 있다', () => {
    for (const selector of ['.app-signin ', '.app-signin__card', '.app-signin__brand', '.app-signin__help', '.app-signin__field', '.app-signin__field input', '.app-signin__error', '.app-signin__submit']) {
      expect(rules.some(rule => rule.startsWith(selector)), selector).toBe(true);
    }
  });

  it('색·치수는 의미 토큰이고 원시 16진수 색을 쓰지 않는다', () => {
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const token of ['--card', '--border', '--input', '--ring', '--primary', '--primary-foreground', '--destructive', '--change-up-bg', '--muted-foreground', '--target-default', '--target-primary', '--radius-xl', '--shadow-panel', '--stroke-focus']) {
      expect(block, token).toContain(`var(${token})`);
    }
    expect(block).toMatch(/max-width:\s*440px/);
  });

  it('움직임이 없어 줄인 움직임 설정과 충돌하지 않는다', () => {
    expect(block).not.toMatch(/transition|animation/);
  });
});
