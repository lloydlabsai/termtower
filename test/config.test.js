'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-test-')), 'config.json');
}

test('load returns {} for a missing or corrupt file', () => {
  const f = tmpFile();
  assert.deepStrictEqual(config.load(f), {});
  fs.writeFileSync(f, 'not json');
  assert.deepStrictEqual(config.load(f), {});
});

test('save/load round-trips and effective() applies defaults', () => {
  const f = tmpFile();
  const stored = {};
  config.setPath(stored, 'summaries.interval_seconds', 300);
  config.save(stored, f);
  const eff = config.effective(config.load(f));
  assert.strictEqual(eff.summaries.interval_seconds, 300);
  assert.strictEqual(eff.summaries.enabled, true);
  assert.strictEqual(typeof eff.summaries.model, 'string');
  assert.ok(eff.summaries.model.length > 0);
  assert.strictEqual(eff.anthropic_key, null);
});

test('effective() rejects nonsense intervals', () => {
  assert.strictEqual(config.effective({ summaries: { interval_seconds: 5 } }).summaries.interval_seconds, 180);
  assert.strictEqual(config.effective({ summaries: { interval_seconds: 'soon' } }).summaries.interval_seconds, 180);
  assert.strictEqual(config.effective({ summaries: { interval_seconds: 60 } }).summaries.interval_seconds, 60);
});

test('config file wins over the environment for the key', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-env-key-aaaaaaaaaaaaaaaaaaaa';
  try {
    assert.strictEqual(config.apiKey(config.effective({})), 'sk-env-key-aaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(config.keySource(config.effective({})), 'env');
    const eff = config.effective({ anthropic_key: 'sk-file-key-bbbbbbbbbbbbbbbbbbbb' });
    assert.strictEqual(config.apiKey(eff), 'sk-file-key-bbbbbbbbbbbbbbbbbbbb');
    assert.strictEqual(config.keySource(eff), 'config');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('unsetPath removes and reports, tolerates absent paths', () => {
  const obj = { summaries: { enabled: false } };
  assert.strictEqual(config.unsetPath(obj, 'summaries.enabled'), true);
  assert.deepStrictEqual(obj, { summaries: {} });
  assert.strictEqual(config.unsetPath(obj, 'summaries.enabled'), false);
  assert.strictEqual(config.unsetPath(obj, 'nope.nope'), false);
});

test('maskSecret shows enough to recognize, not enough to steal', () => {
  const masked = config.maskSecret('sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234');
  assert.ok(masked.includes('…'));
  assert.ok(masked.length < 20);
  assert.ok(masked.endsWith('1234'));
  assert.strictEqual(config.maskSecret(''), '(not set)');
});

test('looksLikeAnthropicKey is loose but not useless', () => {
  assert.ok(config.looksLikeAnthropicKey('sk-ant-api03-' + 'a'.repeat(24)));
  assert.ok(!config.looksLikeAnthropicKey('hello'));
  assert.ok(!config.looksLikeAnthropicKey('sk-short'));
});

test('config file is written 0600', { skip: process.platform === 'win32' }, () => {
  const f = tmpFile();
  config.save({ anthropic_key: 'sk-secret-cccccccccccccccccccc' }, f);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});
