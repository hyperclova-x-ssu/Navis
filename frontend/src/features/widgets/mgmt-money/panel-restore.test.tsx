import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { FeaturePanel } from '../../../ui';
import type { WidgetHost } from '../../../contracts';
import { LedgerPanel } from './ledger';
import { manualsModule } from '../mgmt-store/manuals';

afterEach(() => { cleanup(); document.querySelectorAll('[data-owned-style]').forEach(node => node.remove()); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
function styles(path: string) {
  const style = document.createElement('style');
  style.dataset.ownedStyle = '';
  style.textContent = readFileSync(new URL(path, import.meta.url), 'utf8');
  document.head.appendChild(style);
}
it('restores all offered rows in a roomy editing panel instead of permanently hiding rows by index', () => {
  styles('./widget.css');
  renderWithKit(<FeaturePanel featureId="ledger" groupId="finance" label="손익" width={4} height={4} editing><LedgerPanel featureId="ledger" condition={{ kind: 'default' }} width={4} height={4} shape="L" presetId="A" editing host={host} /></FeaturePanel>);
  const rows = document.querySelectorAll('.mm-row');
  // 6 basic rows + the paid amount and the discount a 4-high card adds (D-333; the seed has a discount and no refund)
  expect(rows).toHaveLength(8);
  for (const row of rows) expect(getComputedStyle(row).display).not.toBe('none');
});
it('keeps both manual counts visible in the smallest panel, including 125% text', () => {
  styles('../mgmt-store/widget.css');
  renderWithKit(<FeaturePanel featureId="manuals" groupId="misc" label="매뉴얼 작성" width={1} height={1}><manualsModule.Panel featureId="manuals" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={host} /></FeaturePanel>, { textScale: 125 });
  expect(getComputedStyle(screen.getByText('인수인계')).display).not.toBe('none');
  expect(getComputedStyle(document.querySelector('[data-slot="manuals.metric.secondary"]')!).display).not.toBe('none');
});
