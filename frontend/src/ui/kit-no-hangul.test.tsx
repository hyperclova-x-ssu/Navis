// T-062: every kit component that shows text must be Hangul-free under en, zh-Hans and zh-Hant (D-55).
// Data-provided content (labels, names, captions) is English here, so any Hangul found is the kit's own text.
import './test-setup';
import '@testing-library/jest-dom/vitest';
import { createRef, useState, type ReactElement } from 'react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from './test-utils';
import {
  ActionButton, BusinessCard, FunctionRailItem, FunctionRow, SearchField, ResizeAxisControl, CellMoveControl, ResizeHandle, RemoveButton, EditToolbar, ModeControl, ThemeTabs, LargeTextControl,
  FeaturePanel, DeltaBadge, Metric, MiniChart, DropPreview, InlineEmpty, Loading, InlineError, SkipLink, FunctionDrawer, DetailDialog, BriefingCard, NoticeFrame, NoticeHost,
  CoachMark, WidgetCoach, CoachFooter, PanelToolsPopover, PageBar, EdgeZoneBand, HelpButton, ListSelectRow, LanguageSelectRow, LanguageSelect, ExampleStateRow, ExampleStateSelect, ExampleStateChip,
  IntegrationBadge, StatusBadge, SplitBar, DetailTabs, ChipChoice, SegmentedControl, TextField, NumberField, Textarea, DateStepper, TimeChips, QuantityStepper, ChecklistRow, ChecklistProgress,
  InlineForm, DraftCard, ChannelTransfer, MasterDetail, PanelAction, PanelState, MetricFit, DiscountSlider, DiscountSummary, BenefitCards, RecipientList, SmsPreview, SendTimePicker, ConfirmStep,
  CopyThenPosted, UsageBar, RateBar, FormulaRow, InsightCard, StepProgress, VideoPlayer, SceneList, ContentRecovery,
  Checkbox, RadioGroup, DateField, TimeField, StatusChip,
} from './index';
import type { Locale, Notice, Panel } from '../contracts';

afterEach(() => { cleanup(); });
const noop = () => {};
const anchor = createRef<HTMLElement>();
const panel: Panel = { featureId: 'ledger', row: 0, column: 0, width: 2, height: 1 } as Panel;
const notice = (messageKey: string, extra: Partial<Notice> = {}): Notice => ({ id: `n-${messageKey}`, kind: 'success', messageKey, expiresAt: Infinity, ...extra });
const scenes = [{ id: 's1', start: 0, end: 3, caption: 'Hello' }, { id: 's2', start: 3, end: 6, caption: 'World' }];
const people = [{ id: 'a', name: 'Kim ○○', consent: true }, { id: 'b', name: 'Lee Mina', consent: false }];

