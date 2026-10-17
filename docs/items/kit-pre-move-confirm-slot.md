---
type: item
title:
  A pre-move confirm slot on the context pane; Scriptorium's move plan through
  it
description:
  The kit's context pane asks the app before a move and can show the human what
  the move would change; Scriptorium's move.plan (links a move would break)
  fills it, so a move waits for the human's confirm.
status: stable
lifecycle: triage
id: 01a14bca-15aa-7799-ac7c-13940a5dd463
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, context]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# A pre-move confirm slot on the context pane; Scriptorium's move plan through it

The kit's sidebar moves a document at once (`onStructure({op:"move"})`). A hook
(`beforeKitAct`) can refuse a move, but it can't ask the human anything.
Scriptorium's shipped surface shows a move plan first: the links the move would
break, and which ones it would fix. The wiki-layer cycle made that plan a daemon
command (`move.plan`) and left the dialog for this cycle (Cole agreed,
2026-10-16).

The slot is generic: an app may answer "show the human this before moving", and
an app that doesn't fill it moves as today. Story Studio has no such slot yet
(kit-parity message 42 says they'd likely use it later to move a bundle's own
files), so it is built here and offered back.

## Definition of done

- [x] The context pane takes an optional pre-move slot. Given the move, the app
      returns a plan to show, or nothing. With a plan, the move waits for the
      human's confirm or cancel. With no slot, nothing changes, and a test
      proves it.
- [x] The flagged Scriptorium fills the slot from `move.plan`, so a drag or menu
      move shows the links it breaks and fixes before it happens.
- [x] Cancel leaves the disk and the tree as they were, and a test shows it.
- [ ] The slot is offered to Story Studio on kit-parity.

## Done and verified

New kit code, not a port: Story Studio's context pane has no such slot (read at
`develop`). Commits on `impl/kit-pre-move-confirm-slot`, on `cycle/panes` at
`5f4295af`:

- `178fb32b`: the slot. `ContextSidebar` takes `beforeMove` and
  `beforeMoveTimeoutMs`; the logic is in `src/kit/context/preMove.ts`.
- `a1356892`: Scriptorium's adapter, `scriptoriumBeforeMove(daemon)` in
  `src/scriptorium/surface/kit/movePlan.tsx`, for the interim frame to pass in.

**The slot.** Every move the sidebar makes asks it first: "Move to…", a row
dropped on a set or folder, and a row dropped on the list or a set's way back.
The app answers with a `ConfirmDialog` request, and the move waits for the
human. It can also answer `{ refused }`, and then nothing is sent and the reason
becomes the notice. Or it answers `null`, and the move is sent at once. With a
slot, moves are asked one at a time and in order, so a drag of several rows asks
about each row in turn; the kit's `useConfirm` would otherwise answer the first
question with Cancel. With no slot, the move is sent synchronously in the same
click or drop, as before. A test pins that, and it went red when the no-slot
path was deferred by one microtask.

**A check that fails or times out still lets the human choose.** If `beforeMove`
throws, or doesn't answer within `beforeMoveTimeoutMs` (5 s), the sidebar shows
its own dialog, "Move X into Y?", saying the move could not be checked first and
why. The buttons are **Move anyway** and Cancel, and Escape cancels. A late
answer is ignored. I rejected two alternatives. Moving silently would skip the
look the app asked for. Refusing, which is what the shipped surface does when
its plan fetch fails, would leave the human unable to move anything while the
daemon is slow or down. A daemon _refusal_ is different, because the plan
refuses exactly what the move would refuse. The adapter turns a refusal into
`{ refused }`, so no pointless "Move anyway" is offered.

**Scriptorium's answer.** The adapter uses the shipped surface's rule (`App.tsx`
`requestMove`), widened by the links. A single document that stays in its git
working tree and breaks nothing moves at once. A folder, a move out of the
repository, or any break shows the plan:

- what moves, and from where to where;
- each broken path link, with the rewrite the relink offer would make
  (`./part/c.md → ./lore/c.md`), plus a note that the offer comes right after
  the move;
- wiki links and frontmatter references, which are reported and never rewritten;
- the shipped git warning, word for word.

Lists are capped at six lines. Everything is inline (`span`), because the
dialog's message is a paragraph.

**Verified.**

- `ContextSidebar.preMove.test.tsx` has 8 tests on fixtures.
- `src/scriptorium/surface/kit/movePlan.test.tsx` has 6 tests. 4 of them run
  against a real flagged daemon (`kitDaemon`, in-process, scratch
  `SCRIPTORIUM_HOME`) with the sidebar in happy-dom. A menu move and a drag move
  show the plan. Cancel leaves every file under `docs/` byte-identical and the
  daemon's context unchanged. Move moves the file on disk and in the tree. A
  refused move shows the notice. The other 2 test the adapter's answers with a
  stand-in `request`.
- The existing context tests pass unchanged (275 in 18 files, with the new
  ones).
- The gate is green: 5936 pass, 0 fail.
- `dist` is unchanged by the build.

**Not covered.**

- The drag test drops a row's payload onto another set's row in the list. A drag
  within one set's tree goes through headless-tree's own drag state, and the
  sidebar's tests don't drive that in happy-dom. It reaches the same `move`, but
  no test drives it.
- Clearing a cancelled "Move to…"'s focus expectation is untested.

## Port-back notes

- New `src/kit/context/preMove.ts`: `PendingMove`, `BeforeMove`,
  `BeforeMoveAnswer`, `PRE_MOVE_TIMEOUT_MS`, `askBeforeMove` and
  `uncheckedMovePrompt`. It is exported from `context/index.ts`.
- `ContextSidebar`:
  - It has two new optional props, `beforeMove` and `beforeMoveTimeoutMs`.
  - `useConfirm()` moved above `move`, which now uses it. The Delete comment
    moved with `askDelete`.
  - `move` returns `true` (sent) or a `Promise<boolean>`.
  - "Move to…" clears `expectMove` when the human cancels.
  - With no slot, the behaviour is unchanged.
- Story Studio's likely use (kit-parity message 42): moving a bundle's own
  files. Its slot answer can be any `ConfirmRequest`, with the app's own confirm
  tone in `confirmClassName`.
