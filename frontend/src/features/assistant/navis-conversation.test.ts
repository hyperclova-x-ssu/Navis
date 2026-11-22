// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_PRICE_CLARIFICATION, AGENT_PROTOCOL_HEADER, agentCommandPolicy, validateAgentFrame, validateAgentRequest, type AgentRequest, type AgentWireArgs } from '../../../shared/navis-agent-schema.mjs';
import { beginDashboard } from '../../app/test-session';
import { getRegistry } from '../../catalog';
import type { DataCommand } from '../../data/commands/types';
import { createSeedTables } from '../../data/db/seed';
import { addDays, TODAY } from '../../data/db/time';
import { createWidgetDataStore, readModel } from '../../data/widget-data';
import { screenPresets } from '../../layout';
import { createRunStore, setChatReceiptVisible, type ChatReceiptNoticeRequest } from '../../state';
import { timePolicy } from '../../ui/motion';
import { navisTranslator } from './messages';
import { menuAgentDomain, menuDomain } from './domains/menu';
import { layoutDomain } from './domains/layout';
import { multiDomain } from './domains/multi';
import { createDomainRegistry, type CommandAdapter, type RecordAdapter } from './domains/registry';
import { applyAgentReceiptUndo } from './agent-actions';
import { prepareConversationText, type AgentProposalPreview } from './navis-conversation';
import { createAssistantProvider } from './provider';
import { sseFrame } from './stream-fixture';
import type { AskInput, AssistantReply } from './types';

interface Scenario { readonly id: string; readonly utterances: readonly string[] }
const evidence = resolve(__dirname, '../../../../.evidence/navis-scenarios');
const trace = resolve(evidence, 'TRACE.csv');
const merged = resolve(evidence, 'MERGED.json');
const hasCorpus = existsSync(trace) && existsSync(merged);
const ids = hasCorpus ? readFileSync(trace, 'utf8').trim().split(/\r?\n/u)
  .map(line => line.split(',')).filter(parts => parts[9] === 'N02').map(parts => parts[0]) : [];
const source = new Map(hasCorpus ? (JSON.parse(readFileSync(merged, 'utf8')) as Scenario[]).map(row => [row.id, row]) : []);
const cases = ids.map(id => {
  const row = source.get(id);
  if (!row) throw new Error(`Missing corpus row ${id}`);
  return row;
});
const verified: string[] = [];
const exceptions: Readonly<Record<string, string>> = {
  'S7-172': 'The host expires and discards its board receipt. A validated inverse placement preview requires the N07 adapter.',
  'S7-178': 'The authored pending layout removal proposal requires the N07 adapter. No bare cancellation can remove the widget.',
  'S8-024': 'The authored two-menu cost comparison cannot provide verified handles until N04 adds that projection.',
  'S8-027': 'The utterances ask for yesterday, while the authored tool condition uses October 20–26. The client reprojects October 25 only.',
  'S8-031': 'The prose requires ordinal placement or a layout proposal, while expected_kind says clarification for all variants. N07 owns the layout adapter.',
  'S8-029': 'The requested inherited vanilla cost and margin require the N04 cross-widget projection.',
  'S8-056': 'The valid price variant opens the proposal required by the plan, while the row assigns a repeated clarification and no tools to every variant.',
  'S8-096': 'A grounded price-advice response needs the N04 cost and margin projection. The client cannot substitute a recommendation.',
  'S8-144': 'The isolated 昨天呢 variant has no earlier topic and asks about a different day than the authored default-today tool and amount.',
};

const menuName = '캬라멜 마키야또';
const newMenu = (name: string = menuName, price = 5500) => `${name} ${price}원 메뉴에 넣어줘`;

type TestCommand = Extract<DataCommand, { type: 'menu.setSaleStatus' | 'menu.delete' | 'menu.update' | 'staff.saveSchedule' | 'localChanges.acknowledge' }>;

/** Supplies later-domain previews only for setup. The actual data store performs and undoes the writes. */
function fixtureAdapter(command: TestCommand, featureId: CommandAdapter['featureId'], preview: AgentProposalPreview): CommandAdapter {
  const args = Object.entries(command).filter(([key]) => key !== 'type');
  const isSlot = (name: string) => ['date', 'start', 'end'].includes(name);
  return {
    command: command.type, featureId, slots: {
      ...Object.fromEntries(args.filter(([key]) => isSlot(key)).map(([key, value]) => [key, (input: unknown) => input === value])),
      ...(command.type === 'menu.update' ? { price: (input: unknown) => input === command.patch.price } : {}),
    },
    resolve(wire, slots, _snapshot, records) {
      if (!wire || typeof wire !== 'object' || args.length !== Object.keys(wire).length) return undefined;
      return args.every(([key, value]) => {
        const arg = (wire as Record<string, unknown>)[key];
        if (arg && typeof arg === 'object' && 'handle' in arg && typeof arg.handle === 'string') return records.get(arg.handle)?.id === value;
        if (arg && typeof arg === 'object' && 'slot' in arg && typeof arg.slot === 'string') return slots[arg.slot] === value;
        if (command.type === 'menu.update' && key === 'patch' && arg && typeof arg === 'object' && 'price' in arg) {
          return !!arg.price && typeof arg.price === 'object' && 'slot' in arg.price
            && arg.price.slot === 'price' && slots.price === command.patch.price && Object.keys(arg).length === 1;
        }
        return arg === value;
      }) ? command : undefined;
    },
    preflight(draft, { idempotencyKey }) {
      return draft === command ? { kind: 'ready', command: { ...command, idempotencyKey } as DataCommand, preview } : { kind: 'invalid' };
    },
    undoToken: receipt => receipt.undoToken,
  };
}

