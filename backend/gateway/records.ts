type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type RecordRoute = readonly [method: Method, path: string];
const publicationPaths = ['/menu/:id/place', '/place/venue', '/items/:id/commerce-stock', '/purchase-orders/:id/supplier-message'];

export const accountRoutes: readonly RecordRoute[] = [
  ['GET', '/profile'], ['PATCH', '/profile'], ['GET', '/preferences'], ['PATCH', '/preferences'],
  ['GET', '/boards'], ['PUT', '/boards/:boardId'],
  ['POST', '/files'], ['PUT', '/files/:fileId/content'], ['POST', '/files/:fileId/complete'],
  ['GET', '/files/:fileId/content'], ['DELETE', '/files/:fileId'],
];

export const inventoryRoutes: readonly RecordRoute[] = [
  ['GET', '/menu'], ['POST', '/menu'], ['GET', '/menu/:menuId'], ['PATCH', '/menu/:menuId'], ['DELETE', '/menu/:menuId'],
  ['GET', '/menu/:menuId/options'], ['PATCH', '/menu/:menuId/options'], ['GET', '/recipes'], ['PATCH', '/recipes'],
  ['POST', '/receipts/:receiptId/undo'],
  ['GET', '/place/menu'], ['GET', '/place/venue'], ['GET', '/items/:id/commerce-stock'],
  ['GET', '/purchase-orders/:id/supplier-message'],
  ['POST', '/approvals'],
  ...publicationPaths.flatMap(path => [['POST', path + '/preview'], ['POST', path + '/confirm']] as const),
];

export const stockRoutes: readonly RecordRoute[] = [
  ['GET', '/items'], ['POST', '/items'], ['GET', '/items/:itemId'], ['PATCH', '/items/:itemId'], ['DELETE', '/items/:itemId'],
  ['GET', '/stock-movements'], ['GET', '/stock-batches'], ['POST', '/stock-batches'], ['POST', '/stock-batches/:batchId/discard'],
  ['POST', '/channel-transfers'], ['POST', '/stock/receipts/:receiptId/undo'], ['GET', '/forecasts/:targetDate/:modelVersion'],
];

export const purchaseRoutes: readonly RecordRoute[] = [
  ['GET', '/suppliers'], ['POST', '/suppliers'], ['GET', '/suppliers/:supplierId'],
  ['PATCH', '/suppliers/:supplierId'], ['DELETE', '/suppliers/:supplierId'],
  ['GET', '/purchase-items'], ['POST', '/purchase-items'], ['GET', '/purchase-items/:purchaseItemId'],
  ['PATCH', '/purchase-items/:purchaseItemId'], ['DELETE', '/purchase-items/:purchaseItemId'],
  ['GET', '/purchase-orders'], ['POST', '/purchase-orders'], ['GET', '/purchase-orders/:poId'],
  ['PATCH', '/purchase-orders/:poId'], ['POST', '/purchase-orders/:poId/cancel'],
  ['GET', '/purchase-orders/:poId/receipts'], ['POST', '/purchase-orders/:poId/receipts'],
  ['GET', '/purchasing/receipts'], ['POST', '/purchasing/receipts/:receiptId/undo'],
];

export const posRoutes: readonly RecordRoute[] = [
  ['GET', '/tables'], ['POST', '/tables'], ['GET', '/tables/:id'], ['PATCH', '/tables/:id'], ['DELETE', '/tables/:id'],
  ['GET', '/bills'], ['POST', '/bills'], ['GET', '/bills/:id'], ['POST', '/bills/:id/void'],
  ['GET', '/coupon-sales'],
  ['POST', '/bills/:id/orders'], ['POST', '/bills/:id/move'], ['POST', '/bills/:id/merge'], ['POST', '/bills/:id/split'],
  ['POST', '/bills/:id/payments'], ['POST', '/settlement-quotes'],
  ['GET', '/orders'], ['GET', '/orders/:id'], ['POST', '/orders/:id/preparation'],
  ['GET', '/payments/:id/receipt'], ['POST', '/payments/:id/reversal-quote'], ['POST', '/settlements/:id/corrections'],
  ['POST', '/receipts/:id/undo'],
  ['GET', '/naver/orders'], ['GET', '/naver/orders/:id'],
  ['POST', '/naver/orders/:id/prepare'], ['POST', '/naver/orders/:id/pickup'],
  ['GET', '/naver/npay/payments/:id'], ['GET', '/naver/npay/pay-histories/:id'], ['POST', '/naver/smartstore/order-statuses'],
];

