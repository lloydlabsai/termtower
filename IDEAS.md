# IDEAS

Parking lot for scope creep. Nothing here is v1 or v1.5.

Explicit non-goals of v1.5, recorded so they stay said no to (for now):

- Inter-session messaging / sending input into sessions — the board stays read-only
- Model providers besides Anthropic (config key naming is provider-generic; the logic is not)
- Cloud chat visibility (claude.ai and friends)
- Summary history / timeline views — only the current summary per session
- Auth, accounts, telemetry, remote access

Maybe someday:

- Treat a finished Claude Code turn (final assistant text, no question) as `waiting` — "Claude is done, come back" — possibly with a decay window so it does not shout forever

- ANSI color rendering in the board's output pane (currently stripped to plain text)
- Dismiss/clear an exited card from the board before its 30-minute expiry
- Desktop notification or terminal bell when a session flips to `waiting`
- `tower ls --json` for scripting
- Keyboard navigation on the board (j/k between cards, enter to expand)
- Configurable thresholds (idle seconds, prompt patterns) once real usage shows the defaults are wrong
- Per-project grouping of cards by cwd
- PTY recording for replaying the last minutes of a session, not just 200 lines
