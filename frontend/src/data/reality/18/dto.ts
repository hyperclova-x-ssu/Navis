import type { ExpenseCategory } from '../../db/types';
import type { CommandReceipt, ListPage, PortFile } from '../00';

export type TaxEvidenceFile = PortFile & { readonly attachedAt: string };
export type TaxPaymentDto = {
  readonly taxPaymentId: string;
  readonly type: string;
  readonly amount: number;
  readonly dueOn: string;
  readonly paidOn: string | null;
  readonly status: 'unpaid' | 'paid';
  readonly overdue: boolean;
  readonly revision: number;
  readonly evidence: 'attached' | 'none';
  readonly evidenceFiles: readonly TaxEvidenceFile[];
};

export type TaxReviewDto = {
  readonly refType: 'expense';
  readonly refId: string;
  readonly date: string;
  readonly category: ExpenseCategory;
  readonly amount: number;
  readonly memo: string | null;
  readonly status: 'needs-check' | 'checked';
  readonly expenseRevision: number;
};

export type TaxExportPreviewDto = {
  readonly from: string;
  readonly to: string;
  readonly asOf: string;
  readonly sourceRevision: number;
  readonly preview: {
    readonly sales: { readonly total: number };
    readonly deposits: { readonly total: number };
    readonly expenses: { readonly total: number; readonly count: number; readonly evidenceRecorded: number; readonly missingEvidence: number };
    readonly reviews: { readonly needsCheck: number; readonly checked: number };
    readonly taxPayments: { readonly count: number; readonly paidTotal: number; readonly unpaidTotal: number; readonly withEvidenceFile: number };
    readonly cashReceipts: null;
    readonly rowCount: number;
  };
  readonly verification: { readonly status: 'verified' | 'mismatch' };
  readonly estimate: { readonly amount: number; readonly basisDate: string } | null;
  readonly connections: readonly { readonly source: 'sales' | 'expenses' | 'evidence'; readonly status: 'connected' | 'partial' }[];
  readonly officialLinks: { readonly hometax: string };
};

export type TaxExportFormat = 'csv' | 'xlsx';
export type TaxExportFile = Pick<PortFile, 'contentType' | 'sha256' | 'size'> & {
  readonly exportId: string;
  readonly format: TaxExportFormat;
  readonly filename: string;
  readonly contentBase64: string;
};
export type TaxExportReceipt = CommandReceipt & {
  readonly sourceRevision: number;
  readonly files: Readonly<Record<TaxExportFormat, Pick<TaxExportFile, 'filename' | 'contentType' | 'size' | 'sha256'>>>;
};

export type TaxPeriodRead = {
  readonly preview: TaxExportPreviewDto;
  readonly reviews: readonly TaxReviewDto[];
};
export type RealTaxSnapshot = {
  readonly today: string;
  readonly month: TaxPeriodRead;
  readonly last: TaxPeriodRead;
};
export type TaxPaymentsDto = ListPage<TaxPaymentDto> & { readonly today: string };
