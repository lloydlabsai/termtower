'use strict';
// The narrative layer. Every summary interval, sessions whose output changed
// meaningfully get a three-line story (doing / last / next) from a small model
// using the user's own key. Summaries are annotations layered over the
// mechanical status, never inputs to it: every failure path in this file must
// leave core session tracking untouched.

const proto = require('./protocol');
const config = require('./config');
const anthropic = require('./anthropic');

const FIRST_TICK_MS = 20000;      // first pass soon after start, then the configured interval
const MAX_LINES_SENT = 120;       // ring-buffer tail sent to the model
const MAX_LINE_CHARS = 300;
const MAX_FIELD_CHARS = 160;      // per summary field, post-parse
const MAX_TOKENS = 300;           // hard cap per call
const MAX_CALLS_PER_TICK = 6;     // cost ceiling when many sessions change at once
const MIN_NEW_LINES = 2;          // fewer new lines than this is not a new story
const BACKOFF_TICKS = [1, 2, 4, 8];

// Output lines that carry no narrative (bars, spinners, dividers, counters).
// Same philosophy as PROMPT_PATTERNS in protocol.js: dumb, short, tunable.
const NOISE_PATTERNS = [
  /^[\s\-=+#>._|/\\%\d\[\]():,]*$/,
  /^[⠁⠂⠄⡀⢀⠠⠐⠈⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷◐◓◑◒]+\s*/,
];

function isNoise(line) {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

// Meaningful content of a buffer: non-empty, non-noise, consecutive dupes
// collapsed (heartbeat logs print the same line forever).
function meaningfulLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = String(raw);
    if (line.trim() === '' || isNoise(line)) continue;
    if (out.length && out[out.length - 1] === line) continue;
    out.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line);
  }
  return out.slice(-MAX_LINES_SENT);
}

