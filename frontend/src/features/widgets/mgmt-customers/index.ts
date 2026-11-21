/** API-201: CCTV 현황 · 회원목록 · 예약. Independent demand/membership panels are removed. */
import type { WidgetModule } from '../../../contracts';
import { CustomerAnalysisDetail, CustomerAnalysisPanel, useCustomerAnalysisSummary } from './customer-analysis';
import { MembersDetail, MembersPanel, useMembersSummary } from './members';
import { VoiceBookingDetail, VoiceBookingPanel, useVoiceBookingSummary } from './voice-booking';
import { customersBundle } from './messages';
import { cctvBundle } from '../../cctv';

export const widgets: readonly WidgetModule[] = Object.freeze([
  { id: 'customer-analysis', Panel: CustomerAnalysisPanel, Detail: CustomerAnalysisDetail, useSummary: useCustomerAnalysisSummary },
  { id: 'members', Panel: MembersPanel, Detail: MembersDetail, useSummary: useMembersSummary },
  { id: 'voice-booking', Panel: VoiceBookingPanel, Detail: VoiceBookingDetail, useSummary: useVoiceBookingSummary },
]);

/** This bundle's own message bundle (prefix `widget.{id}.*` except title / coach / aliases). */
export const bundles = [customersBundle, cctvBundle] as const;
export { customersBundle };
export { r2Review } from './messages';
