'use strict';
// tower run: spawn the command in a PTY, pass the terminal through untouched,
// and stream recent output to the daemon. The wrapped process must behave
// exactly as it would unwrapped; if the daemon is missing the session simply
// does not appear on the board.

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const proto = require('./protocol');

let pty = null;
try { pty = require('node-pty'); } catch { /* fall back to plain pipes */ }

const OUTPUT_FLUSH_MS = 100;
const OUTPUT_CAP = 64 * 1024; // keep only the tail; the daemon only keeps ~200 lines anyway
const RECONNECT_DELAYS_MS = [1000, 2000, 5000]; // fast first retries, then steady

// Shell convention: a signal death exits 128 + signum. node-pty reports the
// signal as a number, child_process as a string name.
function signalExitCode(signal) {
  if (typeof signal === 'number') return 128 + signal;
  return 128 + (os.constants.signals[signal] || 15);
}

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

// node-pty on Windows hands the file straight to ConPTY with no PATH or
// PATHEXT search, so "npm" or "node" must become a real file path first.
function resolveWinExecutable(cmd) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const tryFile = (base) => {
    if (path.extname(base) && fs.existsSync(base)) return base;
    for (const ext of exts) {
      const f = base + ext;
      if (fs.existsSync(f)) return f;
    }
    return null;
  };
  if (cmd.includes('/') || cmd.includes('\\')) return tryFile(path.resolve(cmd));
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    const found = tryFile(path.join(dir, cmd));
    if (found) return found;
  }
  return null;
}

function run(argv, opts = {}) {
  const session = {
    id: crypto.randomUUID(),
    name: opts.name || autoName(argv),
    cwd: process.cwd(),
    command: argv.join(' ').replace(/\s+/g, ' ').trim(),
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
      let file = argv[0];
      let args = argv.slice(1);
      if (process.platform === 'win32') {
        const resolved = resolveWinExecutable(argv[0]);
        if (!resolved) throw new Error(`${argv[0]} not found on PATH`);
        if (/\.(cmd|bat)$/i.test(resolved)) {
          // batch files need the shell; ConPTY cannot exec them directly
          file = process.env.ComSpec || 'cmd.exe';
          args = ['/c', resolved, ...argv.slice(1)];
        } else {
          file = resolved;
        }
      }
      child = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        cwd: process.cwd(),
        // the child can find its own mailbox: `tower inbox` / `tower send`
        // infer identity from TOWER_SESSION (the stable id, names get deduped)
        env: { ...process.env, TOWER_SESSION: session.id },
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
        env: { ...process.env, TOWER_SESSION: session.id },
      });
    } else {
      child = cp.spawn(argv[0], argv.slice(1), {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, TOWER_SESSION: session.id },
      });
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
      attempt = 0;
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
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt++, RECONNECT_DELAYS_MS.length - 1)];
        const t = setTimeout(connect, delay);
        if (t.unref) t.unref();
      }
    });
  }
  let attempt = 0;
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
    process.stdin.on('end', () => {
      // Piped stdin ended (`echo y | tower run ...`). The child's stdin is a
      // PTY, which has no EOF; send EOT so line-mode readers see end-of-input.
      if (!process.stdin.isTTY) {
        try { child.write('\x04'); } catch { /* child gone */ }
      }
    });
    process.stdout.on('resize', () => {
      try { child.resize(process.stdout.columns || 80, process.stdout.rows || 24); } catch { /* fine */ }
    });
  }
  // In fallback mode stdin is inherited; nothing to forward.

  // ---------- signals ----------
  function terminateChild() {
    if (process.platform === 'win32') {
      // node-pty's ConPTY kill is unreliable and rejects signal names;
      // TerminateProcess via process.kill is what actually stops the child.
      try { process.kill(child.pid); } catch { /* already gone */ }
      // ConPTY does not reliably deliver onExit after TerminateProcess, so
      // verify the death ourselves; finish() is guarded against double entry.
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (exiting) return clearInterval(poll);
        let alive = true;
        try { process.kill(child.pid, 0); } catch { alive = false; }
        if (!alive || Date.now() - t0 > 3000) {
          clearInterval(poll);
          finish(1, 'SIGTERM');
        }
      }, 250);
      if (poll.unref) poll.unref();
      return;
    }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
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
    try { process.stdin.unref(); } catch { /* not all stream types support it */ }
    flushOutput();
    if (sock) {
      proto.send(sock, { type: 'exit', id: session.id, code, signal: signal || null });
      sock.end();
    }
    // Mirror the child: its code, or 128+signum for a signal death (so a
    // segfaulted `tower run build && deploy` does not proceed).
    const exitCode = signal ? signalExitCode(signal) : (typeof code === 'number' ? code : 0);
    process.exitCode = exitCode;
    // Let already-queued output callbacks run, then exit as soon as our own
    // stdout/stderr have drained; cap the wait so a blocked consumer cannot
    // hold the wrapper open forever.
    setImmediate(() => setImmediate(() => {
      const pending = [process.stdout, process.stderr]
        .filter((s) => s && typeof s.writableLength === 'number' && s.writableLength > 0);
      if (pending.length === 0) return process.exit(exitCode);
      let waiting = pending.length;
      for (const s of pending) s.once('drain', () => { if (--waiting === 0) process.exit(exitCode); });
      setTimeout(() => process.exit(exitCode), 5000);
    }));
  }

  if (usingPty) {
    // node-pty reports signal deaths as { exitCode: 0, signal }; finish()
    // checks the signal first so those are not mistaken for success.
    child.onExit(({ exitCode, signal }) => finish(exitCode, signal || null));
  } else {
    // 'close' fires once the output pipes have drained; 'exit' alone can leave
    // the child's final lines (a crash stack, typically) undelivered. If a
    // grandchild inherited the pipes and holds them open, the unref'd fallback
    // finishes anyway.
    child.on('close', (code, signal) => finish(code, signal));
    child.on('exit', (code, signal) => {
      const t = setTimeout(() => finish(code, signal), 5000);
      if (t.unref) t.unref();
    });
    child.on('error', (err) => {
      process.stderr.write(`tower: failed to run ${argv[0]}: ${err.message}\n`);
      finish(127, null);
    });
  }
}

module.exports = { run };