function fixture({ board = false, now = { value: 0 }, sellingTarget = 'm-americano', layer = 'management' as AskInput['layer'], realMenu = false, withLayout = false } = {}) {
  const run = board ? createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => now.value, theme: 'light' }) : undefined;
  if (run) {
    beginDashboard(run, 'cafe');
    run.actions.dismissCoach();
    run.actions.applyLayoutIntent({ type: 'restore', panels: [
      { featureId: 'briefing', column: 0, row: 0, width: 2, height: 2 },
      { featureId: 'ledger', column: 2, row: 0, width: 2, height: 1 },
      { featureId: 'margin', column: 2, row: 1, width: 2, height: 1 },
      { featureId: 'calendar', column: 4, row: 0, width: 2, height: 2 },
      { featureId: 'inventory-booking', column: 0, row: 2, width: 2, height: 1 },
      { featureId: 'menu', column: 2, row: 2, width: 2, height: 1 },
    ] });
  }
  const options = run ? { runId: run.getState().runId, pos: run.getState().pos } : {};
  const tables = createSeedTables();
  const seeded = tables.menuItem;
  // Keep authored name-based cases reproducible even as the dashboard sample catalog changes.
  const authored = [
    { menuId: 'm-americano', name: '아메리카노', price: 4500 },
    { menuId: 'm-latte', name: '카페라테', price: 5000 },
    { menuId: 'm-vanilla', name: '바닐라라테', price: 5500 },
  ];
  const template = seeded.find(row => row.kind === 'menu' && !row.deletedAt) ?? seeded[0];
  const menuItems = authored.map(({ menuId, name, price }) => ({
    ...(seeded.find(row => row.menuId === menuId) ?? template), menuId, name: { raw: name }, price, deletedAt: undefined,
    saleStatus: 'selling' as const, category: 'drink' as const, kind: 'menu' as const,
  }));
  const authoredChange = {
    changeId: 'lc-1', kind: 'opening' as const, titleKey: 'data.localChange.newCafe', whenKey: 'data.localChange.when.openingThisWeek',
    startDate: TODAY, endDate: null, distanceM: 120, sameCategory: true, sourceKey: 'data.localChange.source.public',
    updatedAt: `${TODAY}T12:00`, ackedAt: null,
  };
  const localChange = [...tables.localChange.filter(row => row.changeId !== authoredChange.changeId), authoredChange];
  const store = createWidgetDataStore({ menuItem: menuItems, localChange }, options);
  const date = store.getSnapshot().pos!.businessDate;
  const staff = store.getSnapshot().tables.staff.find(row => row.name === '박민수') ?? store.getSnapshot().tables.staff[0];
  const mark = { type: 'menu.setSaleStatus', menuId: sellingTarget, status: 'sold_out' } as const;
  const updatePrice = { type: 'menu.update', menuId: 'm-americano', patch: { price: 5000 } } as const;
  const deleteMenu = { type: 'menu.delete', menuId: 'm-americano' } as const;
  const saveShift = { type: 'staff.saveSchedule', staffId: staff.staffId, date: addDays(date, 11), kind: 'work', start: '09:00', end: '18:00' } as const;
  const markChange = { type: 'localChanges.acknowledge', changeId: 'lc-1' } as const;
  const adapters = [
    fixtureAdapter(mark, 'menu', { title: '품절 상태 변경', target: sellingTarget === 'm-latte' ? '카페라테' : '아메리카노', fields: [{ label: '판매 상태', before: '판매 중', after: '품절' }] }),
    fixtureAdapter(updatePrice, 'menu', { title: '판매가 변경', target: '아메리카노', fields: [{ label: '판매가', before: '4,500원', after: '5,000원' }] }),
    fixtureAdapter(deleteMenu, 'menu', { title: '메뉴 삭제', target: '아메리카노', fields: [{ label: '메뉴', before: '아메리카노', after: '없음' }] }),
    fixtureAdapter(saveShift, 'staff-schedule', { title: '근무 추가', target: staff.name, fields: [{ label: '근무 시간', before: '없음', after: '09:00–18:00' }] }),
    fixtureAdapter(markChange, 'local-changes', { title: '소식 확인', target: '골목 입구 새 카페', fields: [{ label: '확인 상태', before: '새 소식', after: '확인 완료' }] }),
  ];
  const records: RecordAdapter[] = [
    { kind: 'staff', search: ({ query }) => query === staff.name ? [{ handle: 'staff-choice', match: 'exact' }] : [],
      resolve: ({ query }, handle) => query === staff.name && handle === 'staff-choice' ? staff.staffId : undefined },
    { kind: 'localChange', search: ({ query }) => query === '골목 입구 새 카페' ? [{ handle: 'change-choice', match: 'exact' }] : [],
      resolve: ({ query }, handle) => query === '골목 입구 새 카페' && handle === 'change-choice' ? 'lc-1' : undefined },
  ];
  const requests: AgentRequest[] = [];
  let legacy = 0;
  const provider = createAssistantProvider({
    store, run, clock: () => now.value,
    domains: createDomainRegistry([
      realMenu ? menuAgentDomain : menuDomain,
      { commands: realMenu ? adapters.filter(adapter => adapter.featureId !== 'menu') : adapters, reads: records },
      ...(withLayout ? [layoutDomain] : []),
      multiDomain,
    ]),
    async fetcher(_url, init) {
      if (!new Headers(init?.headers).has(AGENT_PROTOCOL_HEADER)) {
        legacy++;
        return new Response(null, { status: 503 });
      }
      const request: unknown = JSON.parse(String(init?.body));
      if (!validateAgentRequest(request)) throw new Error('Invalid client request');
      requests.push(request);
      let output = sseFrame('panels', { panels: [] });
      const { intent, snapshotRevision } = request;
      if (intent.kind === 'menu.create') {
        if (request.searches.some(search => search.matches.some(match => match.match === 'exact'))) {
          output += sseFrame('done', { outcome: 'refused', refusal: { reason: 'duplicate' } });
        } else if (!request.slots.includes('price')) {
          output += sseFrame('done', { outcome: 'clarify', clarification: AGENT_PRICE_CLARIFICATION });
        } else {
          output += sseFrame('action_proposal', { command: 'menu.create', args: { name: { slot: 'name' }, category: intent.category, price: { slot: 'price' },
            ...(request.slots.includes('memo') ? { memo: { slot: 'memo' } } : {}) }, snapshotRevision });
          output += sseFrame('done', { outcome: 'proposal' });
        }
      } else if (intent.kind === 'command') {
        const args = intent.args ?? {};
        const frame = { command: intent.command, args, snapshotRevision, runId: request.runId, layer: request.layer,
          proposalId: `fixture-proposal-${requests.length}`, tier: agentCommandPolicy(intent.command, args).confirmation };
        expect(validateAgentFrame('action_proposal', frame)).toBe(true);
        output += sseFrame('action_proposal', frame);
        output += sseFrame('done', { outcome: 'proposal' });
      } else {
        output += sseFrame('done', { outcome: 'reply' });
      }
      return new Response(output, { headers: { [AGENT_PROTOCOL_HEADER]: 'agent-v1' } });
    },
  });
  const ask = (text: string, input: Partial<AskInput> = {}) => provider.ask({ text, signal: new AbortController().signal, layer, ...input });
  const seed = (text: string, command: TestCommand) => {
    const { type, ...values } = command;
    const menu = type === 'menu.setSaleStatus' || type === 'menu.delete' || type === 'menu.update';
    const kind = menu ? 'menu' : type === 'staff.saveSchedule' ? 'staff' : 'localChange';
    const name = menu ? command.menuId === 'm-latte' ? '카페라테' : '아메리카노' : kind === 'staff' ? staff.name : '골목 입구 새 카페';
    const reader = menu ? menuDomain.reads[0] : records.find(record => record.kind === kind)!;
    const [match] = reader.search({ snapshot: store.getSnapshot(), locale: 'ko', query: name, privateLookup: true });
    const slots = { name, ...(type === 'menu.update' ? { price: command.patch.price } : {}), ...Object.fromEntries(Object.entries(values).filter(([key]) => ['date', 'start', 'end'].includes(key))) };
    const args = Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, key.endsWith('Id') ? { handle: match.handle } : key === 'patch' ? { price: { slot: 'price' } } : key in slots ? { slot: key } : value])) as AgentWireArgs;
    return ask(text, { agentTurn: { intent: { kind: 'command', command: type, args }, slots, lookup: { kind, querySlot: 'name' } } });
  };
  const menu = (id = 'm-americano') => store.getSnapshot().tables.menuItem.find(row => row.menuId === id);
  const created = () => store.getSnapshot().tables.menuItem.find(row => row.name && 'raw' in row.name && row.name.raw === menuName);
  const net = () => readModel(store.getSnapshot(), 'ledger').sales.net;
  const restock = () => readModel(store.getSnapshot(), 'inventory-booking').restockCount;
  return { run, store, ask, seed, provider, now, date, net, restock, requests, get legacy() { return legacy; }, menu, created, mark, updatePrice, deleteMenu, saveShift, markChange };
}

