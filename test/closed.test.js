'use strict';
const test = require('node:test');
const assert = require('node:assert');
const proto = require('../src/protocol');

const exited = (over = {}) => ({
  exited: true, exitCode: null, exitSignal: null, killRequestedAt: null, exitedAt: 1000000,
  stale: false, startedAt: 0, lastOutputAt: 0, tailLine: '', ...over,
});

test('user-terminated sessions derive closed, not exited-error', () => {
  // tower kill: killRequestedAt shortly before the exit
  assert.strictEqual(proto.deriveStatus(exited({ killRequestedAt: 999000, exitCode: 1 })), 'closed');
  // unix signal conventions, string and node-pty numeric forms
  assert.strictEqual(proto.deriveStatus(exited({ exitSignal: 'SIGTERM' })), 'closed');
  assert.strictEqual(proto.deriveStatus(exited({ exitSignal: 'SIGINT' })), 'closed');
  assert.strictEqual(proto.deriveStatus(exited({ exitSignal: 2 })), 'closed');
  assert.strictEqual(proto.deriveStatus(exited({ exitSignal: 15 })), 'closed');
  // Windows Ctrl+C, both integer casts of STATUS_CONTROL_C_EXIT
  assert.strictEqual(proto.deriveStatus(exited({ exitCode: 3221225786 })), 'closed');
  assert.strictEqual(proto.deriveStatus(exited({ exitCode: -1073741510 })), 'closed');
});

test('real failures still earn the attention band', () => {
  assert.strictEqual(proto.deriveStatus(exited({ exitCode: 1 })), 'exited-error');
  assert.strictEqual(proto.deriveStatus(exited({ exitSignal: 'SIGKILL' })), 'exited-error');
  assert.strictEqual(proto.deriveStatus(exited({ exitSignal: 'SIGSEGV' })), 'exited-error');
  assert.strictEqual(proto.deriveStatus(exited({ exitSignal: 11 })), 'exited-error');
  assert.strictEqual(proto.deriveStatus(exited({ exitCode: 0 })), 'exited-ok');
});

test('a stale kill request does not explain a much later crash', () => {
  // killed at t=0, died 5 minutes later with an error: that is a real story
  const s = exited({ killRequestedAt: 1000000 - 300000, exitCode: 1 });
  assert.strictEqual(proto.deriveStatus(s), 'exited-error');
});

test('closed requires an exit; a live session with a pending kill stays live', () => {
  const live = { exited: false, killRequestedAt: Date.now(), stale: false, startedAt: Date.now(), lastOutputAt: Date.now(), tailLine: '' };
  assert.strictEqual(proto.deriveStatus(live, Date.now()), 'running');
  assert.strictEqual(proto.isUserClosed(live), false);
});
