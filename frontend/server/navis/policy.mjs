import {
  agentCommandPolicy, agentCommandRefs, agentHandoffFields, agentNavigationHandoffIssue,
  isAgentNavigationCommand, validateAgentDraft,
} from '../../shared/navis-agent-schema.mjs';

const refusalCopy = {
  duplicate: '같거나 비슷한 이름의 항목이 있어요. 패널에서 확인해 주세요.',
  invalid_target: '해당 항목을 찾을 수 없어요. 이름이나 상태를 확인해 주세요.',
  out_of_scope: '이 매장에서 확인할 수 있는 요청만 도와드릴 수 있어요.',
  unavailable: '지금은 이 요청을 처리할 수 없어요.',
  unsupported: '이 요청은 도와드릴 수 없어요.',
  widget_only: '이 작업은 패널에서 진행해 주세요.',
};
const widgetOnlyCopy = {
  'customOrder.openPayment': '주문을 열고 결제 받기에서 진행해 주세요.',
  'pos.payment': '주문/결제 화면에서 결제해 주세요.',
  'supplier.sendOrder': '발주 패널에서 발주서를 보내 주세요.',
  'tax.markPaid': '세무관리 패널에서 납부 상태를 표시해 주세요.',
};
const bindingFields = ['runId', 'snapshotRevision', 'layer', 'page'];

function commandDraft(input) {
  if (input.intent.kind === 'menu.create') return { command: 'menu.create', draft: {} };
  return { command: input.intent.command, draft: input.intent.args ?? {} };
}

function isNaverCancellation(input, command, draft, handles) {
  return command === 'booking.cancel' && handles?.get(draft.reservationId?.handle)?.some(binding =>
    binding.kind === 'reservation' && binding.origin === 'naver'
    && (!input.intent.querySlot || binding.querySlot === input.intent.querySlot));
}

function scopedHandoff(input, command, draft, featureId, handles) {
  if (!featureId) return undefined;
  const allowedDraft = Object.fromEntries(Object.entries(agentHandoffFields(command, draft)).filter(([field, value]) =>
    agentCommandRefs(command, { [field]: value }).every(ref => {
      if (ref.slot) return input.slots.includes(ref.slot);
      return handles?.get(ref.handle)?.some(binding =>
        (!ref.kinds || ref.kinds.includes('*') || ref.kinds.includes(binding.kind))
        && (!input.intent.querySlot || binding.querySlot === input.intent.querySlot));
    })));
  if (!validateAgentDraft(command, allowedDraft)) return undefined;
  return { featureId, command, draft: allowedDraft, runId: input.runId, snapshotRevision: input.snapshotRevision };
}

/** Adapter denials use the same policy terminal and expose only local widget prefill. */
export function agentPolicyRefusal(input, reason, { handles } = {}) {
  const { command, draft } = commandDraft(input);
  const featureId = agentCommandPolicy(command, draft)?.featureId;
  let alternative;
  let answer = refusalCopy[reason];
  const removesTaxEvidence = command === 'tax.setEvidence' && draft.evidence === 'none';
  if (['widget_only', 'unavailable', 'duplicate'].includes(reason) && !removesTaxEvidence) {
    alternative = scopedHandoff(input, command, draft, featureId, handles);
  }
  if (reason === 'widget_only' && Object.hasOwn(widgetOnlyCopy, command)) answer = widgetOnlyCopy[command];
  if (reason === 'widget_only' && isNaverCancellation(input, command, draft, handles)) {
    answer = '네이버 예약은 예약 화면에서 취소 사유와 해당되는 환불 조건을 입력해 주세요.';
  }
  if (featureId === 'menu' && reason === 'duplicate') {
    answer = '같거나 비슷한 이름의 메뉴가 있어요. 메뉴 패널에서 확인해 주세요.';
  }
  if (featureId === 'menu' && reason === 'invalid_target') {
    alternative = { featureId };
    answer = command === 'menu.delete' ? '삭제할 메뉴를 찾을 수 없어요. 판매 중인 메뉴는 품절로 바꿀 수 있어요.'
      : '메뉴를 찾을 수 없어요. 메뉴 패널에서 확인해 주세요.';
  }
  return { outcome: 'refused', refusal: { reason, ...(alternative && { alternative }) }, sentences: [answer] };
}

/**
 * Run after request validation, before an adapter or a model can act on the intent.
 * Scope and single-recipient evidence come from the authenticated host and its
 * current widget selector. Request fields, labels and model replies are data.
 */
export function evaluateAgentPolicy(input, { scope, handles, singleRecipient } = {}) {
  if (bindingFields.some(field => Object.hasOwn(scope ?? {}, field) && input[field] !== scope[field])) {
    return agentPolicyRefusal(input, 'out_of_scope');
  }
  const { kind } = input.intent;
  if (kind === 'read' || kind === 'help' || kind === 'conversation') return { outcome: 'proceed' };
  const { command, draft } = commandDraft(input);
  const policy = agentCommandPolicy(command, draft);
  if (!policy) return agentPolicyRefusal(input, 'unsupported');
  if (isAgentNavigationCommand(command)) return { outcome: 'proceed' };
  if (input.layer === 'pos' && policy.policy === 'propose') return agentPolicyRefusal(input, 'out_of_scope');
  if (isNaverCancellation(input, command, draft, handles)) return agentPolicyRefusal(input, 'widget_only', { handles });
  if (policy.policy === 'widget-only') return agentPolicyRefusal(input, 'widget_only', { handles });
  if (policy.policy === 'handoff') {
    const handoff = scopedHandoff(input, command, draft, policy.featureId, handles);
    const field = agentNavigationHandoffIssue(command, handoff?.draft ?? {}, true);
    if (field) return { outcome: 'clarify', command, field };
    if (!handoff) return agentPolicyRefusal(input, 'invalid_target');
    return { outcome: 'handoff', handoff, sentences: [command === 'tax.setEvidence'
      ? '세무관리 패널에서 증빙 파일을 첨부해 주세요.' : '패널에서 초안을 확인해 주세요.'] };
  }
  if (singleRecipient !== undefined && (command !== 'coupon.sendSlot' || singleRecipient?.route !== command
    || !draft.slotId?.handle || singleRecipient.slotHandle !== draft.slotId.handle
    || singleRecipient.recipientCount !== 1 || singleRecipient.targetConsented !== true)) {
    return { outcome: 'clarify', field: 'recipientId' };
  }
  return { outcome: 'proceed', tier: policy.confirmation };
}