type Fixture = ReturnType<typeof fixture>;

it('routes one automatic table assignment and declines an ongoing rule', () => {
  expect(prepareConversationText('내일 3시 한○○ 테이블 자동으로 바꿔줘').kind).toBe('text');
  expect(prepareConversationText('예약 생기면 항상 테이블 자동으로 바꿔줘').kind).toBe('automation');
  expect(prepareConversationText('메뉴에 흑임자라떼 6천 원 넣고 메모는 "カフェ, 자동으로 품절 바꾸기"로 남겨줘').kind).toBe('text');
});

it.each([
  "메뉴에 흑임자라떼 6,000원 추가하는데 메모는 '여름 한정'으로 해줘",
  '흑임자라떼 6천원 메뉴에 넣고 메모 여름 한정',
  '메뉴에 흑임자라떼 6,000원 넣어줘 (메모: 여름 한정)',
])('routes a menu addition with a memo to its card and records one undoable write (%s)', async text => {
  const host = fixture();
  const before = host.store.getSnapshot();
  const session = current(await host.ask(text));
  expect(session.getSnapshot().menu?.preview.after).toMatchObject({ name: '흑임자라떼', price: 6000, memo: '여름 한정' });
  expect(host.requests.at(-1)?.intent).toEqual({ kind: 'menu.create', category: 'beverage' });
  await host.ask('네 해줘');
  await host.ask('응 진행해줘');
  await host.ask('오늘 매출 알려줘');
  expect(host.store.getSnapshot()).toBe(before);
  expect(session.isPending()).toBe(true);
  const { id } = session.getSnapshot().proposal;
  const receipt = session.confirm(host.store, id);
  expect(receipt).toMatchObject({ frame: { outcome: 'applied' }, undoToken: expect.any(String) });
  expect(session.confirm(host.store, id)).toBeUndefined();
  expect(host.store.getSnapshot().tables.menuItem.filter(item => item.name && 'raw' in item.name && item.name.raw === '흑임자라떼'))
    .toEqual([expect.objectContaining({ price: 6000, memo: { raw: '여름 한정' } })]);
  if (!receipt || receipt === 'finishEditing' || !receipt.undoToken) throw new Error('Expected a bound undo receipt');
  expect(host.store.undo(receipt.undoToken).ok).toBe(true);
  expect(host.store.getSnapshot().tables.menuItem).toEqual(before.tables.menuItem);
});

