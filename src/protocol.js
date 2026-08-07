'use strict';
// Tower wire protocol: newline-delimited JSON over a local socket
// (a Unix domain socket on macOS/Linux, a named pipe on Windows).
//
// Wrapper -> daemon:
//   { type: 'register', session: { id, name, cwd, command, pid, childPid, startedAt, pty } }
//   { type: 'output',   id, chunk }              // utf8 text, batched by the wrapper
//   { type: 'exit',     id, code, signal }
//
// Daemon -> wrapper:
//   { type: 'registered', id, name }             // name may have been deduped ("npm-2")
//   { type: 'kill', id }                         // please terminate the wrapped child
//
// CLI -> daemon (one-shot request/response):
//   { type: 'ping' }               -> { type: 'pong', pid, port }
//   { type: 'list' }               -> { type: 'sessions', sessions: [...] }
//   { type: 'search', q }          -> { type: 'results', results: [...] }
//   { type: 'post', from, to, msgType, payload }
//                                  -> { type: 'ok', delivered } | { type: 'error', message }
//   { type: 'fetch', name, peek }  -> { type: 'inbox', messages: [...] } | { type: 'error', message }
//   { type: 'history', name }      -> { type: 'history', name, current, history } | { type: 'error', message }
//   { type: 'kill-session', name } -> { type: 'ok', name } | { type: 'error', message }
//   { type: 'shutdown' }           -> { type: 'ok' }

const os = require('os');
const path = require('path');
const fs = require('fs');

// TOWER_DIR env override is a test seam (temp state dirs, parallel daemons);
// normal installs never set it.
const TOWER_DIR = process.env.TOWER_DIR ? path.resolve(process.env.TOWER_DIR) : path.join(os.homedir(), '.tower');
const DEFAULT_PORT = 8697; // "T-O-W-R" on a phone keypad

const IDLE_AFTER_MS = 15000;      // alive but quiet this long -> idle
const WAIT_SETTLE_MS = 2000;      // prompt-looking last line unchanged this long -> waiting
const EXITED_TTL_MS = 30 * 60000; // exited sessions drop off the board after this

function ensureTowerDir() {
  // 0700: state.json holds the last ~200 lines of every wrapped terminal,
  // which routinely includes tokens and connection strings.
  fs.mkdirSync(TOWER_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(TOWER_DIR, 0o700); } catch { /* best effort */ }
  }
  return TOWER_DIR;
}

function socketPath() {
  if (process.platform === 'win32') {
    // An overridden TOWER_DIR gets its own pipe so a test daemon cannot
    // collide with the real one.
    const suffix = process.env.TOWER_DIR ? '-' + Buffer.from(TOWER_DIR).toString('hex').slice(-12) : '';
    return `\\\\.\\pipe\\tower-${os.userInfo().username}${suffix}`;
  }
  return path.join(TOWER_DIR, 'towerd.sock');
}

function daemonInfoPath() { return path.join(TOWER_DIR, 'daemon.json'); }
function statePath() { return path.join(TOWER_DIR, 'state.json'); }
function daemonLogPath() { return path.join(TOWER_DIR, 'daemon.log'); }
function configPath() { return path.join(TOWER_DIR, 'config.json'); }

// Strip ANSI escapes and control bytes (keeps \t \n \r). One implementation
// for every text that reaches a terminal or the board: ring-buffer output,
// transcript turns, titles.
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitizeText(text) {
  return String(text).replace(ANSI_RE, '').replace(CTRL_RE, '');
}

function send(sock, msg) {
  if (!sock || sock.destroyed || !sock.writable) return;
  sock.write(JSON.stringify(msg) + '\n');
}

// Attach a newline-delimited JSON parser to a socket. Tolerates garbage lines.
function onMessages(sock, handler) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (data) => {
    buf += data;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* ignore */ }
      if (msg && typeof msg.type === 'string') handler(msg);
    }
  });
}

// ---------- status heuristics ----------
// Deliberately dumb. A session is "waiting" when its last line of output looks
// like a question and nothing has been printed since. Tune by adding patterns.
const PROMPT_PATTERNS = [
  /[?>»❯]\s*$/,                        // "Continue?", "> ", "❯ "
  /:\s$/,                              // "Username: " (trailing space is the signal)
  /\[[yY](?:\/[nN])?\]\s*\??\s*$/,     // "[y/n]", "[Y]"
  /\((?:y\/n|yes\/no)\)\s*\??\s*$/i,   // "(y/N)?"
  /(?:password|passphrase|username|login|token|otp|2fa code)[^:]*:?\s*$/i,
  /press (?:any key|enter|return)/i,
  /\$\s$/,                             // a shell prompt inside the session
];

function looksLikePrompt(line) {
  if (!line) return false;
  return PROMPT_PATTERNS.some((re) => re.test(line));
}

// A deliberate stop is not an alarm. SIGTERM/SIGINT/SIGHUP are the shell
// conventions for "the user (or their orchestrator) asked this to stop";
// node-pty reports signals as numbers, child_process as names. On Windows a
// Ctrl+C death surfaces as STATUS_CONTROL_C_EXIT (seen as either int cast).
// Anything genuinely ambiguous stays exited-error - a missed real failure is
// worse than occasional noise (DOCTRINE rule 4).
const CLOSED_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 15, 2, 1]);
const WIN_CTRL_C_EXITS = new Set([3221225786, -1073741510]); // 0xC000013A unsigned/signed
const KILL_GRACE_MS = 60000; // a tower kill explains an exit for this long

function isUserClosed(sess) {
  if (!sess.exited) return false;
  // a kill request only explains a prompt death; a session that shrugged it
  // off and crashed later has a real story to tell (DOCTRINE rule 4)
  if (sess.killRequestedAt && sess.exitedAt && sess.exitedAt - sess.killRequestedAt < KILL_GRACE_MS) return true;
  if (sess.exitSignal != null && CLOSED_SIGNALS.has(sess.exitSignal)) return true;
  return WIN_CTRL_C_EXITS.has(sess.exitCode);
}

// Pure derivation so the daemon is the single clock.
// `sess` needs: exited, exitCode, exitSignal, killRequested, stale, startedAt,
// lastOutputAt, tailLine.
function deriveStatus(sess, now = Date.now()) {
  if (sess.exited) {
    if (isUserClosed(sess)) return 'closed';
    // node-pty reports signal deaths as exitCode 0 + signal; check signal first.
    if (sess.exitSignal) return 'exited-error';
    if (sess.exitCode === 0) return 'exited-ok';
    if (sess.exitCode === null || sess.exitCode === undefined) return 'exited-unknown';
    return 'exited-error';
  }
  if (sess.stale) return 'stale';
  const quiet = now - (sess.lastOutputAt || sess.startedAt || now);
  if (quiet >= WAIT_SETTLE_MS && looksLikePrompt(sess.tailLine)) return 'waiting';
  if (quiet >= IDLE_AFTER_MS) return 'idle';
  return 'running';
}

module.exports = {
  TOWER_DIR,
  DEFAULT_PORT,
  IDLE_AFTER_MS,
  WAIT_SETTLE_MS,
  EXITED_TTL_MS,
  ensureTowerDir,
  socketPath,
  daemonInfoPath,
  statePath,
  daemonLogPath,
  configPath,
  send,
  onMessages,
  sanitizeText,
  looksLikePrompt,
  isUserClosed,
  deriveStatus,
};
