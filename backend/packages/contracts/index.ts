import type { PosCatalogItem } from '../../../frontend/src/contracts/pos.ts';
import type { DashboardLayerId, FeatureId, MenuCategory } from '../../../frontend/src/contracts/index.ts';

export const boardWidgetLayers = {
  menu: 'management', 'custom-order': 'management', 'inventory-booking': 'management', suppliers: 'management',
  ledger: 'management', margin: 'management', tax: 'management', 'credit-receivable': 'management', members: 'management',
  'customer-analysis': 'management', 'store-environment': 'management', manuals: 'management', grants: 'management',
  'staff-schedule': 'management', calendar: 'management', 'voice-booking': 'management', briefing: 'management',
  'local-changes': 'marketing', 'trade-area': 'marketing', 'local-trends': 'marketing', 'ai-response': 'marketing',
  community: 'marketing', 'marketing-today': 'marketing', 'slot-coupon': 'marketing', 'expiry-coupon': 'marketing',
  'promo-video': 'marketing', 'notice-send': 'marketing', 'coupon-status': 'marketing', 'customer-groups': 'marketing',
} as const satisfies Record<Exclude<FeatureId, 'marketing-performance'>, DashboardLayerId>; // D-365: 마케팅 성과 left the board catalog (its model stays a data id), so a board can no longer hold it

export type CatalogItem = Pick<PosCatalogItem, 'menuId' | 'name' | 'price' | 'saleStatus'> & {
  readonly category: MenuCategory;
  readonly seasonal?: string;
};
export interface CatalogResponse {
  readonly items: readonly CatalogItem[];
}
export interface AccessTokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly storeId: string;
}

const errorCodes = [
  'INVALID_REQUEST', 'UNAUTHENTICATED', 'TOKEN_EXPIRED', 'STORE_FORBIDDEN', 'NOT_FOUND', 'SERVICE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof errorCodes)[number];
export interface ErrorResponse {
  readonly code: ErrorCode;
}

const uuid = { type: 'string', format: 'uuid' } as const;

export const catalogQuerySchema = {
  type: 'object',
  required: ['storeId'],
  additionalProperties: false,
  properties: { storeId: uuid },
} as const;

export const catalogResponseSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['menuId', 'name', 'category', 'price', 'saleStatus'],
        additionalProperties: false,
        properties: {
          menuId: uuid,
          name: { type: 'string', minLength: 1 },
          category: { type: 'string', enum: ['coffee', 'tea', 'beverage', 'dessert'] },
          seasonal: { type: 'string', minLength: 1 },
          price: { type: 'integer', minimum: 1 },
          saleStatus: { type: 'string', enum: ['selling', 'sold_out'] },
        },
      },
    },
  },
} as const;

export const accessTokenResponseSchema = {
  type: 'object',
  required: ['accessToken', 'expiresIn', 'storeId'],
  additionalProperties: false,
  properties: {
    accessToken: { type: 'string', minLength: 1 },
    expiresIn: { type: 'integer', minimum: 1 },
    storeId: uuid,
  },
} as const;

export const errorResponseSchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: { type: 'string', enum: errorCodes } },
} as const;