function hashLines(lines) {
  // djb2 over the joined tail: cheap, collision-tolerant (a false "unchanged"
  // just delays one summary by a tick).
  let h = 5381;
  const s = lines.join('\n');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${lines.length}:${h}`;
}

const SYSTEM_PROMPT = `You annotate a terminal status board. Given recent output from one terminal session, reply with STRICT JSON only - no markdown, no code fences, no extra keys:
{"doing":"...","last":"..." or null,"next":"..." or null}
doing: what this session is working on. One line, under 90 characters. Required.
last: the most recent meaningful development. One line, under 90 characters. Use null if nothing meaningful has developed yet.
next: the likely next step, phrased as a suggestion ("probably ...", "likely ..."), never a certainty. One line, under 90 characters. Use null when there is no meaningful next step - a healthy steady-state server or watcher needs no invented advice.
Honesty rules: never state a guess as fact; uncertainty must read as uncertainty ("appears to be ...", "may have ..."). Do not invent detail the output does not support - prefer null over speculation.
Plain language, present tense, no filler. If a previous summary is provided, keep the narrative continuous: "still fixing X, now past Y" beats a disconnected snapshot. If the output is too thin to tell what is happening, say so plainly in doing ("quiet session, nothing notable yet") rather than inventing detail.`;

function buildUserContent(item) {
  const parts = [
    `session: ${item.name}`,
    `directory: ${item.cwd || '(unknown)'}`,
    `command: ${item.command || '(unknown)'}`,
  ];
  if (item.closed) {
    // A deliberate stop is not a crash and must not read like one.
    parts.push('NOTE: the user deliberately stopped this session (tower kill / Ctrl+C). Summarize what it was doing and what it got done. Do not describe the stop as a crash or failure. "next" is usually null unless the output shows something left visibly unfinished.');
  } else if (item.exited) {
    parts.push(`NOTE: the process has exited (code ${item.exitCode ?? 'unknown'}). Summarize what it accomplished or where it failed; "next" is what the user should probably do about it.`);
  }
  if (item.previous) {
    parts.push(`previous summary (build on it): ${JSON.stringify(item.previous)}`);
  }
  parts.push(`${item.contentLabel} (oldest first):\n<<<\n${item.content}\n>>>`);
  return parts.join('\n');
}

// Model output ends up in terminals (tower ls) and in state.json; a hostile
// transcript could talk the model into emitting escape sequences, so control
// bytes are stripped no matter what JSON.parse decoded.
const SUMMARY_ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const SUMMARY_CTRL_RE = /[\x00-\x1f\x7f]/g;

// Defensive parse: fences stripped, outermost braces only, three non-empty
// control-free string fields or nothing.
function parseSummary(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj = null;
  try { obj = JSON.parse(t.slice(start, end + 1)); } catch { return null; }
  const clean = (v) => {
    if (typeof v !== 'string') return null;
    const s = v.replace(SUMMARY_ANSI_RE, '').replace(SUMMARY_CTRL_RE, ' ').trim();
    return s ? s.slice(0, MAX_FIELD_CHARS) : null;
  };
  // doing is required; last/next may honestly be null (steady-state sessions,
  // nothing meaningful yet) and render as nothing, not placeholder text.
  const doing = clean(obj.doing);
  if (!doing) return null;
  return { doing, last: clean(obj.last), next: clean(obj.next) };
}

// collect() -> iterable of session records. A record is summarizable when it
// has id/name/cwd/command and either a live `buffer` (wrapped session) or a
// `narrative()` method (transcript-backed session, see claudewatch.js).
// isLive(sess) lets the owner veto a paid call for a record that was removed
// from its registry while a slow tick was in flight.
function createSummarizer({ collect, notify, log, isLive = () => true }) {
  let timer = null;
  let stopped = false;
  let running = false;
  let failures = 0;
  let skipTicks = 0;
  let badKey = null;
  let lastError = null;

  // What ls/board show. `on` means "a key is present and summaries enabled";
  // `keyless` drives the board's one-time hint (a disabled-on-purpose setup
  // with a key present should never be nagged).
  function meta() {
    const eff = config.effectiveCached();
    const key = config.apiKey(eff);
    return {
      on: !!(key && eff.summaries.enabled && !lastError),
      keyless: !key,
      // A removed key is not "rejected": show the hint, not a stale error.
      error: key ? lastError : null,
    };
  }

  function evaluate(sess) {
    const ctl = sess.summaryCtl || (sess.summaryCtl = {});
    if (typeof sess.narrative === 'function') {
      // Transcript-backed session: it decides what changed and what to send.
      const n = sess.narrative();
      if (!n) return null;
      if (n.sig === ctl.sig) return null;
      return { sess, ctl, sig: n.sig, name: sess.name, cwd: sess.cwd, command: sess.command,
        exited: false, exitCode: null, previous: sess.summary || null,
        contentLabel: 'recent conversation turns', content: n.content };
    }
    if (!sess.buffer) return null;
    if (sess.exited && ctl.exitDone) return null;
    const lines = meaningfulLines(sess.buffer.toLines());
    if (lines.length === 0) { if (sess.exited) ctl.exitDone = true; return null; }
    const sig = hashLines(lines);
    let exitedPass = false;
    if (sess.exited) {
      // One final pass so the story ends where the process did; if nothing
      // changed since the last summary, the standing one already tells it.
      // The latch is committed only after the API call happens (or the story
      // is already told) - a transient failure must not eat the last chapter.
      if (sig === ctl.sig && sess.summary) { ctl.exitDone = true; return null; }
      exitedPass = true;
    } else if (sig === ctl.sig) {
      return null;
    } else if (ctl.lineSet) {
      let fresh = 0;
      for (const l of lines) if (!ctl.lineSet.has(l)) fresh++;
      if (fresh < MIN_NEW_LINES && sess.summary) return null;
    }
    return { sess, ctl, sig, lines, exitedPass, name: sess.name, cwd: sess.cwd, command: sess.command,
      exited: sess.exited, exitCode: sess.exitCode, closed: proto.isUserClosed(sess),
      previous: sess.summary || null,
      contentLabel: 'recent output', content: lines.join('\n') };
  }

  async function summarizeOne(item, eff, key) {
    const res = await anthropic.createMessage({
      apiKey: key,
      model: eff.summaries.model,
      maxTokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserContent(item) }],
    });
    const parsed = parseSummary(anthropic.extractText(res));
    // The call happened: commit the change-tracking either way (malformed
    // output keeps the previous summary and does not thrash retries on the
    // same content), and an exit pass counts as done.
    item.ctl.sig = item.sig;
    if (item.lines) item.ctl.lineSet = new Set(item.lines);
    if (item.exitedPass) item.ctl.exitDone = true;
    if (!parsed) {
      log(`summarizer: malformed model output for ${item.name}; keeping previous summary`);
      return;
    }
    // The owner may have dropped this record while we were on the wire;
    // writing a summary to a ghost helps no one.
    if (!isLive(item.sess)) return;
    // The superseded summary joins a hard ring - the story of the session,
    // newest first, never unbounded (state.json is not a database).
    if (item.sess.summary) {
      const depth = eff.summaries.history_depth;
      item.sess.summaryHistory = [item.sess.summary, ...(item.sess.summaryHistory || [])].slice(0, depth);
    }
    item.sess.summary = { ...parsed, summarizedAt: Date.now() };
    notify();
  }

  async function tick() {
    const eff = config.effectiveCached();
    const key = config.apiKey(eff);
    if (!key || !eff.summaries.enabled) { lastError = null; return; }
    if (badKey) {
      if (key === badKey) return; // stop retrying until config changes
      badKey = null;
      lastError = null;
    }
    if (skipTicks > 0) { skipTicks--; return; }
    // Evaluate everything, then spend the per-tick call budget on whoever has
    // gone longest without a summary - a fixed iteration order would starve
    // whatever happens to sit past the cap forever.
    let candidates = [];
    for (const sess of collect()) {
      const item = evaluate(sess);
      if (item) candidates.push(item);
    }
    if (candidates.length > MAX_CALLS_PER_TICK) {
      candidates.sort((a, b) =>
        ((a.sess.summary && a.sess.summary.summarizedAt) || 0) - ((b.sess.summary && b.sess.summary.summarizedAt) || 0));
      candidates = candidates.slice(0, MAX_CALLS_PER_TICK);
    }
    for (const item of candidates) {
      if (!isLive(item.sess)) continue; // removed while this tick was running
      try {
        await summarizeOne(item, eff, key);
        failures = 0;
        lastError = null;
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          badKey = key;
          lastError = 'API key rejected - update it with: tower config set anthropic_key <key>';
          log('summarizer: API key rejected; pausing until the key changes');
          notify();
          return;
        }
        failures++;
        skipTicks = BACKOFF_TICKS[Math.min(failures - 1, BACKOFF_TICKS.length - 1)];
        log(`summarizer: ${e.message}; backing off ${skipTicks} tick(s)`);
        return; // transient trouble; abandon the rest of this tick
      }
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    timer = setTimeout(async () => {
      running = true;
      try { await tick(); } catch (e) { log(`summarizer: unexpected: ${e.message}`); }
      running = false;
      schedule(config.effectiveCached().summaries.interval_seconds * 1000);
    }, delayMs);
    if (timer.unref) timer.unref();
  }

  return {
    start() { schedule(FIRST_TICK_MS); },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    meta,
    // exposed for tests
    _tick: tick,
    _evaluate: evaluate,
  };
}

module.exports = { createSummarizer, parseSummary, meaningfulLines, isNoise, hashLines };
