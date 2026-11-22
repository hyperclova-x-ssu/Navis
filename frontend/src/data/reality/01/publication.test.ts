import { expect, it } from 'vitest';
import { createPortTransport } from '../00/transport';
import { fakeBackend } from '../00/testing';
import { publication } from './publication';

it('stores the proposal in preview and confirms using only the bound approval and preview IDs', async () => {
  const backend = fakeBackend();
  const path = '/inventory/menu/menu-id/place';
  const expiresAt = '2099-01-01';
  const card = { previewId: 'preview-key', expectedRevision: 7, inputHash: 'digest', expiresAt, diff: {} };
  const approval = { approvalId: 'approval-key', expiresAt, requiresConfirmation: false };
  backend.on('POST', path + '/preview', () => card);
  backend.on('POST', '/inventory/approvals', () => approval);
  backend.on('POST', path + '/confirm', () => ({}));
  const client = publication(createPortTransport(backend.fetch), {
    path, operation: 'place.menu.publish', resourceId: 'menu-id',
  });
  const input = { currentName: 'Old name' };
  const attempt = await client.preview(input);
  expect(backend.callsTo('POST', path + '/preview')[0].body).toEqual({ input });
  expect(backend.callsTo('POST', '/inventory/approvals')).toHaveLength(0);
  expect(backend.callsTo('POST', path + '/confirm')).toHaveLength(0);
  const approved = await client.press(attempt);
  expect(backend.callsTo('POST', '/inventory/approvals')[0].body).toEqual({
    stage: 'press', operation: 'place.menu.publish', resourceId: 'menu-id', expectedRevision: 7, previewId: card.previewId,
  });
  expect(backend.callsTo('POST', path + '/confirm')).toHaveLength(0);
  await client.confirm(attempt, approved);
  const [call] = backend.callsTo('POST', path + '/confirm');
  expect(call.headers.get('idempotency-key')).toBe(approval.approvalId);
  expect(call.body).toEqual({ approvalId: approval.approvalId, expectedRevision: 7, previewId: card.previewId });
});
