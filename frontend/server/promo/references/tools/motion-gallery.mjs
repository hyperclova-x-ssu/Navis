import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { staticCheck } from '../../check-scene.mjs';
import { createExamplePhotoSource } from '../../photo-source.mjs';
import { checkVideo, recordVideo } from '../../recorder.mjs';
import { openScene, photoAssets } from '../../renderer.mjs';
import { loadReferences, DEFAULT_REFERENCES_DIR } from '../../references.mjs';
import { loadCreativeLibrary } from '../../templates/creative.mjs';

const layout = {
  'beat-cut': '.frame{inset:0}.caption{bottom:380px;font-size:112px;font-weight:900;border-left:25px solid var(--accent)}',
  lens: '.frame{inset:170px 72px 430px;border:8px solid var(--fg)}.extra{display:block;width:350px;height:350px;right:93px;top:245px;border:12px solid var(--accent);border-radius:50%}.caption{bottom:280px}',
  sticker: '.frame{inset:260px 105px 440px;border-radius:52% 48% 64% 36%/36% 52% 48% 64%}.scene:after{width:320px;height:320px;top:155px;left:95px;clip-path:polygon(50% 0,61% 36%,100% 25%,73% 55%,99% 83%,62% 69%,51% 100%,39% 69%,5% 86%,27% 55%,2% 25%,39% 36%)}.caption{bottom:340px;border-radius:58px}',
  'split-duo': '.frame{inset:120px 80px auto;height:850px;border-radius:28px}.extra{display:block;inset:auto 80px 320px;height:604px;border-radius:28px}.caption{bottom:865px;border-radius:50px}',
  scrapbook: '.frame{inset:290px 102px 470px;border:35px solid #fff5dd;border-bottom-width:90px;box-shadow:18px 35px 0 #0004}.scene:after{top:270px;left:344px;width:380px;height:85px;transform:rotate(-7deg);opacity:.6}.caption{bottom:303px;border-radius:0}',
  ticker: '.frame{inset:0 0 278px}.caption{inset:auto 0 300px;padding-left:84px;width:100%;border-left:30px solid var(--accent);font-weight:900}.scene:after{inset:auto 0 263px;width:100%;height:22px}',
  timeline: '.frame{inset:265px 210px 420px 160px;border:18px solid var(--fg);border-radius:30px}.scene:after{left:925px;top:260px;width:20px;height:1070px;transform-origin:top;transform:scaleY(var(--progress))}.caption{bottom:310px;left:135px}',
  magazine: '.frame{inset:520px 125px 275px;border-radius:50% 50% 4px 4px/27% 27% 4px 4px}.caption{top:230px;font-size:114px;font-weight:900;text-align:left;padding:20px;background:var(--bg);color:var(--fg)}',
  'menu-board': '.frame{inset:205px 100px 720px;border:12px double var(--fg);border-radius:6px}.caption{bottom:490px;padding:54px 20px;border-top:5px dashed var(--accent);border-bottom:5px dashed var(--accent);font-size:114px}',
  film: '.frame{inset:460px 160px 455px;border:20px solid #191817}.extra,.third{display:block;left:160px;right:160px;height:360px;opacity:.58}.extra{top:62px}.third{bottom:35px}.scene:before,.scene:after{display:block;inset:0 auto 0 39px;width:55px;background:repeating-linear-gradient(#decaa6 0 30px,#251f17 30px 75px);z-index:5}.scene:after{left:auto;right:39px}.caption{bottom:415px}',
  parallax: '.background{display:block}.frame{inset:280px 160px 550px;border-radius:135px;border:10px solid var(--fg);box-shadow:0 36px 0 #0003}.caption{bottom:370px;border-radius:75px;font-family:"Navis Serif",serif}',
  'moody-night': '.background{display:block;opacity:.35}.frame{inset:185px 72px 385px;border-radius:38px}.scene:after{inset:120px 20px auto;width:100%;height:850px;border-radius:50%;background:radial-gradient(ellipse,#e8943838 0%,transparent 70%);transform:translateX(var(--light));pointer-events:none}.caption{bottom:290px;font-family:"Navis Serif",serif;letter-spacing:.02em}',
};

const escape = value => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const PHOTO = (id, className) => `<div class="${className}"><img data-photo="${id}" src="assets/photos/${id}.jpg" alt=""></div>`;