export const financeRoutes: readonly RecordRoute[] = [
  ['GET', '/expenses'], ['POST', '/expenses'], ['GET', '/expenses/:id'], ['PATCH', '/expenses/:id'],
  ['GET', '/expense-candidates'], ['POST', '/expense-candidates/:id/confirm'], ['POST', '/finance/receipts/:id/undo'],
  ['GET', '/ledger'], ['GET', '/deposits'], ['GET', '/margins'],
  ['GET', '/closings'], ['POST', '/closings'], ['GET', '/closings/:id'],
  ['PATCH', '/closings/:id/drawer'], ['POST', '/closings/:id/reopen'],
  ['POST', '/cash-movements'], ['DELETE', '/cash-movements/:id'],
  ['GET', '/tax-payments'], ['POST', '/tax-payments'], ['GET', '/tax-payments/:id'], ['PATCH', '/tax-payments/:id'],
  ['DELETE', '/tax-payments/:id'], ['POST', '/tax-payments/:id/paid'], ['POST', '/tax-payments/:id/evidence'],
  ['DELETE', '/tax-payments/:id/evidence/:fileId'],
  ['GET', '/tax-reviews'], ['POST', '/tax-reviews/:id/check'],
  ['GET', '/tax-exports/preview'], ['GET', '/tax-exports'], ['POST', '/tax-exports'], ['GET', '/tax-exports/:id'],
  ['GET', '/tax-exports/:id/file'], ['POST', '/tax/receipts/:id/undo'],
];

export const customOrderRoutes: readonly RecordRoute[] = [
  ['GET', '/custom-templates'], ['POST', '/custom-templates'], ['POST', '/custom-templates/generate'],
  ['GET', '/custom-templates/:id'], ['PATCH', '/custom-templates/:id'], ['DELETE', '/custom-templates/:id'],
  ['POST', '/custom-receipts/receipts/:id/undo'],
  ['GET', '/custom-orders'], ['POST', '/custom-orders'], ['GET', '/custom-orders/:id'], ['PATCH', '/custom-orders/:id'],
  ['POST', '/custom-orders/:id/transitions'], ['POST', '/custom-orders/:id/settlement-quote'],
  ['POST', '/custom-orders/:id/payments'], ['POST', '/custom-orders/:id/reversal-quote'], ['POST', '/custom-orders/:id/corrections'],
  ['GET', '/custom-pickups'], ['POST', '/custom-pickups/:id/transitions'],
];

export const calendarStaffRoutes: readonly RecordRoute[] = [
  ['GET', '/staff'], ['POST', '/staff'], ['GET', '/staff/:id'], ['PATCH', '/staff/:id'], ['DELETE', '/staff/:id'],
  ['GET', '/shifts'], ['POST', '/shifts'], ['GET', '/shifts/history'], ['POST', '/shifts/handoff'],
  ['GET', '/shifts/:id'], ['PATCH', '/shifts/:id'], ['DELETE', '/shifts/:id'],
  ['GET', '/calendar/events'], ['POST', '/calendar/events'], ['GET', '/calendar/events/:id'],
  ['PATCH', '/calendar/events/:id'], ['DELETE', '/calendar/events/:id'],
  ['GET', '/calendar/projections'], ['GET', '/calendar/preferences'], ['PATCH', '/calendar/preferences'],
  ['GET', '/calendar/exports'], ['POST', '/calendar/receipts/:id/undo'], ['POST', '/staff/receipts/:id/undo'],
  ['POST', '/calendar/naver-approvals'], ['POST', '/approvals'],
  ['GET', '/calendar/events/:id/naver'], ['POST', '/calendar/events/:id/naver'],
  ['GET', '/shifts/naver-works'], ['POST', '/shifts/:id/naver-works'],
  ['PATCH', '/shifts/:id/naver-works'], ['DELETE', '/shifts/:id/naver-works'],
];

