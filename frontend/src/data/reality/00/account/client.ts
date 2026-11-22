import type { AccessTokenResponse } from '../../../../../../backend/packages/contracts';
import type { DashboardLayerId, DashboardPage, Locale, PaymentStyle, ShopSettings, TableLayout, Theme } from '../../../../contracts';
import type { BusinessType } from '../../../../contracts';
import type { CctvPosLink, PosPreferences } from '../../../../contracts/session';
import type { AccountRestore } from '../../../../state';
import { PortError, type CommandReceipt } from '../port';
import type { PortSession } from '../transport';

/* ── Wire (PORT.md §10; B00 confirms or amends) ───────────────────────────────────────────────────────── */
export interface StoreSummary { readonly storeId: string; readonly name: string; readonly role: string; readonly current: boolean }
export interface ProfileDto {
  readonly storeId: string; readonly name: string; readonly businessType: BusinessType | null; readonly paymentStyle: PaymentStyle | null; readonly tableLayout: TableLayout | null;
  readonly posPreferences?: PosPreferences; readonly cctvPosLinks?: readonly CctvPosLink[]; readonly onboardingDone: boolean; readonly revision: number;
}
export interface PreferencesDto { readonly theme: Theme; readonly textScale: 100 | 125; readonly locale: Locale; readonly revision: number }
export interface BoardDto { readonly boardId: DashboardLayerId; readonly revision: number; readonly currentPage: number; readonly pages: readonly DashboardPage[] }
export type ProfilePatch = Pick<ProfileDto, 'businessType' | 'paymentStyle' | 'tableLayout' | 'onboardingDone'> & Partial<Pick<ProfileDto, 'posPreferences' | 'cctvPosLinks'>>;
export type PreferencesPatch = Pick<PreferencesDto, 'theme' | 'textScale' | 'locale'>;

export interface AccountRevisions { readonly profile: number; readonly preferences: number; readonly boards: Readonly<Record<DashboardLayerId, number>> }
export interface AccountSnapshot {
  readonly stores: readonly StoreSummary[];
  readonly storeName: string;
  readonly restore: AccountRestore;
  /** Server revisions the next writes are issued against (0 = not stored yet). */
  readonly revisions: AccountRevisions;
}

const LAYERS: readonly DashboardLayerId[] = ['management', 'marketing'];
const bad = () => new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
const emptyBoard = (boardId: DashboardLayerId): BoardDto => ({ boardId, revision: 0, currentPage: 0, pages: [{ pageId: `${boardId}-1`, panels: [] }] });

function checkProfile(value: unknown): ProfileDto {
  const p = value as Partial<ProfileDto> | null;
  if (!p || typeof p.storeId !== 'string' || typeof p.onboardingDone !== 'boolean' || !Number.isInteger(p.revision)) throw bad();
  return p as ProfileDto;
}
function checkPreferences(value: unknown): PreferencesDto {
  const p = value as Partial<PreferencesDto> | null;
  if (!p || (p.theme !== 'light' && p.theme !== 'dark') || (p.textScale !== 100 && p.textScale !== 125) || typeof p.locale !== 'string' || !Number.isInteger(p.revision)) throw bad();
  return p as PreferencesDto;
}
function checkBoards(value: unknown): Record<DashboardLayerId, BoardDto> {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw bad();
  const boards = { management: emptyBoard('management'), marketing: emptyBoard('marketing') };
  for (const item of items as Partial<BoardDto>[]) {
    if (!item || !LAYERS.includes(item.boardId as DashboardLayerId) || !Array.isArray(item.pages) || !Number.isInteger(item.currentPage) || !Number.isInteger(item.revision)) throw bad();
    boards[item.boardId as DashboardLayerId] = item as BoardDto;
  }
  return boards;
}

/** The account service from the browser: session, stores, profile, preferences and boards (REAL-PLAN B00/F00). */
export function createAccountClient(transport: PortSession) {
  const get = <T>(path: string, scope: 'store' | 'root' = 'store') => transport.request<T>({ method: 'GET', path, scope });
  return {
    async load(): Promise<AccountSnapshot> {
      const [profile, preferences, boards, stores] = await Promise.all([
        get<unknown>('/profile'), get<unknown>('/preferences'), get<unknown>('/boards'), get<{ items?: StoreSummary[] }>('/api/v1/stores', 'root'),
      ]);
      const p = checkProfile(profile), pref = checkPreferences(preferences), b = checkBoards(boards);
      const settings: ShopSettings = { businessType: p.businessType, paymentStyle: p.paymentStyle, tableLayout: p.tableLayout, revision: p.revision,
        ...(p.posPreferences ? { posPreferences: p.posPreferences } : {}), ...(p.cctvPosLinks ? { cctvPosLinks: p.cctvPosLinks } : {}) };
      return {
        stores: Array.isArray(stores?.items) ? stores.items : [], storeName: p.name,
        revisions: { profile: p.revision, preferences: pref.revision, boards: { management: b.management.revision, marketing: b.marketing.revision } },
        restore: {
          theme: pref.theme, textScale: pref.textScale, locale: pref.locale, onboardingDone: p.onboardingDone, settings,
          boards: {
            management: { pages: b.management.pages, currentPage: b.management.currentPage, revision: b.management.revision },
            marketing: { pages: b.marketing.pages, currentPage: b.marketing.currentPage, revision: b.marketing.revision },
          },
        },
      };
    },
    saveProfile: (patch: ProfilePatch, expectedRevision: number, idempotencyKey: string) =>
      transport.request<CommandReceipt>({ method: 'PATCH', path: '/profile', body: patch, expectedRevision, idempotencyKey }),
    savePreferences: (patch: PreferencesPatch, expectedRevision: number, idempotencyKey: string) =>
      transport.request<CommandReceipt>({ method: 'PATCH', path: '/preferences', body: patch, expectedRevision, idempotencyKey }),
    saveBoard: (boardId: DashboardLayerId, board: Pick<BoardDto, 'pages' | 'currentPage'>, expectedRevision: number, idempotencyKey: string) =>
      transport.request<CommandReceipt>({ method: 'PUT', path: `/boards/${boardId}`, body: { pages: board.pages, currentPage: board.currentPage }, expectedRevision, idempotencyKey }),

    /** Stores this account can open. */
    async stores(): Promise<readonly StoreSummary[]> {
      const page = await get<{ items?: StoreSummary[] }>('/api/v1/stores', 'root');
      if (!Array.isArray(page?.items)) throw bad();
      return page.items;
    },
    /** Start working in another store: the new token replaces the old one; the caller resets every domain and re-reads. */
    async switchStore(storeId: string, idempotencyKey: string): Promise<void> {
      const next = await transport.request<AccessTokenResponse>({ method: 'POST', path: '/api/v1/auth/store', scope: 'root', body: { storeId }, idempotencyKey });
      if (!next?.accessToken || !next.storeId) throw bad();
      transport.adopt(next);
    },
    async login(loginId: string, password: string): Promise<void> {
      const next = await transport.anonymous<AccessTokenResponse>({ method: 'POST', path: '/api/v1/auth/login', body: { loginId, password } });
      if (!next?.accessToken || !next.storeId) throw bad();
      transport.adopt(next);
    },
    async logout(): Promise<void> {
      try { await transport.anonymous({ method: 'POST', path: '/api/v1/auth/logout' }); } finally { transport.reset({ forgetSession: true }); }
    },
  };
}
export type AccountClient = ReturnType<typeof createAccountClient>;
