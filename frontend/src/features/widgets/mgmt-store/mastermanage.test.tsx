import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { createWidgetDataStore, koText, makeHost, manualsModel, renderDetail } from './test-helpers';
afterEach(cleanup);
it('creates and deletes a store information document with undo', async () => {
 const store = createWidgetDataStore(), { host, notify } = makeHost();
 renderDetail('manuals', host, { store, textScale: 125, reducedMotion: true });
 await userEvent.click(screen.getByRole('tab', { name: /매장 정보/ }));
 await userEvent.click(screen.getByRole('button', { name: '문서 만들기' }));
 await userEvent.type(screen.getByRole('textbox', { name: '제목' }), '배달 포장 규칙');
 await userEvent.type(screen.getByRole('textbox', { name: '1단계' }), '포장 상태를 확인해요');
 await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
 expect(store.getSnapshot().tables.manual.some(m => 'raw' in m.title && m.title.raw === '배달 포장 규칙')).toBe(true);
 await userEvent.click(screen.getByRole('button', { name: /배달 포장 규칙/ }));
 await userEvent.click(screen.getByRole('button', { name: '문서 지우기' }));
 const token = notify.mock.calls.at(-1)?.[0].undoToken;
 expect(token).toBeTruthy();
 expect(store.undo(token!).ok).toBe(true);
 expect(store.getSnapshot().tables.manual.some(m => 'raw' in m.title && m.title.raw === '배달 포장 규칙')).toBe(true);
});
it('resets the empty preview before opening a new manual', async () => {
 const { host, resetPreview, openDetail } = makeHost();
 const { renderPanel } = await import('./test-helpers');
 renderPanel('manuals', 1, 1, host, { preview: { family: 'empty', overrides: {} } });
 await userEvent.click(screen.getByRole('button', { name: /매뉴얼 만들기/ }));
 expect(resetPreview).toHaveBeenCalled();
 expect(openDetail).toHaveBeenCalledWith({ featureId: 'manuals', focus: 'action' });
});
it('allows choosing a document category when creating a manual', async () => {
 renderDetail('manuals', makeHost().host);
 await userEvent.click(screen.getByRole('button', { name: '문서 만들기' }));
 expect(screen.getByRole('radiogroup', { name: '분류' })).toBeInTheDocument();
});

it('keeps the two document counts and renders every store document as body text', async () => {
 const store = createWidgetDataStore(), { host } = makeHost();
 const { publishedCount, storeInfo } = manualsModel(store);
 expect(storeInfo.length).toBeGreaterThan(0);
 renderDetail('manuals', host, { store });
 expect(within(screen.getByRole('list', { name: '매뉴얼 목록' })).getAllByRole('listitem')).toHaveLength(publishedCount);
 await userEvent.click(screen.getByRole('tab', { name: `매장 정보 ${storeInfo.length}개` }));
 const list = screen.getByRole('list', { name: '매뉴얼 목록' });
 expect(within(list).getAllByRole('listitem')).toHaveLength(storeInfo.length);
 for (const doc of storeInfo) {
   await userEvent.click(within(list).getByRole('button', { name: new RegExp(koText(doc.title)) }));
   expect(document.querySelector('[data-slot="manuals.body"]')).toHaveTextContent(koText(doc.body).replace(/\s+/g, ' '));
   expect(document.querySelector('.mgmt-manual .mgmt-steps')).toBeNull();
 }
 await userEvent.click(screen.getByRole('button', { name: '문서 고치기' }));
 expect(screen.getByRole('textbox', { name: '내용' })).toHaveValue(koText(storeInfo.at(-1)!.body));
 expect(screen.getByRole('radio', { name: '매장 정보' })).toHaveAttribute('aria-checked', 'true');
});
