'use strict';
// towerd: holds the in-memory session registry, listens on the local socket
// for wrappers and CLI clients, and serves the status board over localhost HTTP.

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const proto = require('./protocol');
const config = require('./config');
const { createSummarizer } = require('./summarizer');
const { createClaudeWatch, deriveClaudeStatus } = require('./claudewatch');
const { createMailroom } = require('./mailroom');

const WEB_DIR = path.join(__dirname, '..', 'web');

const sessions = new Map(); // id -> session record

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Claude Code transcripts as a second card source; absent dir = no cards.
const claudeWatch = createClaudeWatch({
  notify: () => notifyChange(),
  log,
});

// Session messaging: daemon as mailbox, agents as opt-in readers.
const mailroom = createMailroom({ log });

// "vite-dev", a session id, a cc- transcript id, or "all" -> mailbox ids.
// One logical session gets ONE mailbox: a transcript card that claims a
// wrapper resolves to the wrapper's id (that is the box TOWER_SESSION drains).
// Unknown names are an error; ambiguous names are an error, never a guess.
function resolveRecipients(spec, { includeExited = false } = {}) {
  const wanted = String(spec || '').trim();
  if (!wanted) return { error: 'no recipient given' };
  const pool = [];
  for (const s of sessions.values()) if (includeExited || !s.exited) pool.push(s);
  const agents = [...claudeWatch.records()];
  const claims = claudeClaims();
  const canonical = (id) => (claims.has(id) ? claims.get(id).id : id);
  if (wanted === 'all') {
    const ids = new Set(pool.filter((s) => !s.exited).map((s) => s.id));
    for (const r of agents) ids.add(canonical(r.id));
    return { ids: [...ids], all: true };
  }
  const ids = new Set();
  for (const part of wanted.split(',').map((p) => p.trim()).filter(Boolean)) {
    const hits = [
      ...pool.filter((s) => s.name === part || s.id === part),
      ...agents.filter((r) => r.name === part || r.id === part),
    ];
    if (hits.length === 0) return { error: `no live session named "${part}"` };
    const unique = new Set(hits.map((h) => canonical(h.id)));
    if (unique.size > 1) {
      return { error: `"${part}" is ambiguous (${unique.size} sessions); use an id from tower ls` };
    }
    ids.add([...unique][0]);
  }
  return { ids: [...ids], all: false };
}

// The narrative layer: no key configured means this never makes a call and
// the board behaves exactly as v1. Wrappers claimed by a transcript card are
// excluded - their summary would be paid for and never shown.
const summarizer = createSummarizer({
  collect: () => {
    const claimed = new Set([...claudeClaims().values()].map((s) => s.id));
    return [...[...sessions.values()].filter((s) => !claimed.has(s.id)), ...claudeWatch.records()];
  },
  notify: () => notifyChange(),
  log,
  isLive: (sess) => claudeWatch.get(sess.id) === sess || sessions.get(sess.id) === sess,
});

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------- output ring buffer ----------
// Stores the last ~200 plain-text lines per session. ANSI escapes are stripped
// (the board renders text, the user's own terminal already showed the colors)
// and carriage-return overwrites are collapsed so progress bars keep only
// their latest state.

const sanitize = proto.sanitizeText;

function collapseCR(seg) {
  if (!seg.includes('\r')) return seg;
  const parts = seg.split('\r');
  let line = parts.pop();
  while (line === '' && parts.length) line = parts.pop();
  return line;
}

// An escape sequence split across two output chunks must be reassembled before
// stripping, so the partial line is stored RAW and sanitized only when the line
// completes (or on read, for display).
function sanitizePartial(raw) {
  // also trim a trailing incomplete escape so it never shows as literal junk
  return sanitize(String(raw).replace(/\x1b(?:\[[0-9;?]*[ -\/]*|\][^\x07\x1b]*|)$/, ''));
}

