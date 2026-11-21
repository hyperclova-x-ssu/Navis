/** Public entry of the mkt-coupon folder (API-13): the four plan-2 coupon widgets and their message bundle (T-059). */
import type { WidgetModule } from '../../../contracts';
import { slotCoupon } from './slot-coupon';
import { expiryCoupon } from './expiry-coupon';
import { couponStatus } from './coupon-status';
import { customerGroups } from './customer-groups';

export const widgets: readonly WidgetModule[] = [slotCoupon, expiryCoupon, couponStatus, customerGroups];
export { mktCouponBundle, r2Review } from './messages';
