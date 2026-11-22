import type { MenuItem, Venue } from '../../../../packages/naver/contracts/pn01/wire.ts';

export type PublicationPreview<T> = {
  previewId: string;
  expectedRevision: number;
  inputHash: string;
  diff: T;
  expiresAt: string;
};
export type PublicationConfirm = { approvalId: string; expectedRevision: number; previewId: string };

export type PlaceMenuInput = { currentName?: string };
export type PlaceMenuPreview = {
  revision: number;
  current: MenuItem | null;
  desired: MenuItem;
  patch: Partial<MenuItem>;
};

export type PlaceVenueInput = Partial<Venue>;
export type PlaceVenuePreview = { current: Venue; patch: PlaceVenueInput };
