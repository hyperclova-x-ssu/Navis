import { useRef, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import './test-setup';
import { screenPresets } from '../layout/presets';
import { UiProvider } from './UiProvider';
import { ActionButton } from './components/controls';
import { PosActionButton, PosDialog, ResultPanel } from './components/pos-controls';

afterEach(cleanup);

// A controlled approval boundary: the app scheduler, rather than the kit,
// supplies the result. Removing the close guard must break this flow.
it('keeps an approval dialog open until its result and returns focus on close', async () => {
  let finishApproval: (() => void) | undefined;
  function Flow() {
    const opener = useRef<HTMLButtonElement>(null);
    const method = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [approvals, setApprovals] = useState(0);
    return <UiProvider screenPreset={screenPresets.A} reducedMotion>
      <PosActionButton ref={opener} onAction={() => setOpen(true)}>결제하기</PosActionButton>
      <output aria-label="승인 횟수">{approvals}</output>
      <PosDialog open={open} title="결제" kind="pay" returnFocusRef={opener}
        initialFocusRef={method} busy={busy}
        onClose={() => setOpen(false)}>
        {done ? <ResultPanel title="결제했어요 · 주문 #95"/> : <ActionButton ref={method} aria-busy={busy || undefined}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            setApprovals(n => n + 1);
            finishApproval = () => { setBusy(false); setDone(true); };
          }}>{busy ? '승인 중이에요' : '카드'}</ActionButton>}
      </PosDialog>
    </UiProvider>;
  }
  const user = userEvent.setup();
  render(<Flow />);
  const opener = screen.getByRole('button', { name: '결제하기' });
  await user.click(opener);
  await waitFor(() => expect(screen.getByRole('button', { name: '카드' })).toHaveFocus());
  await user.click(screen.getByRole('button', { name: '카드' }));
  const dialog = screen.getByRole('dialog', { name: '결제' });
  await user.click(screen.getByRole('button', { name: '닫기' }));
  expect(dialog).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '닫기' })).toHaveAccessibleDescription('승인 중에는 닫을 수 없어요');
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog', { name: '결제' })).toBeInTheDocument();
  const backdrop = document.querySelector<HTMLElement>('.ui-scrim')!;
  fireEvent.pointerDown(backdrop, { button: 0, pointerType: 'mouse' });
  fireEvent.pointerUp(backdrop, { button: 0, pointerType: 'mouse' });
  fireEvent.click(backdrop);
  expect(screen.getByRole('dialog', { name: '결제' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '승인 중이에요' }));
  expect(screen.getByLabelText('승인 횟수')).toHaveTextContent('1');
  act(() => finishApproval!());
  expect(screen.getByRole('heading', { name: '결제했어요 · 주문 #95' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: '닫기' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
});