const cases: readonly (readonly [string, () => ReactElement])[] = [
  ['BusinessCard (all types)', () => <>{(['cafe', 'restaurant', 'pub', 'beauty', 'retail', 'academy', 'fitness', 'other'] as const).map((b) => <BusinessCard key={b} businessType={b} selected />)}</>],
  ['FunctionRailItem', () => <FunctionRailItem label="Money" icon="money" />],
  ['FunctionRow placed', () => <FunctionRow label="Ledger" icon="ledger" placed />],
  ['SearchField with value', () => <SearchField value="x" onValueChange={noop} />],
  ['ResizeAxisControl', () => <ResizeAxisControl width={1} height={1} onChange={noop} />],
  ['CellMoveControl', () => <CellMoveControl onMove={noop} />],
  ['ResizeHandle', () => <ResizeHandle label="Ledger" width={2} height={1} />],
  ['RemoveButton', () => <RemoveButton label="Ledger" />],
  ['EditToolbar', () => <EditToolbar onDone={noop} />],
  ['ModeControl', () => <><ModeControl theme="light" onChange={noop} /><ModeControl theme="dark" onChange={noop} /></>],
  ['ThemeTabs', () => <ThemeTabs value="light" onChange={noop} />],
  ['LargeTextControl', () => <LargeTextControl checked={false} onChange={noop} />],
  ['FeaturePanel fallback names', () => <><FeaturePanel featureId="ledger" label="Ledger" groupId="money" width={1} height={1} /><FeaturePanel featureId="ledger" label="Ledger" groupId="money" width={1} height={1} editing /><FeaturePanel featureId="ledger" label="Ledger" groupId="money" width={1} height={1} row={1} column={1} summary="Fine" onHelp={noop} /></>],
  ['DeltaBadge default', () => <DeltaBadge />],
  ['Metric number', () => <Metric data={{ label: 'Sales', value: 1234.5, deltaDirection: 'flat' } as never} />],
  ['MiniChart', () => <><MiniChart data={{ axisLabels: ['a', 'b'], series: [{ name: 'S', unit: '', values: [1, Number.NaN] }] } as never} /><MiniChart data={{ axisLabels: [], series: [{ name: 'S', unit: '', values: [] }] } as never} /></>],
  ['DropPreview (all statuses)', () => <>{(['pending', 'accepted', 'unchanged', 'rejected'] as const).map((s) => <DropPreview key={s} panel={panel} status={s} displacedCount={2} pendingLong />)}</>],
  ['InlineEmpty / Loading / InlineError / SkipLink', () => <><InlineEmpty title="Empty" /><Loading /><InlineError onRetry={noop} /><SkipLink /></>],
  ['FunctionDrawer', () => <FunctionDrawer open title="Money" search={<SearchField value="" onValueChange={noop} />} resultCount={3} onClose={noop}><FunctionRow label="Ledger" icon="ledger" /></FunctionDrawer>],
  ['DetailDialog', () => <DetailDialog open title="Detail" onClose={noop}>Body</DetailDialog>],
  ['BriefingCard defaults', () => <BriefingCard open onClose={noop}>Body</BriefingCard>],
  ['NoticeFrame layout keys', () => <>{['add', 'remove', 'starter-add', 'undo-complete', 'edit-complete', 'NO_CAPACITY', 'OUTSIDE_GRID', 'DUPLICATE', 'UNDO_UNAVAILABLE', 'move-page', 'page-limit', 'unknown-key'].map((k) => <NoticeFrame key={k} notice={notice(k, { undoToken: 'u' })} featureLabel="Ledger" onUndo={noop} />)}<NoticeFrame notice={notice('move', { panel, displacedCount: 2 })} featureLabel="Ledger" /></>],
  ['NoticeFrame AI result', () => <NoticeFrame notice={notice('add')} featureLabel="Ledger" aiResult={{ added: 1, other: 2, onView: noop }} />],
  ['NoticeFrame data undo', () => <NoticeFrame notice={notice('data.done', { undo: { target: 'data', token: 't' } })} onDataUndo={noop} />],
  ['NoticeHost', () => <NoticeHost notice={notice('add')} featureLabel="Ledger" />],
  ['CoachMark / WidgetCoach / CoachFooter', () => <><CoachMark open anchorRef={anchor} onClose={noop}>Tip</CoachMark><WidgetCoach open anchorRef={anchor} onClose={noop} title="Ledger" queue={{ current: 1, total: 3, onSkipAll: noop }}>Shows money</WidgetCoach><CoachFooter current={1} total={2} onSkipAll={noop} /></>],
  ['PanelToolsPopover', () => <PanelToolsPopover open label="Ledger" anchorRef={anchor} width={1} height={1} onChange={noop} onClose={noop} onMove={noop} />],
  ['PageBar / EdgeZoneBand / HelpButton', () => <><PageBar total={3} current={0} onSelect={noop} onAdd={noop} /><PageBar total={1} current={0} onSelect={noop} onAdd={noop} /><EdgeZoneBand side="right" targetPage={2} visible /><HelpButton name="Ledger" onPress={noop} /></>],
  ['Settings rows and subviews', () => <><LanguageSelectRow locale="en" onPress={noop} /><ExampleStateRow family="normal" onPress={noop} /><ListSelectRow label="Language" value="English" onPress={noop} /><LanguageSelect locale="en" onChange={noop} onBack={noop} onClose={noop} /><ExampleStateSelect family="error" onChange={noop} onBack={noop} onClose={noop} /><ExampleStateChip state="Error" onPress={noop} /></>],
  ['Badges', () => <><IntegrationBadge label="Calendar" /><StatusBadge kind="needsReview" /><StatusBadge kind="endingSoon" /><StatusBadge kind="recommended" /><SplitBar a={{ label: 'A', value: 1, display: '1' }} b={{ label: 'B', value: 2, display: '2' }} /></>],
  ['Forms', () => <><DetailTabs value="a" onValueChange={noop} label="Tabs" tabs={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] as never} /><ChipChoice value="a" onChange={noop} label="Chips" options={[{ value: 'a', label: 'A' }] as never} /><SegmentedControl value="a" onChange={noop} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] as never} label="Seg" /><TextField label="Memo" value="" onValueChange={noop} required error="Bad" /><NumberField label="Amount" value={null} onValueChange={noop} /><Textarea label="Body" value="" onValueChange={noop} /></>],
  ['Steppers / checklist', () => <><DateStepper text="Mon" onPrevious={noop} onNext={noop} previousDisabled={false} /><TimeChips times={['14:00']} value="14:00" onChange={noop} /><QuantityStepper label="Qty" value={0} min={0} max={5} unit="L" onChange={noop} /><ChecklistRow checked={false} onCheckedChange={noop}>Receipt</ChecklistRow><ChecklistProgress done={1} total={2} /></>],
  ['InlineForm / DraftCard / ChannelTransfer / MasterDetail', () => <><InlineForm title="Add" onSave={noop} onClose={noop}><span>Field</span></InlineForm><DraftCard text="Draft" /><ChannelTransfer store={3} online={5} unit="pcs" onTransfer={noop} /><MasterDetail list={<p>List</p>} detail={<p>Detail</p>} /></>],
  ['PanelAction / PanelState / MetricFit', () => <><PanelAction label="Send" widgetName="Coupon" onPress={noop} /><PanelState tone="error" message="Failed" action={{ label: 'Retry', widgetName: 'Ledger', onPress: noop }} /><MetricFit value="1,200" unit="won" /></>],
  ['Marketing kit', () => <><DiscountSlider value={30} onChange={noop} max={65} recommended={20} profitText="$1" /><DiscountSummary price="$2" profit="$1" total="$20" lossCost="$12" fixedSet /><BenefitCards value="a" onChange={noop} options={[{ value: 'a', name: 'Free shot', detail: '$1', recommended: true, diff: '$2 more' }]} /><RecipientList recipients={people} selected={['a']} onChange={noop} /><SmsPreview body="Hi" onBodyChange={noop} recipientCount={2} /><SendTimePicker mode="schedule" onModeChange={noop} time="14:00" onTimeChange={noop} /><ConfirmStep count={5} summary={[{ label: 'Who', value: '5' }]} onSend={noop} onCancel={noop} /><CopyThenPosted text="Post" onCopied={noop} onPosted={noop} /><UsageBar used={4} total={20} /><RateBar value={34} label="Place" /><FormulaRow><p>a = b</p></FormulaRow><InsightCard>Quiet on Tuesday</InsightCard><StepProgress steps={['One', 'Two']} current={0} onCancel={noop} title="Making" /><VideoPlayer scenes={scenes} /><SceneList scenes={[{ id: 's', rangeText: '0-3s', name: 'S', caption: 'Hello' }]} current={0} onSelect={noop} /></>],
  ['ContentRecovery', () => <ContentRecovery onRetry={noop}>ok</ContentRecovery>],
  ['Choice, date and time fields (K-C)', () => <><Checkbox checked={false} onCheckedChange={noop} label="Closed" /><RadioGroup label="To" value="a" onValueChange={noop} options={[{ value: 'a', label: 'All' }]} /><DateField label="Date" value="2026-10-26" onValueChange={noop} /><DateField label="Empty" value={null} onValueChange={noop} /><TimeField label="Time" value="09:30" onValueChange={noop} /><TimeField label="Empty time" value={null} onValueChange={noop} /></>],
  ['StatusChip and StatusBadge by meaning (K-C)', () => <><StatusChip semantic="done">Done</StatusChip><StatusChip semantic="none">Kind</StatusChip><StatusBadge semantic="recommend" label="Pick" /><StatusBadge kind="recommended" /></>],
  ['ActionButton', () => <ActionButton>Go</ActionButton>],
];

