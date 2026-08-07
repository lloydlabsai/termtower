'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.TOWER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-searchtest-'));
delete process.env.ANTHROPIC_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const { matchSession } = require('../src/daemon');

const light = (over = {}) => ({
  id: 'x', name: 'vite-dev', cwd: 'C:\\work\\shop', command: 'npm run dev',
  kind: 'wrapped', summary: null, ...over,
});

test('matchSession finds hits in fields and lines, case-insensitively', () => {
  const m = matchSession(light(), ['Server listening', 'ERROR: token expired', 'retrying'], 'error');
  assert.ok(m);
  assert.deepStrictEqual(m.matchFields, []);
  assert.deepStrictEqual(m.matchLines, ['ERROR: token expired']);

  const byName = matchSession(light(), [], 'VITE');
  assert.deepStrictEqual(byName.matchFields, ['name']);

  const byCwd = matchSession(light(), [], 'shop');
  assert.deepStrictEqual(byCwd.matchFields, ['cwd']);
});

test('matchSession searches the narrative fields', () => {
  const m = matchSession(light({ summary: { doing: 'fixing the checkout flow', last: 'x', next: 'y' } }), [], 'checkout');
  assert.deepStrictEqual(m.matchFields, ['doing']);
});

test('matchSession returns null on a miss and caps line hits at 5', () => {
  assert.strictEqual(matchSession(light(), ['aaa', 'bbb'], 'zzz'), null);
  const noisy = Array.from({ length: 20 }, (_, i) => `hit number ${i}`);
  const m = matchSession(light(), noisy, 'hit');
  assert.strictEqual(m.matchLines.length, 5);
});

test('matchSession windows long lines around the hit so the query stays visible', () => {
  const early = matchSession(light(), ['x'.repeat(50) + 'needle' + 'y'.repeat(500)], 'needle');
  assert.ok(early.matchLines[0].length <= 201);
  assert.ok(early.matchLines[0].includes('needle'));

  // a hit far past the cap must still appear in the snippet
  const late = matchSession(light(), ['z'.repeat(300) + 'ETIMEDOUT after 30s' + 'w'.repeat(100)], 'etimedout');
  assert.ok(late.matchLines[0].length <= 201);
  assert.ok(late.matchLines[0].toLowerCase().includes('etimedout'));
  assert.ok(late.matchLines[0].startsWith('…'));
});
