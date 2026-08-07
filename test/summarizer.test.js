'use strict';
// Full-loop summarizer tests against a local mock of the Anthropic API.
// TOWER_DIR must be set before any src/ module is required.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.TOWER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-sumtest-'));
delete process.env.ANTHROPIC_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSummarizer, parseSummary, meaningfulLines, sanitizeStoredSummary, sanitizeStoredHistory } = require('../src/summarizer');
const proto = require('../src/protocol');

function writeConfig(cfg) {
  fs.mkdirSync(proto.TOWER_DIR, { recursive: true });
  fs.writeFileSync(proto.configPath(), JSON.stringify(cfg));
}

function fakeSession(over = {}) {
  return {
    id: 'x', name: 'vite-dev', cwd: '/tmp/app', command: 'npm run dev',
    exited: false, exitCode: null, summary: null,
    buffer: { toLines: () => over.lines || ['starting dev server', 'listening on :5173', 'compiled ok in 300ms'] },
    ...over,
  };
}

// A controllable stand-in for the Messages API.
function mockApi() {
  const state = { calls: 0, status: 200, text: JSON.stringify({ doing: 'serving the app', last: 'compiled ok', next: 'probably keep watching' }), bodies: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      state.calls++;
      state.bodies.push(JSON.parse(raw));
      if (state.status !== 200) {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'x', message: 'mock says no' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: state.text }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      process.env.TOWER_ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
      resolve({ state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function makeSummarizer() {
  const notes = { notified: 0, logs: [] };
  const sessions = [];
  const s = createSummarizer({
    collect: () => sessions,
    notify: () => notes.notified++,
    log: (m) => notes.logs.push(m),
  });
  return { s, sessions, notes };
}

test('parseSummary: strict, fenced, and hostile inputs', () => {
  assert.deepStrictEqual(
    parseSummary('{"doing":"a","last":"b","next":"c"}'),
    { doing: 'a', last: 'b', next: 'c' });
  assert.deepStrictEqual(
    parseSummary('Sure! ```json\n{"doing":"a","last":"b","next":"c"}\n```'),
    { doing: 'a', last: 'b', next: 'c' });
  assert.strictEqual(parseSummary('not json at all'), null);
  assert.strictEqual(parseSummary(''), null);
  const long = parseSummary(JSON.stringify({ doing: 'x'.repeat(500), last: 'b', next: 'c' }));
  assert.ok(long.doing.length <= 160);
});

test('parseSummary: last/next may honestly be null; doing is required', () => {
  assert.deepStrictEqual(
    parseSummary('{"doing":"serving on :8080","last":null,"next":null}'),
    { doing: 'serving on :8080', last: null, next: null });
  // missing optional fields read as null, not as a rejection
  assert.deepStrictEqual(
    parseSummary('{"doing":"a","last":"b"}'),
    { doing: 'a', last: 'b', next: null });
  // no doing, no summary
  assert.strictEqual(parseSummary('{"doing":null,"last":"b","next":"c"}'), null);
  assert.strictEqual(parseSummary('{"last":"b","next":"c"}'), null);
});

test('meaningfulLines drops noise and collapses heartbeats', () => {
  const lines = meaningfulLines([
    '', '=====', '[====>    ] 42%', '   ',
    'GET /health 200', 'GET /health 200', 'GET /health 200',
    'error: connection refused',
  ]);
  assert.deepStrictEqual(lines, ['GET /health 200', 'error: connection refused']);
});

test('happy path: changed session gets a summary, unchanged session does not repeat', async () => {
  const api = await mockApi();
  try {
    writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const { s, sessions, notes } = makeSummarizer();
    const sess = fakeSession();
    sessions.push(sess);
    await s._tick();
    assert.strictEqual(api.state.calls, 1);
    assert.strictEqual(sess.summary.doing, 'serving the app');
    assert.ok(sess.summary.summarizedAt > 0);
    assert.ok(notes.notified >= 1);
    // request carried the session context and the output
    const body = api.state.bodies[0];
    assert.ok(body.max_tokens <= 300);
    assert.match(body.messages[0].content, /vite-dev/);
    assert.match(body.messages[0].content, /compiled ok/);
    // same buffer, next tick: no new call
    await s._tick();
    assert.strictEqual(api.state.calls, 1);
  } finally { await api.close(); }
});

test('continuity: previous summary is sent along with new output', async () => {
  const api = await mockApi();
  try {
    writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const { s, sessions } = makeSummarizer();
    const sess = fakeSession({ summary: { doing: 'old story', last: 'x', next: 'y', summarizedAt: 1 } });
    sess.buffer.toLines = () => ['brand new line one', 'brand new line two', 'brand new line three'];
    sessions.push(sess);
    await s._tick();
    assert.strictEqual(api.state.calls, 1);
    assert.match(api.state.bodies[0].messages[0].content, /old story/);
  } finally { await api.close(); }
});

test('malformed model output keeps the previous summary and does not thrash', async () => {
  const api = await mockApi();
  try {
    writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const { s, sessions, notes } = makeSummarizer();
    const prev = { doing: 'the old truth', last: 'l', next: 'n', summarizedAt: 1 };
    const sess = fakeSession({ summary: { ...prev } });
    sessions.push(sess);
    api.state.text = 'I cannot answer in JSON today.';
    await s._tick();
    assert.strictEqual(sess.summary.doing, 'the old truth');
    assert.ok(notes.logs.some((l) => /malformed/.test(l)));
    // same content is not retried next tick
    await s._tick();
    assert.strictEqual(api.state.calls, 1);
  } finally { await api.close(); }
});

test('invalid key: one clear error, then no calls until the key changes', async () => {
  const api = await mockApi();
  try {
    writeConfig({ anthropic_key: 'sk-test-badbadbadbadbadbadbadbad' });
    const { s, sessions } = makeSummarizer();
    sessions.push(fakeSession());
    api.state.status = 401;
    await s._tick();
    assert.strictEqual(api.state.calls, 1);
    assert.match(s.meta().error, /key rejected/i);
    assert.strictEqual(s.meta().on, false);
    // still latched
    sessions[0].buffer.toLines = () => ['totally new output', 'more new output', 'even more'];
    await s._tick();
    assert.strictEqual(api.state.calls, 1);
    // key change clears the latch
    api.state.status = 200;
    writeConfig({ anthropic_key: 'sk-test-goodgoodgoodgoodgoodgood' });
    await s._tick();
    assert.strictEqual(api.state.calls, 2);
    assert.strictEqual(s.meta().error, null);
  } finally { await api.close(); }
});

test('network down: quiet backoff, session state untouched', async () => {
  const api = await mockApi();
  await api.close(); // server gone = connection refused
  writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa' });
  const { s, sessions, notes } = makeSummarizer();
  const sess = fakeSession();
  sessions.push(sess);
  await s._tick();
  assert.strictEqual(sess.summary, null);
  assert.strictEqual(sess.exited, false);
  assert.ok(notes.logs.some((l) => /backing off/.test(l)));
  assert.strictEqual(s.meta().error, null); // transient, not surfaced as config trouble
});

test('exited session is summarized once with the exit noted, then left alone', async () => {
  const api = await mockApi();
  try {
    writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const { s, sessions } = makeSummarizer();
    const sess = fakeSession({ exited: true, exitCode: 2, lines: ['test run started', '3 passed, 1 failed', 'FAIL src/app.test.js'] });
    sessions.push(sess);
    await s._tick();
    assert.strictEqual(api.state.calls, 1);
    assert.match(api.state.bodies[0].messages[0].content, /exited \(code 2\)/);
    await s._tick();
    assert.strictEqual(api.state.calls, 1);
  } finally { await api.close(); }
});

test('exit pass survives a transient failure and completes when the network returns', async () => {
  const api = await mockApi();
  await api.close(); // network down for the first tick
  writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa' });
  const { s, sessions } = makeSummarizer();
  const sess = fakeSession({ exited: true, exitCode: 1, lines: ['build started', 'fatal: out of memory', 'build aborted'] });
  sessions.push(sess);
  await s._tick();
  assert.strictEqual(sess.summary, null);
  assert.notStrictEqual(sess.summaryCtl.exitDone, true); // the latch must not burn on failure
  const api2 = await mockApi();
  try {
    await s._tick(); // backoff tick (skipped)
    await s._tick(); // live again
    assert.strictEqual(api2.state.calls, 1);
    assert.ok(sess.summary);
    assert.strictEqual(sess.summaryCtl.exitDone, true);
    await s._tick(); // and only once
    assert.strictEqual(api2.state.calls, 1);
  } finally { await api2.close(); }
});

test('call budget goes to the least-recently-summarized, nobody starves', async () => {
  const api = await mockApi();
  try {
    writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const { s, sessions } = makeSummarizer();
    for (let i = 0; i < 8; i++) {
      sessions.push(fakeSession({ id: 'sess' + i, name: 'sess' + i, lines: [`alpha work item ${i}`, `beta result ${i}`, `gamma detail ${i}`] }));
    }
    await s._tick();
    assert.strictEqual(api.state.calls, 6); // capped
    await s._tick();
    assert.strictEqual(api.state.calls, 8); // the two left behind go first next tick
    const named = new Set(api.state.bodies.map((b) => b.messages[0].content.match(/session: (\S+)/)[1]));
    assert.strictEqual(named.size, 8);
  } finally { await api.close(); }
});

test('isLive veto: a session dropped from its registry costs nothing', async () => {
  const api = await mockApi();
  try {
    writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const notes = { logs: [] };
    const sessions = [fakeSession()];
    const s = createSummarizer({
      collect: () => sessions,
      notify: () => {},
      log: (m) => notes.logs.push(m),
      isLive: () => false,
    });
    await s._tick();
    assert.strictEqual(api.state.calls, 0);
  } finally { await api.close(); }
});

test('parseSummary strips ANSI and control bytes from model output', () => {
  const p = parseSummary(JSON.stringify({
    doing: 'work[2J[1;1Hing on it',
    last: 'line with  bell',
    next: ']0;evil titleprobably fine',
  }));
  assert.ok(p, 'should still parse');
  for (const v of [p.doing, p.last, p.next]) {
    assert.ok(!/[ -]/.test(v), 'control byte survived in ' + JSON.stringify(v));
  }
  assert.match(p.next, /probably fine/);
});

test('stored summaries re-entering from state.json are sanitized, validated, and clamped', () => {
  // hostile doing with real escape bytes
  const dirty = { doing: 'pwned ]0;title here [2J', last: null, next: 'ok', summarizedAt: 5 };
  const clean = sanitizeStoredSummary(dirty);
  assert.ok(!/[\x00-\x1f\x7f]/.test(clean.doing), 'escape bytes survived restore');
  assert.match(clean.doing, /pwned/);
  assert.strictEqual(clean.last, null);
  assert.strictEqual(clean.next, 'ok');
  // garbage shapes die quietly
  assert.strictEqual(sanitizeStoredSummary(null), null);
  assert.strictEqual(sanitizeStoredSummary('a string'), null);
  assert.strictEqual(sanitizeStoredSummary({ last: 'no doing' }), null);
  // over-depth and null-riddled arrays come back bounded and clean
  const arr = [null, dirty, 'junk', ...Array.from({ length: 20 }, (_, i) => ({ doing: 'gen ' + i, summarizedAt: i }))];
  const hist = sanitizeStoredHistory(arr, 5);
  assert.strictEqual(hist.length, 5);
  assert.ok(hist.every((h) => h && typeof h.doing === 'string'));
});

test('superseded summaries ring up newest-first, hard-capped at history_depth', async () => {
  const api = await mockApi();
  try {
    writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa', summaries: { history_depth: 3 } });
    const { s, sessions } = makeSummarizer();
    const sess = fakeSession();
    sessions.push(sess);
    for (let gen = 1; gen <= 5; gen++) {
      sess.buffer.toLines = () => [`generation ${gen} line one`, `generation ${gen} line two`, `generation ${gen} line three`];
      api.state.text = JSON.stringify({ doing: `working on gen ${gen}`, last: 'l' + gen, next: 'n' + gen });
      await s._tick();
    }
    assert.strictEqual(api.state.calls, 5);
    assert.strictEqual(sess.summary.doing, 'working on gen 5');
    assert.deepStrictEqual(sess.summaryHistory.map((h) => h.doing),
      ['working on gen 4', 'working on gen 3', 'working on gen 2']); // gen 1 fell off the ring
  } finally { await api.close(); }
});

test('a user-closed session is narrated as a stop, not a crash', async () => {
  const api = await mockApi();
  try {
    writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const { s, sessions } = makeSummarizer();
    const now = Date.now();
    sessions.push(fakeSession({
      exited: true, exitCode: 1, exitSignal: 'SIGTERM', killRequestedAt: now - 2000, exitedAt: now,
      lines: ['watching src/', 'rebuilt ok', 'shutting down'],
    }));
    await s._tick();
    assert.strictEqual(api.state.calls, 1);
    const content = api.state.bodies[0].messages[0].content;
    assert.match(content, /deliberately stopped/);
    assert.ok(!/has exited \(code/.test(content));
  } finally { await api.close(); }
});

test('no key or summaries disabled: never calls, never errors', async () => {
  const api = await mockApi();
  try {
    writeConfig({});
    const { s, sessions } = makeSummarizer();
    sessions.push(fakeSession());
    await s._tick();
    assert.strictEqual(api.state.calls, 0);
    assert.strictEqual(s.meta().on, false);
    assert.strictEqual(s.meta().keyless, true);
    writeConfig({ anthropic_key: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa', summaries: { enabled: false } });
    await s._tick();
    assert.strictEqual(api.state.calls, 0);
    assert.strictEqual(s.meta().keyless, false); // key present, disabled on purpose: no hint
  } finally { await api.close(); }
});
