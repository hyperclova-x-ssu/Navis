import type { FeatureId } from '../../contracts';
import type { DataSnapshot } from '../../data/db/types';
import type { AgentActionProposal, AgentActionReceipt, LocalAgentProposal, MenuDraft, MenuProposalEdit } from './agent-actions';
import { isMenuPrice } from './agent-actions';
import { navisMoneySpans, normalizeNavisInput, parseNavisMoney, parsePendingResponse } from './navis-input';
import type { AgentSuggestion, AgentTurnInput, AssistantReply } from './types';

export const NAVIS_INPUT_LIMIT = 4000;

export function conversationPrice(text: string): number | undefined {
  const value = normalizeNavisInput(text).replace(/(?:이요|입니다|이에요|예요|이에요[.!])$/u, '').trim();
  const spans = navisMoneySpans(value);
  if (spans.length && (spans.length !== 1 || spans[0].start !== 0 || spans[0].end !== value.length)) return undefined;
  const price = parseNavisMoney(value);
  return isMenuPrice(price) ? price : undefined;
}

type Control =
  | { kind: 'confirm' }
  | { kind: 'edit'; field?: 'price'; price?: number }
  | { kind: 'retarget'; query?: string }
  | { kind: 'undo'; target?: string; command?: 'staff.saveSchedule' | 'localChanges.acknowledge' }
  | { kind: 'cancel' | 'cancel-last' | 'hold' | 'repeat-answer' | 'repeat-command' };

const affirm = /^(?:응+|ᄋ{2,}|ᄋᄏ|그래|좋아|해\s*줘|추가해(?:\s*줘)?|네|예|맞아|고고|확인(?:해\s*줘)?|yes|ok(?:ay)?|👍)$/iu;
const deny = /^(?:아니(?:요|야|다)?|아냐|ᄂ{2,}|싫어|안\s*할래|하지\s*마|no|취소(?:해\s*줘|할래)?|그만(?:둘래(?:\s*안\s*할래)?)?|됐어|없던\s*걸로|👎)$/iu;

