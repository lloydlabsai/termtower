#!/usr/bin/env node
'use strict';
// tower CLI: run | ls | open | kill

const net = require('net');
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const proto = require('../src/protocol');

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const COLORS = {
  running: '\x1b[32m',       // green
  active: '\x1b[32m',        // green (claude code sessions)
  idle: '\x1b[90m',          // gray
  waiting: '\x1b[33m',       // yellow
  stale: '\x1b[90m',
  'exited-ok': '\x1b[90m',
  'exited-error': '\x1b[31m', // red
  'exited-unknown': '\x1b[90m',
  closed: '\x1b[90m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function paint(text, color) {
  if (!USE_COLOR || !color) return text;
  return color + text + RESET;
}

function usage() {
  console.log(`tower - a live control tower for your terminal sessions

usage:
  tower run [--name <name>] <command> [args...]   wrap a command so it shows on the board
  tower ls                                        list sessions in the terminal
  tower search <text>                             find it across every session's recent output
  tower open                                      open the status board in a browser
  tower kill <name>                               stop a session (or "daemon" to stop towerd)
  tower config get [key]                          show configuration (secrets masked)
  tower config set <key> <value>                  set a value
  tower config set anthropic_key                  prompts for the key (kept out of shell history)
  tower config unset <key>                        remove a value
`);
  process.exit(process.argv.length <= 2 ? 0 : 1);
}

// ---------- daemon client ----------

function rawRequest(msg, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(proto.socketPath());
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timed out talking to towerd'));
    }, timeoutMs);
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('connect', () => proto.send(sock, msg));
    proto.onMessages(sock, (reply) => {
      clearTimeout(timer);
      sock.end();
      resolve(reply);
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function spawnDaemonDetached() {
  proto.ensureTowerDir();
  const logFd = fs.openSync(proto.daemonLogPath(), 'a', 0o600);
  const child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'src', 'daemon.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: proto.TOWER_DIR,
    windowsHide: true,
  });
  child.on('error', () => { /* surfaced by the ping retries */ });
  child.unref();
  fs.closeSync(logFd);
}

async function startDaemon() {
  spawnDaemonDetached();
  for (let i = 0; i < 40; i++) {
    try { await rawRequest({ type: 'ping' }, 500); return; } catch { await sleep(100); }
  }
  throw new Error(`could not start towerd (see ${proto.daemonLogPath()})`);
}

async function request(msg, { autostart = true } = {}) {
  try {
    return await rawRequest(msg);
  } catch (e) {
    if (!autostart) throw e;
    await startDaemon();
    return rawRequest(msg, 3000);
  }
}

// ---------- formatting ----------

function fmtDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 2) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function shortenCwd(cwd) {
  const os = require('os');
  let out = (cwd || '').replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');
  if (out.startsWith(home)) out = '~' + out.slice(home.length);
  if (out.length > 28) out = '…' + out.slice(-27);
  return out;
}

function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const ATTENTION_RANK = {
  waiting: 0,
  'exited-error': 1,
  running: 2,
  active: 2,
  idle: 3,
  stale: 4,
  'exited-unknown': 5,
  'exited-ok': 6,
  closed: 7,
};

function sortSessions(list) {
  return list.slice().sort((a, b) => {
    const ra = ATTENTION_RANK[a.status] ?? 9;
    const rb = ATTENTION_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.lastOutputAt || 0) - (a.lastOutputAt || 0);
  });
}

// ---------- commands ----------

async function cmdLs() {
  const reply = await request({ type: 'list' });
  if (reply.summaries && reply.summaries.error) {
    console.error(paint(`summaries off: ${reply.summaries.error}`, COLORS.waiting));
  }
  const list = sortSessions(reply.sessions || []);
  if (list.length === 0) {
    console.log('no sessions. start one with: tower run <command>');
    return;
  }
  const now = Date.now();
  // a removed key degrades ls to v1 output even while old summaries linger
  const keyless = !!(reply.summaries && reply.summaries.keyless);
  const showDoing = !keyless && list.some((s) => s.summary && s.summary.doing);
  const rows = list.map((s) => ({
    // name truncation exists to make room for DOING; without summaries the
    // output stays byte-identical to v1
    name: showDoing ? truncate(s.name, 28) : s.name,
    status: s.status,
    last: s.exited ? fmtDur(now - (s.exitedAt || now)) : fmtDur(now - (s.lastOutputAt || now)),
    pid: String(s.childPid || s.pid || '-'),
    cwd: shortenCwd(s.cwd),
    doing: truncate((s.summary && s.summary.doing) || '', 44),
    command: truncate(s.command, showDoing ? 30 : 40),
  }));
  const header = { name: 'NAME', status: 'STATUS', last: 'LAST', pid: 'PID', cwd: 'CWD', doing: 'DOING', command: 'COMMAND' };
  const cols = showDoing
    ? ['name', 'status', 'last', 'pid', 'cwd', 'doing', 'command']
    : ['name', 'status', 'last', 'pid', 'cwd', 'command'];
  const width = {};
  for (const c of cols) width[c] = Math.max(header[c].length, ...rows.map((r) => r[c].length));
  const line = (r, colorize) => cols.map((c) => {
    const cell = r[c].padEnd(width[c]);
    if (colorize && c === 'status') return paint(cell, COLORS[r.status]);
    return cell;
  }).join('  ');
  console.log(paint(line(header, false), DIM));
  for (const r of rows) console.log(line(r, true));
}

