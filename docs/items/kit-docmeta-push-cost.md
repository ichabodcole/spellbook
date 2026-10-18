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

- [ ] `docMeta` is sent only when it changed, or fetched on request, and a test
      shows a typing pause sends no `docMeta`. (Met for typing, the constant
      cost; see below for the broadcasts that still carry it.)
- [x] The agent still sees fresh `docMeta` after a frontmatter edit.

## Done and verified

Two commits on `impl/kit-docmeta-push-cost`:

- `590938b7` changes the kit daemon (`src/kit/workspace/server.ts`). The pause
  in typing (`scheduleEditBroadcast`) compares the app's view with the one the
  last broadcast carried (`sentAppState`), and sends nothing when they match.
  The kit test "a pause in typing sends no state when the app's view did not
  change, and does when it did" pins both halves.
- `0c9d9f4c` tests the flagged backend through its own launchers. A surface
  types in a document's body through two pauses and gets no state frame, so no
  `docMeta`. A frontmatter edit, saved, reaches the surface's
  `appState.docMeta`, and the agent's `state` reads it too.

Deliberate choices:

- **Skip the pause, not trim the frame.** The daemon client (`src/kit/context`)
  replaces the whole state on each frame. A frame without `appState`, or with
  only its changed parts, would wipe `hidden` and `docMeta` on the surface. That
  client was out of this item's lane, so the fix stays on the daemon side. It
  needs no client change, and no app change.
- **Why skipping is safe.** An app without an `appState` hook never had this
  pause, so nothing in the kit waits on it. The only other thing it refreshed is
  a document's `hash`. Story Studio's `DocumentPane` reads that only to refresh
  compare, and compare has no typing; its merge broadcasts on its own.
- **Not done here:** other broadcasts still carry the whole `docMeta` even when
  it did not change. These are the chat lines, tasks, agent acts, presence and
  the attention sweep. They are paced by events, not keystrokes. Sending
  `docMeta` only when changed on those too needs the client to keep the last
  `appState` when a frame leaves it out, which is a `daemonClient` change. If
  that is wanted, it is a follow-up for whoever owns `src/kit/context`.

## Port-back notes

For kit-parity, against Story Studio `develop` at `b6d5956`
(`packages/kit/src/workspace/server.ts`):

- `scheduleEditBroadcast`: the pause broadcast returns early when
  `JSON.stringify(opts.appState(ctx) ?? null)` equals the view the last
  broadcast carried. Before, it always broadcast.
- `broadcastState`: it records `sentAppState`, the app's view as serialized,
  when the app has an `appState` hook. Nothing else changes in the frame.
- The cost is one extra serialization of the app's view for each broadcast and
  each pause, which the daemon pays and not the wire.
- If you depend on a document's `hash` moving on every typing pause, and not
  only on the next broadcast, this change stops that for an app whose view did
  not change. In your kit, only `DocumentPane`'s compare refresh reads it.
