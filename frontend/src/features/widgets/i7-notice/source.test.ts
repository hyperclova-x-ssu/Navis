import { describe, expect, it, vi } from 'vitest';
import { createNoticeSeed, type NoticeCommand } from '../../../data/iteration7/notices';
import type { DataCommandResult } from '../../../data/commands/types';
import { createNoticePort } from './source';

describe('notice source adapter', () => {
  it('loads the imported draft from the updated shared snapshot and passes current preview identifiers when sending', async () => {
    const draft = createNoticeSeed().noticeDraft[0]!;
    const dispatch = vi.fn<(command: NoticeCommand) => DataCommandResult>(command => command.type === 'notice.importClosure' ? { ok: true, revision: 2, value: { noticeId: draft.noticeId, revision: draft.revision } } : { ok: true, revision: 3, value: { sentId: 'sent', status: 'sent_example', recipientCount: 126, sentAt: '2026-10-26T15:45' } });
    const port = createNoticePort(dispatch, id => id === draft.noticeId ? draft : undefined, () => {}, () => 'unique-key');
    const imported = await port.importClosure('closure-1102');
    expect(imported).toMatchObject({ ok: true, draft: { noticeId: draft.noticeId, title: draft.title } });
    await port.send(draft.noticeId, draft.revision, 'preview-id');
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'notice.send', noticeId: draft.noticeId, draftRevision: draft.revision, previewId: 'preview-id', idempotencyKey: 'unique-key' });
  });
  it('does not invent a successful preview when the dispatcher returns no preview', async () => {
    const port = createNoticePort(() => ({ ok: true, revision: 1 }), () => undefined, () => {}, () => 'key');
    expect(await port.preview('draft', 1)).toEqual({ ok: false });
    expect(await port.send('draft', 1, 'preview')).toEqual({ ok: false });
  });
});