it.each([
  '아까 그 메뉴 가격 올려줘',
  '아까 말한 메뉴 가격 좀 올려줘',
  '아까 그거 가격 올려',
])('finds the earlier verified menu after unrelated reads and asks for the price (%s)', async text => {
  const host = fixture({ realMenu: true });
  expect((await host.ask('카페라테 원가 알려줘')).turn).toMatchObject({ kind: 'read' });
  await host.ask('오늘 매출 알려줘');
  await host.ask('재고 부족한 거 알려줘');
  const before = host.store.getSnapshot();
  const reply = await host.ask(text);
  expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'price' });
  expect(reply.answer).toContain('카페라테');
  expect(reply.answer).toContain('5,000원');
  if (reply.turn?.kind !== 'clarification') throw new Error('Expected a price clarification');
  const answered = await host.ask('6천 원', { continuation: { clarificationId: reply.turn.id, value: '6천 원' } });
  const card = current(answered);
  expect(card.getSnapshot().preview).toMatchObject({ target: '카페라테', fields: [{ before: '5,000원', after: '6,000원' }] });
  await host.ask('네 해줘');
  expect(host.store.getSnapshot()).toBe(before);
  expect(pressConfirm(host, card)).toMatchObject({ frame: { outcome: 'applied' } });
  expect(host.menu('m-latte')?.price).toBe(6000);
  expect(host.menu('m-americano')?.price).toBe(4500);
});

it('asks for the menu first when no verified menu was read, then asks for its price', async () => {
  const host = fixture({ realMenu: true });
  const before = host.store.getSnapshot();
  const askName = await host.ask('아까 그 메뉴 가격 올려줘');
  expect(askName.turn).toMatchObject({ kind: 'clarification', field: 'name' });
  if (askName.turn?.kind !== 'clarification') throw new Error('Expected a menu clarification');
  expect(askName.turn.isCurrent()).toBe(true);
  const askPrice = await host.ask('카페라테', { continuation: { clarificationId: askName.turn.id, value: '카페라테' } });
  expect(askPrice.turn).toMatchObject({ kind: 'clarification', field: 'price' });
  expect(askPrice.answer).toContain('5,000원');
  expect(host.store.getSnapshot()).toBe(before);
});

it('retains run references through navigation and requires a fresh menu card', async () => {
  const host = fixture({ board: true, realMenu: true });
  const run = host.run!;
  try {
    await host.ask('카페라테 원가 알려줘');
    const text = '아메리카노 품절로 바꿔줘';
    const original = current(await host.ask(text));
    const originalId = original.getSnapshot().proposal.id;
    const before = host.store.getSnapshot();
    expect(run.actions.switchLayer('marketing')).toBe(true);
    host.provider.discardAgentTurn?.();
    expect(run.actions.switchLayer('management')).toBe(true);
    expect(original.confirm(host.store, originalId)).toBeUndefined();
    expect((await host.ask('아까 그 메뉴 가격 올려줘')).answer).toContain('카페라테');
    const fresh = current(await host.ask(text));
    expect(fresh.getSnapshot().proposal.id).not.toBe(originalId);
    expect(host.store.getSnapshot()).toBe(before);
    expect(pressConfirm(host, fresh)).toMatchObject({ frame: { outcome: 'applied' } });
    expect(host.menu()?.saleStatus).toBe('sold_out');
  } finally {
    run.dispose();
  }
});

function current(reply: AssistantReply) {
  expect(reply.proposalSession?.isPending(), reply.answer).toBe(true);
  return reply.proposalSession!;
}

function pressConfirm(host: Fixture, card: ReturnType<typeof current>) {
  const { proposal, feedback } = card.getSnapshot();
  const receipt = card.confirm(host.store, proposal.id, feedback?.requiresExtraConfirmation);
  if (typeof receipt === 'object' && receipt.notice) host.run?.actions.showNotice(receipt.notice);
  return receipt;
}

function expectRead(reply: AssistantReply, featureId: string, key?: string, value?: number) {
  expect(reply.turn?.kind).toBe('read');
  if (reply.turn?.kind !== 'read') return;
  const record = reply.turn.evidence.find(record => record.tool === 'get_widget' && record.args.featureId === featureId);
  expect(record).toBeDefined();
  if (key && record?.tool === 'get_widget') expect(record.facts).toContainEqual(expect.objectContaining({ key, value }));
}

async function prepare(row: Scenario, host: Fixture) {
  const { id } = row;
  if (['S8-036', 'S8-044', 'S8-045', 'S8-046', 'S8-047', 'S8-051', 'S8-053', 'S8-057', 'S8-060', 'S8-193'].includes(id)) {
    const draft = current(await host.seed(`${id === 'S8-060' ? '카페라테' : '아메리카노'} 품절로 바꿔줘`, host.mark));
    if (id === 'S8-057' || id === 'S8-060') {
      expect(pressConfirm(host, draft)).toMatchObject({ frame: { outcome: 'applied' } });
      if (id === 'S8-060') return current(await host.seed('아메리카노 판매가 5,000원으로 바꿔줘', host.updatePrice));
    }
    return draft;
  }
  if (['S8-038', 'S8-048'].includes(id)) return current(await host.ask(newMenu()));
  if (['S8-032', 'S8-033', 'S8-041', 'S8-056'].includes(id)) expect((await host.ask(`${menuName} 메뉴에 넣어줘`)).clarification?.isCurrent()).toBe(true);
  if (id === 'S3-198' || id === 'S4-150') {
    const card = current(await host.seed(id === 'S3-198' ? `박민수 ${host.saveShift.date} 9시부터 18시까지 근무 넣어줘` : '새 카페 확인 처리해줘',
      id === 'S3-198' ? host.saveShift : host.markChange));
    expect(pressConfirm(host, card)).toMatchObject({ frame: { outcome: 'applied' } });
  }
  if (['S7-171', 'S7-172', 'S7-175'].includes(id)) {
    expect(host.run!.actions.applyLayoutIntent({ type: 'remove', featureId: 'margin' }).status).toBe('accepted');
    if (id === 'S7-172') host.now.value = 10001;
    if (id === 'S7-175') {
      host.now.value = 3000;
      expect(pressConfirm(host, current(await host.ask(newMenu())))).toMatchObject({ frame: { outcome: 'applied' } });
    }
  }
  if (id === 'S7-176') {
    host.run!.actions.setTheme('dark');
    host.run!.actions.setTextScale(125);
    host.run!.actions.setLocale('en');
  }
  if (id === 'S8-062') {
    host.run!.actions.applyLayoutIntent({ type: 'remove', featureId: 'inventory-booking' });
    expect(host.run!.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'inventory-booking' }).status).toBe('accepted');
  }
  if (['S8-027', 'S8-049', 'S8-201'].includes(id)) await host.ask('오늘 얼마 벌었수꽈?');
  if (id === 'S8-030') await host.ask('재고 부족한 거 알려줘');
  if (id === 'S8-023') for (const query of ['카페라테 원가 알려줘', '오늘 매출 알려줘', '재고 부족한 거 알려줘']) await host.ask(query);
  if (id === 'S8-029') await host.ask('카페라테 원가와 마진율은?');
  if (id === 'S8-024') await host.ask('아메리카노랑 카페라테 원가 비교해줘');
  if (id === 'S8-031') await host.ask('재고랑 발주 같이 보여줘');
  if (id === 'S8-034') for (const query of ['오늘 우유 얼마나 썼어?', '재고 부족한 거 알려줘', '아메리카노 가격 알려줘', '메뉴 몇 개 등록돼 있어?', '오늘 얼마 벌었수꽈?']) await host.ask(query);
}