/** The read terminal keeps a source outage and an empty result distinct. */
export function agentPolicyReadStatus(statuses) {
  const observed = new Set(statuses);
  if (observed.has('ready')) return undefined;
  if (observed.has('unsupported_period')) return 'unsupported_period';
  if (observed.has('unavailable')) return 'unavailable';
  return 'missing';
}

const quotedText = /"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/gu;
const payloadStart = /(?:메모(?:는|를)?|(?:답글|답장|공지)\s*(?:초안|문구)?)\s*:/u;
const overrideDirective = /(?:지시|규칙)(?:는|를|을|들을)?\s*(?:무시|바꿔|변경|잊어)|시스템\s*프롬프트|system\s*prompt|(?:ignore|override|forget|change|disregard)\s+(?:(?:all|the|your|previous|prior|above)\s+)*(?:instructions?|rules?)/iu;
const externalLink = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)[^\s<>]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?=\/)/iu;
const menuBulk = /메뉴\s*(?:가격\s*|판매가\s*)?(?:전부|모두|일괄|전체|싹|다(?=\s|지워|삭제|비워|없애))|(?:모든|전체)\s*메뉴/u;
const menuDelete = /지워|비워|없애|삭제(?:\s*(?:해|하|요청)|[.!?]?\s*$)/u;
const menuReprice = /(?:가격|판매가|[0-9]\s*원).*(?:올려|올리|내려|내리|인상|인하|바꿔|변경|수정)|(?:올려|올리|내려|내리|인상|인하|바꿔|변경|수정).*(?:가격|판매가|[0-9]\s*원)/u;
const cardSwipe = /카드(?:로)?\s*(?:결제\s*)?긁어(?:\s*(?:줘|주세요|줄래|달라)|[.!?]?\s*$)/u;
const customOrder = /(?:\bCO-[0-9]+\b|주문\s*제작|맞춤\s*주문|주문\s*결제|[가-힣][○●*][가-힣○●*])/iu;
const replyStatus = /(?:리뷰|답글|답변).*(?:안\s*달고|안\s*해도|그냥\s*넘어가게).*(?:완료|처리|대기에서\s*빼)/u;
const negativeAction = /(?:지우|비우|없애|올리|내리|삭제하|변경하|긁)(?:지|진)\s*마/u;

/** Classify the owner's directive only. Exclude quoted names and draft payloads. */
export function classifyNavisDirective(text) {
  const normalized = text.normalize('NFKC');
  const unquoted = normalized.replace(quotedText, ' ');
  const directive = unquoted.split(payloadStart, 1)[0].replace(/\s+/gu, ' ').trim();
  if (externalLink.test(directive)) {
    return { kind: 'refusal', reason: 'out_of_scope', answer: '링크는 열 수 없어요. 확인할 내용을 직접 알려 주세요.' };
  }
  if (overrideDirective.test(directive) || unquoted !== normalized && /^[.!?。！？\s]*$/u.test(unquoted)) {
    return { kind: 'refusal', reason: 'out_of_scope', answer: refusalCopy.unsupported };
  }
  if (/다른\s*매장|타\s*매장/u.test(directive) && /가져|수정|삭제|매출|조회|고객|보여|알려/u.test(directive)) {
    return { kind: 'refusal', reason: 'out_of_scope', answer: refusalCopy.out_of_scope };
  }
  if (negativeAction.test(directive)) return undefined;
  if (menuBulk.test(directive) && menuDelete.test(directive)) {
    return { kind: 'refusal', reason: 'unsupported', alternative: { featureId: 'menu' },
      answer: '메뉴는 하나씩 지울 수 있어요. 어떤 메뉴를 지울까요?' };
  }
  if (menuBulk.test(directive) && menuReprice.test(directive)) {
    return { kind: 'refusal', reason: 'unsupported', alternative: { featureId: 'menu' },
      answer: '모든 메뉴의 가격을 한꺼번에 바꿀 수 없어요. 바꿀 메뉴 이름을 알려 주세요. 메뉴 패널에서 직접 바꿀 수도 있어요.' };
  }
  if (cardSwipe.test(directive)) {
    const [featureId, command] = customOrder.test(directive)
      ? ['custom-order', 'customOrder.openPayment'] : ['pos', 'pos.payment'];
    return { kind: 'refusal', reason: 'widget_only', answer: widgetOnlyCopy[command],
      alternative: { featureId, command, draft: {} } };
  }
  if (replyStatus.test(directive)) {
    return { kind: 'answer', intent: { kind: 'read', featureId: 'ai-response', condition: { kind: 'default' } },
      answer: '답변을 보내거나 답글을 올려야 대기에서 빠져요.' };
  }
  return undefined;
}