function preview(profile, menu, length, photoIds) {
  const style = layout[profile.key];
  const first = profile.energy === 'fast' ? 0.8 : 1.1;
  const begins = [0, first, length * 0.59];
  const scenes = begins.map((start, i) => ({ sceneId: `s${i + 1}`, start, duration: (begins[i + 1] ?? length) - start,
    photoIds: [photoIds[i], photoIds[(i + 1) % photoIds.length], photoIds[(i + 2) % photoIds.length]], textIds: [`t${i + 1}`] }));
  const markup = scenes.map(({ sceneId, photoIds: [hero, second, third] }, i) => `
    <section class="scene" data-scene="${sceneId}">
      ${PHOTO(hero, 'background')}${PHOTO(hero, 'frame')}${PHOTO(second, 'extra')}${PHOTO(third, 'third')}
      <p class="caption" data-text="t${i + 1}">${escape(menu.names.ko)}</p>
    </section>`).join('');
  const [bg, fg, accent] = profile.colors;
  const css = `
html,body{margin:0;padding:0}#stage{position:relative;width:1080px;height:1920px;overflow:hidden;--bg:${bg};--fg:${fg};--accent:${accent};background:var(--bg);font-family:"Navis Sans",sans-serif}
.scene{position:absolute;inset:0;background:var(--bg);visibility:hidden;overflow:hidden}
.scene:before,.scene:after{content:"";position:absolute;background:var(--accent);display:block}
.frame,.extra,.third,.background{position:absolute;overflow:hidden}
.extra,.third,.background{display:none}.background{inset:-150px;filter:blur(16px);transform:translateX(var(--back))}
.frame img,.extra img,.third img,.background img{height:100%;width:100%;object-fit:cover;display:block}
.frame{transform:translate(var(--slide),var(--lift)) rotate(var(--turn));clip-path:var(--clip)}
.frame img{transform:translate(var(--pan),var(--up)) scale(var(--zoom))}
.extra img{transform:translate(var(--back),var(--down)) scale(1.14)}
.third{transform:translateY(var(--up))}
.caption{position:absolute;z-index:7;left:84px;width:912px;box-sizing:border-box;background:var(--caption-bg);color:white;
  padding:22px 30px;text-align:center;margin:0;font-size:88px;font-weight:760;line-height:1.12;white-space:normal;word-break:keep-all}
${style}
${profile.fontSlot ? `.caption{font-family:"${profile.fontSlot}","Navis Sans",sans-serif;font-weight:400}` : ''}
`;
  const script = `
const scenes=[...document.querySelectorAll('.scene')];
const starts=${JSON.stringify(begins)}, L=${length}, style=${JSON.stringify(profile.key)};
const ease=x=>x*x*(3-2*x), decay=x=>1-Math.pow(1-x,3), bounded=x=>Math.min(1,Math.max(0,x));
window.__duration=L;
window.__onFrame=t=>{
  const i=t>=starts[2]?2:t>=starts[1]?1:0;
  const u=bounded((t-starts[i])/((starts[i+1]??L)-starts[i])), p=ease(u);
  const enter=decay(bounded(u*4)), dir=i%2?-1:1; let pan=(.5-p)*132*dir, up=(.5-p)*48, zoom=1.14+p*.035;
  let slide=0, lift=0, turn=0, clip='inset(0)', back=-(.5-p)*92, light=-240+p*480;
  switch(style){
    case 'beat-cut':zoom=1.12+Math.floor(u*3)*.035;pan=(.5-p)*170*dir;slide=i?dir*(1-enter)*125:0;break;
    case 'lens':zoom=1.235-.195*p;pan=(1-p)*85*dir;back=-pan*.8;break;
    case 'sticker':zoom=1.10+p*.06;clip='circle('+Math.round(59+enter*19)+'% at 50% 52%)';lift=(1-enter)*75-8*Math.sin(u*12);break;
    case 'split-duo':slide=dir*(1-enter)*95;up=90*(.5-p);pan=58*(.5-p);back=-pan;break;
    case 'scrapbook':lift=(1-enter)*127;turn=dir*(2.5-2.1*enter);pan=(.5-p)*108;break;
    case 'ticker':slide=dir*(1-enter)*90;pan=13*dir+(1-p)*122;break;
    case 'timeline':slide=dir*(1-enter)*105;turn=dir*(1-enter)*2;break;
    case 'magazine':clip='inset('+Math.round(6-6*enter)+'% 0 0 0 round 42% 42% 1% 1%)';up=(.5-p)*102;pan=0;break;
    case 'menu-board':clip='inset(0 '+Math.round((1-enter)*26)+'% 0 0)';pan=(.5-p)*100;break;
    case 'film':lift=(.5-p)*112;up=(.5-p)*125;break;
    case 'parallax':slide=(.5-p)*132;pan=(p-.5)*58;zoom=1.14+p*.08;break;
    case 'moody-night':zoom=1.08+p*.09;pan=(.5-p)*84;up=(p-.5)*74;break;
  }
  for(let n=0;n<scenes.length;n++) scenes[n].style.visibility=n===i?'visible':'hidden';
  const s=scenes[i].style;
  for(const [k,v] of Object.entries({slide:slide+'px',lift:lift+'px',turn:turn+'deg',clip,pan:pan+'px',up:up+'px',
    down:-up+'px',zoom,back:back+'px',light:light+'px',progress:Math.max(.01,t/L),'caption-bg':i%2?'#28221b':'#1b1816'})) s.setProperty('--'+k,v);
};
window.__onFrame(0);`;
  return { html: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body><main id="stage">${markup}</main><script>${script}</script></body></html>`,
    story: { scenes } };
}

export async function renderMotionGallery({ ffmpeg, chromium, browserPath, ids, directory = DEFAULT_REFERENCES_DIR, render = true, log = console.log }) {
  const source = createExamplePhotoSource({ sourceId: 'cafe' });
  const references = loadReferences(directory);
  const menus = source.listCatalog().menus;
  for (const profile of loadCreativeLibrary().references.values()) {
    if (ids && !ids.includes(profile.id)) continue;
    const folder = join(directory, profile.id);
    await mkdir(folder, { recursive: true });
    const metaPath = join(folder, 'meta.json');
    const old = JSON.parse(await readFile(metaPath, 'utf8').catch(error => error.code === 'ENOENT' ? '{}' : Promise.reject(error)));
    const lengths = Object.fromEntries([10, 15, 30].map((time, i) => [time, {
      sceneCount: { min: [3, 4, 6][i], max: [7, 10, 16][i] }, photoSlots: { max: [6, 8, 12][i] },
      minSceneSec: profile.key === 'beat-cut' ? 0.45 : 1,
    }]));
    const meta = { id: profile.id, version: '1', nameKey: `promo.ref.${profile.id}.name`, cardAspect: '9:16',
      previewFrom: 0, previewTo: 4, posterAt: 0.55, moods: [], concepts: [], lengths,
      ...old, motion: { ...profile, lengths } };
    const length = Math.round((meta.previewTo - meta.previewFrom) * 30) / 30;
    const menu = menus.find(item => item.menuId === profile.previewMenuId);
    if (!menu || menu.photoIds.length < 3) throw new Error(`Missing gallery menu for ${profile.id}`);
    const photoIds = menu.photoIds.slice(0, 3);
    const { html, story } = preview(profile, menu, length, photoIds);
    const errors = staticCheck(html, { story, rules: references.rules });
    if (errors.length) throw new Error(`Gallery scene ${profile.id} failed static validation`);
    if (render) {
      const assets = await photoAssets(source, photoIds);
      const next = join(folder, 'preview-next.mp4');
      await recordVideo({ html, lengthSec: length, outFile: next, width: 360, height: 640, fadeOutSec: 0,
        assets, fonts: references.fonts, browserPath, chromium, ffmpeg, timeoutMs: 120000 });
      const checked = await checkVideo({ ffmpeg, file: next, lengthSec: length, rules: references.rules,
        width: 360, height: 640, expectAudio: false });
      if (checked.violations.length) throw new Error(`Gallery ${profile.id} ${JSON.stringify(checked.violations)}`);
      const scene = await openScene({ html, assets, fonts: references.fonts, browserPath, scale: 1/3, chromium, readFont: readFile });
      if (!scene.ok) throw new Error(`Cannot load poster for ${profile.id}`);
      try {
        await scene.seek(0.5);
        await writeFile(join(folder, 'poster.jpg'), await scene.screenshot());
      } finally { await scene.close(); }
      await rename(next, join(folder, 'preview.mp4'));
      log(JSON.stringify({ id: profile.id, menu: menu.names.ko, ...checked.info }));
    }
    await writeFile(join(folder, 'motion-example.html'), html);
    await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
  }
}