const localOnly = new Set(['S7-173', 'S7-175', 'S7-176', 'S8-023', 'S8-034', 'S8-035', 'S8-044', 'S8-045', 'S8-046', 'S8-047', 'S8-048', 'S8-049', 'S8-051', 'S8-053',
  'S8-057', 'S8-058', 'S8-060', 'S8-062', 'S8-094', 'S8-099', 'S8-143', 'S8-145', 'S8-146', 'S8-147', 'S8-148', 'S8-149']);

describe.skipIf(!hasCorpus)('N02 authored conversation scenarios (.evidence corpus)', () => {
  it('loads all 59 assigned IDs, with no duplicates', () => {
    expect(cases).toHaveLength(59);
    expect(new Set(ids).size).toBe(59);
  });

  it.each(cases)('$id exercises every authored utterance through the browser provider', async row => {
    const exception = exceptions[row.id];
    for (const original of row.utterances) {
      const host = fixture({ board: row.id.startsWith('S7-') || row.id === 'S8-062', realMenu: row.id === 'S8-023', sellingTarget: row.id === 'S8-060' ? 'm-latte' : 'm-americano', ...(row.id === 'S4-150' ? { layer: 'marketing' as const } : {}) });
      try {
        const draft = await prepare(row, host);
        const before = host.store.getSnapshot();
        const beforeBoard = host.run?.getState().boards;
        const requestCount = host.requests.length;
        const legacyCount = host.legacy;
        const input = row.id === 'S8-094' ? `${'매장 메모 '.repeat(850)}\n${original.slice(original.indexOf(')') + 1)}` : original;
        const locale = row.id === 'S8-135' || row.id === 'S7-176' ? 'en' : row.id === 'S8-144' ? 'zh-Hant' : 'ko';
        if (row.id === 'S8-188') {
          const previous = new AbortController();
          const stopped = host.ask(input, { locale, signal: previous.signal }).catch(error => error);
          previous.abort();
          expect(await stopped).toMatchObject({ name: 'AbortError' });
        }
        const reply = await host.ask(input, { locale });
        if (localOnly.has(row.id)) {
          expect(host.requests).toHaveLength(requestCount);
          expect(host.legacy).toBe(legacyCount);
        }
        expect(host.store.getSnapshot()).toBe(before);
        if (beforeBoard) expect(host.run!.getState().boards.management.revision).toBe(beforeBoard.management.revision);

        switch (row.id) {
          case 'S1-026': case 'S8-006':
            expect(reply.turn).toMatchObject({ kind: 'refusal', reason: 'duplicate' });
            expect(host.requests.at(-1)?.searches[0].matches).toContainEqual({ handle: expect.any(String), match: 'exact' });
            break;
          case 'S3-198':
            expect(host.store.getSnapshot().tables.staffSchedule.some(record => record.date === host.saveShift.date)).toBe(true);
            expect(reply.answer).toContain('알림에서 되돌리기를 눌러 주세요');
            break;
          case 'S4-150':
            expect(host.store.getSnapshot().tables.localChange.find(item => item.changeId === 'lc-1')?.ackedAt).not.toBeNull();
            expect(reply.answer).toContain('알림에서 되돌리기를 눌러 주세요');
            break;
          case 'S7-171':
            expect(host.run!.getState().panels.some(panel => panel.featureId === 'margin')).toBe(false);
            expect(reply.answer).toContain('알림에서 되돌리기를 눌러 주세요');
            break;
          case 'S7-172': expect(host.run!.getState().panels.some(panel => panel.featureId === 'margin')).toBe(false); break;
          case 'S7-173': case 'S8-058': expect(reply.answer).toContain('되돌릴 변경이 없어요'); break;
          case 'S7-175':
            expect(reply.answer).toContain('알림에서 되돌리기를 눌러 주세요');
            break;
          case 'S7-176':
            expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'setting' });
            expect(host.run!.getState()).toMatchObject({ theme: 'dark', textScale: 125, locale: 'en' });
            break;
          case 'S8-022':
            expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'name' });
            break;
          case 'S8-023':
            expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'price' });
            expect(reply.answer).toContain('카페라테');
            expect(reply.answer).toContain('5,000원');
            break;
          case 'S8-024':
            expect(reply.turn ?? reply).not.toMatchObject({ kind: 'proposal' });
            break;
          case 'S8-027':
            expect(host.requests.at(-1)?.intent).toMatchObject({ condition: { kind: 'dateRange', start: addDays(host.date, -1), end: addDays(host.date, -1) } });
            break;
          case 'S8-030': expectRead(reply, 'inventory-booking', 'inventory.restock.count', host.restock()); break;
          case 'S8-031': expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'feature' }); break;
          case 'S8-032':
            expect(current(reply).getSnapshot().menu?.preview.after).toMatchObject({ name: menuName, price: 5500 });
            break;
          case 'S8-033': expect(reply.answer).toContain('판매가'); break;
          case 'S8-034': expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'reference' }); break;
          case 'S8-035': expect(reply.answer).toContain('이전에 나눈 대화가 없어요'); break;
          case 'S8-036': case 'S8-044':
            expect(reply.turn?.kind).toMatch(/clarification|ambiguity/u);
            expect(draft?.getSnapshot().proposal.getReceipt()?.frame.outcome).toBe('cancelled');
            if (row.id === 'S8-036') expect(reply.turn).toMatchObject({ choices: [expect.objectContaining({ label: '카페라테' }), expect.objectContaining({ label: '바닐라라테' })] });
            break;
          case 'S8-038':
            expect(draft?.getSnapshot().menu?.preview.after).toMatchObject({ name: menuName, price: 5000 });
            expect(draft?.isPending()).toBe(true);
            break;
          case 'S8-041':
            expect(reply.clarification?.isCurrent()).toBe(true);
            expect(host.requests.at(-1)?.slots).toEqual(['name']);
            break;
          case 'S8-045': case 'S8-053':
            expect(reply.answer).toBe('카드에서 확인해 주세요');
            expect(draft?.isPending()).toBe(true);
            expect(pressConfirm(host, draft!)).toMatchObject({ frame: { outcome: 'applied' } });
            expect(host.menu()?.saleStatus).toBe('sold_out');
            break;
          case 'S8-046': case 'S8-051': expect(draft?.isPending()).toBe(true); break;
          case 'S8-047': case 'S8-060':
            expect(reply.localAction?.outcome).toBe('cancelled');
            expect(draft?.isPending()).toBe(false);
            if (row.id === 'S8-060') {
              expect(host.menu('m-latte')?.saleStatus).toBe('sold_out');
              expect(host.menu()?.price).toBe(4500);
            }
            break;
          case 'S8-048': expect(draft?.getSnapshot().edit).toBeDefined(); break;
          case 'S8-049': expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'action' }); break;
          case 'S8-056':
            if (input === '5,500원') expect(current(reply).getSnapshot().menu?.preview.after.price).toBe(5500);
            else expect(reply.answer).toContain('판매가는 얼마인가요?');
            break;
          case 'S8-057':
            expect(reply.answer).toContain('알림에서 되돌리기를 눌러 주세요');
            expect(host.menu()?.saleStatus).toBe('sold_out');
            break;
          case 'S8-079': case 'S8-086': expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'name' }); break;
          case 'S8-083': case 'S8-090': case 'S8-134': case 'S8-135': case 'S8-139': case 'S8-201':
            expectRead(reply, 'ledger', 'ledger.sales.net', host.net()); expect(reply.locale).toBe(locale); break;
          case 'S8-092': case 'S8-093':
            expect(current(reply).getSnapshot().menu?.preview.after).toMatchObject({ price: row.id === 'S8-092' ? 6000 : 5800 });
            break;
          case 'S8-094': expect(reply.turn).toMatchObject({ kind: 'refusal', reason: 'input_limit' }); break;
          case 'S8-099': expect(reply.turn).toMatchObject({ kind: 'refusal', reason: 'unsupported' }); break;
          case 'S8-143': expect(reply.answer).toContain('한국어'); break;
          case 'S8-145': expect(reply.answer).toBe('질문을 입력해 주세요'); break;
          case 'S8-146': case 'S8-147': case 'S8-149': expect(reply.answer).toContain('아직 답하지 못해요'); break;
          case 'S8-148': expect(reply.answer).toContain('도와드릴까요'); break;
          case 'S8-188': {
            const t = navisTranslator('ko');
            expect([t.format.money(host.net(), 'full'), t.format.money(host.net(), 'compact')].some(amount => reply.answer.includes(amount))).toBe(true);
            break;
          }
          case 'S8-193':
            expectRead(reply, /재고/u.test(input) ? 'inventory-booking' : 'ledger');
            expect(draft?.isPending()).toBe(true);
            expect(pressConfirm(host, draft!)).toMatchObject({ frame: { outcome: 'applied' } });
            expect(host.menu()?.saleStatus).toBe('sold_out');
            break;
          case 'S8-062': expect(reply.answer).toContain('되돌리기'); break;
          default:
            expect(exception).toBeTruthy();
            expect(reply.localAction?.outcome).not.toBe('applied');
        }
      } catch (error) {
        throw new Error(`${row.id} / ${JSON.stringify(original)}: ${String(error)}`, { cause: error });
      } finally { host.run?.dispose(); }
    }
    if (!exception) verified.push(row.id);
  });

  afterAll(() => {
    const deferred = cases.filter(row => exceptions[row.id]);
    console.log(`${verified.length} of 59 pass, ${deferred.length} listed exceptions with reasons`);
    for (const row of deferred) console.log(`${row.id} — ${exceptions[row.id]}`);
  });
});

