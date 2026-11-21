import { describe, expect, it, vi } from 'vitest';
import { consumeDismissSequence } from './dismiss';

describe('whole close sequence consumption',()=>{
  it('consumes repeated closing keydown until keyup, then allows a fresh input',()=>{
    const observe=vi.fn();const button=document.createElement('button');document.body.append(button);
    document.addEventListener('keydown',observe);
    button.addEventListener('keydown',consumeDismissSequence,{once:true});
    try {
      button.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',repeat:true,bubbles:true,cancelable:true}));
      expect(observe).not.toHaveBeenCalled();
      document.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',bubbles:true,cancelable:true}));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      expect(observe).toHaveBeenCalledTimes(1);
    } finally {document.removeEventListener('keydown',observe);button.remove();}
  });
});
