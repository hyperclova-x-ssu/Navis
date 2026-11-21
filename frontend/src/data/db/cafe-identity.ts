import { seedMembers } from './generated/members';

const memberCodes = new Map(seedMembers.members.map(row => [row.memberId, row.code]));

/** Keep the POS/member command ID contract and link it to the DB's separate profile UUID. */
export const cafeMemberId = (dbId: string): string => memberCodes.get(dbId) ?? dbId;
