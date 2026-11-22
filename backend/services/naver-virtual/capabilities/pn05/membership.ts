import type { FastifyInstance } from 'fastify';
import type { PersonaCapability } from '../../app.ts';
import type { MembershipBenefit } from '../../../../packages/naver/contracts/pn05/index.ts';
import { fields, page, partnerPrefix } from '../../../../packages/naver/contracts/pn03/partner.ts';

const path = `${partnerPrefix}/membership/benefits`;
const columns = 'ref, provider, type, benefit, valid_days, visible, paused';
type Row = {
  ref: string; provider: MembershipBenefit['provider']; type: MembershipBenefit['type']; benefit: string;
  valid_days: number | null; visible: boolean | null; paused: boolean | null;
};

function project(row: Row): MembershipBenefit {
  return {
    ref: row.ref, provider: row.provider, type: row.type, benefit: row.benefit,
    ...(row.valid_days === null ? {} : { validDays: row.valid_days }),
    ...(row.visible === null ? {} : { visible: row.visible }),
    ...(row.paused === null ? {} : { paused: row.paused }),
  };
}

export function registerMembership(app: FastifyInstance, context: Parameters<PersonaCapability['register']>[1]) {
  // Named Place membership integrations 1100 and official coupon management 25061.
  app.get(path, { config: { personaOperation: 'pn05.membership.list' } }, (request) => {
    const [limit, offset] = page(fields(request.query, [], ['limit', 'offset']));
    return context.transaction(request, async (client) => {
      const { rows } = await client.query<Row>(`
        SELECT ${columns} FROM naver_virtual.pn05_membership_benefits
        WHERE account_id = $1 ORDER BY ref LIMIT $2 OFFSET $3
      `, [context.accountId(request), limit, offset]);
      return { items: rows.map(project) };
    });
  });

}
