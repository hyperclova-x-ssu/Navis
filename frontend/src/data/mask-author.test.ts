import { describe, expect, it } from 'vitest';
import { createWidgetDataStore } from './db/store';
import { selectWidget } from './models/select';
import { maskAuthor } from './models/local';

describe('AC-318 reviewer masking', () => {
  it('keeps the first character and always adds two asterisks', () => {
    expect(maskAuthor('김민수')).toBe('김**');
    expect(maskAuthor('Emma Johnson')).toBe('E**');
    expect(maskAuthor('  이  ')).toBe('이**');
    expect(maskAuthor('')).toBeNull();
    expect(maskAuthor(null)).toBeNull();
    expect(maskAuthor(undefined)).toBeNull();
  });
  it('the model exposes only masked names; reviews have one, messages do not', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    const view = selectWidget(snapshot, 'ai-response', { kind: 'default' }, 'normal');
    if (view.status !== 'ready') throw new Error('not ready');
    // ThreadRow carries authorMasked itself (T-055): no cast.
    const rows = view.model.threads;
    expect(rows.filter((r) => r.type === 'review').every((r) => /^.\*\*$/u.test(r.authorMasked ?? ''))).toBe(true);
    const review = snapshot.tables.inquiryThread.find(row => row.type === 'review' && row.author)!;
    expect(rows.find(row => row.threadId === review.threadId)?.authorMasked).toBe('가**');
    expect(JSON.stringify(view.model)).not.toContain(review.author);
    expect(rows.filter((r) => r.type === 'message').every((r) => r.authorMasked === null)).toBe(true);
  });
});
