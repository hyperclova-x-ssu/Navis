// Navis camera page (SCR-351, API-15/16). No framework. Nothing is stored except the session token in sessionStorage.
/* global window, document, navigator, location, URLSearchParams, sessionStorage, WebSocket, performance, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, Blob, fetch */
(function () {
  "use strict";
  var DICT = window.NAVIS_I18N || {};
  var qs = new URLSearchParams(location.search);
  var code = (qs.get("c") || "").toUpperCase();
  var TOKEN_KEY = "navis.cam.token";
  var RETRY_WINDOW_MS = 5 * 60 * 1000;
  var BACKOFF = [1000, 2000, 4000];

  function pickLang() {
    var cands = [qs.get("lang"), navigator.language].concat(navigator.languages || []);
    for (var i = 0; i < cands.length; i++) {
      var l = (cands[i] || "").toLowerCase();
      if (!l) continue;
      if (l === "ko" || l.indexOf("ko-") === 0) return "ko";
      if (l === "en" || l.indexOf("en-") === 0) return "en";
      if (l === "zh-hant" || l.indexOf("zh-hant") === 0 || l === "zh-tw" || l === "zh-hk" || l === "zh-mo") return "zh-Hant";
      if (l === "zh" || l.indexOf("zh-") === 0) return "zh-Hans";
    }
    return "ko";
  }
  var lang = pickLang();
  var T = DICT[lang] || DICT.ko || {};
  function t(k) { return T[k] || (DICT.ko && DICT.ko[k]) || k; }
  document.documentElement.lang = lang;
  document.title = t("phone.title");
  Array.prototype.forEach.call(document.querySelectorAll("[data-t]"), function (el) {
    el.textContent = t(el.getAttribute("data-t"));
  });

  var $ = function (id) { return document.getElementById(id); };
  var video = $("preview"), canvas = $("canvas"), liveEl = $("live");
  var state = { screen: "", sent: 0, acked: 0, skipped: 0, closeCode: null, lang: lang };
  window.__navisCam = state; // read-only debug view for automated checks

  function show(name) {
    state.screen = name;
    Array.prototype.forEach.call(document.querySelectorAll(".screen"), function (s) {
      s.hidden = s.id !== "s-" + name;
    });
  }
  function setLive(textKey, on) {
    liveEl.textContent = "";
    if (!textKey) return;
    var dot = document.createElement("span");
    dot.className = "dot" + (on ? "" : " off");
    dot.setAttribute("aria-hidden", "true");
    var label = document.createElement("span");
    label.textContent = t(textKey);
    liveEl.appendChild(dot);
    liveEl.appendChild(label);
  }

  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY + ":" + code); } catch { return null; } }
  function setToken(v) {
    try { if (v) sessionStorage.setItem(TOKEN_KEY + ":" + code, v); else sessionStorage.removeItem(TOKEN_KEY + ":" + code); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ camera
  var stream = null, wakeLock = null;

  function startCamera() {
    show("asking");
    setLive(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { show("denied"); return Promise.reject(new Error("no media")); }
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 },
               frameRate: { ideal: 30, min: 15 } },
      audio: false
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      return video.play().catch(function () {});
    }, function (err) {
      state.cameraError = err && err.name;
      show("denied"); // nothing is sent to the server; Navis stays "waiting"
      throw err;
    });
  }
  function stopCamera() {
    if (stream) stream.getTracks().forEach(function (tr) { tr.stop(); });
    stream = null;
    video.srcObject = null;
    releaseWake();
  }
  function requestWake() {
    if (!("wakeLock" in navigator)) { $("sleep-warn").hidden = false; return; }
    navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; $("sleep-warn").hidden = true; },
      function () { $("sleep-warn").hidden = false; });
  }
  function releaseWake() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && sending) requestWake();
  });

  // ------------------------------------------------------------------ socket
  var ws = null, params = { maxInflight: 2, maxEdge: 1280, quality: 0.8, fps: 15 };
  var inflight = new Map(), frameId = 0, sending = false, captureTimer = null, pingTimer = null;
  var lastMsgAt = 0, lostSince = 0, attempt = 0, finalState = false;

  function wsUrl(q) { return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/camera?" + q; }

  function connect() {
    var tok = getToken();
    var q = tok ? "s=" + encodeURIComponent(tok) : "c=" + encodeURIComponent(code);
    try { ws = new WebSocket(wsUrl(q)); } catch { onClosed({ code: 1006 }); return; }
    ws.binaryType = "arraybuffer";
    ws.onopen = function () { lastMsgAt = performance.now(); };
    ws.onmessage = function (ev) {
      lastMsgAt = performance.now();
      if (typeof ev.data !== "string") return;
      var m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "hello") {
        setToken(m.sessionToken);
        params = { maxInflight: m.maxInflight || 2, maxEdge: m.maxEdge || 1280, quality: m.quality || 0.8, fps: m.fps || 15 };
        attempt = 0; lostSince = 0; inflight.clear();
        startSending();
      } else if (m.type === "ack") {
        if (inflight.delete(m.frameId)) state.acked++;
      } else if (m.type === "ping") {
        send(JSON.stringify({ type: "pong", t: m.t, phoneT: performance.now() / 1000 }));
      } else if (m.type === "status") {
        if (m.state === "replaced") { finalState = true; finish("replaced"); }
        else if (m.state === "busy") { finalState = true; finish("busy"); }
      }
    };
    ws.onclose = onClosed;
    ws.onerror = function () {};
  }

  function send(data) { if (ws && ws.readyState === 1) { ws.send(data); return true; } return false; }

  function onClosed(ev) {
    state.closeCode = ev && ev.code;
    stopLoops();
    if (finalState) return;
    if (ev && ev.code === 4401) { setToken(null); return finish("expired"); }
    if (ev && ev.code === 4409) return finish("replaced");
    if (!sending && !userStopped) return; // closed before we started; screens handle it
    if (!lostSince) lostSince = performance.now();
    if (performance.now() - lostSince > RETRY_WINDOW_MS) { setLive(null); show("lost"); return; }
    setLive("phone.reconnecting", false);
    var d = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt++;
    setTimeout(connect, d);
  }

  function finish(name) {
    finalState = true;
    stopLoops();
    stopCamera();
    sending = false;
    setLive(null);
    show(name);
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
  }

  function stopLoops() {
    clearTimeout(captureTimer); captureTimer = null;
    clearInterval(pingTimer); pingTimer = null;
  }

  var userStopped = false;
  function startSending() {
    sending = true;
    if (userStopped) { show("stopped"); setLive(null); startPing(); return; }
    show("sending");
    setLive("phone.sending", true);
    requestWake();
    startPing();
    scheduleCapture();
  }
  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(function () {
      send(JSON.stringify({ type: "ping", t: performance.now() / 1000 }));
      if (performance.now() - lastMsgAt > 6000 && ws) { try { ws.close(); } catch { /* ignore */ } } // server silent
    }, 2000);
  }

  function scheduleCapture() {
    clearTimeout(captureTimer);
    var interval = 1000 / (params.fps || 15);
    var next = function () {
      var t0 = performance.now();
      captureOnce();
      captureTimer = setTimeout(next, Math.max(0, interval - (performance.now() - t0)));
    };
    captureTimer = setTimeout(next, interval);
  }

  function captureOnce() {
    if (!sending || userStopped || !ws || ws.readyState !== 1) return;
    var now = performance.now();
    inflight.forEach(function (sentAt, id) { if (now - sentAt > 3000) inflight.delete(id); }); // lost acks
    if (inflight.size >= params.maxInflight || ws.bufferedAmount > 2 * 1024 * 1024) { state.skipped++; return; }
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    var scale = Math.min(1, params.maxEdge / Math.max(vw, vh));
    var w = Math.round(vw * scale), h = Math.round(vh * scale);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    var captureT = performance.now() / 1000;
    var id = frameId++;
    inflight.set(id, now);
    canvas.toBlob(function (blob) {
      if (!blob) { inflight.delete(id); return; }
      var header = new TextEncoder().encode(JSON.stringify({ frameId: id, captureT: captureT, w: w, h: h }));
      var len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, header.length, false);
      if (send(new Blob([len, header, blob]))) state.sent++; else inflight.delete(id);
    }, "image/jpeg", params.quality);
  }

  // ------------------------------------------------------------------ buttons
  $("b-start").onclick = function () {
    startCamera().then(function () { userStopped = false; connect(); }, function () {});
  };
  $("b-denied-retry").onclick = $("b-start").onclick;
  $("b-stop").onclick = function () {
    userStopped = true;
    stopCamera(); // camera light off while stopped
    show("stopped");
    setLive(null);
  };
  $("b-resume").onclick = function () {
    startCamera().then(function () {
      userStopped = false;
      if (ws && ws.readyState === 1) startSending(); else { lostSince = 0; attempt = 0; connect(); }
    }, function () {});
  };
  $("b-reconnect").onclick = function () { lostSince = 0; attempt = 0; startCamera().then(connect, function () {}); };
  $("b-server-retry").onclick = boot;

  // ------------------------------------------------------------------ start
  function boot() {
    if (getToken()) { show("intro"); return; } // same tab reload: reconnect with the session token after tapping start
    if (!code) { show("expired"); return; }
    fetch("/api/pair/check?c=" + encodeURIComponent(code), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (j) {
      if (j.state === "ok") show("intro");
      else if (j.state === "busy") show("busy");
      else show("expired");
    }, function () { show("server"); });
  }
  boot();
})();
