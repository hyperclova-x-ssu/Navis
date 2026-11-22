const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** Keep the geometry and animation vocabulary of the owner reference in versioned code. */
export function renderChatCountdown(story, exampleHtml, { crops, pace }) {
  const { scenes, chatCountdown: chat } = story;
  const texts = new Map(story.texts.map(text => [text.textId, text.text]));
  const originalStyle = exampleHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  if (!originalStyle) throw new Error('Missing ref-1 reference stylesheet');
  const copy = (id, cls, extra = '') => `<span class="${cls}" data-text="${id}"${extra}>${escape(texts.get(id))}</span>`;
  const picture = (id, cls = '') => `<img class="${cls}" data-photo="${escape(id)}" src="assets/photos/${escape(id)}.jpg" alt="">`;
  const scene = (index, content, cls = 'fill') => `<section class="scene" data-scene="${scenes[index].sceneId}">
    ${picture(scenes[index].photoIds[0], cls)}${content}${copy(chat.reactions[index], 'reaction', ` data-reaction="${index}"`)}
  </section>`;
  const notification = (id, i) => `<div class="notif" style="top:${640 + i * 172}px" data-notification="${i}">
    <div class="icon"></div><div class="body">${copy(chat.sender, 'who')}${copy(id, 'msg')}</div>
  </div>`;
  const cards = scenes[2].photoIds.slice(1).map((id, i) => `<figure>${picture(id)}${copy(chat.names[i], 'card-name')}</figure>`).join('');
  const endName = texts.get(chat.storeName);
  const characters = [...endName].reduce((width, ch) => width + (/\p{Script=Hangul}|\p{Script=Han}/u.test(ch) ? 1 : 0.58), 0);
  const nameSize = Math.max(64, Math.min(168, Math.floor(895 / Math.max(characters, 1))));
  const ending = `<div class="dim"></div><div class="end-signature">
    ${copy(chat.storeName, 'end-name', ` style="font-size:${nameSize}px"`)}<div class="end-rule"></div>
    ${copy(story.ending.taglineTextId, 'end-line end-tag')}${copy(chat.location, 'end-line end-loc')}${copy(story.ending.ctaTextId, 'end-line end-cta')}
  </div>`;
  const lock = `<div class="dim lock-dim"></div>${copy(chat.date, 'lock-date')}${copy(chat.clock, 'lock-time')}${chat.notifications.map(notification).join('')}`;
  const base = [scene(0, lock, 'fill blur'), scene(1, ''), scene(2, cards ? `<aside class="other-menus">${copy(chat.other, 'other-label')}<div>${cards}</div></aside>` : ''),
    scene(3, '<div class="sold-flash"></div>'), scene(4, ending, 'fill blur')].join('');
  const numbers = chat.numbers.map(([value, id]) => copy(id, `num outline ${!value ? 'n-red' : value === 1 ? 'n-orange' : 'n-yellow'}`,
    ` data-countdown="${value}"`)).join('');
  const caption = `<div class="cap">${copy(chat.room, 'cap1 outline')}<div class="cap2">${copy(chat.menu, 'w outline')}
    <span class="slot">${numbers}</span>${chat.left ? copy(chat.left, 'w outline rest') : ''}</div></div>`;
  const messages = chat.chats.map(({ id, outgoing, photoId }) => `<div class="grp ${outgoing ? 'out' : 'in'}" data-chat>
    ${outgoing ? '' : `<div class="who-row"><span class="avatar"></span>${copy(chat.friend, 'who-name outline')}</div>`}
    ${photoId ? `<div class="pbub">${picture(photoId)}</div>` : ''}${copy(id, `bub ${outgoing ? 'y' : 'w'}`)}
  </div>`).join('');
  const focalY = { upper: 44, center: 50, lower: 56 }[crops];
  const bubbleSeconds = pace === 'snappy' ? 0.18 : 0.2;
  const style = `
.scene{visibility:hidden}.lock-dim{background:rgba(0,0,0,.25)}.notif .icon{background:#715580}.notif,.cap,.grp{visibility:hidden}
.scene:not([data-current]) :is(.lock-date,.lock-time,.other-menus,.end-signature){visibility:hidden}
.cap2{gap:8px}.cap2 .w{font-size:60px}.slot{width:115px}.num{display:none;width:115px;font-size:64px}.cap[data-sold] .slot{width:150px}.cap[data-sold] .num{width:150px}.cap[data-sold] .rest{display:none}
.grp{gap:var(--gap,6px)}.bub{overflow-wrap:anywhere}.chat, .cap{pointer-events:none}.sold-flash{position:absolute;inset:0;background:#ff3b30;opacity:0}
.reaction{position:absolute;right:84px;top:475px;font-size:42px;line-height:58px;font-family:"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif;opacity:0}
.other-menus{position:absolute;left:95px;right:95px;top:570px;text-align:center}.other-label{display:inline-block;font:700 38px "Navis Sans",sans-serif;background:#302642;padding:8px 20px;border-radius:32px}
.other-menus>div{display:flex;justify-content:center;gap:18px;margin-top:12px}.other-menus figure{width:320px;margin:0;border:8px solid #fff7eb;border-radius:20px;overflow:hidden;background:#fff7eb;color:#18121d}.other-menus img{width:100%;height:214px;display:block;object-fit:cover}.card-name{display:block;padding:4px;font:700 38px "Navis Sans",sans-serif;overflow-wrap:anywhere}
.end-signature{position:absolute;inset:0}.end-name{line-height:1.14;letter-spacing:0;overflow-wrap:anywhere}.end-line{overflow-wrap:anywhere}.end-loc{color:#eee8df}
`;
  const code = `
const starts=${JSON.stringify(scenes.map(scene => scene.start))};
const ticks=${JSON.stringify(chat.countTimes)};
const windows=${JSON.stringify(chat.chats.map(({ start, end }) => [start, end]))};
const scenes=[...document.querySelectorAll('.scene')];
const messages=[...document.querySelectorAll('[data-chat]')];
const nums=[...document.querySelectorAll('[data-countdown]')];
const caption=document.querySelector('.cap');
const bound=x=>Math.max(0,Math.min(1,x));
const ease=x=>1-Math.pow(1-bound(x),3);
window.__duration=${story.lengthSec};
window.__onFrame=t=>{
  const sceneIndex=starts.findLastIndex(start=>t>=start), age=t-starts[sceneIndex];
  for(const [i,scene] of scenes.entries()){
    const start=starts[i], stop=starts[i+1]??window.__duration;
    const current=i===sceneIndex;
    const live=current || (i===sceneIndex-1 && age<.15);
    scene.toggleAttribute('data-current',current);
    scene.style.visibility=live?'visible':'hidden';
    if(!live) continue;
    scene.style.opacity=current?1:.999;
    const u=bound((t-start)/(stop-start));
    const zoom=i===0||i===4?1.18+u*.045:i===2?1.10-.07*u:1.04+.10*u;
    const photo=scene.querySelector('.fill');
    photo.style.opacity=current&&i>0?bound(age/.15):1;
    photo.style.objectPosition='50% '+(i===1||i===3?${focalY}:50)+'%';
    photo.style.transform='scale('+zoom+') translate('+(i===2?(1-u)*28:-u*30)+'px,'+(i===4?u*-40:u*-24)+'px)';
    scene.querySelector('[data-reaction]').style.opacity=i===sceneIndex?ease((age-.29)/.25):0;
  }
  const notificationStarts=[.16,.96];
  for(const note of document.querySelectorAll('[data-notification]')){
    const from=notificationStarts[Number(note.dataset.notification)], shown=ease((t-from)/.24);
    note.style.visibility=sceneIndex===0&&shown>0?'visible':'hidden';
    note.style.opacity=shown; note.style.transform='translateY('+(-40*(1-shown))+'px)';
  }
  const liveChat=sceneIndex>=1&&sceneIndex<=3;
  const active=ticks.findLastIndex(tick=>t>=tick);
  caption.style.visibility=liveChat&&(sceneIndex!==3||active===ticks.length-1)?'visible':'hidden';
  caption.toggleAttribute('data-sold',liveChat&&active===ticks.length-1);
  nums.forEach((node,i)=>{
    node.style.display=liveChat&&i===active?'block':'none';
    const progress=bound((t-ticks[i])/.18);
    node.style.transform='scale('+(1+.12*Math.sin(Math.PI*progress))+')';
  });
  const entrances=windows.map(([from,to])=>t>=from&&t<to&&liveChat?ease((t-from)/${bubbleSeconds}):0);
  messages.forEach((bubble,i)=>{
    const progress=entrances[i];
    bubble.style.visibility=progress>0?'visible':'hidden';
    if(!progress) return;
    let lift=0;
    for(let j=i+1;j<messages.length;j++) lift+=(messages[j].offsetHeight+22)*entrances[j];
    bubble.style.opacity=progress;
    bubble.style.transform='translateY('+((1-progress)*55-lift)+'px) scale('+(0.96+progress*.04)+')';
  });
  scenes[3].querySelector('.sold-flash').style.opacity=sceneIndex===3?.33*Math.sin(Math.PI*bound(age/.25)):0;
  if(sceneIndex===4){
    for(const [i,element] of [...scenes[4].querySelector('.end-signature').children].entries()){
      const progress=ease((age-i*.16)/(i===0?.6:.32));
      element.style.opacity=progress;
    }
  }
};
window.__onFrame(0);`;
  return `<!doctype html><html lang="${story.locale}"><head><meta charset="utf-8"><style>${originalStyle}${style}</style></head>
  <body><main id="stage">${base}${caption}<div class="chat">${messages}</div></main><script>${code}</script></body></html>`;
}