async function cmdRun(argv) {
  let name = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest.length === 0 && (a === '--name' || a === '-n')) { name = argv[++i]; continue; }
    if (rest.length === 0 && a.startsWith('--name=')) { name = a.slice(7); continue; }
    if (rest.length === 0 && a === '--') continue;
    rest.push(a);
  }
  if (rest.length === 0) usage();
  if (name === 'daemon') {
    console.error('tower: "daemon" is a reserved name');
    process.exit(1);
  }
  // Never let daemon health delay the user's command: a short ping decides
  // whether to spawn towerd, and the wrapper's reconnect loop does the rest.
  rawRequest({ type: 'ping' }, 800).catch(() => {
    try { spawnDaemonDetached(); } catch { /* the session simply stays off the board */ }
  });
  const wrapper = require('../src/wrapper');
  wrapper.run(rest, { name });
}

async function cmdOpen() {
  const pong = await request({ type: 'ping' });
  let port = pong.port || proto.DEFAULT_PORT;
  try {
    if (!pong.port) {
      const info = JSON.parse(fs.readFileSync(proto.daemonInfoPath(), 'utf8'));
      if (info.port) port = info.port;
    }
  } catch { /* fall back to default */ }
  const url = `http://127.0.0.1:${port}/`;
  const platform = process.platform;
  const opener = platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  const child = cp.spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
  // spawn ENOENT arrives as an async 'error' event (xdg-open is often absent
  // on minimal Linux); the printed URL is the fallback.
  child.on('error', () => {});
  child.unref();
  console.log(`tower board: ${url}`);
}

async function cmdKill(name) {
  if (!name) usage();
  if (name === 'daemon') {
    try {
      await rawRequest({ type: 'shutdown' });
      console.log('towerd stopped');
    } catch {
      console.log('towerd is not running');
    }
    return;
  }
  let reply;
  try {
    reply = await rawRequest({ type: 'kill-session', name });
  } catch {
    console.log('towerd is not running');
    return;
  }
  if (reply.type === 'ok') console.log(`sent stop to ${reply.name}`);
  else console.error(`tower: ${reply.message}`);
}

// ---------- search ----------

// Windows are compared in the original string - toLowerCase can change
// string length (Turkish İ), which would desync indexOf offsets.
function paintMatches(line, q) {
  if (!USE_COLOR) return line;
  const needle = q.toLowerCase();
  const n = q.length;
  let out = '';
  let i = 0;
  let from = 0;
  while (i <= line.length - n) {
    if (line.slice(i, i + n).toLowerCase() === needle) {
      out += line.slice(from, i) + COLORS.waiting + line.slice(i, i + n) + RESET;
      i += n;
      from = i;
    } else {
      i++;
    }
  }
  return out + line.slice(from);
}

async function cmdSearch(argv) {
  const query = argv.join(' ').trim();
  if (!query) usage();
  const reply = await request({ type: 'search', q: query });
  const results = sortSessions(reply.results || []);
  if (results.length === 0) {
    console.log(`no matches for "${query}"`);
    return;
  }
  for (const r of results) {
    const where = r.matchFields.length ? paint(` (${r.matchFields.join(', ')})`, DIM) : '';
    console.log(paint(r.name, COLORS[r.status]) + '  ' + paint(shortenCwd(r.cwd), DIM) + where);
    for (const line of r.matchLines) {
      console.log('  ' + paintMatches(truncate(line.trim(), 160), query));
    }
  }
}

// ---------- config ----------

const SECRET_KEY_RE = /key|token|secret/i;