it('requires two card presses for a deletion and never accepts typed confirmation', async () => {
  const host = fixture();
  const card = current(await host.seed('아메리카노를 삭제해줘', host.deleteMenu));
  const before = host.store.getSnapshot();
  expect((await host.ask('아메리카노 삭제 확인')).answer).toBe('카드에서 확인해 주세요');
  expect(card.getSnapshot().feedback).toBeUndefined();
  expect(pressConfirm(host, card)).toMatchObject({ requiresExtraConfirmation: true });
  expect(card.confirm(host.store, card.getSnapshot().proposal.id)).toMatchObject({ requiresExtraConfirmation: true });
  expect((await host.ask('응')).answer).toBe('카드에서 확인해 주세요');
  expect(host.store.getSnapshot()).toBe(before);
  expect(pressConfirm(host, card)).toMatchObject({ frame: { outcome: 'applied' } });
  expect(host.menu()?.deletedAt).toBeTruthy();
});

it('reports an expired browser-held undo receipt without touching the store', async () => {
  const host = fixture();
  expect(pressConfirm(host, current(await host.ask(newMenu())))).toMatchObject({ frame: { outcome: 'applied' } });
  host.now.value = timePolicy.undoMs;
  const snapshot = host.store.getSnapshot();
  expect((await host.ask('되돌리기')).answer).toBe('되돌리기 시간이 지났어요');
  expect(host.store.getSnapshot()).toBe(snapshot);
});

