/* Lớp tương thích: cung cấp window.claude.use(...) giống môi trường Claude,
 * nhưng chạy trên máy chủ riêng (server.js). Chỉ kích hoạt khi chưa có window.claude. */
(function () {
  "use strict";
  if (window.claude && window.claude.use) return;

  var POLL = 4000;
  function tok() {
    try { var s = JSON.parse(sessionStorage.getItem("dc_ctl_session_v2") || "null"); return (s && s.w) || ""; } catch (e) { return ""; }
  }
  function hdr(extra) { var h = extra || {}; var t = tok(); if (t) h["x-tmn-w"] = t; return h; }
  function err(code) { var e = new Error(code); e.code = code; return e; }
  function chk(r) {
    if (r.ok) return r.json();
    return r.json().catch(function () { return {}; }).then(function (j) {
      throw err(r.status === 403 ? "permission_denied" : (j && j.error) || "unavailable");
    });
  }

  /* ---------- db ---------- */
  /* listeners[p] = {v, data, exists, cbs:[], gen, writing, q}
   * - gen: tăng mỗi lần ghi; kết quả poll gửi đi trước lần ghi sẽ bị bỏ (tránh bản cũ đè bản vừa lưu)
   * - writing: số lần ghi đang chạy; trong lúc đó không poll
   * - q: hàng đợi ghi tuần tự, để bản lưu sau luôn tới máy chủ sau */
  var listeners = {};
  function L_(p) { return listeners[p] || (listeners[p] = { cbs: [], gen: 0, writing: 0, q: Promise.resolve() }); }
  function fetchDoc(p, v) {
    return fetch("/api/doc?p=" + encodeURIComponent(p) + (v ? "&v=" + v : ""), { cache: "no-store" }).then(chk);
  }
  function poll(p) {
    var L = listeners[p]; if (!L || !L.cbs.length || L.writing) return;
    if (L.polling) { L.again = true; return; }                       // đang hỏi dở → hỏi lại ngay khi xong
    var gen = L.gen; L.polling = true; L.again = false;
    var done = function () { L.polling = false; if (L.again) { L.again = false; setTimeout(function () { poll(p); }, 0); } };
    fetchDoc(p, L.v).then(function (j) {
      done();
      if (j.same || gen !== L.gen || L.writing) return;               // đã có lần ghi xen vào → bỏ kết quả này
      if (L.loaded && L.exists && j.exists && +j.v < +L.v) return;     // bản cũ hơn bản đang có → bỏ
      var changed = !L.loaded || j.v !== L.v || j.exists !== L.exists;
      L.loaded = true; L.v = j.v; L.exists = !!j.exists; L.data = j.data;
      if (changed) emit(p);
    }).catch(function (e) { done(); L.cbs.forEach(function (c) { if (c.e) try { c.e(e); } catch (x) {} }); });
  }
  function emit(p) {
    var L = listeners[p];
    var snap = { exists: L.exists, data: function () { return L.data ? JSON.parse(JSON.stringify(L.data)) : undefined; } };
    L.cbs.slice().forEach(function (c) { try { c.f(snap); } catch (x) { console.error(x); } });
  }
  /* Máy chủ đẩy thay đổi tức thì; khi kết nối đẩy đang sống thì chỉ hỏi lại thưa (30 giây) để phòng hờ,
   * khi đứt thì quay về hỏi mỗi 4 giây. EventSource tự kết nối lại. */
  var LIVE = false, lastPoll = 0;
  try {
    var es = new EventSource("/api/watch");
    es.onopen = function () { LIVE = true; Object.keys(listeners).forEach(poll); };   // vừa nối lại → lấy bản mới nhất
    es.onerror = function () { LIVE = false; };
    es.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (x) { return; }
      if (m && m.k === "adm") { try { window.dispatchEvent(new Event("tmn-adm")); } catch (x) {} return; }
      if (m && m.k === "kick") { try { window.dispatchEvent(new CustomEvent("tmn-kick", { detail: m.s })); } catch (x) {} return; }
      var L = m && listeners[m.p]; if (!L) return;
      if (!L.loaded || +m.v > +(L.v || 0)) poll(m.p);
    };
  } catch (e) {}
  setInterval(function () {
    if (document.hidden) return;
    var now = Date.now(); if (LIVE && now - lastPoll < 30000) return;
    lastPoll = now; Object.keys(listeners).forEach(poll);
  }, POLL);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) Object.keys(listeners).forEach(poll); });

  var db = {
    doc: function (p) {
      return {
        onSnapshot: function (f, e) {
          var L = L_(p);
          var c = { f: f, e: e }; L.cbs.push(c);
          if (L.loaded) setTimeout(function () { try { f({ exists: L.exists, data: function () { return L.data ? JSON.parse(JSON.stringify(L.data)) : undefined; } }); } catch (x) {} }, 0);
          else poll(p);
          return function () { var i = L.cbs.indexOf(c); if (i >= 0) L.cbs.splice(i, 1); };
        },
        get: function () { return fetchDoc(p).then(function (j) { return { exists: !!j.exists, data: function () { return j.data; } }; }); },
        set: function (data) {
          var L = L_(p), body = JSON.stringify(data);
          L.gen++; L.writing++;
          var run = function () {
            return fetch("/api/doc?p=" + encodeURIComponent(p), { method: "PUT", headers: hdr({ "Content-Type": "application/json" }), body: body })
              .then(chk).then(function (j) {
                L.gen++;
                if (!L.loaded || !L.v || +j.v >= +L.v) { L.loaded = true; L.v = j.v; L.exists = true; L.data = JSON.parse(body); }
                return j;
              });
          };
          var pr = L.q.then(run, run);
          L.q = pr.catch(function () {});
          return pr.then(function (j) { L.writing--; if (!L.writing && L.cbs.length) emit(p); return j; },
                         function (e) { L.writing--; throw e; });
        },
      };
    },
  };

  /* ---------- room (mỗi tài khoản 1 phiên) ---------- */
  var CONN = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var peerCbs = [], myPresence = null, roomTimer = null;
  function roomSync(body) {
    return fetch("/api/room?c=" + CONN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(chk).then(function (j) { peerCbs.slice().forEach(function (c) { try { c({ peers: j.peers || [] }); } catch (x) {} }); return j; });
  }
  function roomLoop() {
    if (roomTimer) return;
    roomTimer = setInterval(function () { if (myPresence || peerCbs.length) roomSync({}).catch(function () {}); }, 8000);
  }
  window.addEventListener("pagehide", function () {
    try { if (myPresence && navigator.sendBeacon) navigator.sendBeacon("/api/room?c=" + CONN, new Blob([JSON.stringify({ presence: { a: null } })], { type: "application/json" })); } catch (e) {}
  });
  var room = {
    presence: function (p) { myPresence = p && p.a ? p : null; roomLoop(); return roomSync({ presence: p || { a: null } }).then(function () {}); },
    onPeers: function (cb) { peerCbs.push(cb); roomLoop(); roomSync({}).catch(function () {}); return function () { var i = peerCbs.indexOf(cb); if (i >= 0) peerCbs.splice(i, 1); }; },
  };

  /* ---------- assets ---------- */
  var assets = {
    upload: function (blob) {
      return fetch("/api/assets", { method: "POST", headers: hdr({ "Content-Type": "application/octet-stream" }), body: blob }).then(chk);
    },
    delete: function (id) {
      return fetch("/api/assets/" + encodeURIComponent(id), { method: "DELETE", headers: hdr() }).then(chk);
    },
  };

  /* ---------- downloads ---------- */
  var downloads = {
    save: function (o) {
      return new Promise(function (ok, no) {
        try {
          var d = o.data, b = d instanceof Blob ? d : new Blob([d]);
          var url = URL.createObjectURL(b), a = document.createElement("a");
          a.href = url; a.download = o.filename || "tai-ve"; a.rel = "noopener";
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
          ok();
        } catch (e) { no(err("unavailable")); }
      });
    },
  };

  var NS = { db: db, room: room, assets: assets, downloads: downloads };
  window.claude = { local: true, use: function (n) { return Promise.resolve(NS[n] || null); } };
})();
