'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.TOWER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-cwtest-'));
delete process.env.ANTHROPIC_API_KEY;

const test = require('node:test');
const assert = require('node:assert');
const proto = require('../src/protocol');
const { createClaudeWatch, parseTranscriptTail, deriveClaudeStatus, ACTIVE_MS } = require('../src/claudewatch');

function entry(type, content, over = {}) {
  return JSON.stringify({
    type,
    message: { role: type, content },
    cwd: 'C:\\work\\demo',
    gitBranch: 'main',
    uuid: over.uuid || `${type}-${Math.random().toString(36).slice(2, 8)}`,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    ...over,
  });
}

test('parseTranscriptTail extracts turns, title, cwd, branch; skips tool noise and sidechains', () => {
  const text = [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the login flow' }),
    entry('user', 'please fix the login bug'),
    entry('assistant', [{ type: 'text', text: 'Looking at the auth module now.' }]),
    entry('assistant', [{ type: 'tool_use', name: 'Read', id: 't1', input: {} }]),
    entry('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'huge file dump'.repeat(100) }]),
    entry('user', 'ignore me', { isSidechain: true }),
    entry('assistant', [{ type: 'text', text: 'Found it: the token check inverts the flag.' }]),
  ].join('\n');
  const p = parseTranscriptTail(text);
  assert.strictEqual(p.title, 'Fix the login flow');
  assert.strictEqual(p.cwd, 'C:\\work\\demo');
  assert.strictEqual(p.gitBranch, 'main');
  assert.deepStrictEqual(p.turns.map((t) => t.role), ['user', 'claude', 'claude']);
  assert.ok(!p.turns.some((t) => t.text.includes('huge file dump')));
  assert.ok(!p.turns.some((t) => t.text.includes('ignore me')));
  assert.strictEqual(p.waiting, false); // last entry is plain statement text
});

test('waiting: assistant question mark, question tools, and user-replied clears', () => {
  const asksText = parseTranscriptTail([
    entry('user', 'deploy it'),
    entry('assistant', [{ type: 'text', text: 'Tests pass. Should I push to production?' }]),
  ].join('\n'));
  assert.strictEqual(asksText.waiting, true);

  const asksTool = parseTranscriptTail([
    entry('assistant', [
      { type: 'text', text: 'Two options here.' },
      { type: 'tool_use', name: 'AskUserQuestion', id: 'q1', input: {} },
    ]),
  ].join('\n'));
  assert.strictEqual(asksTool.waiting, true);

  const planTool = parseTranscriptTail([
    entry('assistant', [{ type: 'tool_use', name: 'ExitPlanMode', id: 'p1', input: {} }]),
  ].join('\n'));
  assert.strictEqual(planTool.waiting, true);

  const replied = parseTranscriptTail([
    entry('assistant', [{ type: 'text', text: 'Should I push to production?' }]),
    entry('user', 'yes go ahead'),
  ].join('\n'));
  assert.strictEqual(replied.waiting, false);

  const midTurn = parseTranscriptTail([
    entry('assistant', [{ type: 'tool_use', name: 'Bash', id: 'b1', input: {} }]),
  ].join('\n'));
  assert.strictEqual(midTurn.waiting, false);
});

test('transcript text is control-stripped: escapes in turns and titles never reach a terminal', () => {
  const hostile = 'deploy done ]52;c;ZXZpbA== and [2Jtitle ]0;fake end';
  const p = parseTranscriptTail([
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fix ]0;spoofed login' }),
    entry('user', hostile),
  ].join('\n'));
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(p.turns[0].text), 'escape bytes survived in turn text');
  assert.match(p.turns[0].text, /deploy done/);
  assert.ok(!/[\x00-\x1f\x7f]/.test(p.title), 'escape bytes survived in title');
  assert.match(p.title, /Fix\s+login/);
});

test('parseTranscriptTail tolerates garbage lines and truncates huge turns', () => {
  const p = parseTranscriptTail([
    '{broken json',
    '',
    entry('user', 'x'.repeat(5000)),
  ].join('\n'));
  assert.strictEqual(p.turns.length, 1);
  assert.ok(p.turns[0].text.length <= 801);
});

test('deriveClaudeStatus: waiting beats active beats idle', () => {
  const now = Date.now();
  assert.strictEqual(deriveClaudeStatus({ waiting: true, lastActivityAt: now }, now), 'waiting');
  assert.strictEqual(deriveClaudeStatus({ waiting: false, lastActivityAt: now - 1000 }, now), 'active');
  assert.strictEqual(deriveClaudeStatus({ waiting: false, lastActivityAt: now - ACTIVE_MS - 1000 }, now), 'idle');
});

