import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
const css=readFileSync('src/ui/tokens.css','utf8');
it('ships local variable font and D-37 light and dark colors',()=>{
 expect(css).toContain('NanumSquareNeo-Variable.woff2');
 expect(css).toContain('font-display: swap');
 for(const color of ['#F4F6F8','#171719','#006E38','#9CE3B5','#03C75A','#765600','#F1D17E','#2856A3','#A9C5EF'])expect(css).toContain(color);
 expect(css).toMatch(/--radius-lg:\s*8px/);
 expect(css).toMatch(/--weight-heading:\s*700/);
});
it('keeps text and focus contrast in both themes',()=>{
 const light=css.match(/:root, \[data-theme="light"\] \{([\s\S]*?)\}/)?.[1]??'';
 const dark=css.match(/\[data-theme="dark"\] \{([\s\S]*?)\}/)?.[1]??'';
 const value=(block:string,key:string)=>{const m=block.match(new RegExp(`--${key}:\\s*(#[0-9A-Fa-f]{6})`));expect(m,key).not.toBeNull();return m![1];};
 const luminance=(hex:string)=>{const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
 const ratio=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 for(const block of [light,dark])for(const [a,b,min] of [['foreground','background',4.5],['foreground','card',4.5],['primary-foreground','primary',4.5],['selection-foreground','selection',4.5],['warning','warning-bg',4.5],['success','success-bg',4.5],['change-up','change-up-bg',4.5],['change-down','change-down-bg',4.5],['ring','card',3]] as const)expect(ratio(value(block,a),value(block,b)),`${a}/${b}`).toBeGreaterThanOrEqual(min);
});
