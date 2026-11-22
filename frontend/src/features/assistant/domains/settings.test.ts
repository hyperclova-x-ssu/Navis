// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest,
  type AgentFrameData, type AgentRequest, type AgentSettingsArgs,
} from '../../../../shared/navis-agent-schema.mjs';
import { createSessionActions, sessionGateFor } from '../../../app/session-actions';
import { getRegistry } from '../../../catalog';
import type { RunStore } from '../../../contracts';
import { selectPosClosing } from '../../../data/pos/closing';
import { createWidgetDataStore, readModel, TODAY } from '../../../data/widget-data';
import { screenPresets } from '../../../layout';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { applyAgentRunUndo } from '../agent-actions';
import { createAssistantProvider } from '../provider';

const corpusRoot = new URL('../../../../../.evidence/navis-scenarios/', import.meta.url);
const evidence = (file: string) => readFileSync(new URL(file, corpusRoot), 'utf8');
interface Scenario {
  id: string;
  utterances: string[];
  expected: {
    kind: 'navigate' | 'answer' | 'clarify' | 'refuse';
    tools: { name: string; args: Record<string, unknown> }[];
    answer_must_contain?: string[];
    ask?: string[];
  };
}
const trace = evidence('TRACE.csv').trim().split('\n').slice(1).map(line => line.split(',', 10));
const own = new Set(trace.filter(row => row[9] === 'N08').map(row => row[0]));
const corpus = JSON.parse(evidence('MERGED.json')) as Scenario[];
const scenarios = corpus.filter(s => own.has(s.id));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json')) as Partial<Record<string, { expected?: Partial<Scenario['expected']> }>>;

