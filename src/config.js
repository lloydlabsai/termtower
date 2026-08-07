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
};

// Dotted paths a user may set. Anything else is a typo we should catch.
const KNOWN_KEYS = {
  anthropic_key: 'string',
  'summaries.enabled': 'boolean',
  'summaries.interval_seconds': 'number',
  'summaries.model': 'string',
  claude_projects_dir: 'string',
};

function load(file = proto.configPath()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function save(cfg, file = proto.configPath()) {
  proto.ensureTowerDir();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
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
  };
  const iv = Number(out.summaries.interval_seconds);
  out.summaries.interval_seconds = Number.isFinite(iv) && iv >= 30 ? iv : DEFAULTS.summaries.interval_seconds;
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

// mtime-based cache so the daemon can consult config every second for free.
let cached = null;
let cachedMtime = -1;
function effectiveCached(file = proto.configPath()) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
  if (!cached || mtime !== cachedMtime) {
    cached = effective(load(file));
    cachedMtime = mtime;
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
