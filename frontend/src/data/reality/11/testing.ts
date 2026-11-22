import { createWidgetDataStore } from '../../db/store';
import { TODAY } from '../../db/time';
import { createRealPort, registeredAdapters } from '../00';
import { fakeBackend } from '../00/testing';
import './register';

export const insight = '/insight';
export const noticeId = '00000000-0000-4000-8000-000000000001';
export const draftId = '00000000-0000-4000-8000-000000000002';
export const manualId = '00000000-0000-4000-8000-000000000003';
export const applicationId = '00000000-0000-4000-8000-000000000004';
export const updatedAt = `${TODAY}T06:00:00Z`;
export const grant = {
  id: noticeId, revision: 4, updatedAt, sourceUpdatedAt: updatedAt, sourceMode: 'fake', source: 'bizinfo', providerId: 'PBLN_1',
  officialUrl: 'https://www.bizinfo.go.kr/sample?pblancId=PBLN_1', title: '매장 설비 개선 지원', agency: '중소벤처기업부',
  region: '서울', industry: '카페', summary: '매장 설비 구입을 지원해요', target: '소상공인', applicationMethod: '공고 참조',
  tags: ['서울', '카페'], startsOn: '2022-07-27', deadline: '2022-09-30', reviewStatus: 'before', matchStatus: 'matched',
} as const;
export const draft = {
  id: draftId, revision: 2, updatedAt, section: 'handover', category: 'new-staff', memo: '마감 점검',
  title: '마감 점검', steps: [{ body: '기기 전원을 꺼요' }], body: '', cautions: '', status: 'draft',
} as const;
export const manual = {
  id: manualId, revision: 1, updatedAt, section: 'handover', category: 'closing', title: '마감 점검',
  steps: draft.steps, body: '', cautions: '', isPublished: true, checklist: true, checklistVersion: 1,
} as const;

export function insightSession() {
  const backend = fakeBackend();
  const collections = new Map<string, readonly unknown[]>();
  let businessDay = TODAY;
  for (const path of ['manuals', 'manual-drafts', 'checklists', 'grant-notices', 'grant-applications']) {
    backend.on('GET', `${insight}/${path}`, () => ({ items: collections.get(path) ?? [], nextCursor: null, asOf: updatedAt, sourceRevision: 7 }));
  }
  backend.on('GET', `${insight}/manuals-grants-briefing`, () => ({ businessDay, asOf: updatedAt, sourceRevision: 7, openingChecked: 0, openingSteps: 0, upcomingGrantDeadlines: 0 }));
  const newStore = () => {
    const store = createWidgetDataStore();
    const port = createRealPort({ store, source: domain => domain === 'manuals' ? 'http' : 'fixture', adapters: registeredAdapters(), fetch: backend.fetch });
    store.bindReal(port);
    return store;
  };
  return { backend, collections, newStore, setBusinessDay: (day: string) => { businessDay = day; } };
}
