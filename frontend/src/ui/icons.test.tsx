import { afterEach, expect, it } from 'vitest';
import './test-setup';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Icon } from './icons';

afterEach(cleanup);

it('draws the pencil icon (DS 16 「연필(메모)」) with its own path on the shared 24px stroke frame', () => {
  const pencil = render(<Icon name="pencil" />).container.querySelector('svg')!;
  const trash = render(<Icon name="trash" />).container.querySelector('svg')!;
  const d = pencil.querySelector('path')!.getAttribute('d')!;
  expect(d.length).toBeGreaterThan(10);
  expect(d).not.toBe(trash.querySelector('path')!.getAttribute('d'));
  expect(pencil).toHaveAttribute('viewBox', '0 0 24 24');
  expect(pencil).toHaveAttribute('stroke-width', '2');
  expect(pencil).toHaveAttribute('aria-hidden', 'true');
});

it('names the pencil icon for assistive technology only when a label is given', () => {
  const { getByRole } = render(<Icon name="pencil" label="고치기" />);
  expect(getByRole('img', { name: '고치기' })).toBeInTheDocument();
});