export function readConversationControl(text: string, hasPendingProposal = false): Control | undefined {
  const value = normalizeNavisInput(text).toLowerCase().replace(/[.!?。！？,]+$/u, '').trim();
  if (!value) return undefined;
  if (value === '확인 취소' || /^(?:방금 확인한 거 취소|아까 접은 거 되돌려)\s*(?:해\s*)?줘$/u.test(value)) {
    return { kind: 'undo', command: 'localChanges.acknowledge' };
  }
  if (/^아까 넣은 근무 취소(?:해\s*줘)?$/u.test(value)) return { kind: 'undo', command: 'staff.saveSchedule' };
  const words = value.split(/[\s,.!?。！？]+/u).filter(Boolean);
  const yes = words.some(word => word !== '해줘' && affirm.test(word));
  const no = words.some(word => deny.test(word));
  if (yes && no) return { kind: 'hold' };
  if (/^(?:글쎄|음+|괜찮나|그럴까|일단\s*보류|아마도|생각\s*좀\s*해\s*볼게|maybe|等等)$/iu.test(value)) return { kind: 'hold' };
  const localChange = /^(.+?)\s+다시 새 소식으로$/u.exec(value)?.[1];
  if (localChange) return { kind: 'undo', target: localChange, command: 'localChanges.acknowledge' };
  if (/^(?:(?:방금|아까)\s*(?:(?:한|바꾼)\s*)?(?:거|것)\s*)?(?:원래대로(?:\s*해\s*줘)?|되돌리기|되돌려(?:\s*줘)?|undo|撤銷|撤销|還原|还原)$/iu.test(value) ||
    /^취소해\s*줘\s*원래대로$/u.test(value)) return { kind: 'undo' };
  if (/^(?:방금|아까)\s*(?:한\s*)?(?:거|것)\s*취소(?:해\s*줘)?$/u.test(value) || /^취소해\s*줘$/u.test(value)) return { kind: 'cancel-last' };
  if (/^(?:다시 말해\s*줘|방금 뭐라고 했어|한 번 더 말해\s*줘|repeat (?:that|your answer))$/iu.test(value)) return { kind: 'repeat-answer' };
  if (/^(?:(?:아까|방금)\s*(?:한|했던)\s*(?:거|것)\s*다시(?:\s*해\s*줘)?|똑같이(?:\s*해\s*줘)?|같은\s*작업\s*다시|repeat (?:the|last) (?:command|action))$/iu.test(value)) return { kind: 'repeat-command' };

  const correction = /^(?:(?:아니(?:야)?|아냐)\s*)?(?:(?:.+?)\s*말고\s*|(?:아니(?:야)?|아냐)\s+)(.*)$/u.exec(value);
  const explicitPrice = /^(?:(?:응|네|그래)\s*,?\s*)?가격(?:은|을|만)?\s*(.*)$/u.exec(value);
  if (/^(?:아니(?:야)?|아냐)\s+(?:다른|딴)\s*(?:거|걸|것)$/u.test(value)) return { kind: 'retarget' };
  if (correction || explicitPrice) {
    const tail = (explicitPrice ?? correction)?.[1] ?? '';
    const price = conversationPrice(tail.replace(/(?:으?로)?\s*(?:바꿔\s*줘|해\s*줘|주세요)$/u, '').replace(/으?로$/u, '').trim());
    if (price !== undefined) return { kind: 'edit', field: 'price', price };
    if (explicitPrice && /^(?:바꿀래|고칠래|수정할래|바꿔\s*줘|고쳐\s*줘)$/u.test(tail)) return { kind: 'edit', field: 'price' };
    if (correction && (!tail || /^(?:다른|딴)\s*(?:거|걸|것)/u.test(tail))) return { kind: 'retarget' };
    const query = tail.replace(/(?:으?로)?\s*(?:해\s*줘|바꿔\s*줘)$/u, '').replace(/으?로$/u, '').trim();
    if (correction && /^(?:라[테떼]|카페\s*라[테떼]|아메리카노|바닐라\s*라[테떼])$/u.test(query)) return { kind: 'retarget', query };
  }
  if (hasPendingProposal && /으?로$/u.test(value)) {
    const price = conversationPrice(value.replace(/으?로$/u, '').trim());
    if (price !== undefined) return { kind: 'edit', field: 'price', price };
  }
  const parsed = parsePendingResponse(value);
  if (affirm.test(value) || parsed === 'yes' || words.length > 1 && words.every(word => affirm.test(word))) return { kind: 'confirm' };
  if (deny.test(value) || parsed === 'no' || parsed === 'cancel') return { kind: 'cancel' };
  if (parsed === 'edit' || /^(?:잠깐\s*)?(?:수정\s*좀\s*할게|바꿀게\s*잠깐|수정할래)$/u.test(value)) return { kind: 'edit' };
  if (/^.+?\s*(?:(?:삭제|제거|변경)\s*확인(?:해\s*줘)?|확정(?:해\s*줘)?)$/u.test(value)) return { kind: 'confirm' };
}

