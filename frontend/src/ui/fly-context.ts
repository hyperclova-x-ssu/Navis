import { createContext, useContext } from 'react';
import type { MotionProps } from 'motion/react';
import { transitionFor } from './motion';

/** Only panel text/data crossfades; its painted surface follows the full flight. */
export const FlyInContext=createContext<number|null>(null);
export function useFlyInContent():Pick<MotionProps,'initial'|'animate'|'transition'>{
  const delay=useContext(FlyInContext);
  return delay===null?{initial:false}:{initial:{opacity:0},animate:{opacity:1},transition:{...transitionFor('content'),delay}};
}