class RingBuffer {
  constructor(maxLines = 200) {
    this.maxLines = maxLines;
    this.lines = [];
    this.partial = ''; // the unterminated last line, raw; this is where prompts live
  }
  push(chunk) {
    const data = (this.partial + String(chunk)).replace(/\r\n/g, '\n');
    const segs = data.split('\n');
    this.partial = segs.pop();
    for (const seg of segs) this.lines.push(collapseCR(sanitize(seg)));
    if (this.partial.length > 4000) this.partial = this.partial.slice(-4000);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }
  tailLine() {
    const p = collapseCR(sanitizePartial(this.partial));
    if (p.trim() !== '') return p;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].trim() !== '') return this.lines[i];
    }
    return '';
  }
  toLines() {
    const out = this.lines.slice();
    const p = collapseCR(sanitizePartial(this.partial));
    if (p !== '') out.push(p);
    return out.slice(-this.maxLines);
  }
  loadLines(lines) {
    this.lines = (Array.isArray(lines) ? lines : []).map(String).slice(-this.maxLines);
    this.partial = '';
  }
}

function lightSession(sess, now = Date.now()) {
  const tailLine = sess.buffer.tailLine();
  return {
    id: sess.id,
    name: sess.name,
    cwd: sess.cwd,
    command: sess.command,
    pid: sess.pid,
    childPid: sess.childPid,
    startedAt: sess.startedAt,
    lastOutputAt: sess.lastOutputAt,
    exited: sess.exited,
    exitCode: sess.exitCode,
    exitSignal: sess.exitSignal,
    exitedAt: sess.exitedAt,
    stale: sess.stale,
    pty: sess.pty,
    status: proto.deriveStatus({ ...sess, tailLine }, now),
    tail: tailLine.slice(-160),
    kind: 'wrapped',
    summary: sess.summary || null,
    unread: mailroom.unread(sess.id),
  };
}

function lightClaude(rec, now = Date.now()) {
  const lastTurn = rec.turns && rec.turns.length ? rec.turns[rec.turns.length - 1] : null;
  return {
    id: rec.id,
    name: rec.name,
    cwd: rec.cwd,
    command: rec.command,
    pid: null,
    childPid: null,
    startedAt: rec.startedAt,
    lastOutputAt: rec.lastActivityAt,
    exited: false,
    exitCode: null,
    exitSignal: null,
    exitedAt: null,
    stale: false,
    pty: false,
    status: deriveClaudeStatus(rec, now),
    tail: lastTurn ? `${lastTurn.role}: ${lastTurn.text.replace(/\s+/g, ' ')}`.slice(0, 160) : '',
    kind: 'claude',
    gitBranch: rec.gitBranch || null,
    summary: rec.summary || null,
    unread: mailroom.unread(rec.id),
  };
}

