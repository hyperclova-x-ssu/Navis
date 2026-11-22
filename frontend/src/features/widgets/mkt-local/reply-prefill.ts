import type { DetailRef } from '../../../contracts';
import { validateAgentPrefill } from '../../../../shared/navis-agent-schema.mjs';

export function replyPrefill(ref: DetailRef): string | undefined {
  if (ref.featureId !== 'ai-response' || ref.prefill?.kind !== 'widget-draft') return;
  const { fields } = ref.prefill;
  if (!validateAgentPrefill('ai-response', fields) || fields.threadId && fields.threadId !== ref.itemId) return;
  return typeof fields.body === 'string' && fields.body.trim() ? fields.body : undefined;
}
