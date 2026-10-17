---
type: item
title: Scriptorium's wiki verbs on the kit daemon
description:
  Bring meta, meta-init, meta-set, find, info, forget, move plan, trust tiers
  and the remove verbs to the flagged Scriptorium through the kit's verb and
  appState slots.
status: stable
lifecycle: review
id: 01a1478f-353c-7581-9e00-69376c30d10d
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
cycle: 2026-10-wiki-layer
parent: feature/workspace-kit
---

# Scriptorium's wiki verbs on the kit daemon

The flagged Scriptorium lacks the shipped app's wiki verbs (the SKILL delta in
[scriptorium-on-kit-daemon](./scriptorium-on-kit-daemon.md)). Most need no new
kit slot: they go in through the kit's `verbs`, the CLI's `commands`, and
`appState`
([write-up, 3a](../items/workspace-stack-port-shape/write-up.md#3a-the-wiki-layer-against-the-four-extension-points)).

**Move plan:** Cole ruled on 2026-10-16 that the move plan is a daemon command
in this cycle. The confirm dialog that shows it comes in cycle 3, with the
panes.

## Definition of done

- [x] On the flagged path, `meta`, `meta-init`, `meta-set`, `find`, `info` and
      `forget` behave as the shipped verbs do, with tests ported from the
      shipped suite.
- [x] `docMeta`, the trust tier and `stale` reach the agent through `appState`.
- [x] A move plan is a daemon command: what would move, and which links would
      change. It writes nothing.
- [x] `note-remove`, `task-remove` and `tasks-clear` are either built or mapped
      to the kit's verbs, and the SKILL delta says which.
- [x] acc is conformant on both paths, the census is re-run for the flagged CLI,
      and the default path is unchanged.

## Done and verified

Two commits on `impl/scriptorium-kit-wiki-verbs`: `5d2a5d1b` (the kit) and
`d02fc26a` (Scriptorium on it). A fix round on top, "a move plan is the move:
ambiguous names, new sets, and the app edges it breaks", closes what the
verifier found (see "The fix round" below).

**The kit** gains two methods on `WorkspaceSession`:

- `movePlan(path, into)` returns `MovePlan` (`src/kit/workspace/movePlan.ts`):
  `from`, `to`, `into`, `name`, `folder`, `docs`, `sidecar`, `links`, `wiki`,
  `references` and `checked`. It runs the move's own `pinLinks` and `planRelink`
  in the world after the move (`movedWorld`), so nothing moves.
- `forgetDoc(ref)` drops the record of a document whose file is gone.

**Scriptorium's verbs** are in `src/scriptorium/backend/kit/wiki.ts` (the
daemon) and `wikiCommands.ts` (the CLI): `meta`, `meta-init`, `meta-set`,
`find`, `forget`, `move-plan`, `note-remove`, `task-remove`, `tasks-clear` and
`info`. `appState` carries `docMeta` beside `hidden`.

**Tests.** `src/kit/workspace/movePlan.test.ts` checks each plan against the
move that follows it, and ports the shipped `forget` tests.
`src/scriptorium/backend/kit/wiki.integration.test.ts` ports the shipped `find`,
line-edit, `forget` and `movePlan` cases to the CLI.

**Side by side.** Both CLIs were driven over the same world: `meta`, `find`
(each filter), `meta-init`, `meta-set` (the file byte for byte), the refusals,
`forget`, `note-remove`, and `meta-set` on an open document. A clean document
reloads; one whose active version differs is marked changed outside. The
answers, refusals and chat lines match, except where noted below.

Deliberate choices:

- **`task-remove` and `tasks-clear` are built, not mapped.** `task-cancel` ends
  a task; it does not forget it. They keep the kit's rule: an unfinished task is
  cancelled before it is removed, where shipped removed it at once.
- **The move plan's links** are the links `move --update-links` would offer,
  checked against the move itself in the tests. Board references are counted,
  not judged. `docs` counts what the context shows; shipped counted markdown on
  disk. The plan is also a surface op, answered with a `scriptorium.move.plan`
  frame. The confirm dialog is cycle 3.
- **What differs in words:** the kit's "no document is open: name one with
  --doc" (shipped has a dash), and `info`'s pointer fields. `meta` and `find`
  cover the kit's documents, `.json` included and `.mdx` not.

**The fix round.** The plan now holds to "the plan is the move" in three places
it did not:

- **A name two documents share.** An app's resolver takes the first document of
  a name, so the order matters. The plan hands it the documents in the order the
  session will have them after the move (`treeOrder` in `movePlan.ts`: each set
  as its scan lists it), not the old order with the paths changed.
- **A move into the workspace.** The moved folder becomes a set of its own. The
  plan models that entry (`planWorld` in `session.ts`, as `adoptNew` makes it),
  so a `/`-link in it is read from its new root.
- **App edges.** The plan lists the app edges the move would break (for
  Scriptorium, frontmatter references) under `edges`, with `kind`, `source`,
  `key` and `raw`, and counts them in `checked`. `move --update-links` reports
  them the same way. Nothing rewrites frontmatter: a move only says what it
  broke, and `link-check` lists the same references afterwards. Should a move
  offer to rewrite them? That is a later call.

`task-remove` on an unfinished task now has a `hint`:
`task-cancel <id>, then task-remove <id>`. The layering guard admits the move
plan by name. New tests cover reading the moved world on disk and in the
context, a `forget` that survives a restore, and `docMeta`'s 500 cap, its flag
and its de-duplication (`wiki.test.ts`). The verifier's fuzzer finds no case
where the plan and the move differ, over 250 worlds for each of five seeds.

The SKILL delta in
[scriptorium-on-kit-daemon](./scriptorium-on-kit-daemon.md#skill-delta-for-the-kit-path)
says the same. Its "Seams for later cycles" still lists the wiki layer as
missing. That list is outside the delta, so it was left alone.
