# Contributing

Small tool, strong opinions. Before writing code, read **[DOCTRINE.md](DOCTRINE.md)** -
five standing rules every change must satisfy, especially:

- all text entering a card or leaving through any surface passes the shared
  sanitizer at ingestion, and new text paths ship with a hostile-input test;
- summaries and messages are annotations - mechanical truth (status, exit
  codes, timers, raw tails) is never displaced;
- keyless tower is a complete product; no feature may require an API key to
  keep the classic behavior working.

Practicalities:

- `npm test` runs the whole suite (`node --test`); CI runs it on Linux,
  macOS, and Windows. Tests use `TOWER_DIR` and `TOWER_ANTHROPIC_BASE_URL`
  env seams - never the real `~/.tower` or the real API.
- Boring, conventional choices are recorded in the README's DECISIONS
  section; argue with them there, in a PR.
- Scope creep goes to [IDEAS.md](IDEAS.md), not into your branch.