export function prepareConversationText(text: string):
  | { kind: 'text'; text: string }
  | { kind: 'empty' | 'tooLong' | 'unclear' | 'greeting' | 'unsupportedLanguage' | 'automation' } {
  if (text.length > NAVIS_INPUT_LIMIT) return { kind: 'tooLong' };
  const value = normalizeNavisInput(text);
  if (!value) return { kind: 'empty' };
  if (/^(?:안녕(?:하세요)?|ᄒᄋ|고마워(?:요)?|수고했어|잘 자|😀|hi|hello|你好)[.!?。！？]*$/iu.test(value)) return { kind: 'greeting' };
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value) || /^(?:pouvez-vous|bonjour)\b/iu.test(value)) return { kind: 'unsupportedLanguage' };
  if (/(?:자동으로|알아서|(?:떨어지|없으|모자라)면).*(?:품절|바꿔|발송)/u.test(value)) return { kind: 'automation' };
  if (/^(?:[\p{P}\p{N}\s]+|[ᄀ-ᇿ]{3,}|asdf(?:asdf)*|이 멍청한 봇아|야 쓸모없네|꺼져|너 진짜 바보냐)$/iu.test(value) ||
    /^(?:<[^>]+>|\{\{|['`];)/u.test(value)) return { kind: 'unclear' };
  return { kind: 'text', text: value };
}

/** A pasted form must have one standalone command line, one name, and one amount. */
export function menuRequestText(text: string): string {
  if (/[\r\n]/u.test(text)) {
    const lines = text.split(/\r?\n/u).map(line => line.trim().replace(/^[-•]\s*/u, '')).filter(line => line && !/^신메뉴\s*[:：]$/u.test(line));
    const command = lines.find(line => /^메뉴에\s*(?:추가|등록|넣어)(?:해)?\s*줘[.!]?$/u.test(line));
    const data = lines.filter(line => line !== command);
    return command && data.length === 2 && isMenuPrice(parseNavisMoney(data[1]))
      ? `메뉴에 ${data[0]} ${data[1]} 추가해줘` : text;
  }
  return text.replace(/까페(?=\s*라[떼테])/gu, '카페').replace(/카\s+페\s+라\s+[떼테]/gu, '카페라테').replace(/^.*?(?:좋을 것 같아서|싶은데|고민했는데 결국)\s*(?=메뉴에\s)/u, '').replace(/\s+제발$/u, '');
}

export interface AgentProposalPreview {
  readonly title: string;
  readonly target: string;
  readonly fields: readonly { readonly label: string; readonly before: string; readonly after: string }[];
}

export function proposalPreview(preview: unknown): AgentProposalPreview | undefined {
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
  if (!preview || typeof preview !== 'object' || !('title' in preview) || !text(preview.title) || !('target' in preview) || !text(preview.target)
    || !('fields' in preview) || !Array.isArray(preview.fields) || preview.fields.length < 1 || preview.fields.length > 30) return undefined;
  if (!preview.fields.every(field => field && text(field.label) && text(field.before) && text(field.after))) return undefined;
  return preview as AgentProposalPreview;
}

export type ProposalState = Readonly<{
  proposal: LocalAgentProposal;
  menu?: AgentActionProposal;
  preview?: AgentProposalPreview;
  edit?: MenuProposalEdit;
  editField?: 'price';
  feedback?: AgentActionReceipt;
  reproposed?: boolean;
  refreshFailed?: boolean;
}>;

export function createProposalSession(initial: LocalAgentProposal, menu: AgentActionProposal | undefined,
  canCommit: () => boolean, onApplied: (receipt: AgentActionReceipt, label: string) => void, fallbackLabel: string) {
  let state: ProposalState = { proposal: initial, menu, preview: proposalPreview(initial.preview) };
  const listeners = new Set<() => void>();
  const update = (next: ProposalState) => {
    state = next;
    listeners.forEach(listener => listener());
  };
  const replace = (proposal: LocalAgentProposal, menu: AgentActionProposal | undefined, reproposed = false) => {
    update({ proposal, menu, preview: proposalPreview(proposal.preview), reproposed });
  };
  const label = () => state.menu?.preview.after.name ?? state.preview?.target;
  const isPending = () => !!(state.menu || state.preview) && state.proposal.isCurrent() && (!state.proposal.getReceipt() || !!state.edit);
  const refresh = () => {
    const menu = state.menu?.refresh() ?? undefined;
    const candidate = state.menu ? menu : state.proposal.refresh();
    const proposal = candidate && (menu || proposalPreview(candidate.preview)) ? candidate : undefined;
    if (proposal) replace(proposal, menu, true);
    else update({ ...state, refreshFailed: true });
    return !!proposal;
  };

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    isPending,
    confirm(currentStore: Parameters<LocalAgentProposal['confirm']>[0], proposalId: string, acknowledgeExtra = false) {
      const proposal = state.proposal;
      if (proposal.id !== proposalId || !isPending() || state.edit) return undefined;
      if (!canCommit()) return 'finishEditing' as const;
      const receipt = proposal.confirm(currentStore, acknowledgeExtra ? proposalId : undefined);
      if (receipt.requiresExtraConfirmation) {
        update({ ...state, feedback: receipt, reproposed: false });
        return receipt;
      }
      if (receipt.frame.outcome === 'conflict' && refresh()) return receipt;
      update({ ...state, feedback: receipt, reproposed: false });
      if (receipt.frame.outcome === 'applied') onApplied(receipt, label() ?? fallbackLabel);
      return receipt;
    },
    cancel() {
      if (!isPending()) return undefined;
      state.edit?.cancel();
      const feedback = state.proposal.cancel();
      update({ ...state, edit: undefined, feedback, reproposed: false });
      return feedback;
    },
    edit(field?: 'price', price?: number) {
      if (!state.menu || !state.menu.isCurrent()) return false;
      const edit = state.edit ?? state.menu.edit();
      if (!edit) return false;
      const menu = price === undefined ? undefined : edit.preview({ ...edit.draft, price });
      if (menu) replace(menu, menu);
      else update({ proposal: state.proposal, menu: state.menu, edit, editField: field });
      return true;
    },
    preview(draft: MenuDraft) {
      const menu = state.edit?.preview(draft);
      if (!menu) return false;
      replace(menu, menu);
      return true;
    },
  };
}

export type ProposalSession = ReturnType<typeof createProposalSession>;

export function conversationMemory() {
  let scope: string | undefined;
  let lastRead: { reply: AssistantReply; turn?: AgentTurnInput } | undefined;
  let confirmed: { command: string; label: string; menu?: MenuDraft } | undefined;
  let records: { choices: readonly AgentSuggestion[]; revision: number } | undefined;

  return {
    scope(runId: string | undefined) {
      if (scope === runId) return false;
      scope = runId;
      lastRead = undefined;
      confirmed = undefined;
      records = undefined;
      return true;
    },
    confirmed: () => confirmed,
    rememberCommand(command: string, label: string, menu?: MenuDraft) { confirmed = { command, label, menu }; },
    lastRead: () => lastRead,
    rememberRead(reply: AssistantReply, turn?: AgentTurnInput) {
      if (reply.turn?.kind !== 'read' || !reply.answer) return;
      lastRead = { reply, turn };
    },
    rememberRecords(choices: readonly AgentSuggestion[], revision: number) { records = { choices, revision }; },
    records(snapshot: DataSnapshot) {
      return records?.revision === snapshot.revision ? records.choices : [];
    },
  };
}

export function followupBoardQuestion(text: string): boolean {
  return /(?:첫\s*번째|두\s*번째|세\s*번째|맨\s*위|그\s*(?:위젯|패널)).*(?:추가|올려|놔|넣어)/u.test(text);
}

export function readOrdinal(text: string): number | undefined {
  const value = normalizeNavisInput(text).replace(/[.!?。！？]+$/u, '');
  if (/^(?:첫\s*번째|맨\s*위|1\s*번)(?:\s*(?:거|것|항목|걸로|으로))?$/u.test(value)) return 0;
  if (/^(?:두\s*번째|2\s*번)(?:\s*(?:거|것|항목|걸로|으로))?$/u.test(value)) return 1;
  if (/^(?:세\s*번째|3\s*번)(?:\s*(?:거|것|항목|걸로|으로))?$/u.test(value)) return 2;
}

export function salesRead(text: string): FeatureId | undefined {
  const today = /(?:오늘|today|今天|本日)/iu.test(text);
  const sales = /(?:매출|벌었|팔았|장사\s*얼마나|sales|revenue|make today|营业|營業|销售|銷售|赚|賺)/iu.test(text);
  const narrow = !/(?:어제|지난|저번|내일|비교|보다|마감|입력|등록|추가|바꿔|수정|기록|예상|유입|성과|몇\s*시|어떤|시간|근거|왜|만들|삭제|취소|포함|공급|발주|재고|부족|요약|순이익|차이|기여|빼|지출|지난달|적어|내역|손익|결제|누락|[0-9]|괄호)/u.test(text);
  return today && sales && narrow ? 'ledger' : undefined;
}
