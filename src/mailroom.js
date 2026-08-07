'use strict';
// The daemon as mailbox, agents as opt-in readers. Sessions and the CLI post
// plain-text notes; a session drains its own inbox when it chooses to look.
// Nothing is ever injected into a terminal - delivery ends at the mailbox.
//
// Envelope: { from, to, ts, type: 'event'|'note', payload }
// Mailboxes are keyed by session id (names get deduped and retitled; ids do
// not). Payloads are sanitized AT INGESTION (DOCTRINE rule 1) and capped.
// Messages are ephemeral: TTL + a hard per-inbox cap, oldest dropped.

const proto = require('./protocol');
const config = require('./config');

const MAX_PAYLOAD_CHARS = 2000;
const MAX_FROM_CHARS = 64;

function createMailroom({ log = () => {} } = {}) {
  const boxes = new Map(); // session id -> [envelope]

  function limits() {
    const eff = config.effectiveCached();
    return {
      ttlMs: eff.inbox.ttl_hours * 3600 * 1000,
      cap: eff.inbox.cap,
    };
  }

  // recipients: array of session ids. Returns delivered count.
  function post({ from, recipients, type, payload }, now = Date.now()) {
    const clean = proto.sanitizeText(String(payload || '')).trim().slice(0, MAX_PAYLOAD_CHARS);
    if (!clean) return 0;
    const envelope = {
      // whitespace collapses in `from`: an embedded newline could forge a
      // fresh header line in the CLI's inbox print
      from: proto.sanitizeText(String(from || 'cli')).replace(/\s+/g, ' ').trim().slice(0, MAX_FROM_CHARS) || 'cli',
      ts: now,
      type: type === 'event' ? 'event' : 'note',
      payload: clean,
    };
    const { cap } = limits();
    let delivered = 0;
    for (const id of recipients) {
      const box = boxes.get(id) || [];
      box.push({ ...envelope, to: id });
      while (box.length > cap) box.shift(); // oldest dropped, never the newest
      boxes.set(id, box);
      delivered++;
    }
    if (delivered) log(`mail: ${envelope.from} -> ${delivered} inbox(es)`);
    return delivered;
  }

  // Reads an inbox; drains it unless peeking.
  function fetch(id, { peek = false } = {}, now = Date.now()) {
    sweep(now);
    const box = boxes.get(id) || [];
    const messages = box.slice();
    if (!peek && box.length) boxes.delete(id);
    return messages;
  }

  function unread(id) {
    return (boxes.get(id) || []).length;
  }

  // Expired messages drop out; empty boxes disappear.
  function sweep(now = Date.now()) {
    const { ttlMs } = limits();
    for (const [id, box] of boxes) {
      const fresh = box.filter((m) => now - m.ts <= ttlMs);
      if (fresh.length === 0) boxes.delete(id);
      else if (fresh.length !== box.length) boxes.set(id, fresh);
    }
  }

  // Boxes whose owner is truly gone go with it. The caller decides what
  // "gone" means - board visibility is NOT existence (a quiet transcript
  // session still owns its mail until the TTL says otherwise).
  function retain(keep) {
    for (const id of boxes.keys()) {
      if (!keep(id)) boxes.delete(id);
    }
  }

  function persistable() {
    return Object.fromEntries(boxes);
  }

  function restore(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [id, box] of Object.entries(obj)) {
      if (!Array.isArray(box)) continue;
      // sanitize again on the way back in: state.json is 0600 but DOCTRINE
      // rule 1 does not trust any path
      const clean = box
        .filter((m) => m && typeof m.payload === 'string')
        .map((m) => ({
          from: proto.sanitizeText(String(m.from || 'cli')).slice(0, MAX_FROM_CHARS),
          to: id,
          ts: Number(m.ts) || 0,
          type: m.type === 'event' ? 'event' : 'note',
          payload: proto.sanitizeText(m.payload).slice(0, MAX_PAYLOAD_CHARS),
        }));
      // the cap holds on the way back in too - a tampered or over-full
      // state.json must not mint an unbounded box
      const { cap } = limits();
      if (clean.length) boxes.set(id, clean.slice(-cap));
    }
  }

  return { post, fetch, unread, sweep, retain, persistable, restore };
}

module.exports = { createMailroom, MAX_PAYLOAD_CHARS };