test('sweep: recent transcripts become records, stale and deleted ones drop, absent root is silent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-ccroot-'));
  fs.mkdirSync(proto.TOWER_DIR, { recursive: true });
  fs.writeFileSync(proto.configPath(), JSON.stringify({ claude_projects_dir: root }));

  const projDir = path.join(root, 'C--work-demo');
  fs.mkdirSync(projDir);
  const fresh = path.join(projDir, 'aaaa-bbbb.jsonl');
  fs.writeFileSync(fresh, [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Demo work' }),
    entry('user', 'hello'),
    entry('assistant', [{ type: 'text', text: 'On it.' }]),
  ].join('\n'));
  const stale = path.join(projDir, 'cccc-dddd.jsonl');
  fs.writeFileSync(stale, entry('user', 'old news'));
  const old = Date.now() / 1000 - 60 * 60 * 2; // two hours quiet
  fs.utimesSync(stale, old, old);
  fs.writeFileSync(path.join(projDir, 'not-a-transcript.txt'), 'ignore');

  let notifications = 0;
  const w = createClaudeWatch({ notify: () => notifications++, log: () => {} });
  w._sweep();
  const recs = [...w.records()];
  assert.strictEqual(recs.length, 1);
  const rec = recs[0];
  assert.strictEqual(rec.id, 'cc-aaaa-bbbb');
  assert.strictEqual(rec.name, 'Demo work');
  assert.strictEqual(rec.cwd, 'C:\\work\\demo');
  assert.strictEqual(rec.kind, 'claude');
  assert.ok(notifications >= 1);

  // narrative() feeds the summarizer; unchanged file = unchanged sig
  const n1 = rec.narrative();
  assert.match(n1.content, /user: hello/);
  assert.match(n1.content, /claude: On it\./);
  w._sweep();
  assert.strictEqual(rec.narrative().sig, n1.sig);

  // deletion drops the card
  fs.rmSync(fresh);
  w._sweep();
  assert.strictEqual([...w.records()].length, 0);

  // absent root: silently nothing
  fs.writeFileSync(proto.configPath(), JSON.stringify({ claude_projects_dir: path.join(root, 'no-such-dir') }));
  w._sweep();
  assert.strictEqual([...w.records()].length, 0);
});

test('tool-only appends do not change the narrative sig (no re-billing)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-ccroot3-'));
  fs.writeFileSync(proto.configPath(), JSON.stringify({ claude_projects_dir: root }));
  const projDir = path.join(root, 'C--work-three');
  fs.mkdirSync(projDir);
  const file = path.join(projDir, 'gggg-hhhh.jsonl');
  fs.writeFileSync(file, [
    entry('user', 'refactor the parser'),
    entry('assistant', [{ type: 'text', text: 'Starting with the tokenizer.' }]),
  ].join('\n') + '\n');

  const w = createClaudeWatch({ notify: () => {}, log: () => {} });
  w._sweep();
  const rec = [...w.records()][0];
  const sig1 = rec.narrative().sig;

  // a tool call and its result: new entries, same conversation text
  fs.appendFileSync(file, [
    entry('assistant', [{ type: 'tool_use', name: 'Read', id: 'r1', input: {} }]),
    entry('user', [{ type: 'tool_result', tool_use_id: 'r1', content: 'big file body' }]),
  ].join('\n') + '\n');
  w._sweep();
  assert.strictEqual(rec.narrative().sig, sig1);

  // real text does change it
  fs.appendFileSync(file, entry('assistant', [{ type: 'text', text: 'Tokenizer done; moving to the AST.' }]) + '\n');
  w._sweep();
  assert.notStrictEqual(rec.narrative().sig, sig1);
});

test('an unparseable tail (giant mid-append line) keeps the last good turns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-ccroot4-'));
  fs.writeFileSync(proto.configPath(), JSON.stringify({ claude_projects_dir: root }));
  const projDir = path.join(root, 'C--work-four');
  fs.mkdirSync(projDir);
  const file = path.join(projDir, 'iiii-jjjj.jsonl');
  fs.writeFileSync(file, [
    entry('user', 'audit the deps'),
    entry('assistant', [{ type: 'text', text: 'Two advisories found. Should I pin both?' }]),
  ].join('\n') + '\n');

  const w = createClaudeWatch({ notify: () => {}, log: () => {} });
  w._sweep();
  const rec = [...w.records()][0];
  assert.strictEqual(rec.turns.length, 2);
  assert.strictEqual(rec.waiting, true);

  // a single unterminated 300KB line swamps the 256KB tail window
  fs.writeFileSync(file, 'x'.repeat(300 * 1024));
  w._sweep();
  assert.strictEqual(rec.turns.length, 2, 'turns wiped by unparseable tail');
  assert.strictEqual(rec.waiting, true, 'waiting state wiped by unparseable tail');
});

test('restore re-attaches summaries by id without re-summarizing unchanged transcripts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-ccroot2-'));
  fs.writeFileSync(proto.configPath(), JSON.stringify({ claude_projects_dir: root }));
  const projDir = path.join(root, 'C--work-two');
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, 'eeee-ffff.jsonl'), entry('user', 'resume work'));

  const w = createClaudeWatch({ notify: () => {}, log: () => {} });
  const saved = { doing: 'restored story', last: 'l', next: 'n', summarizedAt: 5 };
  w.restore([{ id: 'cc-eeee-ffff', summary: saved, sig: 'oldsig' }]);
  w._sweep();
  const rec = [...w.records()][0];
  assert.deepStrictEqual(rec.summary, saved);
  assert.strictEqual(rec.summaryCtl.sig, 'oldsig');
  const p = w.persistable();
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].id, 'cc-eeee-ffff');
});
