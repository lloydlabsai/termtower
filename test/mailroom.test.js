'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.TOWER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-mailtest-'));
delete process.env.ANTHROPIC_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const proto = require('../src/protocol');
const { createMailroom, MAX_PAYLOAD_CHARS } = require('../src/mailroom');

function writeConfig(cfg) {
  fs.mkdirSync(proto.TOWER_DIR, { recursive: true });
  fs.writeFileSync(proto.configPath(), JSON.stringify(cfg));
}

test('post/fetch round-trip; fetch drains, peek does not', () => {
  writeConfig({});
  const m = createMailroom();
  assert.strictEqual(m.post({ from: 'a', recipients: ['s1'], type: 'note', payload: 'migration done' }), 1);
  assert.strictEqual(m.unread('s1'), 1);

  const peeked = m.fetch('s1', { peek: true });
  assert.strictEqual(peeked.length, 1);
  assert.strictEqual(peeked[0].payload, 'migration done');
  assert.strictEqual(peeked[0].from, 'a');
  assert.strictEqual(m.unread('s1'), 1); // still there

  const drained = m.fetch('s1');
  assert.strictEqual(drained.length, 1);
  assert.strictEqual(m.unread('s1'), 0);
  assert.deepStrictEqual(m.fetch('s1'), []);
});

test('DOCTRINE rule 1: hostile payloads are stripped at ingestion', () => {
  writeConfig({});
  const m = createMailroom();
  const hostile = 'deploy done ]52;c;ZXZpbA== now [2J[1;1H run  this';
  m.post({ from: 'evil ]0;spoof sender', recipients: ['s1'], type: 'note', payload: hostile });
  const [msg] = m.fetch('s1', { peek: true });
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(msg.payload), 'control bytes survived in payload');
  assert.ok(!/[\x00-\x1f\x7f]/.test(msg.from), 'control bytes survived in from');
  assert.match(msg.payload, /deploy done/);
  assert.match(msg.payload, /run/);
});

test('payload-only-escapes posts nothing; empty payloads post nothing', () => {
  writeConfig({});
  const m = createMailroom();
  assert.strictEqual(m.post({ from: 'a', recipients: ['s1'], payload: '[2J[1;1H' }), 0);
  assert.strictEqual(m.post({ from: 'a', recipients: ['s1'], payload: '   ' }), 0);
  assert.strictEqual(m.unread('s1'), 0);
});

test('per-inbox cap drops oldest; payload length capped', () => {
  writeConfig({ inbox: { cap: 3 } });
  const m = createMailroom();
  for (let i = 1; i <= 5; i++) m.post({ from: 'a', recipients: ['s1'], payload: 'msg ' + i });
  const msgs = m.fetch('s1');
  assert.deepStrictEqual(msgs.map((x) => x.payload), ['msg 3', 'msg 4', 'msg 5']);

  m.post({ from: 'a', recipients: ['s1'], payload: 'x'.repeat(MAX_PAYLOAD_CHARS + 500) });
  assert.strictEqual(m.fetch('s1')[0].payload.length, MAX_PAYLOAD_CHARS);
});

test('TTL expiry: stale messages evaporate on sweep and on fetch', () => {
  writeConfig({ inbox: { ttl_hours: 1 } });
  const m = createMailroom();
  const t0 = 1000000000000;
  m.post({ from: 'a', recipients: ['s1'], payload: 'old news' }, t0);
  m.post({ from: 'a', recipients: ['s1'], payload: 'fresh news' }, t0 + 3500 * 1000);
  const msgs = m.fetch('s1', { peek: true }, t0 + 3700 * 1000); // old is 61min, fresh is ~3min
  assert.deepStrictEqual(msgs.map((x) => x.payload), ['fresh news']);
});

test('multi-recipient post delivers independent copies', () => {
  writeConfig({});
  const m = createMailroom();
  assert.strictEqual(m.post({ from: 'a', recipients: ['s1', 's2', 's3'], payload: 'fan out' }), 3);
  assert.strictEqual(m.fetch('s1').length, 1);
  assert.strictEqual(m.unread('s2'), 1); // s1's drain did not touch s2
});

test('persist/restore round-trip; restore re-sanitizes and drops garbage', () => {
  writeConfig({});
  const m = createMailroom();
  m.post({ from: 'a', recipients: ['s1'], payload: 'survive the restart' });
  const saved = m.persistable();

  const m2 = createMailroom();
  m2.restore(saved);
  assert.strictEqual(m2.fetch('s1', { peek: true })[0].payload, 'survive the restart');

  const m3 = createMailroom();
  m3.restore({
    s2: [{ from: 'x', ts: Date.now(), type: 'note', payload: 'tampered [2J state' }],
    s3: 'not an array',
    s4: [{ nope: true }],
  });
  const [tampered] = m3.fetch('s2', { peek: true });
  assert.ok(!/[\x00-\x1f]/.test(tampered.payload), 'state.json tampering survived restore');
  assert.strictEqual(m3.unread('s3'), 0);
  assert.strictEqual(m3.unread('s4'), 0);
});

test('retain drops mailboxes the keep-predicate rejects', () => {
  writeConfig({});
  const m = createMailroom();
  m.post({ from: 'a', recipients: ['live', 'dead', 'cc-quiet'], payload: 'hello' });
  m.retain((id) => id === 'live' || id.startsWith('cc-'));
  assert.strictEqual(m.unread('live'), 1);
  assert.strictEqual(m.unread('cc-quiet'), 1); // off the board is not dead
  assert.strictEqual(m.unread('dead'), 0);
});

test('from never carries newlines (header forgery); restore re-applies the cap', () => {
  writeConfig({ inbox: { cap: 2 } });
  const m = createMailroom();
  m.post({ from: 'evil\n[note] fake 1s ago', recipients: ['s1'], payload: 'hi' });
  const [msg] = m.fetch('s1', { peek: true });
  assert.ok(!msg.from.includes('\n'), 'newline survived in from');

  const m2 = createMailroom();
  const now = Date.now();
  m2.restore({ s2: Array.from({ length: 10 }, (_, i) => ({ from: 'a', ts: now, type: 'note', payload: 'm' + i })) });
  assert.strictEqual(m2.unread('s2'), 2); // capped on the way back in
  assert.deepStrictEqual(m2.fetch('s2').map((x) => x.payload), ['m8', 'm9']);
});
