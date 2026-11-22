/**
 * PAR-3 test helper: opens one widget in the EXAMPLE mode (fixture store) and in the REAL mode (HTTP port on a fake backend) and
 * reduces what is on screen to its structure — tabs, section headings, buttons, form fields, chips, slots and the part order of
 * the first card — so a test can assert that both modes show the same screen. Row text (data) is never part of the structure.
 */
import { vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { TODAY } from '../../../data/db/time';
import { fakeBackend } from '../../../data/reality/00/testing';
import type { WidgetDetailProps, WidgetHost, WidgetPanelProps } from '../../../contracts';
import { createWidgetDataStore, type WidgetDataStore } from '../../../data/db/store';
import { createRealPort, type RealDomain } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

export type Mode = 'example' | 'real';
export type Backend = ReturnType<typeof fakeBackend>;

export interface OpenOptions {
  readonly backend?: Backend;
  readonly domain?: RealDomain;
  readonly detailRef?: Partial<WidgetDetailProps['detailRef']>;
  readonly panel?: Partial<Pick<WidgetPanelProps, 'width' | 'height' | 'shape'>>;
  readonly modules?: Parameters<typeof renderWithKit>[1];
  /** The example mode's own store (a test that needs other fixture rows builds it). */
  readonly store?: WidgetDataStore;
}

export function openWidget(id: string, which: 'Panel' | 'Detail', mode: Mode, options: OpenOptions = {}) {
  const store = options.store ?? createWidgetDataStore();
  if (mode === 'real') {
    const { backend, domain = 'local' } = options;
    if (!backend) throw new Error('real mode needs a backend');
    const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: d => d === domain ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
    store.bindReal(port);
  }
  const notify = vi.fn();
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked: vi.fn(), openDetail() {}, notify, acknowledgeBriefing() {} };
  const module = widgets.find(widget => widget.id === id)!;
  const view = which === 'Detail'
    ? (() => { const Detail = module.Detail!; return <Detail featureId={id as never} condition={{ kind: 'default' }} detailRef={{ featureId: id as never, ...options.detailRef }} host={host} />; })()
    : (() => { const Panel = module.Panel; const { width = 4, height = 4, shape = 'L' } = options.panel ?? {}; return <Panel featureId={id as never} presetId="A" editing={false} condition={{ kind: 'default' }} width={width} height={height} shape={shape} host={host} />; })();
  const rendered = renderWithKit(view, { modules: widgets, store, ...options.modules });
  return { ...rendered, store, host, notify };
}

const text = (el: Element | null) => (el?.textContent ?? '').replace(/[\u00a0\u2060\s]+/g, ' ').trim();
/** The visible words of a tree with the no-break and word-joiner marks the kit adds written as plain spaces. */
export const plain = (root: Element) => (root.textContent ?? '').replace(/[\u00a0\u2060]/g, ' ');
const inRow = (el: Element) => Boolean(el.closest('li, [role="row"], tr'));

export interface Structure {
  /** Tab names in order. */
  readonly tabs: readonly string[];
  /** `h3.mkt-section`-style headings that are not item titles, in order. */
  readonly sections: readonly string[];
  /** Buttons that are not part of a list row, in document order. */
  readonly buttons: readonly string[];
  /** Links outside list rows. */
  readonly links: readonly string[];
  /** Labelled form fields (text boxes, selects, date and number inputs) and chip groups. */
  readonly fields: readonly string[];
  /** `data-slot` values, unique, in document order. */
  readonly slots: readonly string[];
  /** Class parts of the first card / row, in order (names the lines a card has, never their words). */
  readonly firstCard: readonly string[];
}

export function structure(root: HTMLElement, options: { readonly card?: string } = {}): Structure {
  const unique = <T,>(list: readonly T[]) => [...new Set(list)];
  const tabs = [...root.querySelectorAll('[role="tab"]')].map(text);
  const sections = [...root.querySelectorAll('h3, h4, h5')].filter(el => !inRow(el) && !el.className.includes('mkt-card__title') && !el.closest('.mkt-card')).map(text);
  const buttons = [...root.querySelectorAll('button')].filter(el => !inRow(el) && !el.matches('.mkt-hour') && el.getAttribute('role') !== 'tab' && !el.closest('[role="tablist"]') && !el.closest('.ui-dialog__close')).map(el => text(el) || el.getAttribute('aria-label') || '');
  const links = [...root.querySelectorAll('a[href]')].filter(el => !inRow(el)).map(text);
  const fields = [...root.querySelectorAll('input, textarea, select, [role="radiogroup"], [role="group"][aria-label], .ui-chip-choice')]
    .map(el => el.getAttribute('aria-label') || (el.id && root.querySelector(`label[for="${el.id}"]`)?.textContent) || el.closest('label')?.textContent || el.getAttribute('name') || el.className)
    .map(value => value.replace(/\s+/g, ' ').trim());
  const slots = unique([...root.querySelectorAll('[data-slot]')].map(el => el.getAttribute('data-slot')!));
  const card = root.querySelector(options.card ?? '.mkt-card, .mkt-row, .mkt-pick');
  const firstCard = card ? [...card.children].map(el => el.className.toString().split(/\s+/).filter(Boolean).join('.') || el.tagName.toLowerCase()) : [];
  return { tabs, sections, buttons, links, fields, slots, firstCard };
}