it.each([false, true])('uses the visible menu receipt and respects its expiry (expired: %s)', async expired => {
  const host = fixture({ board: true });
  const run = host.run!;
  const originalMenu = host.store.getSnapshot().tables.menuItem;
  const card = current(await host.ask(newMenu()));
  const receipt = card.confirm(host.store, card.getSnapshot().proposal.id);
  const identity = card.getSnapshot().receiptIdentity;
  if (!receipt || typeof receipt === 'string' || !receipt.notice || !receipt.undoToken || !identity) throw new Error('Expected a chat undo receipt');
  const notice: ChatReceiptNoticeRequest = { ...receipt.notice, chatReceipt: identity };
  run.actions.showNotice(notice);
  setChatReceiptVisible(run, identity, true);
  if (expired) host.now.value = timePolicy.undoMs;
  const applied = host.store.getSnapshot();
  const reply = await host.ask('방금 메뉴 추가한 거 취소해줘');
  expect(reply.answer).toBe(expired ? '되돌리기 시간이 지났어요' : '영수증의 되돌리기를 눌러 주세요');
  expect(host.store.getSnapshot()).toBe(applied);
  expect(applyAgentReceiptUndo(run, host.store, identity, receipt.undoToken)).toBe(!expired);
  expect(host.store.getSnapshot().tables.menuItem).toEqual(expired ? applied.tables.menuItem : originalMenu);
});

it('reports the expired layout card rather than redirecting typed undo to the board notice', async () => {
  const host = fixture({ board: true, withLayout: true });
  const run = host.run!;
  try {
    const card = current(await host.ask('발주랑 세무관리 둘 다 추가해줘'));
    const receipt = card.confirm(host.store, card.getSnapshot().proposal.id);
    const identity = card.getSnapshot().receiptIdentity;
    if (!receipt || typeof receipt === 'string' || !receipt.notice || !receipt.undoToken || !identity) throw new Error('Expected a layout undo receipt');
    const notice: ChatReceiptNoticeRequest = { ...receipt.notice, chatReceipt: identity };
    run.actions.showNotice(notice);
    setChatReceiptVisible(run, identity, true);
    expect((await host.ask('되돌려줘')).answer).toBe('영수증의 되돌리기를 눌러 주세요');
    host.now.value = timePolicy.undoMs - 1;
    expect(run.actions.applyLayoutIntent({ type: 'remove', featureId: 'margin' }).status).toBe('accepted');
    host.now.value += 2;
    const applied = run.getState().boards.management.pages;
    expect((await host.ask('되돌려줘')).answer).toBe('되돌리기 시간이 지났어요');
    expect(applyAgentReceiptUndo(run, host.store, identity, receipt.undoToken)).toBe(false);
    expect(run.getState().boards.management.pages).toEqual(applied);
  } finally {
    run.dispose();
  }
});

it('refuses confirmation from the replaced price preview', async () => {
  const host = fixture();
  const card = current(await host.ask(newMenu()));
  const first = card.getSnapshot().proposal.id;
  const before = host.store.getSnapshot();
  await host.ask('5,000원으로');
  expect(card.getSnapshot().proposal.id).not.toBe(first);
  expect(card.confirm(host.store, first)).toBeUndefined();
  expect(host.store.getSnapshot()).toBe(before);
  expect(pressConfirm(host, card)).toMatchObject({ frame: { outcome: 'applied' } });
  expect(host.created()?.price).toBe(5000);
});

it('keeps a price clarification across a typed read and resolves a scoped ordinal', async () => {
  const host = fixture();
  const price = await host.ask(`${menuName} 메뉴에 넣어줘`);
  await host.ask('라떼 가격?');
  const moneyQuestion = await host.ask('오늘 매출은 5,000원이야?');
  expect(moneyQuestion.proposalSession).toBeUndefined();
  expect(price.clarification?.isCurrent()).toBe(true);
  expect(current(await host.ask('5500')).getSnapshot().menu?.preview.after.price).toBe(5500);
  await host.ask('아니');
  const choices = await host.ask('라떼 가격?');
  expect(choices.turn?.kind).toBe('ambiguity');
  expect((await host.ask('두 번째 거')).answer).toContain('바닐라라테');
  const referred = await host.ask('그거 가격 알려줘');
  expect(referred.answer).toContain('바닐라라테');
  expect(referred.answer).not.toContain('카페라테');
});

it('requires a fresh name and proposal when repeating the last confirmed menu creation', async () => {
  const host = fixture();
  expect(pressConfirm(host, current(await host.ask(newMenu())))).toMatchObject({ frame: { outcome: 'applied' } });
  expect((await host.ask('똑같이 해줘')).turn).toMatchObject({ kind: 'clarification', field: 'name' });
  const repeat = current(await host.ask('흑임자 라테'));
  expect(repeat.getSnapshot().menu?.preview.after).toMatchObject({ name: '흑임자 라테', price: 5500 });
});

