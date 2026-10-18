---
type: item
title: docMeta rides every state push on the kit path
description:
  The kit broadcasts appState on each typing pause, and Scriptorium's docMeta
  doubles each frame (76 KB to 159 KB on 2,000 documents); send it only when it
  changes, or on request.
status: stable
lifecycle: done
id: 01a1486e-3a72-755d-ae24-fcfc18a8e5ee
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-document-pane
---

# docMeta rides every state push on the kit path

Found by the wiki-verbs verifier (2026-10-17). The kit sends `appState` with
every state push, including each pause in typing. Scriptorium's `docMeta` (up to
500 documents) took a 2,000-document world's frame from 76 KB to 159 KB, about 1
ms warm.

## Definition of done

- [x] `docMeta` is sent only when it changed, or fetched on request, and a test
      shows a typing pause sends no `docMeta`.
- [x] The agent still sees fresh `docMeta` after a frontmatter edit.

## Done and verified

Commits on `impl/kit-docmeta-push-cost`, in order:

- **`590938b7` added a typing-pause skip.** It was later removed by `dfe3e5cf`.
  The pause in typing sent nothing when the app's view was unchanged.
- **`0c9d9f4c` added the first flagged-backend test.** It was later revised by
  `7018591e`.
- **`56449dd1` marks an unchanged view on every broadcast.** It changes the
  daemon, the protocol and the client together, because they must land as a
  pair.
  - A state frame carries `appState` only to a connection whose last copy
    differs.
  - Every other connection gets `appStateUnchanged: true` and no `appState` key.
    The protocol calls this shape `StateFrame`.
  - The daemon client (`daemonClient`) folds frames with `resolveAppState`. On a
    marked frame, it keeps the view it holds.
  - The test harness's `FakeSurface` folds frames the same way.
- **`40a11dfc` adds the chat line to the flagged-backend test.**
- **`dfe3e5cf` brings back the typing-pause broadcast.**
  - The skip from `590938b7` is gone. A pause broadcasts as it did before this
    item. Its frame carries the documents' new hashes, with the view marked
    unchanged.
  - The `appState` hook runs once per broadcast.
  - The daemon types the frames it builds as `StateFrame`.
  - The open handler's no-op `delete` is gone.
- **`d73bc515` tests a dropped frame.** Bun's `send` is patched to answer 0
  once.
  - After a dropped whole frame, the next broadcast carries the view whole to
    the connection that missed it.
  - After a dropped marked frame, the next frame is whole.
- **`7018591e` revises the flagged-backend test.**
  - Two typing pauses and a chat line each send a state frame. Every one is
    marked, and none contains `docMeta`. The surface keeps the `docMeta` it
    holds.
  - A saved frontmatter edit sends `docMeta` fresh, and the agent's `state`
    reads it.

Deliberate choices:

- **The marker is explicit (`appStateUnchanged: true`), not a missing key.** A
  missing key could be misread in two ways:
  - as an app with no view, but that app sends `appState: null`;
  - as a frame from an older daemon.

  With the marker, a frame that has neither the marker nor `appState` is clearly
  malformed.

- **The daemon tracks what it sent per connection, not globally.** Every
  connection does get every broadcast. But Bun can drop a frame (`send` answers
  0), which leaves one connection behind. The drop clears that connection's
  record, so its next frame carries the view whole.
- **A new connection always starts whole,** whether it is the first or a
  reconnect, because a new socket has no record. `GET /state`, the agent's read,
  is always whole.
- **A mark from another session reads as no view** (`null`), never as the old
  session's view. The daemon never sends one, because a new session means a new
  socket.
- **The typing-pause skip was dropped.**
  - The pause broadcast also carries the documents' hashes. Story Studio reads
    those on surfaces other than the one typing: the canvas card refreshes from
    `docs[].hash` (`CanvasView.tsx:400` at `b6d5956`), and so does a second
    surface's compare.
  - Now that every frame marks an unchanged view, skipping the pause saved
    nothing more.

Out of scope, filed separately by the coordinator: editing an unopened
document's frontmatter on disk sends no state frame on the flagged backend. That
is unchanged from the base.

## Port-back notes

For kit-parity, against Story Studio `develop` at `b6d5956`.

**Port `server.ts`, `protocol.ts` and `daemonClient.ts` together, as one
change.** If the daemon sends `appStateUnchanged` and the client does not fold
it, Atlas loses its `appState` on almost every broadcast. Three checks catch a
partial port:

- A `server.ts` without the new `protocol.ts` fails `tsc`, because `StateFrame`
  is not exported.
  - The daemon's frames are typed as `StateFrame` (`satisfies ServerOp`) for
    this reason. Untyped, a partial port would compile and silently break old
    clients.
- A new `protocol.ts` with an old `daemonClient` (or test harness) fails `tsc`:
  `StateFrame` is not assignable to `PublicState`.
- At runtime, the test "against the real daemon: a broadcast that leaves the
  view alone keeps it" fails.

The changes:

- `packages/kit/src/workspace/protocol.ts`:
  - adds `StateFrame` and `resolveAppState`;
  - changes `ServerOp`'s `state` frame from `PublicState` to `StateFrame`.

  `resolveAppState` is the first runtime export in that otherwise type-only
  file. It has no imports.

- `packages/kit/src/workspace/server.ts`:
  - `sendState` sends one frame to one socket. It keeps `viewSent`, a per-socket
    `WeakMap`, and a send that answers 0 clears the socket's record.
  - `broadcastState` sends through `sendState` and no longer through `send`.
  - The websocket `open` handler sends its first frame through `sendState`. A
    new socket has no record, so that frame is whole.
  - `scheduleEditBroadcast` is unchanged: a pause broadcasts as before.
- `packages/kit/src/context/daemonClient.ts`: `case "state"` folds the frame
  with `resolveAppState(view.state, frame.state)`.
- The test harness `FakeSurface.state` folds the frames it has seen. Any test of
  yours that reads `frame.state.appState` from a raw frame, and not through a
  folding reader, needs the same change.

Cost compared with before:

- The `appState` hook runs as often as before: once per broadcast and once per
  first frame.
- The daemon serializes the view once more per broadcast, to compare it with
  each socket's record.
- The daemon serializes the frame at most twice per broadcast: once whole, and
  once marked, each only if some socket needs it.
- The wire carries the view only to a socket whose copy is out of date.
