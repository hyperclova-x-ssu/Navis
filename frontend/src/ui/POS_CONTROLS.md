# T-240 public POS kit contract

Sources: DESIGN_SYSTEM §15, MOTION §13, SCREENS §13.2/13.4/13.5,
TASKS §15.3 T-240. Import the exports below from `src/ui`; `UiProvider`
installs the preset variables and `pos.css` on the canvas and its portal.
Do not copy these rules into feature CSS.

## Components and props

| Export | Props |
| --- | --- |
| `CountBadge` | `count:number`, `tone?:'cart'|'neutral'|'missing'` (default neutral), span attributes. The parent supplies the combined accessible card/tab name; this badge is not a live region. |
| `PosStatusChip` | Existing `StatusChip` props: `children`, `tone?:'neutral'|'success'|'warning'|'danger'`, `compact?:boolean`. POS size is applied by the wrapper. |
| `CategoryChips<V>` | `value:V`, `onChange(V)`, `options:readonly ChoiceItem<V>[]` (`value`, `label`, optional `disabled`), `label?`. Reuses `ChipChoice` radio navigation. |
| `PosSearchField` | Existing `SearchFieldProps`: `value`, `onValueChange(string)`, `label?`, `inputRef?`, input attributes. POS uses a hidden label and a Korean clear name. |
| `PosQuantityStepper` | `value:number`, `name:string`, `onChange(number)`, `removeOnly?`, `disabledReason?`, `onBlocked?(reason)`, `tabIndex?:number` (applies to both buttons for cart roving navigation). At 1, minus emits 0. At 99, plus is disabled with a description. Removed-menu minus emits 0 regardless of quantity. No quote/price calculation. |
| `PosActionButton` | Existing button attributes including `ref`, `variant?`, `disabled?`, and `children`; plus `onAction():void`, `reason?`, `busy?`, `busyLabel?`, `onBlocked?(reason)`. Does not accept `onClick`/`loading`. Dispatch synchronously and set controlled busy state in that event. A ref blocks repeated activation before React commits. Reasons stay focusable and call `onBlocked`, which should show the existing common Notice. |
| `PosDialog` | Existing `DetailDialogProps` including `open`, `title`, `children`, `onClose(reason,event?)`, `returnFocusRef?`, `initialFocusRef?`, `footer?`, `headerAction?`, `popupRef?`, `popupStyle?`, `description?`, `closeLabel?`; plus `kind?:'option'|'pay'|'confirm'|'receipt'`, `busy?`, `busyReason?`. Description is an accessible description; render visible amount/content in the body. Confirm uses alertdialog and defaults focus to safe close; options/payment should supply their first-choice ref. `busy` blocks close, Escape and outside press and describes why close is unavailable. It retains the existing notice slot and Base UI trap. Keep the component mounted and control `open` for the 160ms exit; exiting content is inert. |
| `Spinner` | No props. Decorative 32px arc; render only while waiting, next to a visible sentence. Reduced motion keeps the arc static. |
| `ResultPanel` | `title`, `description?:ReactNode`, `children?`, `onInteract?():void`. Focuses its heading on entry. Its automatic focus does not pause the app timer; later focus/pointer/keyboard interaction calls `onInteract`. The app handles the one completion toast announcement. |
| `ErrorPanel` | `title`, `description?:ReactNode`, `actions?:ReactNode`. Focuses its heading and exposes one alert. Supply existing ActionButtons; the recipe makes them 56px. |
| `PosMoney` | `amount:number` (safe integer won), `moneyStyle?:'full'|'compact'`, `sign?:'auto'|'plus'|'minus'`, `size?:'body'|'control'|'metric'|'display'`, span attributes. Defaults full/auto/body. The unit stays the same size as the number. Pass `aria-live='polite'` only on the final amount slot. |
| `CorrectionConfirmation` | `PosDialog` props except kind/title/busy/footer, plus `operation:'cancel'|'refund'`, `amount:number`, `methodLabel?`, `phase:'ready'|'busy'|'done'|'error'`, `error?`, `reason?`, `onConfirm():void`, `onInteract?`, `effects?:ReactNode`. `children` holds scope/item selectors; the quote amount and effects follow. Busy/done/error stay at the action position; busy locks all dismissal paths. No business scheduler, reversal calculation or undo. Zero disables confirmation. |
| `CashDrawerInput` | `value:number|null`, `onValueChange(number|null)`, `closed?`, `error?`. Uses the existing labeled TextField/number-field visual treatment with numeric keypad. Keeps invalid text as an editing draft, displays the approved error, and does not send negative/fractional/text/unsafe values to the money command. Empty emits null. Closed disables input and explains why. |
| `CashDrawerCalc` | `rows:readonly CashDrawerRow[]`, `expected:number`, `actual:number|null`, `difference:number|null`, `onActualChange(number|null)`, `closed?`, `error?`, `memo?`, `onMemoChange?`. Each row is `{id,label,amount,sign?,note?,action?:{label,onPress}}`. All totals/differences come from the selector; nothing is summed here. Closed disables row actions, actual input and memo. |
| `DiffLine` | `difference:number|null`. Null is empty; zero/surplus/shortage use text plus check/info/warning with a polite atomic update. Receives, rather than calculates, the difference. |