/** Waits for a stable screen: the widget heading/state is out of `loading`. */
export async function settled(find: () => Promise<unknown>) { await find(); await screen.findAllByText(/./); }

const at = `${TODAY}T06:45:00.000Z`;
const base = '/marketing';
const page = { items: [], nextCursor: null, asOf: at, sourceRevision: 1 };
export const PARTNER = '22222222-2222-4222-8222-222222222222';

/**
 * The service's answers for the neighbourhood domain, shaped like what the example data holds: three changes (an owner record without a link,
 * a licence and an event with an official link), hourly movement bands, two menus sold, one received offer awaiting an answer from one peer.
 */
export function localBackend(options: { readonly changes?: boolean; readonly offers?: boolean } = {}) {
  const b = fakeBackend();
  const change = (id: string, kind: string, title: string, dateKind: string, sourceUrl: string | null, authority: string) => ({ id, revision: 1, title, kind, region: '서울 동작구 상도동', authority, sourceUrl, dateKind, referenceDate: TODAY, updatedAt: at, acknowledgedAt: null });
  b.on('GET', `${base}/local-changes`, ({ query }) => ({ ...page, coverage: { region: '서울 동작구 상도동', kinds: ['food-license', 'festival'], referenceDate: TODAY }, unreadCount: options.changes === false ? 0 : 3, period: { from: query.from, to: query.to },
    items: options.changes === false ? [] : [change('c1', 'owner-record', '상도동 보행로 정비', 'recorded-date', null, '사장님 기록'), change('c2', 'food-license', '상도역 앞 독립 서점 개점', 'license-date', 'https://data.seoul.go.kr/dataList/OA-18696/S/1/datasetView.do', '서울특별시 동작구'),
      change('c3', 'festival', '숭실대 동아리 겨울 정기 공연', 'event-date', 'https://data.seoul.go.kr/dataList/OA-18671/S/1/datasetView.do', '서울특별시 동작구')] }));
  b.on('GET', `${base}/trade-area`, ({ query }) => ({ asOf: at, period: { from: query.from, to: query.to },
    population: { status: 'available', quarter: '2026-Q4', weekday: 7, items: [8, 9, 10, 11, 12, 18].map((h, i) => ({ region: '서울 동작구 상도동', quarter: '2026-Q4', weekday: 7, startHour: h, endHour: h + 1, estimate: 1000 + i * 100, referenceDate: TODAY, refreshedAt: at, sourceUrl: 'https://data.seoul.go.kr/dataList/OA-23016/S/1/datasetView.do' })) },
    sales: { status: 'available', items: [{ hour: 10, quantity: 21, settlementIds: ['s1'] }, { hour: 11, quantity: 15, settlementIds: ['s2'] }] } }));
  b.on('GET', `${base}/local-trends`, ({ query }) => ({ asOf: at, period: { from: query.from, to: query.to }, search: null,
    sales: { status: 'available', items: [{ menuId: 'm1', menuName: '아메리카노', businessDate: TODAY, quantity: 9 }, { menuId: 'm2', menuName: '카페라떼', businessDate: TODAY, quantity: 5 }] } }));
  b.on('GET', `${base}/offers`, () => ({ ...page, items: options.offers === false ? [] : [{ id: 'o1', revision: 1, title: '책방 영수증 혜택', terms: '할인 안내', senderStoreId: PARTNER, recipientStoreId: b.storeId, startsOn: TODAY, endsOn: TODAY,
    respondBy: TODAY, canRespond: true, status: 'pending', interested: false, sharedContact: null, updatedAt: at, visibility: 'direct' }] }));
  b.on('GET', `${base}/offers/peers`, () => ({ status: 'available', items: [{ storeId: PARTNER, displayName: '상도책방' }] }));
  b.on('GET', `${base}/community/cafe-boards`, () => ({ items: [{ clubid: '1', menuid: '2' }] }));
  b.on('GET', `${base}/community/cafe-posts`, () => page);
  return b;
}

/** Waits until the widget shows content (not its loading or error state). */
export async function loaded(root: HTMLElement) {
  await waitFor(() => {
    if (root.querySelector('[data-slot$=".state.message"], .mkt-detail-state__message[data-state]')) throw new Error('still loading');
    if (!root.querySelector('[data-slot]')) throw new Error('nothing yet');
  }, { timeout: 4000 });
  await new Promise(resolve => setTimeout(resolve, 30));
}
