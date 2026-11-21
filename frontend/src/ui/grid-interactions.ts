/** Shared by grids, the region panel and the existing parent dialog. No new trap. */
type Layer={root:HTMLElement;priority:()=>number;dismiss:()=>void;cancel?:()=>void};
const documents=new WeakMap<Document,Set<Layer>>();
export function registerGridLayer(layer:Layer):()=>void{
  const doc=layer.root.ownerDocument;
  let layers=documents.get(doc);
  if(!layers){
    layers=new Set();documents.set(doc,layers);
    doc.addEventListener('keydown',event=>{
      if(event.key!=='Escape'||event.defaultPrevented)return;
      const active=doc.activeElement;
      const candidates=[...documents.get(doc)??[]].filter(l=>l.root.isConnected&&!l.root.closest('[inert]')&&l.priority()>0);
      // Restrict to the active modal, so another mounted dialog cannot intercept it.
      const modal=active?.closest('[role="dialog"]');
      const top=candidates.filter(l=>!modal||modal.contains(l.root)).sort((a,b)=>b.priority()-a.priority())[0];
      if(top){event.preventDefault();event.stopImmediatePropagation();top.dismiss();}
    },true);
  }
  layers.add(layer);return()=>layers?.delete(layer);
}
export function cancelGridEdits(root:HTMLElement){for(const layer of documents.get(root.ownerDocument)??[])if(root.contains(layer.root))layer.cancel?.();}
