import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { ZoneEditor } from './ZoneEditor';
import { encodeRle } from './mask';
import { CELLS } from './types';
import { keepDraft } from './editor-state';
afterEach(() => { cleanup(); keepDraft(null); });
it('offers a controlled POS link for saved zones and emits unlink', async () => {
  const onChange = vi.fn(), cells = new Uint8Array(CELLS); cells.fill(1, 0, 40);
  renderWithKit(<ZoneEditor onSaved={() => {}} onClose={() => {}} initial={{ revision: 1, savedAt: 'x', frameAspect: 1.78, zones: [{ id: 'z1', number: 1, source: 'drawn', mask: encodeRle(cells) }] }} linkPicker={{ valueFor: () => 'T1', optionsFor: () => [{ value: 'T1', label: 'T1' }], onChange }} />);
  fireEvent.click(await screen.findByText('테이블 목록'));
  const picker = screen.getByRole('combobox', { name: '테이블 1 POS 테이블 연결' });
  expect(picker).toHaveValue('T1');
  fireEvent.change(picker, { target: { value: '' } });
  expect(onChange).toHaveBeenCalledExactlyOnceWith('z1', null);
});