export const memberRoutes: readonly RecordRoute[] = [
  ['GET', '/customers'], ['POST', '/customers'], ['GET', '/customers/:id'], ['PATCH', '/customers/:id'],
  ['DELETE', '/customers/:id'], ['PATCH', '/customers/:id/consents'],
  ['POST', '/members/:id/notes'], ['PATCH', '/members/:id/notes/:noteId'], ['DELETE', '/members/:id/notes/:noteId'],
  ['GET', '/membership-products'], ['POST', '/membership-products'], ['GET', '/memberships'],
  ['GET', '/memberships/:id/uses'], ['POST', '/memberships/:id/uses'], ['POST', '/memberships/:id/uses/:useId/cancel'],
  ['POST', '/members/receipts/:id/undo'],
];

export const bookingRoutes: readonly RecordRoute[] = [
  ['GET', '/reservations'], ['POST', '/reservations'], ['GET', '/reservations/:id'], ['PATCH', '/reservations/:id'],
  ['POST', '/reservations/:id/transitions'], ['POST', '/reservations/:id/first-order-claim'],
  ['GET', '/reservations/export-source'], ['GET', '/reservation-suggestions'], ['GET', '/reservation-changes'],
  ['GET', '/reservation-pickups'], ['GET', '/booking-products'], ['GET', '/call-records'],
  ['POST', '/booking/receipts/:id/undo'], ['GET', '/claims/:id'],
  ['POST', '/claims/:id/reconcile'], ['POST', '/claims/:id/abort'],
];

export const memberPosRoutes: readonly RecordRoute[] = [
  ['GET', '/member-accounts'], ['GET', '/member-accounts/:id'],
  ['GET', '/member-accounts/:id/entries'], ['POST', '/member-accounts/:id/entries'],
  ['GET', '/member-funding/:id'], ['POST', '/member-funding/:id/refunds'],
  ['POST', '/bills/:id/member-quote'], ['POST', '/bills/:id/member-payments'],
];

export const insightRecordRoutes: readonly RecordRoute[] = [
  ...[
    'cameras', 'zones', 'cctv-buckets', 'table-links', 'environment-readings', 'environment-limits',
    'environment-summary', 'cctv-reviews', 'manuals-grants-briefing',
  ].map(path => ['GET', '/insight/' + path] as const),
  ...['manuals', 'manual-drafts', 'checklists', 'grant-notices', 'grant-applications'].flatMap(path => [
    ['GET', '/insight/' + path], ['GET', '/insight/' + path + '/:id'], ['GET', '/insight/' + path + '/:id/history'],
  ] as const),
  ...[
    'environment-readings', 'cctv-reviews', 'manuals', 'manuals/:id/publish', 'manual-drafts',
    'manual-drafts/:id/save', 'checklists', 'grant-notices/sync', 'grant-notices/:id/review',
    'grant-applications', 'receipts/:id/undo',
  ].map(path => ['POST', '/insight/' + path] as const),
  ...['cameras/:id/zones', 'zones/:id/table-link', 'environment-limits', 'manuals/:id', 'grant-applications/:id']
    .map(path => ['PATCH', '/insight/' + path] as const),
  ...['manuals/:id', 'manual-drafts/:id', 'grant-applications/:id'].map(path => ['DELETE', '/insight/' + path] as const),
  ['GET', '/insight/briefings'], ['POST', '/insight/briefings/:businessDay/ack'],
  ['GET', '/insight/financial-center/recommendations'], ['GET', '/insight/financial-center/recommendations/:ref'],
  ['GET', '/insight/review-insights'], ['GET', '/insight/channel-reports/search-ads'],
];

export const marketingLocalRoutes: readonly RecordRoute[] = [
  ['GET', '/community/cafe-boards'], ['GET', '/community/cafe-posts'],
  ['GET', '/local-changes'], ['GET', '/trade-area'], ['GET', '/local-trends'], ['GET', '/offers'], ['GET', '/offers/peers'],
  ['GET', '/local-trends/candidates'], ['POST', '/local-trends/candidates'], ['DELETE', '/local-trends/candidates/:id'],
  ['POST', '/local-trends/preview'],
  ['POST', '/local-changes'], ['POST', '/local-changes/:id/ack'], ['POST', '/local-changes/:id/unack'],
  ['POST', '/local-changes/receipts/:id/undo'], ['POST', '/offers'], ['POST', '/offers/:id/accept'],
  ['POST', '/offers/:id/decline'], ['POST', '/offers/:id/interest'],
];

