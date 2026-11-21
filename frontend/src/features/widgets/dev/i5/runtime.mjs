import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
export const root=fileURLToPath(new URL('../../../../../',import.meta.url));
export const evidence=fileURLToPath(new URL('./evidence/',import.meta.url));
export const viteOptions={root,server:{host:'127.0.0.1',port:0,strictPort:false,open:false,watch:{ignored:[/(^|[/\\])evidence([/\\]|$)/]}}};
/** Keep kit assertions intact and reuse this runtime's evidence-ignoring Vite. */
export function prepareKitSource(original,{root,folder,port}){
 let source=original.replace("const root=fileURLToPath(new URL('../../../',import.meta.url));",`const root=${JSON.stringify(root)};`).replace("const folder=fileURLToPath(new URL('./evidence/mastermanage/',import.meta.url));",`const folder=${JSON.stringify(folder)};`);
 const parsed=ts.createSourceFile('kit-check.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];
 const base=pathToFileURL(join(root,'src/ui/dev/kit-check.mjs'));
 function visit(node){
  const specifier=ts.isImportDeclaration(node)||ts.isExportDeclaration(node)?node.moduleSpecifier:
   ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:undefined;
  if(specifier&&(ts.isStringLiteral(specifier)||ts.isNoSubstitutionTemplateLiteral(specifier))&&/^\.\.?\//.test(specifier.text))edits.push({start:specifier.getStart(parsed),end:specifier.end,value:JSON.stringify(new URL(specifier.text,base).href)});
  ts.forEachChild(node,visit);
 }
 visit(parsed);
 for(const edit of edits.reverse())source=source.slice(0,edit.start)+edit.value+source.slice(edit.end);
 source=source.replaceAll('5203',String(port)).replace('if(server.exitCode!==null)','if(server&&server.exitCode!==null)');
 const spawnLine=/^\s*server=spawn\([^\n]*await ready\(\);/m;
 if(!spawnLine.test(source))throw new Error('kit Vite 실행 위치가 바뀌었습니다');
 return source.replace(spawnLine,'\n  await ready();');
}
export const stamp=()=>execFileSync('date',['+%Y-%m-%d %H:%M %Z'],{encoding:'utf8'}).trim();
export const json=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
export function args(argv=process.argv.slice(2)){
 const result={};for(let i=0;i<argv.length;i++){if(!argv[i].startsWith('--'))throw new Error(`인자 오류: ${argv[i]}`);const [k,v]=argv[i].slice(2).split('=');result[k]=v??(argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true);}return result;
}
export async function newEvidence(kind){await mkdir(evidence,{recursive:true});return mkdtemp(join(evidence,`${stamp().replace(/[^\w-]/g,'-')}-${kind}-`));}
export async function fingerprint(){
 const hash=createHash('sha256');
 async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(['evidence','node_modules','.git'].includes(entry.name))continue;const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(/\.(tsx?|mjs|css|html|json)$/.test(path)){hash.update(path.slice(root.length));hash.update(await readFile(path));}}}
 await walk(join(root,'src'));for(const file of ['vite.config.ts','package.json','package-lock.json'])hash.update(await readFile(join(root,file)).catch(()=>''));return hash.digest('hex');
}
export function browserLaunchOptions(profile,{classicScrollbars=false}={}){
 return {executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-gpu',`--disk-cache-dir=${profile}`],...(classicScrollbars?{ignoreDefaultArgs:['--hide-scrollbars']}:{})};
}
/** The full browser command line is not available without Chrome automation; record our launch options. */
export function perfLaunchEnvironment(options){
 return {chromeFlags:'unavailable',chromeLaunchArgs:options.args,chromeIgnoredDefaultArgs:options.ignoreDefaultArgs};
}
export async function runtime(options={}){
 let server,browser,profile;
 try{
  server=await createServer(viteOptions);await server.listen();
  const port=server.httpServer.address().port;if(port===5173)throw new Error('5173 포트 사용 금지');
  profile=await mkdtemp(join(os.tmpdir(),'navis-i5-'));
  const perfLaunchOptions=options.classicScrollbars?browserLaunchOptions(profile,options):undefined;
  // Playwright owns and closes only this Chrome process; no connection to an existing browser.
  browser=await chromium.launch(browserLaunchOptions(profile,options));
  let closed=false;
  const cleanup=async()=>{if(closed)return;closed=true;process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);try{await browser.close();}finally{try{await server.close();}finally{await rm(profile,{recursive:true,force:true});}}};
  const interrupt=()=>void cleanup().finally(()=>process.exit(130)),terminate=()=>void cleanup().finally(()=>process.exit(143));
  process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
  return {browser,base:`http://127.0.0.1:${port}`,environment:{recordedAt:stamp(),node:process.version,chrome:browser.version(),cpu:os.cpus()[0]?.model,cores:os.cpus().length,platform:os.platform(),port},...(perfLaunchOptions?{perfLaunchOptions}:{}),close:cleanup};
 }catch(error){await browser?.close();await server?.close();if(profile)await rm(profile,{recursive:true,force:true});throw error;}
}
export async function settled(page){
 await page.evaluate(()=>document.fonts.ready);let last='';
 for(let i=0;i<30;i++){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const next=await page.evaluate(()=>[...document.querySelectorAll('.ui-panel-content')].map(e=>`${e.innerHTML.length}/${e.scrollWidth}/${e.scrollHeight}/${e.querySelectorAll('[data-fit-hidden],[hidden]').length}`).join('|'));
 if(next===last&&i>2)return;last=next;await page.waitForTimeout(60);}
 throw new Error('패널 fit 안정화 시간 초과');
}
