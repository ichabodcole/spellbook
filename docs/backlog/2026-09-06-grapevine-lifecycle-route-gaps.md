# Grapevine daemon — three lifecycle-route gaps found while giving the human parity

**Filed:** 2026-09-06 · **From:** the `feat/grapevine-ux` implementing agent and
its fresh-agent cold read · **Type:** backend findings (out of the UX branch's
scope by ruling — "no backend changes"); each is a route behaviour the surface
now works around or documents rather than fixes.

## 1. `PUT /channels/:name/topic` has no archived check

The CLI's `topic` verb refuses on an archived channel only because it
`POST /channels {name}`s first and that answers 409. The PUT handler itself
appends a `kind:"topic"` frame to a read-only channel. The watch surface
disables its topic editor on an archived channel (inventory L3a), so the human
path matches the CLI path — but a race (an agent archives between the human's
click and Enter, inside one poll) lands the frame. Fix shape: the same
`existsSync(archivedPath(name))` → 409 guard `POST /messages` has.

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
