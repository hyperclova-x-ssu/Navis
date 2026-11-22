import type { ManualCategory } from '../../db/types';
import type { GrantApplication } from '../../db/management-types';

interface RevisionDto {
  readonly id: string;
  readonly revision: number;
  readonly updatedAt: string;
}

interface DocumentFields {
  readonly section: 'handover' | 'store-info';
  readonly title: string;
  readonly category: ManualCategory;
  readonly body: string;
  readonly cautions: string;
  readonly steps: readonly { readonly body: string; readonly photoKey?: string }[];
}

export interface ManualDto extends RevisionDto, DocumentFields {
  readonly isPublished: boolean;
  readonly checklist: boolean;
  readonly checklistVersion: number;
}

export interface DraftDto extends RevisionDto, DocumentFields {
  readonly memo: string;
  readonly status: 'draft';
}

export interface ChecklistDto extends RevisionDto {
  readonly manualId: string;
  readonly manualRevision: number;
  readonly category: ManualCategory;
  readonly businessDay: string;
  readonly checkedSteps: readonly number[];
  readonly totalSteps: number;
}

export interface GrantNoticeDto extends RevisionDto {
  readonly providerId: string;
  readonly source: 'bizinfo';
  readonly sourceMode: 'fake' | 'live';
  readonly sourceUpdatedAt: string;
  readonly officialUrl: string;
  readonly title: string;
  readonly agency: string;
  readonly summary: string;
  readonly target: string;
  readonly applicationMethod: string;
  readonly startsOn: string | null;
  readonly deadline: string | null;
  readonly tags: readonly string[];
  readonly region: string;
  readonly industry: string;
  readonly reviewStatus: 'before' | 'reviewed';
  readonly matchStatus: 'matched' | 'needs-check';
  readonly matchTier?: 'exact' | 'related';
  readonly matchReason?: string;
}

export interface GrantApplicationDto extends RevisionDto {
  readonly noticeId: string;
  readonly title: string;
  readonly source: 'owner';
  readonly appliedOn: string;
  readonly status: GrantApplication['status'];
  readonly receiptNumber: string | null;
  readonly resultMemo: string | null;
}

export interface ManualsGrantsBriefingDto {
  readonly businessDay: string;
  readonly asOf: string;
  readonly sourceRevision: number;
  readonly openingChecked: number;
  readonly openingSteps: number;
  readonly upcomingGrantDeadlines: number;
}
