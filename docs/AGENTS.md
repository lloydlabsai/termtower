# Tower for agents

Tower's inbox turns parallel agent sessions into coworkers who leave each
other notes. The daemon is a mailbox; agents are opt-in readers. Nothing is
ever typed into a session's terminal - an agent reads its inbox when it
reaches a natural boundary, and tells the others when it finishes something
they might be waiting on.

Inside any `tower run` session, `TOWER_SESSION` is set automatically, so
`tower inbox` and `tower send` already know who "self" is.

## Drop this into your CLAUDE.md

```markdown
## Coordinating through Tower

This machine runs Tower (`tower` CLI). Other agent sessions may be working in
parallel, and the Tower inbox is how we coordinate:

- At natural boundaries - when you start a task, and again when you finish
  one - run `tower inbox`. If messages are waiting, read them and take them
  into account before continuing. An empty inbox costs nothing.
- When you complete work that another session might be waiting on (a build
  published, a schema migrated, an API changed, files moved), announce it:
  `tower send all "schema migration done, artifacts in /dist"`
  Address one session by name instead of `all` when you know who needs it.
- Keep messages short, factual, and self-contained: what happened, where the
  results are. The reader has no other context.
- Never wait or poll for replies. The inbox is asynchronous by design: post
  and move on, read at boundaries.
```

## A worked example

Session A is migrating a database schema; session B is building features on
top of it.

1. A finishes and announces:

   ```
   $ tower send all "schema migration done, new tables live, artifacts in /dist"
   delivered to 3 inboxes
   ```

2. B reaches its next task boundary and checks:

   ```
   $ tower inbox
   [note] schema-migrate 2m ago
     schema migration done, new tables live, artifacts in /dist
   ```

3. B regenerates its ORM models against the new schema instead of the stale
   one it was about to use. No polling, no file-watching, no injected input -
   B found out exactly when B was ready to know.

## The mechanics

| command | behavior |
|---|---|
| `tower send <session\|all> "<text>"` | leave a note; `--event` tags it as an event |
| `tower inbox` | read AND drain your own inbox (inside `tower run`) |
| `tower inbox --name <session>` | read a named session's inbox |
| `tower inbox --peek` | read without draining |

- Messages are ephemeral: default TTL 24h (`inbox.ttl_hours`), per-inbox cap
  100 (`inbox.cap`), oldest dropped first. The board shows an unread badge and
  a read-only view of queued messages; only `tower inbox` drains.
- Payloads are plain text, control-stripped at ingestion. Do not send secrets:
  anyone at this machine's board can read queued messages.
- Delivery is the whole contract. Reading cadence belongs to the agents.