Exported prop/data types: `CountBadgeProps`, `CategoryChipsProps<V>`,
`PosQuantityStepperProps`, `PosActionButtonProps`, `PosDialogProps`,
`ResultPanelProps`, `ErrorPanelProps`, `PosMoneyProps`,
`CorrectionConfirmationProps`, `CashDrawerInputProps`, `CashDrawerRow`,
`CashDrawerCalcProps`, `PosMoneyFormat`. Existing `SearchFieldProps` adds
`clearLabel?`. Existing `DialogFrameProps`/`DetailDialogProps` add optional
`closeLocked`, `closeLockReason`, `initialFocusRef`, `popupClassName`,
`dialogRole`, `posMotion`, `descriptionHidden`; their defaults preserve prior behavior.
Existing `DataGridProps<Row>` adds `rowActionsLabel?:string` for a visible and
accessible processing-column heading; its absence retains the prior empty heading.

## Tokens, formatting and copy

- `posLayoutTokens.common` and `.A`/`.B`: exact logical layout/control sizes.
  All exported member names and values are in `pos-tokens.ts`; common keys are
  merged with the selected preset. `UiProvider` calls
  `posCssVariables(preset:'A'|'B'):CSSProperties` automatically. Keys become
  `--pos-<kebab-case-key>`, e.g. `cartWidth` → `--pos-cart-width`.
  `menuColumns` and `quantityMax` are unitless; size values are px.
- `posTimeTokens`: `payApproveMs=1000`, `payDoneMs=1000`,
  `cartHighlightMs=400`, `spinnerTurnMs=800`, `resultScaleFrom=.8`.
- Existing `motionTokens.duration` adds `cartIn=120`, `cartOut=120`,
  `resultIn=160`, `check=200`, `posDialogIn=200`, `posDialogOut=160`,
  `tabContent=80`, `stateSwap=120`, `billMove=220` (ms).
  `transitionFor` accepts these keys; billMove uses the existing in-out curve.
  Spinner duration remains outside this UI-transition duration map.
- CSS color aliases: `--table-reserved` (existing schedule/news color),
  `--table-busy`, `--table-busy-bg`, `--table-waiting`, `--table-waiting-bg`,
  `--table-cleaning-bg`, `--missing`, `--missing-bg`. No new hex colors.
- `formatPosMoney(won:number, options?:PosMoneyFormat):string` validates integer
  won, uses Korean grouping, shows full won by default and permits compact only
  when explicitly requested for an approved summary slot. Compact uses
  `Math.round(abs / 1000) / 10` with exactly one decimal, including `1.0만 원`.
  Negative sign is `−`; forced minus preserves `−0원`.
- `posMessages` and `posUiBundle` export Korean-only copy. Existing locales are
  unchanged. Every new component marks its content `lang='ko'`.
