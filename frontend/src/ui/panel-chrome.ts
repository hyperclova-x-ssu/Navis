import { createContext, useContext } from 'react';
/** What a panel tells its controls: editing hides PanelAction and (?) ; waiting (idle) hides them too. Both keep their slot. */
export interface PanelChrome {
  readonly editing:boolean;
  readonly waiting:boolean;
  /** Actual grid span, supplied by FeaturePanel; W alone cannot distinguish 2x1 from 3x1. */
  readonly span?:{readonly width:number;readonly height:number};
}
export const PanelChromeContext=createContext<PanelChrome>({editing:false,waiting:false});
export function usePanelChrome():PanelChrome{return useContext(PanelChromeContext);}
