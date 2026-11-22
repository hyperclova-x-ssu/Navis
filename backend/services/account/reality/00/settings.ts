import type { PoolClient } from 'pg';
import { array, boolean, expectedRevision, identifier, integer, invalid, option, record, unique } from './wire.ts';

const businesses = ['cafe', 'restaurant', 'pub', 'beauty', 'retail', 'academy', 'fitness', 'other'] as const;
const paymentStyles = ['prepaid', 'postpaid'] as const;
const tabs = ['order', 'status', 'tables'] as const;

function tableLayout(value: unknown) {
  const input = record(value, ['layoutId', 'columns', 'rows', 'revision', 'tables'], 'tableLayout');
  const tables = array(input.tables, 1, 20, 'tables', value => {
    const table = record(value, ['tableId', 'number', 'seats', 'column', 'row'], 'tables');
    return {
      tableId: identifier(table.tableId, 'tableId'), number: integer(table.number, 1, 20, 'number'),
      seats: integer(table.seats, 1, 12, 'seats'), column: integer(table.column, 0, 8, 'column'), row: integer(table.row, 0, 5, 'row'),
    };
  });
  unique(tables.map(table => table.tableId), 'tableId');
  unique(tables.map(table => table.number), 'number');
  unique(tables.map(table => table.row * 9 + table.column), 'tables');
  return { layoutId: identifier(input.layoutId, 'layoutId'), columns: integer(input.columns, 9, 9, 'columns'),
    rows: integer(input.rows, 6, 6, 'rows'), revision: integer(input.revision, 0, 2147483647, 'revision'), tables };
}

function posPreferences(value: unknown) {
  const input = record(value, ['startTab', 'userChoseStart', 'showStatus', 'showTables'], 'posPreferences');
  return {
    startTab: option(input.startTab, tabs, 'startTab'), userChoseStart: boolean(input.userChoseStart, 'userChoseStart'),
    showStatus: boolean(input.showStatus, 'showStatus'), showTables: boolean(input.showTables, 'showTables'),
  };
}

function cctvPosLinks(value: unknown) {
  const links = array(value, 0, 100, 'cctvPosLinks', value => {
    const link = record(value, ['zoneId', 'tableId'], 'cctvPosLinks');
    return { zoneId: identifier(link.zoneId, 'zoneId'), tableId: identifier(link.tableId, 'tableId') };
  });
  unique(links.map(link => link.zoneId), 'zoneId');
  unique(links.map(link => link.tableId), 'tableId');
  return links;
}

function smsSettings(value: unknown) {
  const input = record(value, ['senderNumber', 'optOutNumber'], 'smsSettings');
  function number(value: unknown, field: string, pattern: RegExp) {
    if (value === null) return null;
    const normalized = typeof value === 'string' && value.replace(/[ -]/g, '');
    if (!normalized || !pattern.test(normalized)) throw invalid(field);
    return normalized;
  }
  return { senderNumber: number(input.senderNumber, 'senderNumber', /^[0-9]{8,11}$/),
    optOutNumber: number(input.optOutNumber, 'optOutNumber', /^080[0-9]{7,8}$/) };
}

export function parseProfile(value: unknown) {
  const input = record(value, ['businessType', 'paymentStyle', 'tableLayout', 'posPreferences', 'cctvPosLinks',
    'onboardingDone', 'smsSettings', 'expectedRevision']);
  return {
    expected: expectedRevision(input.expectedRevision),
    patch: {
      ...(input.businessType !== undefined ? { businessType: input.businessType === null ? null : option(input.businessType, businesses, 'businessType') } : {}),
      ...(input.paymentStyle !== undefined ? { paymentStyle: option(input.paymentStyle, paymentStyles, 'paymentStyle') } : {}),
      ...(input.tableLayout !== undefined ? { tableLayout: input.tableLayout === null ? null : tableLayout(input.tableLayout) } : {}),
      ...(input.posPreferences !== undefined ? { posPreferences: posPreferences(input.posPreferences) } : {}),
      ...(input.cctvPosLinks !== undefined ? { cctvPosLinks: cctvPosLinks(input.cctvPosLinks) } : {}),
      ...(input.onboardingDone !== undefined ? { onboardingDone: boolean(input.onboardingDone, 'onboardingDone') } : {}),
      ...(input.smsSettings !== undefined ? { smsSettings: smsSettings(input.smsSettings) } : {}),
    },
  };
}