export const marketingNoticeRoutes: readonly RecordRoute[] = [
  ['POST', '/approvals'], ['POST', '/community/cafe-posts'], ['POST', '/reviews/:id/navis-draft-preview'],
  ['GET', '/notices/:id/sms-reservation'], ['POST', '/notices/:id/cancel-sms'],
  ['GET', '/notice-recipient-groups'], ['POST', '/notice-recipient-groups'],
  ['POST', '/notice-reply-approvals'],
  ['GET', '/inquiries'], ['POST', '/inquiries'], ['GET', '/inquiries/:id'],
  ['PATCH', '/inquiries/:id/draft'], ['POST', '/inquiries/:id/attestation'],
  ['POST', '/inquiries/:id/navis-draft-preview'],
  ['POST', '/inquiries/:id/reply'], ['PATCH', '/inquiries/:id/reply'], ['DELETE', '/inquiries/:id/reply'],
  ['GET', '/notices'], ['POST', '/notices'], ['GET', '/notices/:id'], ['PATCH', '/notices/:id/draft'],
  ['POST', '/notices/:id/attestation'], ['DELETE', '/notices/:id/draft'], ['POST', '/notices/:id/send'],
  ['GET', '/notice-reply-receipts/:id'], ['POST', '/notice-reply-receipts/:id/undo'], ['DELETE', '/notices/:id/place-news'],
  ['GET', '/reviews'], ['GET', '/reviews/:id'], ['GET', '/review-statistics'], ['POST', '/reviews/:id/draft-preview'],
  ['GET', '/talktalk/consultations'], ['GET', '/talktalk/consultations/:id'], ['GET', '/talktalk/marketing/audiences'],
  ['GET', '/place/news'], ['GET', '/place/hours'],
];

export const marketingPromoRoutes: readonly RecordRoute[] = [
  ['GET', '/marketing/promo/assets'], ['POST', '/marketing/promo/assets'],
  ['GET', '/marketing/promo/drafts'], ['POST', '/marketing/promo/drafts'],
  ['PATCH', '/marketing/promo/drafts/:draftId'],
  ['POST', '/marketing/promo/drafts/:draftId/generate'], ['GET', '/marketing/promo/publications'],
  ['POST', '/marketing/promo/jobs/:jobId/attest'], ['POST', '/marketing/promo/jobs/:jobId/place-news'],
  ['POST', '/marketing/promo/jobs/:jobId/clip'], ['POST', '/marketing/promo/jobs/:jobId/reels'],
  ['POST', '/marketing/promo/jobs/:jobId/shorts'],
  ['GET', '/promo/jobs/:jobId'], ['GET', '/promo/jobs/:jobId/video.mp4'],
];

export const marketingCouponRoutes: readonly RecordRoute[] = [
  ['GET', '/coupons'], ['GET', '/coupons/usage'], ['GET', '/coupons/:id'], ['POST', '/coupons/slot'], ['POST', '/coupons/expiry'],
  ['PATCH', '/coupons/:id'], ['POST', '/coupons/:id/pause'], ['POST', '/coupons/:id/resume'], ['POST', '/coupons/:id/extend'],
  ['POST', '/coupons/:id/end'], ['POST', '/coupons/:id/notify-ending'], ['POST', '/coupons/receipts/:id/undo'],
  ['POST', '/coupon-codes/:id/mark-posted'], ['POST', '/coupon-codes/:id/unpublish'],
  ['POST', '/coupon-redemptions/quote'], ['POST', '/coupon-redemptions'], ['GET', '/coupon-redemptions'],
  ['GET', '/coupon-redemptions/:id'], ['POST', '/coupon-redemptions/:id/reconcile'], ['POST', '/coupon-redemptions/:id/release'],
  ['POST', '/naver-coupon-approvals'], ['GET', '/naver-coupons'], ['GET', '/naver-coupons/place/:ref/issues'], ['POST', '/naver-coupons/place'],
  ['DELETE', '/naver-coupons/place/:ref'], ['PATCH', '/naver-coupons/issues/:ref/usage'], ['POST', '/naver-coupons/promotions'],
  ['POST', '/naver-coupons/promotions/:ref/extend'], ['POST', '/naver-coupons/promotions/:ref/end'],
];

export const marketingGroupRoutes: readonly RecordRoute[] = [
  ['GET', '/groups'], ['GET', '/groups/:groupId/customers'], ['POST', '/groups/:groupId/reach-out-check'],
  ['GET', '/performance'], ['GET', '/channel-reports'], ['GET', '/recommendations'],
];

export const uploadTypes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
export const maxUploadBytes = 4 * 1024 * 1024;
