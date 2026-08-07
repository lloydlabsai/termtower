'use strict';
// Watches Claude Code's transcript files (~/.claude/projects/**/*.jsonl) and
// turns recently-active ones into board cards - the first data source beyond
// the `tower run` wrapper. Strictly read-only: tail-reads only, never writes,
// and a machine without Claude Code simply produces no cards.
//
// Transcripts are newline-delimited JSON. The entries tower cares about:
//   { type: 'user'|'assistant', message: {...}, cwd, timestamp, isSidechain, uuid }
//   { type: 'ai-title', aiTitle: 'Fix the login flow' }   // Claude Code's own session title
// Everything else (tool payloads, file snapshots, bookkeeping) is skipped.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const POLL_MS = 10000;              // directory sweep cadence
const SHOW_WINDOW_MS = 45 * 60000;  // transcripts quiet longer than this drop off the board
const ACTIVE_MS = 2 * 60000;        // written to this recently = "active"
const TAIL_BYTES = 256 * 1024;      // transcripts run to megabytes; only the tail matters
const MAX_TURNS = 8;                // conversation turns kept for the summarizer
const MAX_TURN_CHARS = 800;

// "Waiting" means the last entry is the assistant asking the user something:
// an explicit question tool, a plan approval, or final text ending in "?".
// Same philosophy as PROMPT_PATTERNS: dumb, short, tunable.
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function readTail(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // started mid-file: the first line is almost certainly a fragment
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* fine */ } }
  }
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// One pass over the tail: turns for the summarizer, title, cwd, branch, and
// whether the final entry leaves the ball in the user's court.
function parseTranscriptTail(text) {
  const out = { turns: [], title: null, cwd: null, gitBranch: null, lastUuid: null, waiting: false };
  let lastEntry = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e = null;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) {
      out.title = e.aiTitle.trim();
      continue;
    }
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain) continue;
    if (e.cwd) out.cwd = e.cwd;
    if (e.gitBranch) out.gitBranch = e.gitBranch;
    if (e.uuid) out.lastUuid = e.uuid;
    lastEntry = e;
    const msg = e.message || {};
    const text_ = textOfContent(msg.content).trim();
    if (text_) {
      const role = e.type === 'user' ? 'user' : 'claude';
      // tool_result-only user entries have no text and are skipped here
      out.turns.push({ role, text: text_.length > MAX_TURN_CHARS ? text_.slice(0, MAX_TURN_CHARS) + '…' : text_ });
    }
  }
  out.turns = out.turns.slice(-MAX_TURNS);
  if (lastEntry && lastEntry.type === 'assistant') {
    const content = Array.isArray(lastEntry.message && lastEntry.message.content) ? lastEntry.message.content : [];
    const asksViaTool = content.some((b) => b && b.type === 'tool_use' && QUESTION_TOOLS.has(b.name));
    const final = content[content.length - 1];
    const asksInText = !!(final && final.type === 'text' && /\?\s*$/.test(String(final.text || '').trimEnd()));
    out.waiting = asksViaTool || asksInText;
  }
  return out;
}

function deriveClaudeStatus(rec, now = Date.now()) {
  if (rec.waiting) return 'waiting';
  if (now - rec.lastActivityAt <= ACTIVE_MS) return 'active';
  return 'idle';
}

function createClaudeWatch({ notify, log }) {
  const records = new Map(); // id -> record
  const restored = new Map(); // id -> {summary, sig} from state.json, applied on first sight
  let timer = null;

  function scanFile(dir, base, stat) {
    const id = 'cc-' + base.replace(/\.jsonl$/, '');
    let rec = records.get(id);
    if (rec && rec.mtimeMs === stat.mtimeMs && rec.size === stat.size) {
      return false; // untouched since last sweep
    }
    const parsed = parseTranscriptTail(readTail(path.join(dir, base)));
    if (!rec) {
      rec = {
        id,
        kind: 'claude',
        file: path.join(dir, base),
        startedAt: stat.birthtimeMs || stat.mtimeMs,
        summary: null,
        summaryCtl: {},
      };
      const prev = restored.get(id);
      if (prev) {
        rec.summary = prev.summary || null;
        rec.summaryCtl.sig = prev.sig;
        restored.delete(id);
      }
      records.set(id, rec);
      // narrative() is the summarizer's hook; sig is the last entry seen, so
      // an unchanged transcript is never re-summarized.
      rec.narrative = () => {
        if (!rec.turns || rec.turns.length === 0) return null;
        return {
          sig: `${rec.lastUuid || ''}:${rec.turns.length}`,
          content: rec.turns.map((t) => `${t.role}: ${t.text}`).join('\n\n'),
        };
      };
      log(`claude session ${rec.id.slice(0, 11)} (${parsed.title || path.basename(dir)})`);
    }
    rec.mtimeMs = stat.mtimeMs;
    rec.size = stat.size;
    rec.lastActivityAt = stat.mtimeMs;
    rec.cwd = parsed.cwd || rec.cwd || '';
    rec.gitBranch = parsed.gitBranch || rec.gitBranch || null;
    rec.name = parsed.title || rec.name || path.basename(dir);
    rec.command = 'claude code';
    rec.turns = parsed.turns;
    rec.lastUuid = parsed.lastUuid;
    rec.waiting = parsed.waiting;
    return true;
  }

  function sweep() {
    const root = config.effectiveCached().claude_projects_dir;
    let changed = false;
    const seen = new Set();
    const cutoff = Date.now() - SHOW_WINDOW_MS;
    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      // no Claude Code here (or the dir is unreadable): silently nothing
      if (records.size) { records.clear(); changed = true; }
      if (changed) notify();
      return;
    }
    for (const d of projectDirs) {
      const dir = path.join(root, d.name);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const base of files) {
        if (!base.endsWith('.jsonl')) continue;
        let stat = null;
        try { stat = fs.statSync(path.join(dir, base)); } catch { continue; }
        if (!stat.isFile() || stat.mtimeMs < cutoff) continue;
        try {
          if (scanFile(dir, base, stat)) changed = true;
        } catch (e) {
          log(`claudewatch: ${base}: ${e.message}`);
        }
        seen.add('cc-' + base.replace(/\.jsonl$/, ''));
      }
    }
    for (const id of records.keys()) {
      if (!seen.has(id)) { records.delete(id); changed = true; }
    }
    if (changed) notify();
  }

  return {
    start() {
      // First sweep soon after boot (not synchronously: daemon startup should
      // never wait on a directory walk), then the steady cadence.
      const first = setTimeout(() => { try { sweep(); } catch (e) { log(`claudewatch: ${e.message}`); } }, 500);
      if (first.unref) first.unref();
      timer = setInterval(() => { try { sweep(); } catch (e) { log(`claudewatch: ${e.message}`); } }, POLL_MS);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) clearInterval(timer); },
    records: () => records.values(),
    get: (id) => records.get(id),
    // summaries survive a daemon restart without re-billing unchanged sessions
    persistable() {
      return [...records.values()]
        .filter((r) => r.summary)
        .map((r) => ({ id: r.id, summary: r.summary, sig: r.summaryCtl.sig || null }));
    },
    restore(arr) {
      for (const item of Array.isArray(arr) ? arr : []) {
        if (item && typeof item.id === 'string') restored.set(item.id, item);
      }
    },
    _sweep: sweep, // for tests
  };
}

module.exports = { createClaudeWatch, parseTranscriptTail, deriveClaudeStatus, ACTIVE_MS, SHOW_WINDOW_MS };
