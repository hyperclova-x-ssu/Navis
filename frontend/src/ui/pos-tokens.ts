import type { CSSProperties } from 'react';
import { motionTokens } from './motion';

/** R4 DS 15.2–15.4 / SCREENS R-15. Logical pixels, independent of font scale. */
export const posLayoutTokens = Object.freeze({
  common: Object.freeze({
    contentX:24, contentY:112, tabWidth:160, tabHeight:48, tabGap:8,
    contentTop:184, closedContentTop:264, columnGap:24, gridGap:16,
    menuCardHeight:200, menuPhotoHeight:104, chipHeight:56, chipMinWidth:120,
    stepperSize:56, quantityWidth:40, quantityMax:99, actionHeight:80, reasonHeight:24,
    methodHeight:136, optionMinHeight:72, bandHeight:64, payingBandHeight:48,
    badgeHeight:32, badgeRadius:16, statusHeight:28, dialogHeaderHeight:72,
    spinnerSize:32, successSize:64, successIconSize:32, methodIconSize:40,
    smallIconSize:16, optionCheckSize:20, lineMinHeight:72, lineAmountMinWidth:96,
    orderHeaderHeight:48, orderRowHeight:72, orderRowLargeHeight:88,
    orderProcessWidth:288, prepareWidth:128, completeWidth:120,
    tableInset:8, summaryCellHeight:170, summaryCellLargeHeight:198, orderNumberWidth:112, orderTimeWidth:176, tableCardPadding:20, searchClearSize:48, correctionMinWidth:240,
  }),
  A: Object.freeze({
    contentWidth:1872, contentHeight:944, bodyHeight:872, closedBodyHeight:792,
    menuAreaWidth:1336, cartWidth:512, menuCardWidth:322, menuColumns:4,
    searchWidth:400, methodWidth:261, optionWidth:208,
    dialogOptionWidth:720, dialogPayWidth:880, dialogConfirmWidth:640,
    dialogReceiptWidth:560, dialogMaxHeight:952,
    tableCellWidth:203.56, tableCellHeight:129.33, tableTileWidth:187.56, tableTileHeight:113.33,
    summaryCellWidth:298.67,
  }),
  B: Object.freeze({
    contentWidth:2512, contentHeight:1304, bodyHeight:1232, closedBodyHeight:1152,
    menuAreaWidth:1848, cartWidth:640, menuCardWidth:356.8, menuColumns:5,
    searchWidth:480, methodWidth:314.67, optionWidth:234.67,
    dialogOptionWidth:800, dialogPayWidth:1040, dialogConfirmWidth:720,
    dialogReceiptWidth:640, dialogMaxHeight:1248,
    tableCellWidth:274.67, tableCellHeight:189.33, tableTileWidth:258.67, tableTileHeight:173.33,
    // Six equal cells fill the available content width with five 16px gaps.
    summaryCellWidth:(2512 - 5 * 16) / 6,
  }),
});

/** MOTION 13.1. Approval/result scheduling belongs to the app, never the kit. */
export const posTimeTokens = Object.freeze({
  payApproveMs:1000, payDoneMs:1000, cartHighlightMs:400,
  spinnerTurnMs:800, resultScaleFrom:.8,
});

/** Public recipes for screen-local parts (DS 15.10). Use these with the existing kit. */
export const posClasses = Object.freeze({
  content:'ui-pos-content', body:'ui-pos-body', tabs:'ui-pos-tabs', tab:'ui-pos-tab',
  menuGrid:'ui-pos-menu-grid', menuCard:'ui-pos-menu-card', menuPicture:'ui-pos-menu-picture',
  menuCardBody:'ui-pos-menu-card__body', menuCardName:'ui-pos-menu-card__name', menuCardPrice:'ui-pos-menu-card__price',
  options:'ui-pos-options', option:'ui-pos-option', optionCheck:'ui-pos-option__check',
  optionPrice:'ui-pos-option__price', optionError:'ui-pos-option-error',
  cart:'ui-pos-cart', cartLines:'ui-pos-cart-lines', orderLine:'ui-pos-order-line',
  lineButton:'ui-pos-line-button', lineDetail:'ui-pos-line-detail', lineAmount:'ui-pos-line-amount',
  summary:'ui-pos-summary', summaryRow:'ui-pos-summary-row', summaryTotal:'ui-pos-summary-total',
  methods:'ui-pos-methods', method:'ui-pos-method', orderGrid:'ui-pos-order-grid',
  orderActions:'ui-pos-order-actions', prepare:'ui-pos-prepare', complete:'ui-pos-complete',
  cashRow:'ui-pos-cash-row', cashTotal:'ui-pos-cash-total', receipt:'ui-pos-receipt',
  notice:'ui-pos-notice', orderNotice:'ui-pos-notice--order',
});

/** Single adapter for JS tokens → inherited CSS variables on both canvas and portal. */
export function posCssVariables(preset:'A'|'B'):CSSProperties {
  const values = { ...posLayoutTokens.common, ...posLayoutTokens[preset] };
  const variables:Record<string,string|number> = {};
  for (const [key,value] of Object.entries(values)) {
    const suffix = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    variables[`--pos-${suffix}`] = key==='menuColumns'||key==='quantityMax'?value:`${value}px`;
  }
  for (const name of ['cartIn','cartOut','resultIn','check','posDialogIn','posDialogOut','tabContent','stateSwap','billMove'] as const) {
    variables[`--motion-duration-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`] = `${motionTokens.duration[name]}ms`;
  }
  variables['--motion-duration-spinner-turn'] = `${posTimeTokens.spinnerTurnMs}ms`;
  variables['--motion-scale-result-from'] = posTimeTokens.resultScaleFrom;
  variables['--motion-scale-overlay'] = motionTokens.scaleOverlay;
  return variables as CSSProperties;
}
