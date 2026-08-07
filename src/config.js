'use strict';
// ~/.tower/config.json: the only knobs tower has. Every reader goes through
// effective(), so defaults live in exactly one place. The daemon re-reads the
// file (mtime-cached) instead of holding config in memory, so `tower config
// set` takes effect without a daemon restart.

const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('./protocol');

const DEFAULTS = {
  anthropic_key: null,
  summaries: {
    enabled: true,               // meaningful only when a key is present
    interval_seconds: 180,
    model: 'claude-haiku-4-5',   // the only place a model string appears
  },
  claude_projects_dir: path.join(os.homedir(), '.claude', 'projects'),
  closed_ttl_seconds: 1800,      // user-closed sessions leave the board after this
  inbox: {
    ttl_hours: 24,               // undelivered messages evaporate after this
    cap: 100,                    // per-inbox hard cap, oldest dropped
  },
};

// Dotted paths a user may set. Anything else is a typo we should catch.
const KNOWN_KEYS = {
  anthropic_key: 'string',
  'summaries.enabled': 'boolean',
  'summaries.interval_seconds': 'number',
  'summaries.model': 'string',
  claude_projects_dir: 'string',
  closed_ttl_seconds: 'number',
  'inbox.ttl_hours': 'number',
  'inbox.cap': 'number',
};

function load(file = proto.configPath()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function save(cfg, file = proto.configPath()) {
  proto.ensureTowerDir();
  // write-then-rename: a crash mid-write must not leave a torn config that
  // silently loads as "no config at all"
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  }
  fs.renameSync(tmp, file);
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] == null || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (cur == null || typeof cur !== 'object') return false;
    cur = cur[part];
  }
  if (cur == null || typeof cur !== 'object' || !(parts[parts.length - 1] in cur)) return false;
  delete cur[parts[parts.length - 1]];
  return true;
}

// Stored config over defaults, one level of nesting is all we have.
function effective(cfg = load()) {
  const out = {
    anthropic_key: cfg.anthropic_key ?? DEFAULTS.anthropic_key,
    summaries: { ...DEFAULTS.summaries, ...(cfg.summaries || {}) },
    claude_projects_dir: cfg.claude_projects_dir ?? DEFAULTS.claude_projects_dir,
    closed_ttl_seconds: cfg.closed_ttl_seconds ?? DEFAULTS.closed_ttl_seconds,
    inbox: { ...DEFAULTS.inbox, ...(cfg.inbox || {}) },
  };
  const iv = Number(out.summaries.interval_seconds);
  out.summaries.interval_seconds = Number.isFinite(iv) && iv >= 30 ? iv : DEFAULTS.summaries.interval_seconds;
  const ct = Number(out.closed_ttl_seconds);
  out.closed_ttl_seconds = Number.isFinite(ct) && ct >= 60 ? ct : DEFAULTS.closed_ttl_seconds;
  const th = Number(out.inbox.ttl_hours);
  out.inbox.ttl_hours = Number.isFinite(th) && th >= 1 ? th : DEFAULTS.inbox.ttl_hours;
  const cap = Number(out.inbox.cap);
  out.inbox.cap = Number.isFinite(cap) && cap >= 1 && cap <= 1000 ? Math.floor(cap) : DEFAULTS.inbox.cap;
  return out;
}

// The config file wins over the environment, per the README contract.
function apiKey(eff = effective()) {
  return eff.anthropic_key || process.env.ANTHROPIC_API_KEY || null;
}

function keySource(eff = effective()) {
  if (eff.anthropic_key) return 'config';
  if (process.env.ANTHROPIC_API_KEY) return 'env';
  return null;
}

// "sk-ant-api03-…wxyz": enough to recognize your own key, useless to a shoulder-surfer.
function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '(not set)';
  if (s.length <= 14) return s.slice(0, 3) + '…';
  return s.slice(0, 11) + '…' + s.slice(-4);
}

function looksLikeAnthropicKey(value) {
  return /^sk-[\w-]{20,}$/.test(String(value || ''));
}

// Stat-based cache so the daemon can consult config every second for free.
// Size is part of the signature: Windows mtime granularity can swallow two
// writes in the same tick.
let cached = null;
let cachedSig = '';
function effectiveCached(file = proto.configPath()) {
  let sig = 'absent';
  try {
    const st = fs.statSync(file);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch { /* missing file is a valid state */ }
  if (!cached || sig !== cachedSig) {
    cached = effective(load(file));
    cachedSig = sig;
  }
  return cached;
}

module.exports = {
  DEFAULTS,
  KNOWN_KEYS,
  load,
  save,
  getPath,
  setPath,
  unsetPath,
  effective,
  effectiveCached,
  apiKey,
  keySource,
  maskSecret,
  looksLikeAnthropicKey,
};
