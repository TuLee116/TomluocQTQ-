/* TMN Quy trình – máy chủ Node (không cần thư viện ngoài)
 * - Phục vụ trang tĩnh trong public/ (nội dung đã mã hoá sẵn)
 * - API lưu dữ liệu đồng bộ (thay cho kho db của Claude): /api/doc
 * - Phiên đăng nhập 1 thiết bị: /api/room
 * - Tệp tải lên: /api/assets, /_blob/:id
 * - Nhật ký đăng nhập + phiên đang mở: /api/auth/log, /api/sess, /api/admin/* (chỉ vinhtu)
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUB = path.join(__dirname, "public");
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const DOCS = path.join(DATA, "docs");
const BLOBS = path.join(DATA, "blobs");
fs.mkdirSync(DOCS, { recursive: true });
const LOGDIR = path.join(DATA, "logs");
fs.mkdirSync(BLOBS, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const TOK_SUPER = process.env.SUPER_PASS ? sha("tmn-w|" + process.env.SUPER_PASS) : null;
const TOK_ADMIN = process.env.ADMIN_PASS ? sha("tmn-w|" + process.env.ADMIN_PASS) : null;
if (!TOK_SUPER) console.warn("[!] Chưa đặt SUPER_PASS – sẽ không ai lưu được nội dung.");

function roleOf(req) {
  const t = String(req.headers["x-tmn-w"] || "");
  if (!t || t.length !== 64) return null;
  const eq = (a, b) => a && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (eq(TOK_SUPER, t)) return "super";
  if (eq(TOK_ADMIN, t)) return "admin";
  return null;
}

/* ---------- Quyền ghi ---------- */
function canWrite(role, p) {
  if (!role) return false;
  if (role === "super") return true;
  if (role === "admin") return p === "content/accounts" || /^accreq\/[\w-]+$/.test(p);
  return false;
}
const PATH_RE = /^(content|accreq)\/[\w-]{1,64}$/;
const docFile = (p) => path.join(DOCS, p.replace("/", "__") + ".json");

/* ---------- Tiện ích ---------- */
function send(res, code, body, headers) {
  const h = Object.assign({ "Cache-Control": "no-store" }, headers || {});
  if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    h["Content-Type"] = "application/json; charset=utf-8";
  }
  res.writeHead(code, h);
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((ok, fail) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { fail(Object.assign(new Error("too_large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}
function writeAtomic(file, buf) {
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/* ---------- Đẩy thay đổi tức thì (Server-Sent Events) ----------
 * Trình duyệt mở /api/watch và giữ kết nối; mỗi lần có bản lưu mới, máy chủ báo {p, v} ngay
 * để mọi người đang xem nhận nội dung mới không phải chờ chu kỳ hỏi lại. */
const WATCH = new Set();
function broadcast(p, v) {
  const msg = "data: " + JSON.stringify({ p: p, v: v }) + "\n\n";
  for (const res of WATCH) { try { res.write(msg); } catch (e) { WATCH.delete(res); } }
}
function broadcastRaw(o) {
  const msg = "data: " + JSON.stringify(o) + "\n\n";
  for (const res of WATCH) { try { res.write(msg); } catch (e) { WATCH.delete(res); } }
}
setInterval(() => { for (const res of WATCH) { try { res.write(": ping\n\n"); } catch (e) { WATCH.delete(res); } } }, 20000);

/* ---------- Nhật ký đăng nhập (lưu DATA_DIR/logs/login.jsonl, giữ ~5.000 dòng mới nhất) ---------- */
const LOG_FILE = path.join(LOGDIR, "login.jsonl");
const LOG_KEEP = 5000, LOG_SLACK = 500;
let LOGS = [];
try {
  LOGS = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).slice(-LOG_KEEP);
} catch (e) {}
function addLog(rec) {
  LOGS.push(rec);
  try {
    if (LOGS.length > LOG_KEEP + LOG_SLACK) {
      LOGS = LOGS.slice(-LOG_KEEP);
      writeAtomic(LOG_FILE, LOGS.map((r) => JSON.stringify(r)).join("\n") + "\n");
    } else fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n");
  } catch (e) { console.error("[log]", e.message); }
}
function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (xf || req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "").toString().replace(/^::ffff:/, "").slice(0, 64);
}
const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);
const ROLES = new Set(["super", "admin", "manager", "user"]);
const cleanRole = (r) => (ROLES.has(r) ? r : "user");
/* Chặn ghi log dồn dập từ một IP (tối đa 40 lần/phút) */
const RATE = new Map();
function rateOk(ip, max) {
  const now = Date.now(), m = Math.floor(now / 60000), r = RATE.get(ip);
  if (!r || r.m !== m) { RATE.set(ip, { m: m, n: 1 }); return true; }
  return ++r.n <= max;
}
setInterval(() => { const m = Math.floor(Date.now() / 60000); for (const [k, v] of RATE) if (v.m !== m) RATE.delete(k); }, 60000);

/* ---------- Phiên đang mở (theo sid trong phiên trình duyệt) ---------- */
const SESS = new Map();   // sid -> {sid,u,r,v,ip,ua,lt,seen,act}
const KICKED = new Map(); // sid -> thời điểm bị buộc thoát
const SESS_TTL = 3 * 60000, SESS_MAX = 3000, KICK_TTL = 24 * 3600000;
const SID_RE = /^[a-z0-9]{6,64}$/i;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SESS) if (now - v.seen > SESS_TTL) SESS.delete(k);
  for (const [k, t] of KICKED) if (now - t > KICK_TTL) KICKED.delete(k);
}, 30000);

