import type { PosCatalogItem } from '../../../frontend/src/contracts/pos.ts';

export type CatalogItem = Pick<PosCatalogItem, 'menuId' | 'name' | 'price' | 'saleStatus'> & {
  readonly category: 'drink' | 'dessert';
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
  'INVALID_REQUEST', 'UNAUTHENTICATED', 'TOKEN_EXPIRED', 'STORE_FORBIDDEN', 'SERVICE_UNAVAILABLE',
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
          category: { type: 'string', enum: ['drink', 'dessert'] },
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
