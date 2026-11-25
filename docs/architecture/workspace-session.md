---
type: architecture
title: The workspace session
description:
  "How WorkspaceSession and the workspace daemon are to be split into parts in
  workspace/session/ and workspace/daemon/: the tiers, which part owns which
  state, the parts Spellbook has that Story Studio does not, and the checks that
  keep it split."
tags: [kit, refactor, architecture]
status: draft
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# The workspace session

## Overview

`WorkspaceSession` (`src/kit/workspace/session.ts`) is one sitting of the daemon
on a workspace: its record (the manifest), the tree, the open documents and
their versions, the chat, the link layer, and every verb that changes them. On
2026-11-24 it is one class of 9,072 lines (7,848 as Biome counts them). It is to
be split into **parts** in `src/kit/workspace/session/`, each owning a piece of
the state, along the plan in
[Splitting the kit's oversized modules](../items/kit-split-oversized-modules/write-up.md),
whose steps are the items of [the kit split](../features/kit-split/feature.md).

This page is ported from Story Studio's `docs/architecture/workspace-session.md`
(their develop at `b2abead4`), where the same split is built. Their table lists
only their parts and points here for ours, so this page is the record of the
parts Spellbook has that Story Studio does not. We keep their tiers and their
part names, so a port between the two kits is a diff between files of the same
name.

G1 put the guard in place: the size limit, the tier test with empty tables, and
the start-path test (below). **S2 built tier 0**: `errors`, `names`, `paths`,
`facts`, `types` and `manifest` are files in `session/`, and `session.ts`
imports them and re-exports every name it exported before, so no import outside
the file changed. The other tiers are still planned. When a step builds a part,
it adds the part's row here and in the tier test, in the same change.

## Why parts, and why tiers

A size limit alone would split the file into `session2.ts`. The parts split it
by ownership instead: a part's state is private to it, so a new behaviour has to
go in the part that owns the state it touches, and the file stays split once it
is split. The tiers keep the parts from tangling again: a part imports only
downward, so no part can reach back up to the facade or the server, and the
order the parts can be lifted in follows the tiers.

## The parts, by tier

A part owns the fields and manifest keys its row lists, and only that part
writes them. Other parts may read them. `session.ts` stays at its path as the
**facade**: `create`, `restore`, `listSaved`, building the parts, and every
public member as a delegate while callers still use it. Where a pure sibling
module of `workspace/` has the same topic (`movePlan.ts` is the pure planner;
`session/movePlan.ts` holds the session's move preview), the folder says which
is which.

The planned parts. A name in _italics_ is ours and not Story Studio's; their
parts we don't have are in the last column.

| Tier | Holds                                          | Parts (tier 0 built at S2; the rest planned)                                                                                                   | Story Studio's, not ours                 |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 0    | Pure code, no session state                    | `errors`, `names`, `paths`, `facts`, `types`, _`manifest`_                                                                                     |                                          |
| 1    | The core, which every part takes               | `state` (the manifest `m`, `persist`), `places` (display, the path guards, _our own-places guards_), `writes`                                  |                                          |
| 2    | The tree, what is on screen, the conversation  | `context` (with _the scan filter_), `placing`, `viewer`, `media`, `sidecars`, `chats`, _`workspace`_                                           | `bundleStamps`, `top`, `copyIn`          |
| 3    | Documents                                      | `documents`, `follow`, `tasks`, `images`                                                                                                       | `unseen`, `audio`, `orders`              |
| 4    | What reacts, saves and reads across documents  | `reconcile`, `saving`, `compare`, `notes`, `readIndex` (with _the app's link slot_), `linkResolve`, `profiles`, `relations`, `search`, `trash` | `markers`, `copyRecords`, `libraryLinks` |
| 5    | Changes that span the tree, and the whole view | `linkCheck`, `linkReports`, `relinkOnMove`, `structure`, `imageImport`, _`movePlan`_, _`sets`_, `views`                                        | `copySource`, `projectMeta`              |

What each part owns, member by member, is in the write-up's
[module map](../items/kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts).

### Ours, not Story Studio's

| Part or addition                    | Tier | What it holds                                                                                                                                              | Story Studio keeps it in |
| ----------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `session/manifest.ts`               | 0    | The manifest refusals (`refuseMalformedManifest`, `refuseForeignManifest`, `looksLikeScriptorium`) and `migrateSlot`, which `restore` runs on a raw record | (no counterpart)         |
| our own-places guards, in `places`  | 1    | `ownPlaces`, `notOwnPlaceOrDie`, `notOwnSourceOrDie`, `mayBeASetOrDie`, `pinDir`, `dirStillOrDie`, `ownFileOrDie`, `writeShown`                            | (no counterpart)         |
| `session/workspace.ts`              | 2    | No home and the workspace: `setWorkspace`, `workspaceOverlap`, `overlapToSay`, `setAppHome`, `appSlot`, `updateApp`, `m.overlapSaid`                       | `projectMeta` (tier 5)   |
| the scan filter, in `context`       | 2    | `scanGuard`, `scanSkip`, `filteredOut`, `refilter`                                                                                                         | (no counterpart)         |
| the app's link slot, in `readIndex` | 4    | `linkSlot`, `linkCheckOpts`, `resolvable`                                                                                                                  | (no counterpart)         |
| `session/movePlan.ts`               | 5    | The move preview: `movePlan`, `planWorld`, `listedAfter`, `entryAfter`, `docsAfter`, `pinEdges`, `brokenEdges` (the pure planner is `../movePlan.ts`)      | (no counterpart)         |
| `session/sets.ts`                   | 5    | Set promotion: `makeSet`, `unmakeSet`, `addFolder`                                                                                                         | (no counterpart)         |

**Same name, smaller part.** Our `session/chats.ts` will hold one chat
(`m.chat`, `addMessage`, `messages`), where theirs holds many chats and a timer.
We keep their name so their code ports into the file of the same name.

```text
tier 5  linkCheck  linkReports  relinkOnMove  structure  imageImport  movePlan  sets  views
          │
tier 4  reconcile  saving  compare  notes  readIndex  linkResolve  profiles  relations  search  trash
          │
tier 3  documents  follow  tasks  images
          │
tier 2  context  placing  viewer  media  sidecars  chats  workspace
          │
tier 1  state  ←  places  ←  writes
          │
tier 0  errors  names  paths  facts  types  manifest   (and the existing pure siblings:
                                                       links.ts, tree.ts, movePlan.ts, …)
```

## The rules

- **A part imports only parts in lower tiers**, or in its own tier where the
  call graph already goes one way (within tier 1, `writes` and `places` take
  `state`; the other one-way edges within a tier are recorded here as each step
  finds them).
- **Tiers 0 and 1 import no part above them.** Tier 0 imports no part outside
  tier 0.
- **Nothing in `session/` imports the facade (`session.ts`) or `server.ts`**, or
  anything that opens a socket or a watcher.
- **A lower part that needs a higher one exposes a hook** instead of importing
  upward (Story Studio needed two: `state.persist` asks the chats what to add to
  the record, and `context.removeContext` tells the viewer an entry went).
- **A part takes what it needs in its constructor**, as an object of functions
  built in the facade (`{ docOrDie: (s) => this.docOrDie(s), … }`), never the
  facade itself. So parts can move in any order: while `docOrDie` is still a
  private method of the facade, the facade supplies it; once `documents` is
  lifted, `documents` does.
- **Pure logic goes in a sibling module of `workspace/`**, not in a part.

The playbook that applies these when adding behaviour or splitting a file is
[Splitting an oversized module](../playbooks/splitting-a-module-playbook.md).

## How it is checked

- **`tests/architecture/session-tiers.test.ts`** holds every part's tier, from
  the tables above. It fails on an import cycle among the parts, an import from
  a higher tier, a tier 0 or 1 file importing a part above it, any import of the
  facade or `server.ts`, and a file in `session/` that has no tier. It also
  follows a part's run-time imports of sibling modules through the kit's source,
  since several (`tasks.ts`, the `index.ts` barrel and others) import the facade
  today: a part that reaches it that way fails too. Type-only imports are not
  followed. It is strict from the start: every part in its table must be a file
  in `session/`, as every file there must have a tier. Its tables are empty
  until S2 (and D1 for the daemon); a change that adds a part gives it a tier in
  the test and here, and one that removes a part takes its row out of both, in
  the same change. Story Studio's also refuses an import of the kit by its
  package name; ours has none, so the port leaves that rule out.
- **The size limit**: Biome's `style/noExcessiveLinesPerFile` in `biome.json`,
  at 1,200 lines for every source file under `src/` (test files left out), as an
  error. Biome counts code, line comments and blank lines between tokens, but
  not the lines inside a JSDoc block comment or a template literal, nor anything
  after the last token, so a file's decisions written in JSDoc do not push it
  over. The 15 files over it on 2026-11-24 each have their own override at their
  Biome count, which the step splitting the file lowers, and removes once the
  file is under 1,200. `session.ts` was frozen at 7,848 and S2 lowered it to
  7,210; `server.ts` is at 4,876.
- **The start path** (`src/kit/workspace/noteGuard.lazy.test.ts`, ours): the CLI
  entry loads neither `session.ts` nor `server.ts`, nor micromark or mdast; the
  daemon entry loads no `document/projection` or mdast until `loadNoteGuard`
  runs; and the daemon's third-party packages at start are exactly 28 (`yaml`,
  micromark and its family). The split adds modules of our own on purpose, so it
  counts packages, not modules.
- **The gate typechecks every move**, through
  `grimoire/type-check-ward.test.ts`. Story Studio also kept a temporary
  snapshot of the facade's public members (`session.members.test.ts`) while
  callers still used it; we have not ported it.

## The daemon's parts, by tier

`server.ts` (`createWorkspaceDaemon` and its `boot()`) is to be split the same
way, into `src/kit/workspace/daemon/`, in the D steps. A daemon part is a
closure, not a class: its module exports a `create…` function that takes what it
needs (`n`) and returns its functions and reads. Its state lives inside it as
`let`s and maps, so only its own functions change it. `boot()` builds each part
where its code ran before the split, so boot runs in the order it always did;
that is not tier order. A need built before the part is handed to it as a value;
one built after it is handed as an arrow
(`pageState: (fresh) => views.pageState(fresh)`), which is read only when
called.

| Tier | Modules, planned (none built yet)                                                               | Story Studio's, not ours                                   |
| ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0    | `types`, `rules`, `landings`                                                                    | `askStudio`, `navFacts`, `vocabularyVersions`, `verbChain` |
| 1    | `core` (the kernel), `views`                                                                    |                                                            |
| 2    | `prefs`, `presence`, `messages`, `watching`                                                     |                                                            |
| 3    | `saving`, `trash`, `picker`                                                                     | `asks`, `libraryLinks`                                     |
| 4    | `imagesIn`, `structure`, `linkFollow`, `appWork`                                                | `adding` (ours is one function), `auto`, `projects`        |
| 5    | `surfaceOps/documents`, `surfaceOps/chats`, `surfaceOps/tree`, `surfaceOps`, `agentOps`, `http` |                                                            |

What each module owns is in the write-up's
[module map for server.ts](../items/kit-split-oversized-modules/write-up.md#the-proposed-module-map-serverts).
`server.ts` keeps the shell: building the parts, `ctx`, `close`,
`runWorkspaceDaemon`.

The rules. The import rules and strictness are checked by the second half of
`tests/architecture/session-tiers.test.ts` (`DAEMON_TIERS`, `daemonBreaks`); the
two marked _(review)_ are conventions that review enforces, not the test:

- **A daemon module imports only lower tiers**, or its own tier one way (`views`
  takes `core`), so there are no import cycles in `daemon/`.
- **The kernel imports no part**: `core.ts` imports only tier 0.
- **Nothing in `daemon/` imports `server.ts`**, directly or through a sibling
  module at run time. A part may import the session and its parts; **nothing in
  `session/` imports `daemon/`**.
- _(review)_ **A factory only stores what it is handed**: it calls no need while
  it is built, so a part built earlier may be handed an arrow to a later one.
- _(review)_ **State is never handed out.** A part returns functions and reads
  (`core.closed()`), never its `let` or its map. A write another part makes is a
  function of the owner's, and a part's timers are cleared by its `stop()`,
  called where `close` cleared them.
- **Strict from the start**: every file in `daemon/` has a tier, and every
  module in the table is a file. A module in a subfolder is named with it
  (`surfaceOps/tree`). A step that adds a part gives it a tier in the test and
  here, in the same change.

## Gotchas

What Story Studio's build hit, kept here because each will apply to ours. A step
that finds the same in our code records our instance under it.

- **Measure a file with Biome, not `wc -l`.** The limit is Biome's count
  (above), so `wc -l` overstates how close a file is. Run
  `bunx biome lint <file>`: when a file is over its limit, the message prints
  its count.
- **A spy on a module export works only where the export is defined.** Story
  Studio's `spyOn(sessionModule, "newSessionId")` kept `newSessionId` in
  `session.ts` when tier 0 moved out. Grep for `spyOn(` on the session module
  before moving a module-level name. Ours had none at S2: no test spies on an
  export of `session.ts`, so every tier 0 name moved.
- **Tier 0 parts must not import back across the tier in a cycle.** Where two
  pure parts need each other's helpers, keep the shared helper in the one lower
  in the chain (their `names` kept `entryAt` and `tilde` rather than importing
  `paths`). Ours does the same at S2: `copyName` in `names` uses `entryAt` and
  `tilde`, so both live in `names`, and `paths` imports `names` (`contentHash`
  for `treeHash`, `bundleNameAt` for the bundle refusals), never the reverse.
- **A write the session makes is the daemon's own only if `writes` knows it.**
  `owned` is private to `writes`: a write that does not go through `writeOwned`
  is remembered with `writes.own(path, text)` before it lands, and a file the
  session removes is disowned. One that is not shows only as the watcher
  announcing the daemon's own write as foreign.
- **A test that reaches the core reaches the part.** After S3 the record is
  `core.m` (our `ownPlaces.test.ts` reads `m.docs` today and is repointed then).
- **A part calls a facade member a test replaces through a hook.** Tests replace
  `persist` and other members on a session to count calls; a part that calls one
  of them takes it as a hook built in the facade
  (`persist: () => this.persist()`), never its own copy, so the count still sees
  it. Calls between parts go direct. The daemon's parts, once callers move, call
  the session's parts directly, so a test that counts calls must spy on the
  part's method; the facade's delegate passes through it, so one spy on the part
  sees both.
- **A test that reaches a read-side cache reaches its part.** For us:
  `profiles.cost`, `profiles.session`, `relations.cost` and `relations.session`
  reach `profileReader` and `relationsReader` on the session today; S5 repoints
  them and shows the counters still move.
- **What is on screen has one writer.** Only the viewer writes `openDoc`,
  `openImage` and `docAside`. Its methods are not one rule applied everywhere (a
  Trash or a delete closes an open image without bringing back the document
  aside); keep each as it is unless a change means to alter what the human sees.
- **The caches are pruned only after a pass that read every candidate**, in the
  order the facade pruned them, each by a method on the part that owns it.
- **A dispatcher looks a handler up by the map's own key** (`Object.hasOwn`), so
  a frame named for `Object.prototype` (`constructor`, `toString`) is an unknown
  op, as it was to the switch; and the merged surface map holds `CLIENT_OPS`
  with no op in two topics (a spread merge would let a later map win silently).
- **The note guard stays lazy.** `loadNoteGuard` moves with the notes and keeps
  its `await import("../../document/projection.ts")` (one folder deeper than
  today's `../document/projection.ts`); `notes.ts` imports `NOT_PLACED` from
  `document/notPlaced.ts`, never from `projection.ts`, which re-exports it. The
  start-path test fails if the parser joins the daemon's start.

## Related Documentation

- [Splitting the kit's oversized modules](../items/kit-split-oversized-modules/write-up.md)
- [The kit split](../features/kit-split/feature.md)
- [Splitting an oversized module](../playbooks/splitting-a-module-playbook.md)
- [Spell backends](./spell-backend-architecture.md)
- Story Studio: `docs/architecture/workspace-session.md`,
  `tests/architecture/session-tiers.test.ts`,
  `docs/playbooks/implementing-a-branch-playbook.md` (rules 19 and 20)

---

## Revision History

- **2026-11-24**: Ported from Story Studio's page (develop `b2abead4`) at
  kit-split G1: the tiers and planned parts, ours that they don't have, the tier
  test with empty tables, the size limit and the start-path test, before any
  part is built.
- **2026-11-25**: S2 built tier 0 (`errors`, `names`, `paths`, `facts`, `types`,
  `manifest`); the tier test lists them, and `session.ts`'s override went from
  7,848 to 7,210.