const hangul = /[ᄀ-ᇿ㄰-㆏가-힯]/u;
function hangulIn(root: HTMLElement): string[] {
  const found: string[] = [];
  // Language endonyms (한국어) carry a lang attribute and are the one intended exception.
  const clone = root.cloneNode(true) as HTMLElement; clone.querySelectorAll('[lang]').forEach((el) => el.remove());
  const text = clone.textContent ?? '';
  if (hangul.test(text)) found.push(`text: ${text.match(/.{0,12}[ᄀ-ᇿ㄰-㆏가-힯]+.{0,12}/u)?.[0]}`);
  for (const el of root.querySelectorAll('*')) for (const attr of ['aria-label', 'title', 'placeholder', 'alt', 'aria-description']) { const v = el.getAttribute(attr); if (v && hangul.test(v)) found.push(`${attr}: ${v}`); }
  return found;
}

describe.each(['en', 'zh-Hans', 'zh-Hant'] as const)('kit text has no Hangul in %s (T-062)', (locale: Locale) => {
  it.each(cases)('%s', (_name, build) => {
    renderWithKit(build(), { locale });
    expect(hangulIn(document.body)).toEqual([]);
  });
});

describe.each(['en', 'zh-Hans', 'zh-Hant'] as const)('K-C opened calendar and time list have no Hangul in %s', (locale: Locale) => {
  it('DateField popover', async () => {
    renderWithKit(<DateField label="Date" value="2026-10-26" onValueChange={noop} clearable />, { locale });
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('dialog');
    expect(hangulIn(document.body)).toEqual([]);
  });
  it('TimeField popover', async () => {
    renderWithKit(<TimeField label="Time" value="09:30" onValueChange={noop} />, { locale });
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('listbox');
    expect(hangulIn(document.body)).toEqual([]);
  });
});

