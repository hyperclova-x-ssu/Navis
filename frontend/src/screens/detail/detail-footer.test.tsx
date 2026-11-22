import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DetailFooterContext, InlineForm } from '../../ui';
import { renderWithKit } from '../../ui/test-utils';

afterEach(() => {
  cleanup();
  document.querySelector('[data-test-detail-footer]')?.remove();
});

it('associates the fixed save button with its form and keeps close in the same footer', () => {
  const footer = document.createElement('footer');
  footer.setAttribute('data-test-detail-footer', '');
  document.body.append(footer);
  const save = vi.fn();
  const close = vi.fn();
  const claim = vi.fn();
  renderWithKit(<DetailFooterContext.Provider value={{ slot: footer, claim }}>
    <InlineForm title="일정 추가" saveLabel="일정 저장하기" closeLabel="닫기" onSave={save} onClose={close} footerActions>
      <label>일정 이름<input /></label>
    </InlineForm>
  </DetailFooterContext.Provider>);
  const form = screen.getByRole('form', { name: '일정 추가' });
  expect(within(form).queryByRole('button', { name: '일정 저장하기' })).toBeNull();
  const button = within(footer).getByRole('button', { name: '일정 저장하기' });
  expect((button as HTMLButtonElement).form).toBe(form);
  fireEvent.click(button);
  expect(save).toHaveBeenCalledOnce();
  fireEvent.click(within(footer).getByRole('button', { name: '닫기' }));
  expect(close).toHaveBeenCalledOnce();
});