- `ClosingButton` and `ClosedDayState` now default to T-241's `POS_NOW_TIME`
  from `pos/clock.ts`, keeping one business clock. Historical `time` overrides
  remain supported. Other closing/domain clock migration belongs to T-242.

## Screen-local recipes (`posClasses`)

Every key maps to the named `ui-pos-*` CSS class in `pos.css`:

`content`, `body`, `tabs`, `tab`, `menuGrid`, `menuCard`, `menuPicture`,
`menuCardBody`, `menuCardName`, `menuCardPrice`, `options`, `option`,
`optionCheck`, `optionPrice`, `optionError`, `cart`, `cartLines`, `orderLine`,
`lineButton`, `lineDetail`, `lineAmount`, `summary`, `summaryRow`, `summaryTotal`,
`methods`, `method`, `orderGrid`, `orderActions`, `prepare`, `complete`,
`cashRow`, `cashTotal`, `receipt`, `notice`, `orderNotice`.

- Card/option/method/line-button/tab/prepare/complete classes attach to existing
  `ActionButton`, which retains its fixed hit surface and M-01 feedback.
  `menuCard` children: picture, body (name, price/status); CountBadge is positioned
  automatically. Use `data-added='true'` for a nonzero count, `aria-disabled`
  and a blocked-click Notice for sold-out cards. Cards remain add actions,
  rather than toggle buttons. Images need explicit dimensions/alt handling.
- `options` is the three-column group. `option` uses role radio/checkbox,
  `aria-checked`, a name, optional price and a selected `Icon` using optionCheck.
  Required selection, error descriptions and first-error focus remain in composer.
- `orderLine` uses lineButton, PosQuantityStepper and lineAmount. Caller sets
  `data-highlighted='true'` for `cartHighlightMs`, restarting the same timer on
  repeated add; `data-removing='true'` is a 120ms exit. Reduced mode removes
  lines/badges immediately. Values are replaced immediately in either mode.
- `method` uses an icon/Spinner and label inside ActionButton. Avoid its generic
  `loading` prop: retain the chosen button's focus, set `aria-busy`, render Spinner
  plus the sentence, guard clicks, and disable other methods in the screen.
- `orderGrid` wraps the existing `DataGrid`, with 48px header and 72/88px rows.
  It sets the existing `--table-action-width` to 288px; supply `rowActionsLabel`
  with the approved processing heading. Use `renderRowActions` and the `orderActions` recipe with prepare
  (128×56) and complete (120×56); do not make a new grid or side panel.
- `notice` plus `orderNotice` positions the existing shared `NoticeFrame` under
  the menu area, away from the amount and primary action. A dialog's existing
  slot takes precedence. Other POS tabs use notice without orderNotice and may
  use a panel-aware placement style computed from the available content region.

## Handoff obligations

- T-243 owns MenuCard, OptionTile, OrderLine, OrderSummaryBlock and composer
  semantics (DS 15.10). Use these recipes; do not duplicate their dimensions.
- T-244 owns approval scheduling: use the 1000/1000ms tokens, ignore stale run/
  attempt callbacks, remove Spinner on every result/disposal, guard other methods
  and tools, and keep busy changes synchronous. ResultPanel's `onInteract` pauses
  the completion timer permanently until explicit close.
- T-244/T-248: `CommonNotice` currently finds only `[role='dialog']` slots.
  Include `[role='alertdialog']` for correction confirmations, and ignore inert
  exiting dialogs. Add the POS notice class to the single existing common host.
  Preserve R-17: no second toast host and no domain-token deletion when a toast
  is replaced. Existing NoticeHost already limits visible toasts to one.
- Return focus refs must target a connected, enabled control. After a payment
  empties the cart, T-244 should target the menu-grid fallback when needed.
- Table/receipt/member/split UI stays screen-local. Use existing DataGrid and
  DetailSidePanel, the exported table/color/motion tokens and Korean copy.
- API-250/DATA_MODEL 18 name photoKey but do not enumerate the eight asset IDs
  from DS 15.8. R3 should define that ID-to-illustration mapping with R4 before
  T-253. No identifiers or images were invented in T-240.

No app storage, server, payment adapter, clock scheduler or package is introduced.