describe('maskName keeps already masked names (T-062)', () => {
  it('shows "Kim ○○" unchanged and still masks a plain name', () => {
    renderWithKit(<RecipientList recipients={[{ id: 'a', name: 'Kim ○○', consent: true }, { id: 'b', name: 'Lee*', consent: true }, { id: 'c', name: 'Park', consent: true }]} selected={[]} onChange={noop} />, { locale: 'en' });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Kim ○○');
    expect(text).toContain('Lee*');
    expect(text).toContain('P○○○');
  });
});

describe('T-062 optional kit API additions', () => {
  it('NoticeFrame calls onDataUndo for a data undo and onUndo for a layout undo', () => {
    const data = vi.fn(), layout = vi.fn();
    const { unmount } = renderWithKit(<NoticeFrame notice={notice('data.done', { undo: { target: 'data', token: 'd1' } })} onUndo={layout} onDataUndo={data} />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(data).toHaveBeenCalledWith('d1'); expect(layout).not.toHaveBeenCalled();
    unmount();
    renderWithKit(<NoticeFrame notice={notice('add', { undoToken: 'l1' })} onUndo={layout} onDataUndo={data} />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(layout).toHaveBeenCalledWith('l1');
  });
  it('NoticeFrame translates data.* keys through a translator prop', () => {
    const translator = { locale: 'en', t: (k: string, p?: Record<string, unknown>) => `T:${k}:${String(p?.n)}`, has: (k: string) => k.startsWith('data.') } as never;
    renderWithKit(<NoticeFrame notice={notice('data.saved', { params: { n: 3 } })} translator={translator} />, { locale: 'en' });
    expect(screen.getByRole('status')).toHaveTextContent('T:data.saved:3');
  });
  it('InlineError retry says common.retry in Korean', () => {
    renderWithKit(<InlineError onRetry={noop} />);
    expect(screen.getByRole('button', { name: '다시 시도하기' })).toBeInTheDocument();
  });
  it('PanelAction puts id on the button', () => {
    renderWithKit(<PanelAction id="act-1" label="Send" widgetName="Coupon" onPress={noop} />, { locale: 'en' });
    expect(screen.getByRole('button', { name: 'Send, Coupon' })).toHaveAttribute('id', 'act-1');
  });
  it('PanelToolsPopover renders a pageSlot', () => {
    renderWithKit(<PanelToolsPopover open label="Ledger" anchorRef={anchor} width={1} height={1} onChange={noop} onClose={noop} onMove={noop} pageSlot={<button type="button">Send to next page</button>} />, { locale: 'en' });
    expect(screen.getByText('Send to next page')).toBeInTheDocument();
  });
  it('VideoPlayer follows currentIndex and reports scene changes', () => {
    const changed = vi.fn();
    function Host() { const [i, setI] = useState(1); return <><button type="button" onClick={() => setI(0)}>ext</button><VideoPlayer scenes={scenes} currentIndex={i} onSceneChange={(n) => { changed(n); setI(n); }} /></>; }
    renderWithKit(<Host />, { locale: 'en' });
    expect(screen.getByRole('button', { name: /Scene 2/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'ext' }));
    expect(screen.getByRole('button', { name: /Scene 1/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Scene 2/ }));
    expect(changed).toHaveBeenLastCalledWith(1);
  });
});