/* ---------- Phòng (phiên đăng nhập) ---------- */
const ROOM = new Map(); // conn -> {presence, t}
const ROOM_TTL = 30000;
function roomPeers(me) {
  const now = Date.now(), out = [];
  for (const [k, v] of ROOM) {
    if (now - v.t > ROOM_TTL) { ROOM.delete(k); continue; }
    if (k !== me) out.push({ presence: v.presence, kind: "viewer", sameTab: false });
  }
  return out;
}

/* ---------- Trang tĩnh ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".map": "application/json" };
let INDEX = null;
function indexHtml() {
  if (INDEX) return INDEX;
  let h = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
  const tag = '<script src="/claude-shim.js"></script>';
  const i = h.search(/<script[\s>]/i);
  h = i >= 0 ? h.slice(0, i) + tag + h.slice(i) : h.replace(/<\/head>/i, tag + "</head>");
  INDEX = Buffer.from(h, "utf8");
  return INDEX;
}
const SEC = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
function serveStatic(req, res, pathname) {
  if (pathname === "/" || pathname === "/index.html") return send(res, 200, indexHtml(), Object.assign({ "Content-Type": MIME[".html"] }, SEC));
  if (pathname === "/claude-shim.js") {
    return send(res, 200, fs.readFileSync(path.join(__dirname, "claude-shim.js")), Object.assign({ "Content-Type": MIME[".js"] }, SEC));
  }
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB + path.sep)) return send(res, 403, "Forbidden");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    const ext = path.extname(file).toLowerCase();
    const longCache = rel.startsWith("f" + path.sep) || rel.startsWith("pdfjs" + path.sep);
    res.writeHead(200, Object.assign({ "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": longCache ? "public, max-age=604800" : "no-cache" }, SEC));
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- Router ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;

    if (p === "/healthz") return send(res, 200, { ok: true });

    if (p === "/api/watch" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      res.write("retry: 3000\n\n");
      WATCH.add(res);
      req.on("close", () => WATCH.delete(res));
      return;
    }

    // Tài liệu đồng bộ
    if (p === "/api/doc") {
      const dp = String(u.searchParams.get("p") || "");
      if (!PATH_RE.test(dp)) return send(res, 400, { error: "bad_path" });
      const f = docFile(dp);
      if (req.method === "GET") {
        if (!fs.existsSync(f)) return send(res, 200, { exists: false });
        const rec = JSON.parse(fs.readFileSync(f, "utf8"));
        if (u.searchParams.get("v") && String(rec.v) === u.searchParams.get("v")) return send(res, 200, { exists: true, same: true, v: rec.v });
        return send(res, 200, { exists: true, v: rec.v, data: rec.data });
      }
      if (req.method === "PUT") {
        if (!canWrite(roleOf(req), dp)) return send(res, 403, { error: "permission_denied" });
        const body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString("utf8") || "null");
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "invalid_argument" });
        let v = 0;
        try { v = JSON.parse(fs.readFileSync(f, "utf8")).v || 0; } catch (e) {}
        writeAtomic(f, JSON.stringify({ v: v + 1, at: Date.now(), data: body }));
        broadcast(dp, v + 1);
        return send(res, 200, { ok: true, v: v + 1 });
      }
      return send(res, 405, { error: "method" });
    }

    // Nhật ký đăng nhập: trình duyệt báo kết quả mỗi lần bấm Đăng nhập (không bao giờ gửi mật khẩu)
    if (p === "/api/auth/log" && req.method === "POST") {
      const ip = clientIp(req);
      if (!rateOk(ip, 40)) return send(res, 429, { error: "rate" });
      const b = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}") || {};
      const ok = b.ok === true;
      const vr = roleOf(req); // vai trò máy chủ tự xác thực được (super/admin)
      addLog({ t: Date.now(), ev: ok ? "ok" : "fail", u: clip(b.u, 80), r: ok ? cleanRole(b.r) : "", v: vr || "", ip: ip, ua: clip(req.headers["user-agent"], 300) });
      return send(res, 200, { ok: true });
    }

    // Phiên đang mở: hello (vào trang) · ping (30 giây/lần) · bye (đăng xuất)
    if (p === "/api/sess" && req.method === "POST") {
      const b = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}") || {};
      const sid = String(b.sid || "");
      if (!SID_RE.test(sid)) return send(res, 400, { error: "bad_sid" });
      if (KICKED.has(sid)) { SESS.delete(sid); return send(res, 200, { kick: true }); }
      const now = Date.now(), op = String(b.op || "ping");
      if (op === "bye") { SESS.delete(sid); return send(res, 200, { ok: true }); }
      let s = SESS.get(sid);
      if (op === "hello" || s) {
        if (!s) {
          if (SESS.size >= SESS_MAX) return send(res, 503, { error: "full" });
          s = { sid: sid };
          SESS.set(sid, s);
        }
        if (op === "hello") { s.u = clip(b.u, 80); s.r = cleanRole(b.r); s.v = roleOf(req) || ""; s.lt = +b.lt > 0 && +b.lt <= now ? +b.lt : (s.lt || now); }
        s.ip = clientIp(req); s.ua = clip(req.headers["user-agent"], 300); s.seen = now;
        const act = +b.act;
        s.act = act > 0 && act <= now ? Math.max(act, s.act || 0) : (s.act || now);
        return send(res, 200, { ok: true });
      }
      return send(res, 200, { unknown: true }); // máy chủ vừa khởi động lại → trình duyệt gửi lại hello
    }

    // Trang quản trị: chỉ vinhtu (header x-tmn-w khớp SUPER_PASS)
    if (p.startsWith("/api/admin/")) {
      if (roleOf(req) !== "super") return send(res, 403, { error: "permission_denied" });
      if (p === "/api/admin/logs" && req.method === "GET") {
        const lim = Math.min(Math.max(parseInt(u.searchParams.get("limit") || "5000", 10) || 5000, 1), LOG_KEEP + LOG_SLACK);
        return send(res, 200, { total: LOGS.length, items: LOGS.slice(-lim).reverse() });
      }
      if (p === "/api/admin/sessions" && req.method === "GET") {
        const now = Date.now(), items = [];
        for (const v of SESS.values()) if (now - v.seen <= SESS_TTL) items.push(v);
        items.sort((a, b) => (b.lt || 0) - (a.lt || 0));
        return send(res, 200, { now: now, items: items });
      }
      if (p === "/api/admin/kick" && req.method === "POST") {
        const b = JSON.parse((await readBody(req, 1024)).toString("utf8") || "{}") || {};
        const sid = String(b.sid || "");
        if (!SID_RE.test(sid)) return send(res, 400, { error: "bad_sid" });
        const s = SESS.get(sid);
        KICKED.set(sid, Date.now());
        SESS.delete(sid);
        broadcastRaw({ k: "kick", s: sid });
        addLog({ t: Date.now(), ev: "kick", u: s ? s.u : "", r: s ? s.r : "", v: "", ip: s ? s.ip : "", ua: s ? s.ua : "", by: "vinhtu" });
        return send(res, 200, { ok: true, found: !!s });
      }
      return send(res, 404, { error: "not_found" });
    }

    // Phòng: phiên đăng nhập 1 thiết bị
    if (p === "/api/room") {
      const conn = String(u.searchParams.get("c") || "").slice(0, 64);
      if (!/^[\w-]{8,64}$/.test(conn)) return send(res, 400, { error: "bad_conn" });
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
        if (body && body.presence && body.presence.a) ROOM.set(conn, { presence: body.presence, t: Date.now() });
        else if (body && body.presence) ROOM.delete(conn);
        else { const r = ROOM.get(conn); if (r) r.t = Date.now(); }
        return send(res, 200, { peers: roomPeers(conn) });
      }
      if (req.method === "GET") return send(res, 200, { peers: roomPeers(conn) });
      return send(res, 405, { error: "method" });
    }

    // Tệp tải lên (đã mã hoá phía trình duyệt)
    if (p === "/api/assets" && req.method === "POST") {
      if (!roleOf(req)) return send(res, 403, { error: "permission_denied" });
      const buf = await readBody(req, 60 * 1024 * 1024);
      const id = crypto.randomUUID();
      writeAtomic(path.join(BLOBS, id), buf);
      return send(res, 200, { id });
    }
    let m = p.match(/^\/api\/assets\/([\w-]{36})$/);
    if (m && req.method === "DELETE") {
      if (!roleOf(req)) return send(res, 403, { error: "permission_denied" });
      try { fs.unlinkSync(path.join(BLOBS, m[1])); } catch (e) {}
      return send(res, 200, { ok: true });
    }
    m = p.match(/^\/_blob\/([\w-]{36})$/);
    if (m && (req.method === "GET" || req.method === "HEAD")) {
      const f = path.join(BLOBS, m[1]);
      if (!fs.existsSync(f)) return send(res, 404, "Not found");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "private, max-age=86400" });
      return fs.createReadStream(f).pipe(res);
    }

    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, p);
    return send(res, 405, "Method not allowed");
  } catch (e) {
    const code = e && e.code === 413 ? 413 : (e instanceof SyntaxError ? 400 : 500);
    if (code === 500) console.error(e);
    if (!res.headersSent) send(res, code, { error: code === 413 ? "too_large" : code === 400 ? "invalid_argument" : "server_error" });
  }
});

server.listen(PORT, () => console.log("TMN Quy trình chạy tại cổng " + PORT + " · dữ liệu: " + DATA));