type Profile = Omit<Required<ReturnType<typeof parseProfile>['patch']>, 'posPreferences' | 'cctvPosLinks'> & {
  name: string; storeId: string; revision: number;
  posPreferences?: ReturnType<typeof posPreferences>; cctvPosLinks?: ReturnType<typeof cctvPosLinks>;
};

export async function readProfile(client: PoolClient, storeId: string): Promise<Profile | undefined> {
  const { rows: [profile] } = await client.query<Profile>(`
    SELECT store_id AS "storeId", display_name AS name, business_type AS "businessType", payment_style AS "paymentStyle",
      table_layout AS "tableLayout", pos_preferences AS "posPreferences", cctv_pos_links AS "cctvPosLinks",
      onboarding_done AS "onboardingDone", settings_revision AS revision,
      jsonb_build_object('senderNumber', sms_sender_number, 'optOutNumber', sms_opt_out_number) AS "smsSettings"
    FROM account.store WHERE store_id = $1
  `, [storeId]);
  if (!profile) return;
  if (profile.posPreferences === null) delete profile.posPreferences;
  if (profile.cctvPosLinks === null) delete profile.cctvPosLinks;
  return profile;
}

export async function saveProfile(client: PoolClient, profile: Profile, revision: number) {
  await client.query(`
    UPDATE account.store SET business_type = $2, payment_style = $3, table_layout = $4, pos_preferences = $5,
      cctv_pos_links = $6, onboarding_done = $7, settings_revision = $8, pos_start_tab = COALESCE($9, pos_start_tab),
      sms_sender_number = $10, sms_opt_out_number = $11,
      updated_at = statement_timestamp() WHERE store_id = $1
  `, [profile.storeId, profile.businessType, profile.paymentStyle, profile.tableLayout, profile.posPreferences,
    profile.cctvPosLinks && JSON.stringify(profile.cctvPosLinks), profile.onboardingDone, revision, profile.posPreferences?.startTab,
    profile.smsSettings.senderNumber, profile.smsSettings.optOutNumber]);
}

export function parsePreferences(value: unknown) {
  const input = record(value, ['theme', 'textScale', 'locale', 'expectedRevision']);
  const scale = input.textScale === undefined ? undefined : integer(input.textScale, 100, 125, 'textScale');
  if (scale !== undefined && scale !== 100 && scale !== 125) throw invalid('textScale');
  return {
    expected: expectedRevision(input.expectedRevision),
    patch: {
      ...(input.theme !== undefined ? { theme: option(input.theme, ['light', 'dark'], 'theme') } : {}),
      ...(scale !== undefined ? { textScale: scale } : {}),
      ...(input.locale !== undefined ? { locale: option(input.locale, ['ko', 'en', 'zh-Hans', 'zh-Hant'], 'locale') } : {}),
    },
  };
}

type Preferences = Required<ReturnType<typeof parsePreferences>['patch']> & { revision: number };

export async function readPreferences(client: PoolClient, storeId: string, userId: string): Promise<Preferences> {
  const { rows: [preferences] } = await client.query<Preferences>(`
    SELECT theme, text_scale AS "textScale", locale, revision FROM account.preference WHERE store_id = $1 AND user_id = $2
  `, [storeId, userId]);
  return preferences ?? { theme: 'light', textScale: 100, locale: 'ko', revision: 0 };
}

export async function savePreferences(client: PoolClient, storeId: string, userId: string, preferences: Preferences, revision: number) {
  await client.query(`
    INSERT INTO account.preference (store_id, user_id, theme, text_scale, locale, revision) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (store_id, user_id) DO UPDATE SET theme = EXCLUDED.theme, text_scale = EXCLUDED.text_scale,
      locale = EXCLUDED.locale, revision = EXCLUDED.revision
  `, [storeId, userId, preferences.theme, preferences.textScale, preferences.locale, revision]);
}