// Keys typed as arguments land in shell history and the process list;
// `tower config set anthropic_key` with no value reads it invisibly instead
// (or from a pipe when stdin is not a terminal).
function readSecret(promptText) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i !== -1) { process.stdin.pause(); resolve(buf.slice(0, i).trim()); }
      });
      process.stdin.on('end', () => resolve(buf.trim()));
      return;
    }
    process.stdout.write(promptText);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let val = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(val.trim());
        }
        if (c === '\x03') { // ctrl-c
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\x7f' || c === '\b') { val = val.slice(0, -1); continue; }
        val += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function cmdConfig(args) {
  const config = require('../src/config');
  const sub = args[0];

  if (sub === 'get' && args.length <= 2) {
    const stored = config.load();
    const eff = config.effective(stored);
    const rows = Object.keys(config.KNOWN_KEYS).map((key) => {
      let value = config.getPath(eff, key);
      let source = config.getPath(stored, key) !== undefined ? 'config' : 'default';
      if (key === 'anthropic_key') {
        value = config.maskSecret(config.apiKey(eff));
        source = config.keySource(eff) || 'not set';
      }
      return { key, value: String(value ?? '(not set)'), source };
    });
    if (args[1]) {
      const row = rows.find((r) => r.key === args[1]);
      if (!row) return unknownKey(args[1], config);
      console.log(row.value);
      return;
    }
    const w = Math.max(...rows.map((r) => r.key.length));
    for (const r of rows) console.log(`${r.key.padEnd(w)}  ${r.value}  ${paint(`(${r.source})`, DIM)}`);
    return;
  }

  if (sub === 'set' && args[1]) {
    const key = args[1];
    const wanted = config.KNOWN_KEYS[key];
    if (!wanted) return unknownKey(key, config);
    let raw = args.slice(2).join(' ');
    if (key === 'anthropic_key' && (!raw || raw === '-')) {
      raw = await readSecret('paste your Anthropic API key (input hidden): ');
      if (!raw) {
        console.error('tower: no key entered');
        process.exit(1);
      }
    } else if (!raw) {
      usage();
    }
    let value = raw;
    if (wanted !== 'string') {
      try { value = JSON.parse(raw); } catch { /* stays a string, caught below */ }
      if (typeof value !== wanted) {
        console.error(`tower: ${key} expects a ${wanted}, got "${raw}"`);
        process.exit(1);
      }
    }
    if (key === 'summaries.interval_seconds' && value < 30) {
      console.error('tower: summaries.interval_seconds must be at least 30');
      process.exit(1);
    }
    if (key === 'closed_ttl_seconds' && value < 60) {
      console.error('tower: closed_ttl_seconds must be at least 60');
      process.exit(1);
    }
    if (key === 'anthropic_key' && !config.looksLikeAnthropicKey(value)) {
      console.error('tower: that does not look like an Anthropic API key (expected sk-...)');
      process.exit(1);
    }
    const stored = config.load();
    config.setPath(stored, key, value);
    config.save(stored);
    if (SECRET_KEY_RE.test(key)) {
      console.log(`${key} = ${config.maskSecret(value)} (saved)`);
    } else {
      console.log(`${key} = ${value} (saved)`);
    }
    if (key === 'anthropic_key') {
      const anthropic = require('../src/anthropic');
      const model = config.effective(stored).summaries.model;
      process.stdout.write(`verifying with a 1-token call to ${model}... `);
      const v = await anthropic.verifyKey(value, model);
      if (v.ok) {
        console.log('ok - summaries are enabled');
      } else if (v.invalidKey) {
        console.log(`rejected (${v.message})`);
        console.error('tower: the key is saved but the API rejected it; summaries will stay off until it is fixed');
        // process.exit() here trips a libuv teardown assertion on Windows
        // while undici's fetch handles are still closing; exitCode drains clean.
        process.exitCode = 1;
      } else {
        console.log(`could not verify (${v.message})`);
        console.log('the key is saved; tower will try it when the network is back');
      }
    }
    return;
  }

  if (sub === 'unset' && args[1] && args.length === 2) {
    if (!config.KNOWN_KEYS[args[1]]) return unknownKey(args[1], config);
    const stored = config.load();
    if (config.unsetPath(stored, args[1])) {
      config.save(stored);
      console.log(`${args[1]} removed`);
    } else {
      console.log(`${args[1]} was not set`);
    }
    return;
  }

  usage();
}

function unknownKey(key, config) {
  console.error(`tower: unknown config key "${key}"\nknown keys: ${Object.keys(config.KNOWN_KEYS).join(', ')}`);
  process.exit(1);
}

async function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);
  switch (cmd) {
    case 'run': return cmdRun(args);
    case 'ls': case 'list': return cmdLs();
    case 'search': case 'grep': return cmdSearch(args);
    case 'open': return cmdOpen();
    case 'kill': return cmdKill(args[0]);
    case 'config': return cmdConfig(args);
    case '--version': case '-v':
      return console.log(require('../package.json').version);
    default:
      return usage();
  }
}

main().catch((err) => {
  console.error('tower:', err.message);
  process.exit(1);
});
