# Grapevine daemon — three lifecycle-route gaps found while giving the human parity

**Filed:** 2026-09-06 · **From:** the `feat/grapevine-ux` implementing agent and
its fresh-agent cold read · **Type:** backend findings (out of the UX branch's
scope by ruling — "no backend changes"); each is a route behaviour the surface
now works around or documents rather than fixes.

## 1. `PUT /channels/:name/topic` has no archived check — and the CLI verb is open too

_Corrected 2026-09-06 after the verify pass, which ran it:_ the PUT handler
appends a `kind:"topic"` frame to a read-only channel, **and the CLI's `topic`
verb does not refuse either** — `cli.ts:405` sends `POST /channels {name}` to
ensure the channel is loaded and **discards the response**, so the 409 that
answers for an archived name is ignored and the PUT that follows lands
(`archive x; topic x "t"` → `ok:true`, exit 0). An earlier version of this item
said the verb refused "through its `POST /channels` 409"; it does not.

So the agent path is open on both the route and the verb, and the watch
surface's topic editor — disabled on an archived channel (inventory L3a), and
cancelled when an archive lands mid-edit (L3c) — is **stricter than the agent
path**, not at parity with it. Fix shape, daemon side: the same
`existsSync(archivedPath(name))` → 409 guard `POST /messages` has, on
`PUT /topic`; CLI side: `cmdTopic` should read the ensure's status and die on
409 like `cmdOpen` does. The daemon guard is the real fence; the surface's is a
courtesy until it lands.

## 2. Any non-explicit verb re-creates a deleted channel

`pull`, `tail`, `who`, `topic`, `read` all `POST /channels {name}` to "ensure
loaded", which creates a missing channel. So an agent polling a channel the
human just deleted from the surface (or another agent `close`d) silently
resurrects it empty and never learns it was deleted. Measured by the cold read:
`pull cold-read-test` after a UI delete → `{"ok":true,"messages":[]}` and the
channel is back in `list`. Fix shape: an `ensure`/`load` that does not create,
or a 404 from the read verbs on a missing channel.

## 3. Archive / unarchive emit no frame

Neither direction appends anything to the log or the stream — `list` flips
`archived` and that is the only signal. The UI and the CLI are at parity here
(both silent), but an agent tailing a channel cannot see either party archive
it; it finds out on its next send's 409. Fix shape: a `kind:"status"` frame (the
disposition machinery already folds those out of `tail`) or a `subscribed`-style
event.
