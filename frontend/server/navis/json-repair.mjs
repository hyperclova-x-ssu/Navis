// HCX-005 sometimes ends a JSON reply one closing bracket early (and sometimes wraps it in a code fence). Closing at most three open
// brackets is the only repair; callers still validate the parsed value against their own schema.
export function parseJsonLoose(content) {
  const text = typeof content === 'string' ? content.replace(/^```(?:json)?\s*|\s*```$/gu, '').trim() : '';
  try { return JSON.parse(text); } catch { /* try closing */ }
  const open = [];
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) { if (char === '\\') index++; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') open.push(char === '{' ? '}' : ']');
    else if (char === '}' || char === ']') { if (open.pop() !== char) return undefined; }
  }
  if (inString || !open.length || open.length > 3) return undefined;
  try { return JSON.parse(text + open.reverse().join('')); } catch { return undefined; }
}

/**
 * Drops what the reply schema does not know (HCX-005 sometimes adds a "reason" or "answer" key) and keeps at most twelve fact refs.
 * The result still has to pass validateAgentModelReply, so an unknown outcome, a bad ref or a missing field stays invalid.
 */
export function tidyModelReply(reply) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return reply;
  if (reply.outcome === 'reply') {
    return { outcome: 'reply', ...(Array.isArray(reply.facts) && { facts: reply.facts.slice(0, 12) }), ...(typeof reply.text === 'string' && { text: reply.text }) };
  }
  if (reply.outcome === 'clarify') return { outcome: 'clarify', field: reply.field };
  if (reply.outcome === 'refused') return { outcome: 'refused' };
  return reply;
}