// Matching is deliberately narrow: the wrapped command's first word must BE
// claude (a path to it and .exe/.cmd/.bat count; npx/bunx claude counts).
// `tail -f claude.log` must not merge into an agent card.
function isClaudeCommand(command) {
  const words = String(command || '').trim().split(/\s+/);
  let first = words[0] || '';
  if (/^(npx|bunx)$/i.test(first)) first = words[1] || '';
  first = path.basename(first.replace(/["']/g, '')).replace(/\.(exe|cmd|bat)$/i, '');
  return first.toLowerCase() === 'claude';
}

function normCwd(p) {
  let s = String(p || '').replace(/[\\/]+$/, '');
  if (process.platform === 'win32') s = s.replace(/\//g, '\\').toLowerCase();
  return s;
}

// Find one session (wrapped or transcript) by name or id, for read paths
// like history. No mailbox canonicalization: a merged pair's summaries live
// on the transcript record, and reads should reach whichever was named.
function findSession(name) {
  const wanted = String(name || '').trim();
  if (!wanted) return { error: 'no session given' };
  const hits = [
    ...[...sessions.values()].filter((s) => s.name === wanted || s.id === wanted),
    ...[...claudeWatch.records()].filter((r) => r.name === wanted || r.id === wanted),
  ];
  if (hits.length === 0) return { error: `no session named "${wanted}"` };
  if (hits.length > 1) return { error: `"${wanted}" is ambiguous (${hits.length} sessions); use an id from tower ls` };
  return { session: hits[0] };
}

// A `tower run claude` wrapper and a transcript record in the same cwd are
// the same session. One source of truth for that pairing: ccId -> wrapper
// record, newest transcript first, each wrapper claimed once. Used by the
// board merge, the summarizer's collect, and kill-through.
function claudeClaims() {
  const claims = new Map();
  const claimed = new Set();
  const agents = [...claudeWatch.records()].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  for (const a of agents) {
    for (const s of sessions.values()) {
      if (claimed.has(s.id) || s.exited || !isClaudeCommand(s.command)) continue;
      if (normCwd(s.cwd) === normCwd(a.cwd)) { claims.set(a.id, s); claimed.add(s.id); break; }
    }
  }
  return claims;
}

function lightList() {
  const now = Date.now();
  const claims = claudeClaims();
  const claimed = new Set([...claims.values()].map((s) => s.id));
  const out = [];
  // The transcript card wins (it knows what the work is about); the wrapper
  // lends mechanical truth, and its terminal prompt state beats file-mtime
  // guesses for "waiting".
  for (const r of claudeWatch.records()) {
    const a = lightClaude(r, now);
    const wrapper = claims.get(a.id);
    if (wrapper) {
      const w = lightSession(wrapper, now);
      a.viaWrapper = w.name;
      a.pid = w.pid;
      a.childPid = w.childPid;
      if (w.tail) a.tail = w.tail;
      if (w.status === 'waiting') a.status = 'waiting';
      // one logical session, one mailbox: the wrapper's (that is what the
      // agent's TOWER_SESSION drains), so the badge must count it
      a.unread = mailroom.unread(wrapper.id);
    }
    out.push(a);
  }
  for (const s of sessions.values()) {
    if (!claimed.has(s.id)) out.push(lightSession(s, now));
  }
  return out;
}

// "daemon" is reserved so `tower kill daemon` is unambiguous.
function dedupeName(base) {
  const taken = new Set(['daemon']);
  for (const s of sessions.values()) if (!s.exited) taken.add(s.name);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function handleRegister(sock, raw) {
  const s = raw || {};
  if (!s.id || typeof s.id !== 'string') return null;
  let sess = sessions.get(s.id);
  if (sess) {
    // A wrapper reconnecting after a daemon restart or a dropped connection.
    sess.sock = sock;
    sess.stale = false;
    sess.pid = s.pid;
    sess.childPid = s.childPid;
  } else {
    sess = {
      id: s.id,
      name: dedupeName(String(s.name || 'session')),
      cwd: String(s.cwd || ''),
      command: String(s.command || ''),
      pid: s.pid,
      childPid: s.childPid,
      startedAt: s.startedAt || Date.now(),
      lastOutputAt: s.startedAt || Date.now(),
      exited: false,
      exitCode: null,
      exitSignal: null,
      exitedAt: null,
      killRequestedAt: null,
      stale: false,
      pty: !!s.pty,
      buffer: new RingBuffer(),
      sock,
    };
    sessions.set(sess.id, sess);
    log(`registered ${sess.name} (${sess.command})`);
  }
  proto.send(sock, { type: 'registered', id: sess.id, name: sess.name });
  notifyChange();
  return sess.id;
}

function handleExit(msg) {
  const sess = sessions.get(msg.id);
  if (!sess) return;
  sess.exited = true;
  sess.exitCode = typeof msg.code === 'number' ? msg.code : null;
  sess.exitSignal = msg.signal || null;
  sess.exitedAt = Date.now();
  log(`exited ${sess.name} code=${sess.exitCode} signal=${sess.exitSignal || '-'}`);
  notifyChange();
}

function markDisconnected(id) {
  const sess = sessions.get(id);
  if (!sess || sess.exited) return;
  // The wrapper vanished without sending an exit. If its process is gone,
  // the session is over; otherwise keep it around as stale so a reconnect heals it.
  if (pidAlive(sess.pid) || pidAlive(sess.childPid)) {
    sess.stale = true;
  } else {
    sess.exited = true;
    sess.exitCode = null;
    sess.exitedAt = Date.now();
  }
  notifyChange();
}

function killSession(name) {
  let target = null;
  for (const s of sessions.values()) {
    if ((s.name === name || s.id === name) && !s.exited) { target = s; break; }
  }
  if (!target) {
    // A merged claude card hides its wrapper's name; killing the card
    // reaches through to the wrapped process.
    for (const rec of claudeWatch.records()) {
      if (rec.name === name || rec.id === name) {
        target = claudeClaims().get(rec.id) || null;
        if (!target) return { type: 'error', message: `"${name}" is a transcript-only session; there is no process for tower to stop` };
        break;
      }
    }
  }
  if (!target) return { type: 'error', message: `no running session named "${name}"` };
  // A tower kill is a deliberate stop: the exit it causes lands as `closed`,
  // not in the attention band, even if the signal mapping is lossy. Persist
  // promptly - a daemon restart inside the kill window must not demote the
  // stop to exited-unknown.
  target.killRequestedAt = Date.now();
  notifyChange();
  if (target.sock && !target.sock.destroyed) {
    proto.send(target.sock, { type: 'kill', id: target.id });
  } else if (pidAlive(target.childPid)) {
    try { process.kill(target.childPid, 'SIGTERM'); } catch { /* best effort */ }
  }
  return { type: 'ok', name: target.name };
}

// ---------- search ----------
// Case-insensitive substring across everything a session knows about itself:
// name, cwd, command, the narrative, and its recent output (conversation
// turns for transcript sessions). Deliberately not regex: dumb and instant.

const SEARCH_MAX_LINES_PER_SESSION = 5;
const SEARCH_MAX_SESSIONS = 50;
const SEARCH_LINE_CAP = 200;

// Pure: one light session + its searchable lines -> match record or null.
function matchSession(light, lines, query) {
  const q = String(query).toLowerCase();
  const fields = [];
  const fieldPairs = [
    ['name', light.name], ['cwd', light.cwd], ['command', light.command],
    ['doing', light.summary && light.summary.doing],
    ['last', light.summary && light.summary.last],
    ['next', light.summary && light.summary.next],
  ];
  for (const [field, value] of fieldPairs) {
    if (value && String(value).toLowerCase().includes(q)) fields.push(field);
  }
  const matchLines = [];
  for (const raw of lines) {
    const line = String(raw);
    const idx = line.toLowerCase().indexOf(q);
    if (idx !== -1) {
      // window long lines around the hit - a snippet that no longer contains
      // the query reads as a false positive
      let snippet = line;
      if (line.length > SEARCH_LINE_CAP) {
        const start = Math.max(0, Math.min(idx - 40, line.length - SEARCH_LINE_CAP));
        snippet = (start > 0 ? '…' : '') + line.slice(start, start + SEARCH_LINE_CAP);
      }
      matchLines.push(snippet);
      if (matchLines.length >= SEARCH_MAX_LINES_PER_SESSION) break;
    }
  }
  if (!fields.length && !matchLines.length) return null;
  return { ...light, matchFields: fields, matchLines };
}

function searchableLines(light, claims) {
  if (light.kind === 'claude') {
    const rec = claudeWatch.get(light.id);
    const lines = [];
    for (const t of (rec && rec.turns) || []) {
      for (const l of t.text.split('\n')) lines.push(`${t.role}: ${l}`);
    }
    // a merged card also answers for its hidden wrapper's terminal output
    const wrapper = claims.get(light.id);
    if (wrapper) lines.push(...wrapper.buffer.toLines());
    return lines;
  }
  const sess = sessions.get(light.id);
  return sess ? sess.buffer.toLines() : [];
}

function searchSessions(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const claims = claudeClaims();
  const out = [];
  for (const light of lightList()) {
    const hit = matchSession(light, searchableLines(light, claims), q);
    if (hit) out.push(hit);
    if (out.length >= SEARCH_MAX_SESSIONS) break;
  }
  return out;
}

// ---------- status board: localhost HTTP + server-sent events ----------

let httpPort = null;
const sseClients = new Set();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// The board serves terminal output and transcript text; a DNS-rebinding page
// could read it cross-origin if we answered arbitrary Host headers.
const HOST_OK_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.headers.host && !HOST_OK_RE.test(req.headers.host)) return json(res, 403, { error: 'forbidden host' });
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  if (u.pathname === '/') {
    return fs.readFile(path.join(WEB_DIR, 'index.html'), (err, data) => {
      if (err) return json(res, 500, { error: 'board page missing' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }
  if (u.pathname === '/api/state') return json(res, 200, { sessions: lightList(), summaries: summarizer.meta() });
  if (u.pathname === '/api/search') return json(res, 200, { results: searchSessions(u.searchParams.get('q')) });
  if (u.pathname === '/api/events') return serveEvents(req, res);
  const m = u.pathname.match(/^\/api\/session\/([\w-]+)$/);
  if (m) {
    // the board reads mailboxes without draining; only a fetch drains
    const cc = claudeWatch.get(m[1]);
    if (cc) {
      const lines = (cc.turns || []).flatMap((t) => [`${t.role}:`, ...t.text.split('\n'), '']);
      const claimedBy = claudeClaims().get(cc.id);
      return json(res, 200, { ...lightClaude(cc), lines, mail: mailroom.fetch(claimedBy ? claimedBy.id : cc.id, { peek: true }), summaryHistory: cc.summaryHistory || [] });
    }
    const sess = sessions.get(m[1]);
    if (!sess) return json(res, 404, { error: 'no such session' });
    return json(res, 200, { ...lightSession(sess), lines: sess.buffer.toLines(), mail: mailroom.fetch(sess.id, { peek: true }), summaryHistory: sess.summaryHistory || [] });
  }
  return json(res, 404, { error: 'not found' });
});

function serveEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');
  sseClients.add(res);
  sseSendTo(res, { type: 'sessions', sessions: lightList(), summaries: summarizer.meta() });
  req.on('close', () => sseClients.delete(res));
}

function sseSendTo(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseBroadcast(obj) {
  if (!sseClients.size) return;
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

let sessionsTimer = null;
function broadcastSessionsSoon() {
  if (sessionsTimer || !sseClients.size) return;
  sessionsTimer = setTimeout(() => {
    sessionsTimer = null;
    sseBroadcast({ type: 'sessions', sessions: lightList(), summaries: summarizer.meta() });
  }, 100);
}

const outputTimers = new Map();
function outputChanged(id) {
  if (!sseClients.size || outputTimers.has(id)) return;
  outputTimers.set(id, setTimeout(() => {
    outputTimers.delete(id);
    const sess = sessions.get(id);
    if (sess) sseBroadcast({ type: 'output', id, lines: sess.buffer.toLines() });
  }, 150));
}

function startHttp() {
  let fellBack = false;
  httpServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !fellBack) {
      fellBack = true;
      log(`port ${proto.DEFAULT_PORT} is taken, falling back to an ephemeral port`);
      httpServer.listen(0, '127.0.0.1');
    } else {
      log('http server error:', e.message);
      process.exit(1);
    }
  });
  httpServer.on('listening', () => {
    httpPort = httpServer.address().port;
    try {
      fs.writeFileSync(proto.daemonInfoPath(), JSON.stringify({ pid: process.pid, port: httpPort, startedAt: Date.now() }), { mode: 0o600 });
    } catch (e) { log('could not write daemon.json:', e.message); }
    log(`status board on http://127.0.0.1:${httpPort}/`);
  });
  httpServer.listen(proto.DEFAULT_PORT, '127.0.0.1');
}

// ---------- persistence: a daemon restart is not amnesia ----------

let saveTimer = null;

function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveStateNow, 1000);
  if (saveTimer.unref) saveTimer.unref();
}

function saveStateNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const data = {
    savedAt: Date.now(),
    sessions: [...sessions.values()].map((s) => ({
      ...lightSession(s),
      lines: s.buffer.toLines(),
      killRequestedAt: s.killRequestedAt || null,
      summaryHistory: s.summaryHistory || [],
      // unread is derived, not state; it rides in via lightSession but is
      // ignored on load (the mailroom owns the truth)
      // summarizer bookkeeping rides along so a restart never re-bills an
      // unchanged session or repeats a done exit pass (board payloads via
      // lightSession never carry these)
      summarySig: (s.summaryCtl && s.summaryCtl.sig) || null,
      summaryExitDone: !!(s.summaryCtl && s.summaryCtl.exitDone),
    })),
    claude: claudeWatch.persistable(),
    mail: mailroom.persistable(),
  };
  try { fs.writeFileSync(proto.statePath(), JSON.stringify(data), { mode: 0o600 }); } catch { /* best effort */ }
}

function loadState() {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(proto.statePath(), 'utf8')); } catch { return; }
  claudeWatch.restore(data.claude);
  mailroom.restore(data.mail);
  const now = Date.now();
  for (const s of data.sessions || []) {
    if (!s || typeof s.id !== 'string') continue;
    const buffer = new RingBuffer();
    buffer.loadLines(s.lines);
    const sess = {
      id: s.id,
      name: String(s.name || 'session'),
      cwd: String(s.cwd || ''),
      command: String(s.command || ''),
      pid: s.pid,
      childPid: s.childPid,
      startedAt: s.startedAt,
      lastOutputAt: s.lastOutputAt,
      exited: !!s.exited,
      exitCode: typeof s.exitCode === 'number' ? s.exitCode : null,
      exitSignal: s.exitSignal || null,
      exitedAt: s.exitedAt || null,
      killRequestedAt: s.killRequestedAt || null,
      stale: false,
      pty: !!s.pty,
      buffer,
      sock: null,
      summary: s.summary || null,
      summaryHistory: Array.isArray(s.summaryHistory) ? s.summaryHistory : [],
      summaryCtl: { sig: s.summarySig || undefined, exitDone: !!s.summaryExitDone },
    };
    if (!sess.exited) {
      if (pidAlive(sess.pid) || pidAlive(sess.childPid)) {
        // Its wrapper is alive and will reconnect within a few seconds.
        sess.stale = true;
      } else {
        sess.exited = true;
        sess.exitCode = null;
        sess.exitedAt = data.savedAt || now;
      }
    }
    if (sess.exited) {
      const ttl = proto.isUserClosed(sess) ? config.effectiveCached().closed_ttl_seconds * 1000 : proto.EXITED_TTL_MS;
      if (now - (sess.exitedAt || 0) > ttl) continue;
    }
    sessions.set(sess.id, sess);
  }
  if (sessions.size) log(`restored ${sessions.size} session(s) from ${proto.statePath()}`);
}

