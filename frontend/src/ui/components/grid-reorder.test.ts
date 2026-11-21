import { afterEach, expect,it,vi } from 'vitest';
import { createElement, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { planGridFlip, useGridReorder } from './grid-reorder';
afterEach(cleanup);
it('moves only rows visible both before and after the sort',()=>{
  expect(planGridFlip(new Map([['a',100],['b',156],['c',212]]),new Map([['d',100],['b',156],['a',212]]))).toEqual([{id:'a',delta:-112}]);
});
it('animates retained visible rows after an added row and cleans animations on scroll',()=>{
  const cancelled=vi.fn(),animated=vi.fn(()=>({cancel:cancelled}));
  const original=Element.prototype.animate;Element.prototype.animate=animated as unknown as typeof Element.prototype.animate;
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){const index=this.dataset.gridRow?[...this.parentElement!.querySelectorAll('[data-grid-row]')].indexOf(this):0;return {x:0,y:index*56,top:index*56,left:0,right:300,bottom:this.dataset.gridRow?(index+1)*56:200,width:300,height:this.dataset.gridRow?56:200,toJSON:()=>({})};});
  vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype,'offsetTop','get').mockImplementation(function(this:HTMLElement){return this.dataset.gridRow?[...this.parentElement!.querySelectorAll('[data-grid-row]')].indexOf(this)*56:0;});
  vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){return this.dataset.gridRow?56:200;});
  function Host(){const ref=useRef<HTMLDivElement>(null),[rows,setRows]=useState(['a','b']),motion=useGridReorder(ref,rows,false,'');return createElement('div',null,createElement('button',{onClick:()=>{motion.capture();setRows(['new','a','b']);}},'추가'),createElement('div',{ref,onScroll:motion.cancel},rows.map(id=>createElement('div',{'data-grid-row':id,key:id},id))));}
  try{render(createElement(Host));fireEvent.click(screen.getByRole('button',{name:'추가'}));expect(animated).toHaveBeenCalledWith([{transform:'translateY(-56px)'},{transform:'translateY(0px)'}],expect.objectContaining({duration:180}));fireEvent.scroll(screen.getByText('a').parentElement!);expect(cancelled).toHaveBeenCalled();}finally{Element.prototype.animate=original;}
});
it('switches to immediate placement when either visible set exceeds thirty',()=>{
  const many=new Map(Array.from({length:31},(_,i)=>[String(i),i*56]));expect(planGridFlip(many,new Map([['0',100]]))).toEqual([]);
  expect(planGridFlip(new Map([['0',100]]),many)).toEqual([]);
});
it('does no geometry work for reduced motion',()=>{
  const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect');
  function Host(){const ref=useRef<HTMLDivElement>(null),[rows,setRows]=useState(['a','b']),motion=useGridReorder(ref,rows,true,'');return createElement('div',null,createElement('button',{onClick:()=>{motion.capture();setRows(['b','a']);}},'정렬'),createElement('div',{ref},rows.map(id=>createElement('div',{'data-grid-row':id,key:id},id))));}
  render(createElement(Host));rect.mockClear();fireEvent.click(screen.getByRole('button',{name:'정렬'}));expect(rect).not.toHaveBeenCalled();
});
it('bounds rect reads to the visible slice and finishes all reads before animation writes',()=>{
  const events:string[]=[];
  const index=(node:HTMLElement)=>[...node.parentElement!.children].indexOf(node);
  vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype,'offsetTop','get').mockImplementation(function(this:HTMLElement){events.push('read');return this.dataset.gridRow?index(this)*56:0;});
  vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){events.push('read');return this.dataset.gridRow?56:200;});
  const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){events.push('read');const y=this.dataset.gridRow?index(this)*56:0;return {x:0,y,top:y,left:0,right:300,bottom:y+(this.dataset.gridRow?56:200),width:300,height:this.dataset.gridRow?56:200,toJSON:()=>({})};});
  const original=Element.prototype.animate;Element.prototype.animate=vi.fn(()=>{events.push('animate');return {cancel:()=>events.push('cancel')};}) as unknown as typeof Element.prototype.animate;
  function Host(){const ref=useRef<HTMLDivElement>(null),[rows,setRows]=useState(()=>Array.from({length:126},(_,i)=>String(i))),motion=useGridReorder(ref,rows,false,'');return createElement('div',null,createElement('button',{onClick:()=>{motion.capture();setRows(v=>[v[1],v[0],...v.slice(2)]);}},'정렬'),createElement('div',{ref},rows.map(id=>createElement('div',{'data-grid-row':id,key:id},id))));}
  try{render(createElement(Host));rect.mockClear();fireEvent.click(screen.getByRole('button',{name:'정렬'}));expect(rect.mock.calls.length).toBeLessThanOrEqual(12);const firstWrite=events.indexOf('animate');expect(firstWrite).toBeGreaterThan(0);expect(events.slice(firstWrite)).not.toContain('read');}finally{Element.prototype.animate=original;}
});
