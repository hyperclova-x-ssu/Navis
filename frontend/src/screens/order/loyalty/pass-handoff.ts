import { createContext } from 'react';
import type { PosMemberChoice } from '../../../data/reality/02/dto';

export const PassHandoff = createContext<{
  readonly member: PosMemberChoice;
  readonly membershipId: string;
} | null>(null);
