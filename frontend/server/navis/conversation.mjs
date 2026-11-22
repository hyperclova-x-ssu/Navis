import { randomUUID } from 'node:crypto';
import { agentCommandPolicy, agentCommandRefs } from '../../shared/navis-agent-schema.mjs';

const MAX_RUNS = 512;
const MEMORY_MS = 30 * 60_000;
const READ_MEMORY = 4;
export const AGENT_INPUT_LIMIT = 4000;

const affirmative = /^(?:응|ㅇㅇ+|ㅇㅋ|그래|좋아|해줘|네|예|맞아|고고|확인|진행해(?:줘)?|yes|ok(?:ay)?|好|是|👍)$/u;
const negative = /^(?:아니(?:요|야|다)?|아냐|ㄴㄴ|싫어|안 ?할래|하지 ?마|no|不|그만(?:둘래)?|됐어|없던 걸로|👎|취소(?:해 ?줘|할래)?|cancel|取消)$/u;
const expired = reason => ({ type: 'unavailable', reason });
const undoWords = /되돌(?:려|리)|원래대로|\bundo\b/u;
const pastWords = /방금|아까|전에|이전|그 ?전/u;

const menuAliases = new Map([
  ['아아', '아메리카노'], ['뜨아', '아메리카노'], ['아메', '아메리카노'],
  ['아이스아메리카노', '아메리카노'], ['핫아메리카노', '아메리카노'],
  ['ㅇㅁㄹㅋㄴ', '아메리카노'], ['ㅋㅍㄹㅌ', '카페라테'], ['ㅂㄴㄹㄹㅌ', '바닐라라테'],
]);
const spelling = [
  [/까페|카패|카폐/gu, '카페'],
  [/라떼|레테/gu, '라테'],
  [/크로아상|크로와상/gu, '크루아상'],
  [/캬라멜|캐러멜/gu, '카라멜'],
  [/焦糖[玛瑪]奇朵|caramel\s*macchiato/giu, '카라멜 마키아토'],
  [/마키야또|마키아또|마끼아또|마끼아토/gu, '마키아토'],
  [/아메리까노|美式[咖珈][啡非]|americano/giu, '아메리카노'],
  [/\bcroissant\b/giu, '크루아상'],
  [/가걱/gu, '가격'],
];