describe('ordered plan on the dashboard path (B23 sequencer)', () => {
  const both = '아메리카노 품절 처리하고 카페라테 가격 5,500원으로 올려줘';
  const settle = () => new Promise<void>(done => setTimeout(done, 0));
  const withFollowUps = () => {
    const follow: AssistantReply[] = [];
    return { follow, input: { onFollowUp: (reply: AssistantReply) => { follow.push(reply); } } };
  };

  it('shows step 1 of 2 with its own card and keeps every write behind its own press', async () => {
    const host = fixture({ realMenu: true });
    const before = host.store.getSnapshot();
    const { follow, input } = withFollowUps();
    const first = await host.ask(both, input);
    const card = current(first);
    expect(card.getSnapshot().proposal.command).toBe('menu.setSaleStatus');
    expect(first.answer).toContain('1/2');
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0].intent).toMatchObject({ kind: 'command', command: 'menu.setSaleStatus' });
    for (const typed of ['네 해줘', '응 진행해줘', '확인']) await host.ask(typed);
    await settle();
    expect(host.store.getSnapshot()).toBe(before);
    expect(follow).toHaveLength(0);
    expect(host.requests).toHaveLength(1);
  });

  it('advances only from the actual card receipt, reprojects from the committed revision, then asks for the second card', async () => {
    const host = fixture({ realMenu: true });
    const { follow, input } = withFollowUps();
    const card = current(await host.ask(both, input));
    expect(pressConfirm(host, card)).toMatchObject({ frame: { outcome: 'applied' } });
    await settle();
    expect(host.menu('m-americano')?.saleStatus).toBe('sold_out');
    expect(host.menu('m-latte')?.price).toBe(5000);
    expect(follow).toHaveLength(1);
    const second = current(follow[0]);
    expect(second.getSnapshot().proposal.command).toBe('menu.update');
    expect(follow[0].answer).toContain('2/2');
    expect(host.requests).toHaveLength(2);
    expect(host.requests[1].snapshotRevision).toBe(host.store.getSnapshot().revision);
    expect(host.requests[1].snapshotRevision).toBeGreaterThan(host.requests[0].snapshotRevision);
    expect(host.menu('m-latte')?.price).toBe(5000);
    expect(pressConfirm(host, second)).toMatchObject({ frame: { outcome: 'applied' } });
    await settle();
    expect(host.menu('m-latte')?.price).toBe(5500);
    expect(follow).toHaveLength(1);
    expect(host.requests).toHaveLength(2);
  });

  it.each([
    '아메리카노 품절로 하고 카페라테는 5500원으로 해줘',
    '아메리카노는 품절, 카페라테는 5,500원으로 바꿔줘',
  ])('plans the other phrasings of the same two writes (%s)', async text => {
    const host = fixture({ realMenu: true });
    const { follow, input } = withFollowUps();
    const card = current(await host.ask(text, input));
    expect(card.getSnapshot().proposal.command).toBe('menu.setSaleStatus');
    expect(pressConfirm(host, card)).toMatchObject({ frame: { outcome: 'applied' } });
    await settle();
    expect(follow).toHaveLength(1);
    expect(current(follow[0]).getSnapshot().proposal.command).toBe('menu.update');
  });

  it('does not plan a bare comma list that the owner means as one request', async () => {
    const host = fixture({ realMenu: true, withLayout: true });
    const reply = await host.ask('아메리카노, 카페라테 알려줘');
    expect(reply.answer).not.toMatch(/^1\/\d/u);
    expect(host.requests.length).toBeLessThanOrEqual(1);
  });

  it('records a cancelled step and still offers the independent step, with no write from the cancel', async () => {
    const host = fixture({ realMenu: true });
    const { follow, input } = withFollowUps();
    const card = current(await host.ask(both, input));
    const before = host.store.getSnapshot();
    expect(card.cancel()).toMatchObject({ frame: { outcome: 'cancelled' } });
    await settle();
    expect(host.store.getSnapshot()).toBe(before);
    expect(follow).toHaveLength(1);
    expect(current(follow[0]).getSnapshot().proposal.command).toBe('menu.update');
    expect(host.menu('m-americano')?.saleStatus).toBe('selling');
  });

  it('drops the remaining steps when the conversation moves on or closes, and never presses a card for the owner', async () => {
    const host = fixture({ realMenu: true });
    const { follow, input } = withFollowUps();
    const card = current(await host.ask(both, input));
    host.provider.discardAgentTurn?.();
    await settle();
    expect(card.isPending()).toBe(false);
    expect(follow).toHaveLength(0);
    expect(host.requests).toHaveLength(1);
    expect(host.menu('m-americano')?.saleStatus).toBe('selling');
  });

  it('keeps the pending step through an unrelated read', async () => {
    const host = fixture({ realMenu: true });
    const { follow, input } = withFollowUps();
    const card = current(await host.ask(both, input));
    expect((await host.ask('오늘 매출 알려줘')).turn?.kind).toBe('read');
    expect(card.isPending()).toBe(true);
    expect(pressConfirm(host, card)).toMatchObject({ frame: { outcome: 'applied' } });
    await settle();
    expect(follow).toHaveLength(1);
  });

  it('answers an ordered read list in one reply, step by step with its progress, and writes nothing', async () => {
    const host = fixture({ realMenu: true });
    const before = host.store.getSnapshot();
    const reply = await host.ask('카페라테 원가 알려주고 아메리카노 원가 알려줘');
    expect(reply.turn?.kind).toBe('read');
    expect(reply.answer).toMatch(/^1\/2 카페라테 /u);
    expect(reply.answer).toMatch(/\n2\/2 아메리카노 /u);
    expect(host.store.getSnapshot()).toBe(before);
    expect(host.requests.map(request => request.intent)).toEqual([
      { kind: 'read', recordKind: 'menu', querySlot: 'name' }, { kind: 'read', recordKind: 'menu', querySlot: 'name' },
    ]);
    expect(reply.turn?.kind === 'read' ? reply.turn.evidence.map(record => record.tool) : []).toEqual(['search_records', 'search_records']);
  });
});