// Stale sessions whose processes are gone become exited; old exited cards
// expire - user-closed ones on their own configurable clock.
function cleanupSweep() {
  const now = Date.now();
  const closedTtlMs = config.effectiveCached().closed_ttl_seconds * 1000;
  let changed = false;
  for (const [id, s] of sessions) {
    if (!s.exited && s.stale && !pidAlive(s.pid) && !pidAlive(s.childPid)) {
      s.exited = true;
      s.exitCode = null;
      s.exitedAt = now;
      changed = true;
    }
    if (s.exited) {
      const ttl = proto.isUserClosed(s) ? closedTtlMs : proto.EXITED_TTL_MS;
      if (now - (s.exitedAt || 0) > ttl) {
        sessions.delete(id);
        changed = true;
      }
    }
  }
  mailroom.sweep(now);
  // Wrapped mailboxes die with their session records; transcript (cc-)
  // mailboxes are governed by the TTL alone - falling off the 45-minute
  // board window is not death, and the 24h promise holds (review finding).
  mailroom.retain((id) => sessions.has(id) || id.startsWith('cc-'));
  if (changed) notifyChange();
}

// ---------- change notification ----------

function notifyChange() {
  broadcastSessionsSoon();
  saveStateSoon();
}

// ---------- socket server ----------

