// Camera page (SCR-351) layout shots via Chrome DevTools Protocol. Run: node --experimental-websocket shot.mjs <outdir> [y4m]
import { spawn } from "node:child_process";
import fs from "node:fs";
const out = process.argv[2] || "evidence/after";
const y4m = process.argv[3] || `${process.env.HOME}/Datasets/cafe-sample/fakecam/cafe17_720p15.y4m`;
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const udd = fs.mkdtempSync("/private/tmp/camshot-");
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${udd}`, "--no-first-run",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`, "about:blank"], { stdio: "ignore" });
let ver; for (let i = 0; i < 50; i++) { try { ver = await (await fetch("http://127.0.0.1:9333/json/version")).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { targetId } = await call("Target.createTarget", { url: "about:blank" });
const { sessionId: S } = await call("Target.attachToTarget", { targetId, flatten: true });
const ev = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, S)).result.value;

const SIZES = [["p360x640", 360, 640], ["p390x844", 390, 844], ["p430x932", 430, 932], ["l844x390", 844, 390], ["l640x360", 640, 360]];
const LANGS = ["ko", "en", "zh-Hans"];
const STATES = ["intro", "asking", "denied", "sending", "sending-reconnecting", "sending-warn", "stopped", "lost", "server", "busy", "expired", "replaced"];
const report = [];
await call("Page.enable", {}, S);
for (const lang of LANGS) for (const [name, w, h] of SIZES) {
  const land = w > h;
  await call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: land ? "landscapePrimary" : "portraitPrimary", angle: land ? 90 : 0 } }, S);
  await call("Emulation.setTouchEmulationEnabled", { enabled: true }, S);
  await call("Page.navigate", { url: `http://127.0.0.1:8099/?c=ABC123&lang=${lang}` }, S);
  await sleep(700);
  await ev(`document.getElementById("b-start").click()`); await sleep(1200); // real fake camera -> preview video has stream
  for (const st of STATES) {
    await ev(`(function(){var st=${JSON.stringify(st)},base=st.split("-")[0];
      document.querySelectorAll(".screen").forEach(function(s){s.hidden=s.id!=="s-"+base});
      var live=document.getElementById("live");live.textContent="";
      function setLive(txt,on){var d=document.createElement("span");d.className="dot"+(on?"":" off");var l=document.createElement("span");l.textContent=txt;live.appendChild(d);live.appendChild(l);}
      var T=window.NAVIS_I18N[document.documentElement.lang];
      if(base==="sending"){setLive(T[st==="sending-reconnecting"?"phone.reconnecting":"phone.sending"],st!=="sending-reconnecting");document.getElementById("sleep-warn").hidden=st!=="sending-warn";}
      document.getElementById("preview").play&&document.getElementById("preview").play().catch(function(){});})()`);
    await sleep(250);
    const m = await ev(`(function(){var de=document.documentElement,r={sw:de.scrollWidth,iw:innerWidth,sh:Math.max(de.scrollHeight,document.body.scrollHeight),ih:innerHeight,btn:[],clip:[]};
      document.querySelectorAll(".screen:not([hidden]) button").forEach(function(b){var q=b.getBoundingClientRect();r.btn.push([Math.round(q.width),Math.round(q.height),b.scrollWidth>b.clientWidth+1||b.scrollHeight>b.clientHeight+1]);});
      var v=document.getElementById("preview").getBoundingClientRect();r.vid=[Math.round(v.width),Math.round(v.height)];
      var last=document.querySelector(".screen:not([hidden])");var bb=last.getBoundingClientRect();r.bottom=Math.round(bb.bottom);return r;})()`);
    const bad = m.sw > m.iw || m.sh > m.ih || m.btn.some((b) => b[2]);
    report.push({ lang, size: name, state: st, ...m, scroll: m.sh > m.ih, hscroll: m.sw > m.iw });
    const shot = await call("Page.captureScreenshot", { format: "png" }, S);
    fs.writeFileSync(`${out}/${lang}_${name}_${st}.png`, Buffer.from(shot.data, "base64"));
  }
}
fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
const bad = report.filter((r) => r.scroll || r.hscroll || r.btn.some((b) => b[2]) || (r.state.startsWith("sending") && r.vid[0] < 160));
console.log(`shots=${report.length} problems=${bad.length}`);
for (const r of bad) console.log(r.lang, r.size, r.state, `scroll v ${r.sh}/${r.ih} h ${r.sw}/${r.iw}`, "vid", r.vid, "btn", JSON.stringify(r.btn));
chrome.kill(); process.exit(0);
