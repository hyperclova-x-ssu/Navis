/** 마케팅 레이어 위젯 묶음 mkt-local (T-051): 동네 변화·상권분석·로컬 트렌드·메시지·리뷰 응대·커뮤니티. API-13 module shape. */
import type { WidgetModule } from '../../../contracts';
import { aiResponseModule } from './ai-response';
import { communityModule } from './community';
import { localChangesModule } from './local-changes';
import { localTrendsModule } from './local-trends';
import { tradeAreaModule } from './trade-area';

export const widgets: readonly WidgetModule[] = [localChangesModule, tradeAreaModule, localTrendsModule, aiResponseModule, communityModule];
export { mktLocalBundle, mktLocalReviewKeys } from './messages';
