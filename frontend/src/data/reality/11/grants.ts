import { daysBetween } from '../../db/time';
import type { DataSnapshot } from '../../db/types';
import type { GrantRow, GrantsModel } from '../../models/types';
import { isOfficialNotice, isOwnerApplication } from './adapter';
import type { GrantNoticeDto } from './dto';

export type NoticeRow = GrantRow & { readonly official?: GrantNoticeDto; readonly businessDay?: string };
export type GrantsViewModel = Omit<GrantsModel, 'notices'> & { readonly notices: readonly NoticeRow[] };

function isOpen(notice: GrantNoticeDto, businessDay: string) {
  return !!notice.deadline && notice.deadline >= businessDay && (!notice.startsOn || notice.startsOn <= businessDay);
}

function openRank(row: NoticeRow) {
  return Number(Boolean(row.official && row.businessDay && isOpen(row.official, row.businessDay)));
}

export function projectOfficialGrants({ tables }: DataSnapshot, model: GrantsModel): GrantsViewModel {
  const applications = model.applications.map(row => {
    const stored = tables.grantApplication.find(application => application.applicationId === row.applicationId);
    return stored && isOwnerApplication(stored) ? { ...row, ...stored } : row;
  });
  const notices = tables.grantNotice.filter(isOfficialNotice).map((row): NoticeRow => {
    const { official, businessDay } = row;
    const reviewStatus = tables.grantReview.find(review => review.noticeId === row.noticeId)?.reviewStatus ?? 'before';
    const daysLeft = official.deadline ? daysBetween(businessDay, official.deadline) : 0;
    const isCandidate = isOpen(official, businessDay) &&
      reviewStatus === 'before' && !applications.some(application => application.noticeId === row.noticeId);
    return { ...row, applyEndDate: official.deadline ?? '', applyEndTime: '', reviewStatus, daysLeft, isCandidate };
  }).sort((a, b) => openRank(b) - openRank(a) ||
      Number(b.official?.matchTier === 'exact') - Number(a.official?.matchTier === 'exact') ||
      Number(!a.applyEndDate) - Number(!b.applyEndDate) ||
      a.applyEndDate.localeCompare(b.applyEndDate) || a.noticeId.localeCompare(b.noticeId));
  return { ...model, notices, applications, candidateCount: notices.filter(row => row.isCandidate).length };
}