const server = net.createServer((sock) => {
  let sessionId = null;
  sock.on('error', () => { /* client went away mid-write */ });
  proto.onMessages(sock, (msg) => {
    switch (msg.type) {
      case 'register':
        sessionId = handleRegister(sock, msg.session);
        break;
      case 'output': {
        const sess = sessions.get(msg.id);
        if (sess && typeof msg.chunk === 'string') {
          sess.buffer.push(msg.chunk);
          sess.lastOutputAt = Date.now();
          sess.stale = false; // output is proof of life
          outputChanged(sess.id);
          notifyChange();
        }
        break;
      }
      case 'exit':
        handleExit(msg);
        break;
      case 'ping':
        proto.send(sock, { type: 'pong', pid: process.pid, port: httpPort });
        break;
      case 'list':
        proto.send(sock, { type: 'sessions', sessions: lightList(), summaries: summarizer.meta() });
        break;
      case 'kill-session':
        proto.send(sock, killSession(String(msg.name || '')));
        break;
      case 'search':
        proto.send(sock, { type: 'results', results: searchSessions(String(msg.q || '')) });
        break;
      case 'post': {
        const r = resolveRecipients(msg.to);
        if (r.error) { proto.send(sock, { type: 'error', message: r.error }); break; }
        // "all" means everyone else - the announcer does not need a copy
        const ids = r.all ? r.ids.filter((id) => id !== msg.from) : r.ids;
        // a from that IS a live session id becomes that session's name: the
        // one sender label the daemon can actually vouch for
        const sender = sessions.get(String(msg.from || ''));
        const delivered = mailroom.post({ from: sender ? sender.name : msg.from, recipients: ids, type: msg.msgType, payload: msg.payload });
        proto.send(sock, { type: 'ok', delivered });
        notifyChange();
        break;
      }
      case 'history': {
        const r = findSession(msg.name);
        if (r.error) { proto.send(sock, { type: 'error', message: r.error }); break; }
        proto.send(sock, {
          type: 'history',
          name: r.session.name,
          current: r.session.summary || null,
          history: r.session.summaryHistory || [],
        });
        break;
      }
      case 'fetch': {
        // exited sessions keep readable mail until they expire - a badge the
        // CLI refuses to clear would be worse than useless
        const r = resolveRecipients(msg.name, { includeExited: true });
        if (r.error || r.ids.length !== 1) { proto.send(sock, { type: 'error', message: r.error || 'fetch takes exactly one session' }); break; }
        const messages = mailroom.fetch(r.ids[0], { peek: !!msg.peek });
        proto.send(sock, { type: 'inbox', messages });
        if (messages.length && !msg.peek) notifyChange();
        break;
      }
      case 'shutdown':
        proto.send(sock, { type: 'ok' });
        log('shutdown requested');
        setTimeout(() => shutdown(0), 100);
        break;
      default:
        break;
    }
  });
  sock.on('close', () => {
    if (!sessionId) return;
    // Only the session's CURRENT socket closing means the wrapper is gone;
    // a late close from a superseded connection must not mark it stale.
    const sess = sessions.get(sessionId);
    if (sess && sess.sock !== sock) return;
    markDisconnected(sessionId);
  });
});