const frame = <K extends keyof AgentFrameData>(name: K, data: AgentFrameData[K]) => {
  expect(validateAgentFrame(name, data)).toBe(true);
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
};
function fixture(seed?: Parameters<typeof createWidgetDataStore>[0]) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  const store = createWidgetDataStore(seed, { runId: run.getState().runId, sessionGate: sessionGateFor(run) });
  expect(createSessionActions(run, store).completeOnboarding(null).ok).toBe(true);
  const requests: AgentRequest[] = [];
  let forge = false;
  const assistant = createAssistantProvider({ store, run, fetcher: async (_url, options) => {
    const request: AgentRequest = JSON.parse(String(options?.body));
    if (!validateAgentRequest(request)) return new Response(null, { status: 400 });
    requests.push(request);
    const { intent, snapshotRevision, runId, layer, page } = request;
    const panels = frame('panels', { panels: [] });
    let body = panels + frame('done', { outcome: 'reply' });
    if (intent.kind === 'command' && intent.command.startsWith('settings.set_') ||
      intent.kind === 'command' && intent.command === 'settings.reset_widget_preview') {
      body = panels + frame('action_proposal', {
        command: intent.command as keyof AgentSettingsArgs, args: forge ? { theme: 'light' } : intent.args ?? {},
        snapshotRevision, runId, layer, proposalId: 'fake-n08', tier: 'normal',
      }) + frame('done', { outcome: 'proposal' });
    } else if (intent.kind === 'command' && intent.command === 'ui.open_closing') {
      body = panels + frame('done', { outcome: 'navigate', navigation: {
        command: intent.command, args: intent.args ?? {}, snapshotRevision, runId, layer, page,
      } });
    }
    return new Response(body, { headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
  } });
  const ask = (text: string) => assistant.ask({ text, locale: run.getState().locale, signal: new AbortController().signal });
  return { run, store, assistant, requests, ask, forge: () => { forge = true; } };
}

type Fixture = ReturnType<typeof fixture>;
const prepare = (run: RunStore, id: string) => {
  if (id === 'S7-119' || id === 'S7-120') run.actions.setTheme('dark');
  if (id === 'S7-123') run.actions.setTextScale(125);
  if (id === 'S7-129') run.actions.setLocale('en');
  if (id === 'S7-135' || id === 'S7-192') run.actions.setPreviewFamily('empty');
  if (['S7-135', 'S7-141', 'S7-192'].includes(id)) run.actions.setPreviewVariant('inventory-booking', 'partial-data');
  if (id === 'S7-141') run.actions.setPreviewVariant('menu', 'no-menus');
  if (id === 'S7-144') run.actions.setClosingPreview('error');
};
const presentation = (run: RunStore) => {
  const { theme, locale, textScale, preview, detailDialogFullscreen } = run.getState();
  return { theme, locale, textScale, preview, detailDialogFullscreen };
};

function confirm({ store }: Fixture, reply: Awaited<ReturnType<Fixture['ask']>>) {
  const card = reply.proposalSession;
  expect(card?.getSnapshot().preview?.fields.length).toBeGreaterThan(0);
  if (!card) throw new Error('Missing proposal card');
  const receipt = card.confirm(store, card.getSnapshot().proposal.id, false);
  if (!receipt || typeof receipt === 'string') throw new Error('Card confirmation did not return a receipt');
  return receipt;
}

function expectSetting(run: RunStore, tool: Scenario['expected']['tools'][number]) {
  const state = run.getState(), args = tool.args;
  switch (tool.name) {
    case 'settings.set_theme': expect(state.theme).toBe(args.theme); break;
    case 'settings.set_text_scale': expect(state.textScale).toBe(args.scale); break;
    case 'settings.set_locale': expect(state.locale).toBe(args.locale); break;
    case 'settings.set_preview_family':
      expect(state.preview).toMatchObject({ family: args.family, overrides: {} });
      break;
    case 'settings.set_preview_variant':
      expect(state.preview.overrides).toHaveProperty(String(args.featureId), args.variant);
      break;
    case 'settings.reset_widget_preview':
      expect(state.preview.overrides).not.toHaveProperty(String(args.featureId));
      expect(state.preview.overrides).toHaveProperty('menu', 'no-menus');
      break;
    case 'settings.set_closing_preview': expect(state.preview.closing).toBe(args.variant); break;
    case 'settings.set_pos_preview':
      expect(state.preview).toMatchObject({ pos: args.scenario, family: 'normal' });
      break;
    case 'settings.set_detail_fullscreen': expect(state.detailDialogFullscreen).toBe(args.fullscreen); break;
    default: throw new Error(`Unrecognized settings action ${tool.name}`);
  }
}

describe('N08 representative scenario contracts', () => {
  it('loads 44 assigned cases and six downstream dependencies', () => {
    expect(scenarios).toHaveLength(44);
    expect(trace.filter(row => row[8]?.split('|').includes('N08'))).toHaveLength(50);
  });

  // D-365: S7-140 asked to preview the removed 마케팅 성과 widget's empty state; there is no such widget to preview any more.
  const retired = new Set(['S7-140']);
  it.each(scenarios.filter(s => retired.has(s.id)).flatMap(s => s.utterances.map((text, i) => [s.id, i + 1, text] as const)))('%s/%d %s no longer changes any preview', async (id, _index, text) => {
    const { run, requests, ask } = fixture();
    prepare(run, id);
    const before = presentation(run);
    const reply = await ask(text);
    expect(reply.proposalSession).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain('marketing-performance');
    expect(presentation(run)).toEqual(before);
  });

  it.each(scenarios.filter(s => !retired.has(s.id)).flatMap(s => s.utterances.map((text, i) => [s.id, i + 1, text, s] as const)))('%s/%d %s', async (id, index, text, scenario) => {
    const { run, store, assistant, requests, ask, ...fixtureMethods } = fixture();
    prepare(run, id);
    if (id === 'S7-162' || id === 'S7-167') {
      expect(store.dispatch({ type: 'closing.closeDay', date: TODAY, scenario: 'normal',
        expectedGeneration: 0, idempotencyKey: `fixture-${id}` }).ok).toBe(true);
    }
    const before = store.getSnapshot(), settings = presentation(run);
    const { kind, tools, ask: fields, answer_must_contain: copy } = { ...scenario.expected, ...overlay[id]?.expected };
    const plan = classifyNavigation(text, run.getState(), before);
    if (kind === 'navigate' && tools.some(tool => tool.name.endsWith('open_closing'))) {
      const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
      expect(plan?.command).toBe('ui.open_closing');
      if (!plan) throw new Error('No closing route');
      const prepared = prepareNavigationRequest(plan, run.getState(), navigation);
      expect(prepared).toBeDefined();
      const arrived: AgentFrameData['done'][] = [];
      await assistant.ask({ text, signal: new AbortController().signal, agentTurn: prepared!.agentTurn,
        onNavigation: action => arrived.push({ outcome: 'navigate', navigation: action }) });
      const reply = arrived[0];
      expect(reply?.outcome).toBe('navigate');
      if (reply?.outcome !== 'navigate') throw new Error('Missing closing navigation');
      const args = prepared!.resolve(reply.navigation);
      expect(await navigation.execute(reply.navigation.command, args!)).toBe('opened');
      expect(run.getState().overlay).toMatchObject({ type: 'closing', readOnly: true,
        tab: id === 'S7-160' ? 'drawer' : 'sales' });
    } else {
      expect(plan).toBeUndefined();
      const reply = await ask(text);
      expect(presentation(run)).toEqual(settings);
      if (kind === 'navigate') {
        const change = tools.at(-1)!;
        const args = change.name === 'settings.set_closing_preview' ? { scenario: change.args.variant } : change.args;
        expect(requests[0]?.intent).toMatchObject({ kind: 'command', command: change.name, args });
        const preview = reply.proposalSession?.getSnapshot().preview;
        const labels = preview && [preview.title, ...preview.fields.map(field => `${field.label} ${field.after}`)].join('\n');
        for (const word of (copy ?? []).filter(word => word !== '껐어요')) expect(labels).toContain(id === 'S7-132' && word === '시연용' ? '예시 상태 보기' : word);
        const receipt = confirm({ run, store, assistant, requests, ask, ...fixtureMethods }, reply);
        expect(receipt).toMatchObject({ frame: { outcome: 'applied' }, notice: { undo: { target: 'run' } } });
        tools.forEach(tool => expectSetting(run, tool));
      } else {
        expect(reply.proposalSession).toBeUndefined();
        if (kind === 'clarify') expect(reply.turn).toMatchObject({ kind: 'clarification', field: fields?.[0] });
        if (kind === 'refuse') {
          expect(reply.turn).toMatchObject({ kind: 'refusal', reason: 'widget_only',
            ...(tools[0]?.name === 'ui.open_closing' ? { alternative: { featureId: 'pos-closing' } } : {}),
            ...(tools[0]?.name === 'ui.switch_layer' ? { alternative: { featureId: 'pos' } } : {}),
          });
          expect(run.getState().overlay.type).toBe('none');
        }
        if (tools[0]?.name === 'get_source' || tools[0]?.name === 'get_ui_state') {
          expect(reply.turn).toMatchObject({ kind: 'read', evidence: [{ tool: tools[0].name, status: 'ready' }] });
        }
        // S7-191 combines text-size and language questions in its authored expectation.
        const expectedCopy = id === 'S7-191' ? [index === 3 ? '한국어' : '큰 글자'] : copy ?? [];
        for (const word of expectedCopy) expect(reply.answer).toContain(word);
      }
    }
    expect(store.getSnapshot()).toBe(before);
  });
});

describe('Normal widget reads with all domains registered', () => {
  it.each([
    ['재고 상태 알려줘', 'inventory-booking', 'inventory.restock.count'],
    ['오늘 재고 상태 어때', 'inventory-booking', 'inventory.outOfStock.count'],
    ['재고 일부 없어?', 'inventory-booking', 'inventory.restock.count'],
    ['메뉴 비어 있어?', 'menu', 'menu.count'],
    ['메뉴 상태 어때?', 'menu', 'menu.count'],
    ['마진 에러 났어?', 'margin', 'margin.rate'],
    ['캘린더 상태 보여줘', 'calendar', /^calendar\.(?:today|entries)\.count$/u],
    ['세무관리 상태 알려줘', 'tax', 'tax.review.count'],
    [corpus.find(s => s.id === 'S1-001')!.utterances[0], 'menu', 'menu.count'],
    [corpus.find(s => s.id === 'S2-021')!.utterances[0], 'margin', 'margin.coverage'],
    [corpus.find(s => s.id === 'S2-052')!.utterances[0], 'tax', 'tax.review.count'],
  ] as const)('reads stored facts for %s', async (text, featureId, key) => {
    const f = fixture();
    f.run.actions.setPreviewFamily('error');
    const before = f.store.getSnapshot(), preview = f.run.getState().preview;
    expect(classifyNavigation(text, f.run.getState(), before)).toBeUndefined();
    const reply = await f.ask(text);
    expect(f.requests[0]?.intent).toMatchObject({ kind: 'read', featureId });
    expect(reply.proposalSession).toBeUndefined();
    expect(reply.turn).toMatchObject({ kind: 'read', evidence: [{ tool: 'get_widget', status: 'ready',
      facts: expect.arrayContaining([expect.objectContaining({ key: typeof key === 'string' ? key : expect.stringMatching(key) })]),
    }] });
    if (featureId === 'menu') expect(reply.answer).toContain(String(readModel(before, 'menu').total));
    expect(f.run.getState().preview).toBe(preview);
    expect(f.store.getSnapshot()).toBe(before);
  });

  it('reports zero registered menus when the stored menu is empty', async () => {
    const f = fixture({ menuItem: [] });
    const reply = await f.ask('메뉴 비어 있어?');
    expect(reply.proposalSession).toBeUndefined();
    expect(reply.turn).toMatchObject({ kind: 'read', evidence: [{ tool: 'get_widget', status: 'ready',
      facts: [expect.objectContaining({ key: 'menu.count', value: 0 })],
    }] });
    expect(reply.answer).toContain('0개');
  });
});

describe('N08 card and receipt boundary', () => {
  it('previews, confirms once and restores the widget preview via its receipt', async () => {
    const f = fixture();
    const before = f.store.getSnapshot();
    expect(readModel(before, 'menu').rows.length).toBeGreaterThan(0);
    const reply = await f.ask('메뉴 패널만 비어 있음으로 해줘');
    const card = reply.proposalSession!;
    expect(card?.isPending()).toBe(true);
    await f.ask('확인');
    expect(f.run.getState().preview.overrides).toEqual({});
    const receipt = confirm(f, reply);
    expect(f.run.getState().preview.overrides).toEqual({ menu: 'no-menus' });
    expect(card.confirm(f.store, card.getSnapshot().proposal.id, false)).toBeUndefined();
    expect(f.store.getSnapshot()).toBe(before);
    expect(selectPosClosing(before, { date: TODAY, scenario: 'normal' }).totals.revenue).toBe(831220);
    f.run.actions.showNotice(receipt!.notice!);
    const token = receipt!.notice!.undo!.token;
    await f.ask('되돌려 줘');
    expect(f.run.getState().preview.overrides).toEqual({ menu: 'no-menus' });
    const reentrant: boolean[] = [];
    const stop = f.run.subscribe(() => reentrant.push(applyAgentRunUndo(f.run, f.store, token)));
    expect(applyAgentRunUndo(f.run, f.store, token)).toBe(true);
    stop();
    expect(reentrant).toEqual([false]);
    expect(f.run.getState().preview.overrides).toEqual({});
    expect(applyAgentRunUndo(f.run, f.store, token)).toBe(false);
  });

  it('refreshes a changed setting instead of applying its stale preview', async () => {
    const f = fixture();
    const reply = await f.ask('큰 글자로 해줘');
    f.run.actions.setTextScale(125);
    expect(confirm(f, reply)).toMatchObject({ frame: { outcome: 'conflict' } });
    expect(f.run.getState().textScale).toBe(125);
  });

  it('rejects a forged model proposal that differs from the typed intent', async () => {
    const f = fixture();
    f.forge();
    const reply = await f.ask('다크 모드로 바꿔줘');
    expect(reply.proposalSession).toBeUndefined();
    expect(f.run.getState().theme).toBe('light');
  });

  it.each(['다크 모드야', '지금 화면 모드가 뭐야', '어두운 화면인지 알려줘', '지금 다크야?', '라이트야?'])('reads the actual theme for %s and preserves a pending card', async text => {
    const f = fixture();
    try {
      const pending = await f.ask('큰 글자로 해줘');
      const before = f.run.getState();
      const reply = await f.ask(text);
      expect(reply.proposalSession).toBeUndefined();
      expect(reply.turn).toMatchObject({ kind: 'read', evidence: [{ tool: 'get_ui_state', facts: [
        expect.objectContaining({ key: 'ui.theme', value: 'light' }),
      ] }] });
      expect(pending.proposalSession?.isPending()).toBe(true);
      expect(f.run.getState()).toBe(before);
      expect(f.requests.at(-1)?.intent).toEqual({ kind: 'read', tool: 'get_ui_state' });
    } finally { f.run.dispose(); }
  });

  it('cancels the dark-mode proposal when the owner edits it back to the current mode', async () => {
    const f = fixture();
    const reply = await f.ask('다크 모드로 바꿔줘');
    expect(reply.proposalSession?.isPending()).toBe(true);
    expect((await f.ask('다크 모드 말고 라이트로 해줘')).answer).toContain('이미 라이트');
    expect(reply.proposalSession?.isPending()).toBe(false);
    expect(f.run.getState().theme).toBe('light');
  });

  it('uses the answer to a language question to prepare a card', async () => {
    const f = fixture();
    expect((await f.ask('중국어로 바꿔줘')).turn).toMatchObject({ kind: 'clarification', field: 'locale' });
    const reply = await f.ask('간체');
    expect(f.run.getState().locale).toBe('ko');
    expect(confirm(f, reply).frame.outcome).toBe('applied');
    expect(f.run.getState().locale).toBe('zh-Hans');
  });

  it('refuses the S7-151 shop write and offers Settings', async () => {
    const f = fixture();
    const snapshot = f.store.getSnapshot(), shop = f.run.getState().shopSettings;
    const reply = await f.ask('업종을 미용실로 바꿔줘');
    expect(reply.turn).toMatchObject({ kind: 'refusal', reason: 'widget_only', alternative: { featureId: 'settings' } });
    expect(reply.answer).toContain('업종');
    expect(reply.answer).toContain('설정');
    expect(f.run.getState().shopSettings).toBe(shop);
    expect(f.store.getSnapshot()).toBe(snapshot);
    expect(f.requests).toHaveLength(0);
  });

  it('keeps a pending payment approval out of the settings proposal path', async () => {
    const f = fixture();
    const before = f.run.getState();
    const approval = {
      status: 'pending' as const, attemptId: 'pending-test', runId: before.runId,
      meta: { runId: before.runId, idempotencyKey: 'pending-test' },
      cartId: 'test-cart', splits: [], quoteFingerprint: 'test-quote', payloadFingerprint: 'test-payload',
      closingGeneration: 0, scenario: 'normal' as const,
    };
    expect(f.run.actions.setPosUi({ ...before.posUi, approval }, before.runId)).toBe(true);
    const reply = await f.ask('결제 실패 예시로 바꿔줘');
    expect(reply.turn).toMatchObject({ kind: 'refusal', reason: 'unavailable' });
    expect(f.run.getState().preview).toBe(before.preview);
    expect(f.requests).toHaveLength(0);
  });

  it('publishes the payment example and its family together and preserves the closing example', async () => {
    const f = fixture();
    f.run.actions.setPreviewFamily('empty');
    f.run.actions.setClosingPreview('error');
    const observed: string[] = [];
    const stop = f.run.subscribe(state => observed.push(`${state.preview.family}/${state.preview.pos}/${state.preview.closing}`));
    const reply = await f.ask('결제 실패 예시로 바꿔줘');
    expect(confirm(f, reply)).toMatchObject({ frame: { outcome: 'applied' } });
    stop();
    expect(observed).toEqual(['normal/payment-failure/error']);
  });

  it('leaves normal closing amounts and status available during a display preview', async () => {
    const f = fixture();
    f.run.actions.setPreviewFamily('empty');
    const before = f.store.getSnapshot();
    const reply = await f.ask('오늘 마감했어?');
    expect(reply.turn).toMatchObject({ kind: 'read', evidence: [{ tool: 'get_source', facts: [
      expect.objectContaining({ key: 'closing.status', value: 'open' }),
    ] }] });
    expect(f.requests[0]?.catalog).toEqual([]);
    expect(f.store.getSnapshot()).toBe(before);
  });

  it('distinguishes unconfirmed drawer cash from a stored zero', async () => {
    const f = fixture();
    const { expected, actual } = selectPosClosing(f.store.getSnapshot(), { date: TODAY, scenario: 'normal' }).drawer;
    expect(actual).toBeNull();
    const reply = await f.ask('오늘 예상 현금은 얼마야?');
    expect(reply.turn).toMatchObject({ kind: 'read', evidence: [{ tool: 'get_source', status: 'ready', facts: [
      expect.objectContaining({ key: 'closing.drawer.expected', value: expected }),
      expect.objectContaining({ key: 'closing.drawer.actual', value: 'unconfirmed' }),
    ] }] });
  });

  it('reads the stored closing history summary without opening a sheet', async () => {
    const f = fixture();
    const { history } = selectPosClosing(f.store.getSnapshot(), { date: TODAY, scenario: 'normal' });
    const reply = await f.ask('정산 이력 몇 건 있어?');
    expect(reply.turn).toMatchObject({ kind: 'read', evidence: [{ tool: 'get_source', status: 'ready', facts: [
      expect.objectContaining({ key: 'closing.history.count', value: history.length }),
      expect.objectContaining({ key: 'closing.history.latestDate', value: history[0]?.businessDate }),
    ] }] });
    expect(f.run.getState().overlay.type).toBe('none');
  });
});
