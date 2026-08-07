# IDEAS

Parking lot for scope creep. Nothing here is shipped.

Standing non-goals, recorded so they stay said no to:

- Sending input into any session's terminal - permanent. v2 shipped inter-session
  *messaging* (the inbox), but delivery ends at the mailbox and the board stays read-only.
- Model providers besides Anthropic (config key naming is provider-generic; the logic is not)
- Cloud chat visibility (claude.ai and friends)
- Auth, accounts, telemetry, remote access
- Summary history beyond the bounded per-session ring that shipped in v2 - no
  pagination, no export, no archive; state.json is not a database

Maybe someday:

- Wrapper reports signal provenance (did IT receive the signal from outside vs forward a tower kill), so a watchdog's SIGTERM could be told apart from a user's and kept in the attention band

- Treat a finished Claude Code turn (final assistant text, no question) as `waiting` — "Claude is done, come back" — possibly with a decay window so it does not shout forever

- ANSI color rendering in the board's output pane (currently stripped to plain text)
- Dismiss/clear an exited card from the board before its 30-minute expiry
- Desktop notification or terminal bell when a session flips to `waiting`
- `tower ls --json` for scripting
- Keyboard navigation on the board (j/k between cards, enter to expand)
- Configurable thresholds (idle seconds, prompt patterns) once real usage shows the defaults are wrong
- Per-project grouping of cards by cwd
- PTY recording for replaying the last minutes of a session, not just 200 lines
