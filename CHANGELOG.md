# Changelog

## 2.0.0

The coordination release. Everything below was adversarially reviewed before
merge (20 confirmed findings fixed across the three phases).

- **`closed` status.** Sessions you stop on purpose - `tower kill`, Ctrl+C,
  SIGTERM/SIGINT/SIGHUP, Windows Ctrl+C - land quietly in ALL QUIET with
  their own `closed_ttl_seconds`, instead of masquerading as failures.
  Only unexpected exits earn NEEDS YOU.
- **Honest summaries.** `last`/`next` may be `null` when there is nothing
  meaningful to say - steady-state servers get no invented advice - and
  deliberately stopped sessions are narrated as stops, never crashes.
  Guesses must read as guesses.
- **The inbox.** `tower send <session|all> "<text>"` leaves a note;
  `tower inbox` reads and drains your own (inside `tower run`,
  `TOWER_SESSION` makes both infer self); `--name` looks at another
  session's queue, `--drain` takes it. Unread badges on cards; messages
  never touch NEEDS YOU; payloads control-stripped at ingestion; 24h TTL,
  100-message cap. `docs/AGENTS.md` has the CLAUDE.md block that makes
  parallel Claude Code sessions coordinate through it.
- **Summary history.** The last 12 chapters of each session's story
  (`summaries.history_depth`), on the board behind a history toggle and in
  `tower history <session>`. Bounded hard; search does not index it.
- **DOCTRINE.md.** The standing rules, written down.

## 1.5.x

- **The narrative layer.** Bring your own Anthropic key: every card gains a
  doing/last/next story from a Haiku-class model, refreshed only when output
  meaningfully changes. No key = exactly the classic board.
- **Claude Code sessions on the board** without wrapping, read from their
  transcript files: title, branch, active/idle/waiting, conversation-derived
  summaries. A `tower run claude` wrapper merges with its transcript card.
- **Search.** `/` on the board or `tower search <text>`: name, path, command,
  narrative, and recent output, hits highlighted.
- **Card redesign.** Name as anchor, narrative strip, agent badge, quiet
  key hint. Hardened per adversarial review (16 findings fixed).

## 1.0.0 (as 0.1.0)

- `tower run` PTY wrapper, `towerd` daemon, the live board over SSE,
  `tower ls` / `open` / `kill`, waiting/idle/exited triage, state that
  survives daemon restarts. Zero config, localhost-only, one dependency.
