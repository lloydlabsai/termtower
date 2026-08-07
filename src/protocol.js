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
//   { type: 'kill-session', name } -> { type: 'ok', name } | { type: 'error', message }
//   { type: 'shutdown' }           -> { type: 'ok' }

const os = require('os');
const path = require('path');
const fs = require('fs');

const TOWER_DIR = path.join(os.homedir(), '.tower');
const DEFAULT_PORT = 8697; // "T-O-W-R" on a phone keypad

function ensureTowerDir() {
  fs.mkdirSync(TOWER_DIR, { recursive: true });
  return TOWER_DIR;
}

function socketPath() {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\tower-${os.userInfo().username}`;
  }
  return path.join(TOWER_DIR, 'towerd.sock');
}

function daemonInfoPath() { return path.join(TOWER_DIR, 'daemon.json'); }
function statePath() { return path.join(TOWER_DIR, 'state.json'); }
function daemonLogPath() { return path.join(TOWER_DIR, 'daemon.log'); }

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

module.exports = {
  TOWER_DIR,
  DEFAULT_PORT,
  ensureTowerDir,
  socketPath,
  daemonInfoPath,
  statePath,
  daemonLogPath,
  send,
  onMessages,
};