export function normalizeConversationAlias(text) {
  const key = text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  // Check initial consonants before compatibility normalization joins them into syllables.
  const literal = text.normalize('NFC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const alias = menuAliases.get(literal) ?? menuAliases.get(key);
  const canonical = spelling.reduce((value, [from, to]) => value.replace(from, to), key).replace(/\s+/gu, '');
  return { key: alias ?? canonical, requiresChoice: alias !== undefined && literal !== '아메' };
}

/** Normalize a local utterance before it becomes a typed, literal-free request. */
export function normalizeConversationTurn(text, { pending = false } = {}) {
  if (text.length > AGENT_INPUT_LIMIT) return { kind: 'refused', reason: 'too_long' };
  const raw = text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
  if (!raw) return { kind: 'reply', reason: 'empty' };
  if (/<\/?[a-z!][^>]*>|\b(?:drop|alter|truncate)\s+table\b|\{\{|\$\{/iu.test(raw)) return { kind: 'reply', reason: 'unsupported' };
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(raw)
    || /\b(?:pouvez|veuillez|bonjour|combien|changer|prix)\b/u.test(raw)) {
    return { kind: 'reply', reason: 'unsupported_language' };
  }
  if (/^(?:안녕(?:하세요)?|ㅎㅇ|고마워(?:요)?|수고했어(?:요)?|잘 자|😀)$/u.test(raw.replace(/[.!?]+$/u, ''))) {
    return { kind: 'reply', reason: 'greeting' };
  }
  const value = raw.replace(/^(?:ㄱㅅ|감사합니다)\s+/u, '').replace(/[.!?。！？]+$/u, '').trim();
  if (value === '확인 취소') return { kind: pending ? 'cancel' : 'undo' };
  const lead = value.split(/[\s!?,.。！？]+/u);
  if (lead.every(word => affirmative.test(word))) return { kind: 'hold' };
  const hasAffirmative = lead.some(word => word !== '해줘' && affirmative.test(word));
  const hasNegative = lead.some(word => negative.test(word));
  if (hasAffirmative && hasNegative && !/[\d가-힣](?:원|리터)|가격|이름/u.test(value)) return { kind: 'hold' };
  if (/^(?:글쎄|음+(?: 글쎄)?|괜찮나|그럴까|일단 보류|아마도|생각 좀 해볼게|몰라|ㅁㄹ|공짜|아무거나|얼마가 좋을까)(?:요)?$/u.test(value)
    || pending && /^이거\s*(?:저장|하|누르).*(?:뭐가 바뀌|어떻게 돼|반영돼)/u.test(value)) return { kind: 'hold' };

  if (/먼저|그 ?전에|그렇고|근데|아 맞다/u.test(value) || !pending) {
    const todaySales = /오늘.*(?:매출|순매출|얼마|장사)|(?:매출|순매출).*오늘|매출\s*매출|\btoday\b.*\b(?:sales|revenue|make|made)\b|\b(?:sales|revenue|make|made)\b.*\btoday\b|今天.*(?:赚|賺|营业额|營業額|销售额|銷售額)/u;
    if (todaySales.test(value) && !/바꾸지 마|취소해|되돌려/u.test(value)) return { kind: 'read', featureId: 'ledger' };
  }
  if (/오늘.*(?:매출|얼마|장사)|\b(?:sales|revenue)\b.*\btoday\b/u.test(value)) return { kind: 'read', featureId: 'ledger' };
  if (/(?:^|\s)재고(?:는|가|부터)?\s*(?:(?:좀\s*)?(?:어때|얼마나|알려줘|보여줘|현황))?$/u.test(value)) {
    return { kind: 'read', featureId: 'inventory-booking' };
  }
  if (/^(?:그럼\s*)?세금(?:은|이|이요)?$/u.test(value)) return { kind: 'read', featureId: 'tax' };
  if (/^(?:(?:그럼|그러면)\s*)?(?:지난달|저번 달|어제|昨天)(?:은|는|呢)?\s*(?:매출은?|얼마였어|어땠어|얼마야)?$/u.test(value)) {
    const period = /지난달|저번 달/u.test(value) ? 'previous_month' : 'yesterday';
    return { kind: 'repeat_read', period };
  }
  const month = /^(?:그럼\s*)?(0?[1-9]|1[0-2])\s*월(?:은|는)\s*(?:얼마야|어땠어|매출은)?$/u.exec(value);
  if (month) return { kind: 'repeat_read', period: 'month', month: Number(month[1]) };
  if (/^(?:다시 말해줘|방금 뭐라고 했어|한 번 더 말해줘|더 있어|다른 건|또 뭐 있어|나머지는)$/u.test(value)) return { kind: 'repeat_read' };
  if (/다 ?떨어지면|재고 ?없으면|재료 ?모자라면|자동으로/u.test(value)) return { kind: 'refused', reason: 'automation' };
  if (/바꾸지\s*말?아?\s*(?:마|줘)|하지\s*마(?:세요)?$|는 거 아니야$|말고 그대로|don.t\s+(?:change|set|mark)|(?:不要|別|别)(?:改|设置)/u.test(value)
    && !negative.test(value)) return { kind: 'reply', reason: 'declined' };

  if (/두 개 다|둘 다|그 전 거|그전 거|처음에|두 번 전|한 거 전부/u.test(value) && (undoWords.test(value) || /취소/u.test(value))) {
    return { kind: 'undo', previous: true };
  }
  if (undoWords.test(value) || pastWords.test(value) && /취소|빼줘|없던 걸로/u.test(value)
    || /^(?:새 .+ 다시 새 소식으로|위젯 추가한 거 취소)$/u.test(value)
    || /^방금 .+ (?:켠|바꾼) 거 취소해줘$|^큰 글자 켠 거 취소해줘$/u.test(value)) {
    return { kind: pending && /취소/u.test(value) ? 'cancel' : 'undo' };
  }
  if (negative.test(value) || /^(?:그만둘래 안 할래|아니,? 됐어)$/u.test(value)) return { kind: 'cancel' };
  if (pending && /^(?:(?:네|예)\s*)?(?:삭제해|지워줘)$/u.test(value)) return { kind: 'hold' };
  if (/^(?:(?:아니|취소 말고)\s*)?(?:(?:방금|아까) (?:한 |그)?거 다시|다시 해줘|다시 해볼래)$|^취소 말고 다시$|(?:똑같이|같은 만큼|같은 금액).*(?:해줘|올려|바꿔)|(?:한|했던) 거 다시/u.test(value)
    || /^(?:\S+라테|\S+라떼|라테|라떼)도\s*(?:품절로|같이 처리해줘)$/u.test(value)) return { kind: 'repeat_command' };
  const ordinal = /(?:맨 위|맨 처음|첫\s*번째|두\s*번째|세\s*번째|네\s*번째|([1-5])\s*번째)/u.exec(value);
  if (ordinal) {
    const word = ordinal[0].replace(/\s+/gu, '');
    return { kind: 'refer', ordinal: Number(ordinal[1] ?? (word.startsWith('두') ? 2 : word.startsWith('세') ? 3 : word.startsWith('네') ? 4 : 1)) };
  }

  if (pending && /수정|고칠래|고치기|바꿀게|바꿔줘|말고|^(?:아냐|아니(?:야)?|아)\s|이름 틀렸|\bedit\b|가격은|가격만|(?:원|리터|ml)으로/u.test(value)) {
    return { kind: 'edit' };
  }
  if (/^(?:그거|저거|아까 .+|아까 그 메뉴|방금 전 대화|그 위젯|그럼 .+)/u.test(value)
    || /^(?:[가-힣]{2,16})(?:는|은)(?:\s*어때)?$/u.test(value)) {
    if (/(?:오늘|내일)\s+|(?:넣|추가|등록)어?\s*줘/u.test(value)) return { kind: 'intent', text: value };
    return { kind: 'refer' };
  }
  if (/올려도|올리면|올릴까요|올려 볼까/u.test(value)) return { kind: 'read', featureId: 'menu' };
  if (/^[\d,\s]+(?:원(?:이요)?)?$/u.test(value) || /^[\d,영공일이삼사오육칠팔구십백천만원\s]+(?:이요)?$/u.test(value)) {
    return pending ? { kind: 'value' } : { kind: 'reply', reason: 'unsupported' };
  }

  for (const [alias, target] of menuAliases) {
    const candidate = alias.includes('아메리카노') ? alias.replace('아메리카노', '\\s*아메리카노') : alias;
    const match = new RegExp(`(?:^|[^가-힣])(${candidate})(?:$|[^가-힣]|도|로|는|를)`, 'u').exec(value);
    if (match) {
      return { kind: alias === '아메' ? 'intent' : 'alias', target, text: value.replace(match[1], target) };
    }
  }
  if (!/[가-힣\p{Script=Han}]/u.test(value) && !/\b(?:menu|sales|price|croissant|sold|ameri[cC]ano)\b/iu.test(value)
    || /^[ㅋㅎㅠㅜ]+$/u.test(value) || /(?:멍청한 봇|쓸모없네|^꺼져$|바보냐|asdf)/u.test(value)) {
    return { kind: 'reply', reason: 'unsupported' };
  }
  return {
    kind: 'intent',
    text: spelling.reduce((turn, [from, to]) => turn.replace(from, to), value.normalize('NFKC'))
      .replace(/(?:^|\s)(?:어|음|저기요|저기)(?:\s|$)/gu, ' ').replace(/\s+/gu, ' ').trim(),
  };
}

const resolutionCopy = {
  ko: {
    undo_expired: '되돌리기 시간이 지났어요',
    undo_unavailable: '되돌릴 변경이 없어요.',
    pending_missing: '응답할 수 있는 카드가 없어요.',
    target_required: '변경 대상을 지정하고 다시 확인해 주세요.',
    reference_missing: '이전 대화에서 항목을 확인할 수 없어요. 어떤 항목인지 다시 알려 주세요.',
    reprepare: '현재 상태로 다시 확인 카드를 준비해 주세요.',
    cancel: '변경을 취소했어요.',
  },
  en: {
    undo_expired: 'The undo window has expired. Make the change directly in the widget.',
    undo_unavailable: 'There is no change to undo.',
    pending_missing: 'There is no pending card to respond to.',
    target_required: 'Choose the item to change and confirm again.',
    reference_missing: 'Please specify the item again.',
    reprepare: 'Prepare a new confirmation card using the current state.',
    cancel: 'The change was cancelled.',
  },
  'zh-Hans': {
    undo_expired: '撤销时限已过。请在小组件中直接修改。',
    undo_unavailable: '没有可以撤销的更改。',
    pending_missing: '没有等待回复的卡片。',
    target_required: '请选择要更改的项目，然后再次确认。',
    reference_missing: '请重新指定项目。',
    reprepare: '请根据当前状态重新准备确认卡片。',
    cancel: '已取消更改。',
  },
  'zh-Hant': {
    undo_expired: '復原時限已過。請在小工具中直接修改。',
    undo_unavailable: '沒有可以復原的變更。',
    pending_missing: '沒有等待回覆的卡片。',
    target_required: '請選擇要變更的項目，然後再次確認。',
    reference_missing: '請重新指定項目。',
    reprepare: '請依目前狀態重新準備確認卡片。',
    cancel: '已取消變更。',
  },
};
export function conversationResolutionText(resolution, locale = 'ko') {
  const message = resolutionCopy[locale]?.[resolution.reason ?? resolution.type];
  return message ? [message] : [];
}

const copy = value => structuredClone(value);
const requestScope = ({ runId, layer, page, snapshotRevision }) => ({ runId, layer, page, snapshotRevision });
const sameBoard = (a, b) => a.layer === b.layer && a.page === b.page;
const sameSnapshot = (a, b) => sameBoard(a, b) && a.snapshotRevision === b.snapshotRevision;
const scopedSearches = searches => searches.map(({ kind, querySlot, queryBinding, cursor, matches }) => ({
  kind, querySlot, queryBinding, cursor, handles: matches.map(({ handle }) => handle),
}));

/** The wire stores metadata and opaque references. The authorized local store owns all effects. */
export function createAgentConversation({
  clock = { now: Date.now }, makeId = randomUUID, getUndoReceipts = () => [],
} = {}) {
  const runs = new Map();
  function state(runId) {
    const now = clock.now();
    while (runs.size && now - runs.values().next().value.updatedAt >= MEMORY_MS) runs.delete(runs.keys().next().value);
    const current = runs.get(runId) ?? { reads: [] };
    runs.delete(runId);
    current.updatedAt = now;
    runs.set(runId, current);
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
    return current;
  }

  function remember(input, { proposal, clarification, read, searches = [], panels = [], competing = false, lookupReceipt }) {
    const current = state(input.runId);
    const scope = requestScope(input);
    if (lookupReceipt) current.lookup = { scope, receipt: lookupReceipt };
    else if (competing || searches.length) delete current.lookup;
    if (read) {
      current.reads.unshift({
        scope, intent: copy(read), searches: scopedSearches(searches),
        widgets: panels.map(({ featureId }) => featureId),
      });
      if (current.reads.length > READ_MEMORY) current.reads.pop();
    }
    if (proposal) {
      const intent = input.intent?.kind === 'command' || input.intent?.kind === 'menu.create'
        ? copy(input.intent) : { kind: 'command', command: proposal.command, args: copy(proposal.args) };
      current.pending = { scope, id: proposal.proposalId, proposal: copy(proposal), intent };
      delete current.retryCommand;
    } else if (clarification) {
      current.pending = { scope, id: clarification.id, clarification: copy(clarification), intent: copy(input.intent), lookupReceipt };
    } else if (competing) {
      delete current.pending;
    }
  }

  function currentLookup(input) {
    const current = state(input.runId);
    if (input.intent?.action === 'continue') {
      const pending = current.pending;
      return pending?.id === input.intent.pendingId && sameSnapshot(input, pending.scope) ? pending.lookupReceipt : undefined;
    }
    return current.lookup && sameSnapshot(input, current.lookup.scope) ? current.lookup.receipt : undefined;
  }

  function referenced(input, current, { ordinal, recordKind, featureId }) {
    for (const entry of current.reads) {
      if (!sameSnapshot(input, entry.scope)) continue;
      if (recordKind || entry.searches.length && !featureId) {
        const choices = entry.searches.filter(search => !recordKind || search.kind === recordKind)
          .flatMap(({ kind, querySlot, queryBinding, cursor, handles }) => {
            const currentSearch = input.searches.find(search => search.kind === kind && search.querySlot === querySlot
              && search.queryBinding === queryBinding && search.cursor === cursor);
            return handles.map(handle => ({
              choice: { type: 'record', recordKind: kind, querySlot, handle, ...(queryBinding && { queryBinding }) },
              current: currentSearch?.matches.some(match => match.handle === handle),
            }));
          });
        if (choices.length) {
          if (ordinal) return choices[ordinal - 1]?.current ? choices[ordinal - 1].choice : expired('reference_missing');
          const verified = choices.filter(choice => choice.current).map(({ choice }) => choice);
          if (verified.length !== choices.length) return expired('reference_missing');
          return select(verified);
        }
      }
      const widgets = entry.widgets.filter(id => (!featureId || featureId === id) && input.catalog?.some(widget => widget.id === id))
        .map(id => ({ type: 'widget', featureId: id }));
      if (widgets.length) return select(widgets, ordinal);
    }
    return expired('reference_missing');
  }

  function select(choices, ordinal) {
    if (ordinal !== undefined) return choices[ordinal - 1] ?? expired('reference_missing');
    return choices.length === 1 ? choices[0] : { type: 'choose', choices: choices.slice(0, 5) };
  }

  function undo(input, { featureId, previous }) {
    if (previous) return expired('undo_unavailable');
    // This port exposes current receipt metadata inside the authorized run only.
    const receipts = getUndoReceipts(input.runId).filter(receipt => {
      const policy = agentCommandPolicy(receipt.command);
      return receipt.runId === input.runId && Number.isFinite(receipt.expiresAt) && policy?.policy === 'propose'
        && (receipt.target === 'layout' && receipt.command.startsWith('layout.')
          || receipt.target === 'data' && !/^(?:layout|settings|ui)\./u.test(receipt.command));
    });
    const newest = new Map();
    for (const receipt of receipts) {
      const existing = newest.get(receipt.target);
      if (!existing || receipt.revision > existing.revision) newest.set(receipt.target, receipt);
    }
    const available = [...newest.values()].filter(receipt => {
      const id = receipt.featureId ?? agentCommandPolicy(receipt.command).featureId;
      return (!featureId || featureId === id) && !receipt.consumed
        && (receipt.target !== 'data' || input.snapshotRevision === receipt.revision)
        && (receipt.target !== 'layout' || (receipt.layer === undefined || receipt.layer === input.layer)
          && (receipt.page === undefined || receipt.page === input.page));
    });
    const deadline = clock.now();
    const live = available.filter(receipt => receipt.expiresAt > deadline);
    if (live.length) return select(live.map(receipt => ({ type: 'undo', receiptId: receipt.id, target: receipt.target })));
    if (available.length) {
      const widget = available[0].featureId ?? agentCommandPolicy(available[0].command).featureId;
      return { ...expired('undo_expired'), ...(widget ? { featureId: widget } : {}) };
    }
    return featureId ? { ...expired('undo_unavailable'), featureId } : expired('undo_unavailable');
  }

  function repeatRead(input, current, { period, month }) {
    const remembered = current.reads.find(entry => entry.scope.layer === input.layer
      && !entry.intent.querySlot && (entry.intent.featureId || entry.intent.sourceId
        || entry.intent.reads?.length && entry.intent.reads.every(({ name }) => name === 'get_widget' || name === 'get_source')));
    if (!remembered) return expired('reference_missing');
    const intent = copy(remembered.intent);
    if (period) {
      const anchor = new Date(`${input.businessDate}T00:00:00Z`);
      if (period === 'yesterday') anchor.setUTCDate(anchor.getUTCDate() - 1);
      if (period === 'previous_month') anchor.setUTCDate(0);
      if (period === 'month') {
        const year = anchor.getUTCFullYear() - Number(month > anchor.getUTCMonth() + 1);
        anchor.setUTCFullYear(year, month, 0);
      }
      const end = anchor.toISOString().slice(0, 10);
      if (period !== 'yesterday') anchor.setUTCDate(1);
      const start = anchor.toISOString().slice(0, 10);
      const condition = { kind: 'dateRange', start, end };
      if (intent.reads) intent.reads = intent.reads.map(read => ({ ...read, args: { ...read.args, condition } }));
      else intent.condition = condition;
    }
    return { type: 'read', intent };
  }

  function resolve(input, control, { staleDraft = false } = {}) {
    const current = state(input.runId);
    const pending = current.pending;
    const { action, pendingId } = control;
    if (action === 'undo' && pendingId === undefined) return undo(input, control);
    if (action === 'refer') return referenced(input, current, control);
    if (action === 'repeat_read') return repeatRead(input, current, control);
    if (action === 'repeat_command') {
      const command = current.retryCommand ?? current.lastConfirmed ?? pending?.proposal?.command;
      return command ? { type: 'reprepare', command } : expired('reference_missing');
    }
    if (action === 'hold') return { type: 'hold' };
    if (!pending || pending.id !== pendingId) return expired('pending_missing');

    if (action === 'cancel' || action === 'undo' || action === 'edit') {
      delete current.pending;
      if (pending.lookupReceipt && current.lookup?.receipt === pending.lookupReceipt) delete current.lookup;
      if (action !== 'edit' && pending.proposal) current.retryCommand = pending.proposal.command;
      return { type: action === 'edit' ? 'edit' : 'cancel', pendingId };
    }
    if (pending.clarification) {
      if (action !== 'continue' || !sameSnapshot(input, pending.scope)) return expired('pending_missing');
      const { field } = pending.clarification;
      if (!control.selection) return { type: 'continue', pendingId, field };
      if (pending.intent?.kind !== 'command') return expired('target_required');
      return { type: 'continue_record', field, intent: copy(pending.intent) };
    }

    const { proposal, scope } = pending;
    if (!sameSnapshot(input, scope)) {
      delete current.pending;
      if (staleDraft && proposal.command === 'menu.create' && sameBoard(input, scope)
        && agentCommandRefs(proposal.command, proposal.args).every(ref => ref.slot && input.slots.includes(ref.slot))) {
        return { type: 'proposal', intent: copy(pending.intent) };
      }
      return { type: 'reprepare', pendingId, command: proposal.command };
    }

    // These controls belong to the card. Text agreement is classified as hold.
    if (action !== 'confirm' && action !== 'confirm_extra') return expired('pending_missing');
    if (proposal.tier === 'extra-confirm') {
      if (action === 'confirm') {
        const targets = agentCommandRefs(proposal.command, proposal.args).map(ref => ref.handle).filter(Boolean);
        if (proposal.args?.featureId) targets.push(proposal.args.featureId);
        if (!targets.length || !targets.includes(control.target)) return expired('target_required');
        pending.challengeId ??= makeId();
        return { type: 'extra_confirm', pendingId, challengeId: pending.challengeId };
      }
      if (!pending.challengeId || pending.challengeId !== control.challengeId) return expired('target_required');
    } else if (action === 'confirm_extra') {
      return expired('target_required');
    }
    delete current.pending;
    current.lastConfirmed = proposal.command;
    delete current.retryCommand;
    return { type: 'confirm', pendingId };
  }

  return Object.freeze({ remember, resolve, currentLookup });
}
