# tower

A live control tower for all of your terminal sessions.

You run a dev server in one terminal, a test watcher in another, an AI coding agent in a third, a build in a fourth. Tower answers one question at a glance: **which of my terminals needs me right now?**

![status board](docs/board.png)

## Install

Not on npm yet (the name is still being chosen). Install from source:

```
git clone https://github.com/lloydlabsai/tower && cd tower
npm i -g .
```

Zero config, localhost-only. Nothing leaves your machine.

## 60-second demo

Wrap any command with `tower run`. Your terminal behaves exactly as before; the session just also appears on the board.

```
tower run npm run dev        # terminal 1
tower run pytest -f          # terminal 2
tower run claude             # terminal 3
tower open                   # the status board
```

Sessions that need you (waiting for input, or exited with an error) sort to the top. Click a card to see its recent output, live.

## Statuses

| status | meaning |
|---|---|
| `running` | process alive, output in the last 15 seconds |
| `idle` | process alive, quiet for a while |
| `waiting` | the last output line looks like a prompt (`? `, `: `, `[y/n]`, ...) and nothing has been printed since |
| `exited-ok` / `exited-error` | from the exit code |
| `stale` | the wrapper lost contact; heals automatically on reconnect |

The waiting heuristic is deliberately dumb and easy to tune: it is a short list of regexes in `src/protocol.js`.

## CLI

```
tower run [--name <name>] <command> [args...]   wrap a command so it shows on the board
tower ls                                        list sessions in the terminal
tower open                                      open the status board in a browser
tower kill <name>                               stop a session ("daemon" stops towerd)
```

That is the whole surface.

## How it works

Three small pieces, about 1,500 lines total:

- **`towerd`**, a daemon that starts itself the first time you use tower. It keeps the session registry in memory, listens on a Unix domain socket, and serves the board on `http://127.0.0.1:8697`. Last-known state is persisted to `~/.tower/state.json`, so a daemon restart is not amnesia.
- **the wrapper** (`tower run`) spawns your command in a PTY, passes your terminal through untouched, and streams the last ~200 lines of output to the daemon. If the daemon dies, your process does not; the wrapper reconnects quietly in the background.
- **the board**, a single HTML page with vanilla JS, updated over server-sent events. Read-only in v1: the board shows your terminals, it never types into them.

No database, no accounts, no cloud, no telemetry.

## Platform support

macOS and Linux. Windows is out of scope for v1, though most of it happens to work there (named pipe instead of a Unix socket, ConPTY via node-pty).

## Uninstall

```
tower kill daemon
npm rm -g tower-cli    # the package name from `npm ls -g`
rm -rf ~/.tower
```

## DECISIONS

Boring, conventional choices made during the build, recorded so they are arguable:

- **Node >= 18, one dependency.** `node-pty` is an `optionalDependency`; if its native build fails, `tower run` falls back to plain pipes (line-based programs work, full-screen TUIs see a non-TTY). Install never hard-fails.
- **SSE instead of websockets.** One-directional live updates need nothing more, and it keeps the dependency count at one.
- **Status is derived in the daemon,** not the wrapper: one clock, one implementation, and `tower ls` and the board can never disagree.
- **The ring buffer stores plain text.** ANSI escapes are stripped and carriage-return overwrites are collapsed, so progress bars show their latest state instead of 200 frames of spinner.
- **Port 8697** ("TOWR" on a phone keypad), falling back to an ephemeral port if taken; the real port lives in `~/.tower/daemon.json`.
- **`daemon` is a reserved session name** so `tower kill daemon` is unambiguous.
- **Exited cards expire after 30 minutes.** The board is a status board, not a history.
- **Session names are auto-generated from the command** (`npm-run-dev`), deduped with `-2`, `-3`; override with `--name`.
- **The npm package name is a placeholder and `"private": true` guards it.** `tower-cli` is already taken on npm by an unrelated package; this repo installs from source until a real name is secured.
- **A signal-killed child exits `128 + signum`** (shell convention) and shows as `exited-error`, even though PTYs report such deaths with exit code 0.

## License

MIT