let boundSocket = false; // never unlink a socket path this process does not own

function shutdown(code) {
  saveStateNow();
  try { server.close(); } catch { /* already closed */ }
  try { httpServer.close(); } catch { /* already closed */ }
  for (const res of sseClients) { try { res.end(); } catch { /* fine */ } }
  if (boundSocket) {
    try { fs.unlinkSync(proto.daemonInfoPath()); } catch { /* fine */ }
  }
  removeSocketFile();
  process.exit(code);
}

function removeSocketFile() {
  if (boundSocket && process.platform !== 'win32') {
    try { fs.unlinkSync(proto.socketPath()); } catch { /* fine */ }
  }
}

// Claim the socket bind-first: EADDRINUSE means a live daemon (bow out) or a
// stale file from a crash. Stale recovery (unlink + rebind) is serialized
// through an O_EXCL lock file so two racing daemons cannot unlink each other's
// freshly bound socket.
function claimSocketAndListen(onReady) {
  const sp = proto.socketPath();
  const lockPath = path.join(proto.TOWER_DIR, 'towerd.lock');
  let recovered = false;

  function bowOut() {
    log('another towerd is already running; exiting');
    process.exit(0);
  }

  function recoverStaleSocket() {
    if (recovered) {
      log(`cannot claim ${sp}`);
      process.exit(1);
    }
    recovered = true;
    let locked = false;
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      locked = true;
    } catch {
      let owner = NaN;
      try { owner = parseInt(fs.readFileSync(lockPath, 'utf8'), 10); } catch { /* fine */ }
      if (owner && pidAlive(owner)) bowOut(); // someone else is mid-recovery
      // stale lock from a crashed recovery; steal it once
      try { fs.unlinkSync(lockPath); } catch { /* fine */ }
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        locked = true;
      } catch { bowOut(); }
    }
    if (!locked) bowOut();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(sp); } catch { /* fine */ }
    }
    server.listen(sp);
  }

  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') {
      log('socket server error:', e.message);
      process.exit(1);
    }
    // Someone holds the path. A live daemon answers a probe; silence means a
    // stale file left by a crash.
    const probe = net.createConnection(sp);
    probe.on('connect', () => { probe.end(); bowOut(); });
    probe.on('error', recoverStaleSocket);
  });

  server.on('listening', () => {
    boundSocket = true;
    try { fs.unlinkSync(lockPath); } catch { /* fine (only ours if we recovered) */ }
    if (process.platform !== 'win32') {
      try { fs.chmodSync(sp, 0o600); } catch { /* best effort */ }
    }
    log(`towerd listening on ${sp}`);
    onReady();
  });

  server.listen(sp);
}

function start() {
  proto.ensureTowerDir();
  if (process.platform !== 'win32') {
    // files created by older versions may predate the 0600 modes
    for (const f of [proto.statePath(), proto.daemonInfoPath(), proto.daemonLogPath()]) {
      try { fs.chmodSync(f, 0o600); } catch { /* fine */ }
    }
  }
  loadState();
  claimSocketAndListen(() => {
    startHttp();
    claudeWatch.start();
    summarizer.start();
    // Statuses drift with time (running -> idle -> waiting); keep watchers current.
    setInterval(() => {
      if (sseClients.size) sseBroadcast({ type: 'sessions', sessions: lightList(), summaries: summarizer.meta() });
    }, 1000);
    setInterval(cleanupSweep, 30000);
  });
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', removeSocketFile);
}

if (require.main === module) start();

module.exports = { start, sessions, RingBuffer, isClaudeCommand, matchSession, resolveRecipients };
