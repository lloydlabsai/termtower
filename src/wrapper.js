'use strict';
// tower run: spawn the command in a PTY, pass the terminal through untouched,
// and stream recent output to the daemon. The wrapped process must behave
// exactly as it would unwrapped; if the daemon is missing the session simply
// does not appear on the board.

const net = require('net');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const proto = require('./protocol');

let pty = null;
try { pty = require('node-pty'); } catch { /* fall back to plain pipes */ }

const OUTPUT_FLUSH_MS = 100;
const OUTPUT_CAP = 64 * 1024; // keep only the tail; the daemon only keeps ~200 lines anyway
const RECONNECT_MS = 5000;

function autoName(argv) {
  const parts = [];
  const first = path.basename(argv[0]).replace(/\.(exe|cmd|bat|sh)$/i, '');
  parts.push(first);
  for (const a of argv.slice(1)) {
    if (a.startsWith('-')) continue;
    const base = path.basename(a);
    if (!/^[\w.@:-]+$/.test(base)) continue;
    parts.push(base);
    if (parts.join('-').length > 20) break;
  }
  let name = parts.join('-').replace(/[^\w.:@-]+/g, '-');
  if (name.length > 24) name = name.slice(0, 24);
  return name || 'session';
}

function quoteWinArg(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^()]/.test(a)) return a;
  return '"' + a.replace(/"/g, '\\"') + '"';
}

function run(argv, opts = {}) {
  const session = {
    id: crypto.randomUUID(),
    name: opts.name || autoName(argv),
    cwd: process.cwd(),
    command: argv.join(' '),
    pid: process.pid,
    childPid: null,
    startedAt: Date.now(),
    pty: false,
  };

  // ---------- spawn ----------
  let child = null;
  let usingPty = false;
  if (pty) {
    try {
      child = pty.spawn(argv[0], argv.slice(1), {
        name: 'xterm-256color',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        cwd: process.cwd(),
        env: process.env,
      });
      usingPty = true;
    } catch { child = null; }
  }
  if (!child) {
    // Degraded mode: no PTY. Line-based programs work; full-screen TUIs will
    // notice stdout is not a terminal. stdin stays inherited so typing works.
    if (process.platform === 'win32') {
      child = cp.spawn(argv.map(quoteWinArg).join(' '), {
        shell: true,
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } else {
      child = cp.spawn(argv[0], argv.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
    }
  }
  session.childPid = child.pid;
  session.pty = usingPty;

  // ---------- daemon connection (best effort, reconnects forever) ----------
  let sock = null;
  let exiting = false;

  function connect() {
    const s = net.createConnection(proto.socketPath());
    let closed = false;
    s.on('connect', () => {
      sock = s;
      proto.send(s, { type: 'register', session });
      flushOutput();
    });
    proto.onMessages(s, (msg) => {
      if (msg.type === 'registered' && msg.name) session.name = msg.name;
      else if (msg.type === 'kill') terminateChild();
    });
    s.on('error', () => { /* handled by close */ });
    s.on('close', () => {
      if (closed) return;
      closed = true;
      if (sock === s) sock = null;
      if (!exiting) {
        const t = setTimeout(connect, RECONNECT_MS);
        if (t.unref) t.unref();
      }
    });
  }
  connect();

  // ---------- output tee ----------
  let outBuf = '';
  let outTimer = null;

  function queueOutput(text) {
    outBuf += text;
    if (outBuf.length > OUTPUT_CAP) outBuf = outBuf.slice(-OUTPUT_CAP);
    if (!outTimer) {
      outTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
      if (outTimer.unref) outTimer.unref();
    }
  }

  function flushOutput() {
    if (outTimer) { clearTimeout(outTimer); outTimer = null; }
    if (!outBuf || !sock) return;
    proto.send(sock, { type: 'output', id: session.id, chunk: outBuf });
    outBuf = '';
  }

  if (usingPty) {
    child.onData((data) => {
      process.stdout.write(data);
      queueOutput(data);
    });
  } else {
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      queueOutput(data.toString('utf8'));
    });
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      queueOutput(data.toString('utf8'));
    });
  }

  // ---------- stdin passthrough ----------
  if (usingPty) {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      try { child.write(d.toString('utf8')); } catch { /* child gone */ }
    });
    process.stdout.on('resize', () => {
      try { child.resize(process.stdout.columns || 80, process.stdout.rows || 24); } catch { /* fine */ }
    });
  }
  // In fallback mode stdin is inherited; nothing to forward.

  // ---------- signals ----------
  function terminateChild() {
    try {
      if (usingPty) child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
      else child.kill('SIGTERM');
    } catch { /* already gone */ }
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 5000);
    if (t.unref) t.unref();
  }

  if (usingPty) {
    // Raw mode delivers Ctrl+C to the child through the PTY; a direct signal
    // to the wrapper still forwards.
    process.on('SIGTERM', terminateChild);
    process.on('SIGINT', terminateChild);
  } else {
    // The child shares our process group, so Ctrl+C reaches it directly.
    // Ignore it here and follow the child's exit.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', terminateChild);
  }

  // ---------- exit ----------
  function finish(code, signal) {
    if (exiting) return;
    exiting = true;
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* fine */ }
    }
    process.stdin.pause();
    flushOutput();
    if (sock) {
      proto.send(sock, { type: 'exit', id: session.id, code, signal: signal || null });
      sock.end();
    }
    const exitCode = typeof code === 'number' ? code : (signal ? 1 : 0);
    setTimeout(() => process.exit(exitCode), 120);
  }

  if (usingPty) {
    child.onExit(({ exitCode, signal }) => finish(exitCode, signal));
  } else {
    child.on('exit', (code, signal) => finish(code, signal));
    child.on('error', (err) => {
      process.stderr.write(`tower: failed to run ${argv[0]}: ${err.message}\n`);
      finish(127, null);
    });
  }
}

module.exports = { run };
