import assert from 'node:assert/strict';
import { ApprovalError } from '../../packages/approvals/index.ts';
import { loadPersonaCapabilities } from '../../services/naver-virtual/app.ts';
import { personaPool } from '../../services/naver-virtual/db.ts';

const required = Array.from({ length: 17 }, (_, i) => 'pn' + String(i + 1).padStart(2, '0'));
const capabilities = await loadPersonaCapabilities(required);
assert.deepEqual(capabilities.map(({ id }) => id).sort(), required);
assert.equal(typeof personaPool, 'function');
const approvalError = new ApprovalError(403, 'CARD_REQUIRED');
assert.equal(approvalError.status, 403);
assert.equal(approvalError.code, 'CARD_REQUIRED');
console.info('PASS NAVER Virtual Server, all 17 registrars and the shared approval module import in Node strip-only mode');
