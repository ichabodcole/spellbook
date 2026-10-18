---
type: item
title: docMeta rides every state push on the kit path
description:
  The kit broadcasts appState on each typing pause, and Scriptorium's docMeta
  doubles each frame (76 KB to 159 KB on 2,000 documents); send it only when it
  changes, or on request.
status: stable
lifecycle: active
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

Four commits on `impl/kit-docmeta-push-cost`:

- **`590938b7` changes the kit daemon** (`src/kit/workspace/server.ts`).
  - The pause in typing (`scheduleEditBroadcast`) compares the app's view with
    the one the last broadcast carried (`sentAppState`). When they match, it
    sends nothing.
  - The kit test "a pause in typing sends no state when the app's view did not
    change, and does when it did" pins both halves.
- **`0c9d9f4c` tests the flagged backend** through its own launchers.
  - A surface types in a document's body through two pauses and gets no state
    frame, so no `docMeta`.
  - A frontmatter edit, saved, reaches the surface's `appState.docMeta`, and the
    agent's `state` reads it too.
- **`56449dd1` changes every other broadcast.** It changes the daemon, the
  protocol and the client together, because the two must land as a pair.
  - A state frame carries `appState` only to a connection whose last copy
    differs. Every other connection gets `appStateUnchanged: true` and no
    `appState` key. The protocol names this shape `StateFrame`.
  - The daemon client (`daemonClient`) folds frames with `resolveAppState`. On a
    marked frame, it keeps the view it holds.
  - The test harness's `FakeSurface` folds frames the same way.
  - Tests in `server.test.ts` and `daemonClient.test.ts` cover a chat line, a
    new connection, `GET /state`, an app with no view and a reconnect.
- **`40a11dfc` extends the flagged-backend test.**
  - A chat line's broadcast arrives marked, with no `docMeta` in the frame, and
    the surface keeps the `docMeta` it holds.
  - The saved frontmatter edit's frame carries the fresh `docMeta` whole.

Deliberate choices:

- **The marker is explicit (`appStateUnchanged: true`), not a missing key.** A
  missing key could be misread in two ways:
  - as an app with no view, but that app sends `appState: null`;
  - as a frame from an older daemon.

  With the marker, a client that sees neither the marker nor `appState` knows
  the frame is malformed, not unchanged.

- **The daemon tracks what it sent per connection, not globally.** Every
  connection does get every broadcast, and the hello is per connection. But Bun
  can drop a frame (`send` answers 0), which leaves one connection behind. That
  connection's next frame must carry the view whole.
- **A new connection always starts whole,** whether it is the first or a
  reconnect, because its first frame carries the full view. `GET /state`, the
  agent's read, is always whole.
- **A mark from another session reads as no view** (`null`), never as the old
  session's view. The daemon never sends one, because a new session means a new
  socket.
- **The typing-pause skip stays.** An app without an `appState` hook never had
  that pause, so nothing in the kit waits on it. The only other thing it
  refreshed is a document's `hash`. Story Studio's `DocumentPane` reads that
  only to refresh compare, and compare has no typing; its merge broadcasts on
  its own.

## Port-back notes

For kit-parity, against Story Studio `develop` at `b6d5956`.

**Take the daemon change and the client change together, in one change.** If
Story Studio's daemon takes `appStateUnchanged` but its `daemonClient` does not
fold it, Atlas loses its `appState` on the first broadcast that leaves the view
unchanged. Atlas would lose it on almost every broadcast. Two checks catch a
mismatched pair:

- `tsc` fails on a client that does not fold, because `StateFrame` is not a
  `PublicState`.
- The test "against the real daemon: a broadcast that leaves the view alone
  keeps it" fails at runtime.

The changes:

- `packages/kit/src/workspace/protocol.ts`:
  - adds `StateFrame` and `resolveAppState`;
  - changes `ServerOp`'s `state` frame from `PublicState` to `StateFrame`.

  `resolveAppState` is the first runtime export in that otherwise type-only
  file. It has no imports.

- `packages/kit/src/workspace/server.ts`:
  - `sendState` sends one frame to one socket, with `viewSent` (a per-socket
    `WeakMap`).
  - `broadcastState` sends through `sendState` and no longer through `send`.
  - The websocket `open` handler sends its hello through `sendState`, whole.
  - `scheduleEditBroadcast` skips the pause when the view is unchanged.
- `packages/kit/src/context/daemonClient.ts`: `case "state"` folds the frame
  with `resolveAppState(view.state, frame.state)`.
- The test harness `FakeSurface.state` folds the frames it has seen. Any test of
  yours that reads `frame.state.appState` from a raw frame, and not through a
  folding reader, needs the same change.
- The cost moves from the wire to the daemon: one serialization of the app's
  view per broadcast, and one per pause.
- If you depend on a document's `hash` moving on every typing pause, and not
  only on the next broadcast, the pause skip stops that for an app whose view
  did not change. In your kit, only `DocumentPane`'s compare refresh reads it.
