---
type: write-up
title: Splitting the kit's oversized modules
description:
  "Port Story Studio's split: session.ts into about thirty parts that own their
  state, in five tiers behind the WorkspaceSession facade; server.ts into
  closure parts under daemon/; the shell, the pane, protocol.ts and verbs.ts
  along Story Studio's W, P and V seams. A 1,200-line Biome limit with frozen
  overrides and a start-path test keep it split; the bounty, grapevine and other
  spells' files stay whole under their overrides."
tags: [kit, refactor, story-studio]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Splitting the kit's oversized modules

**Outcome:** Decided. Cole approved all eight decisions on 2026-11-24 (see
Decided), the build items are filed, and Story Studio answered on kit-parity the
same day (see Story Studio's answer).

---

## Question

`src/kit/workspace/session.ts` is 9,040 lines and `server.ts` 5,357. How should
they be split, and which of the other large files should be split too? The
answer feeds the build items for the next cycle. Cole ruled on 2026-11-17 that
the split's build opens that cycle, before any Story Studio UX port: until we
split, every port is a rewrite by hand into our single files.

Two constraints from the item:

- **Port-back.** Story Studio's kit has the same shape, and both teams cite each
  other's code on kit-parity. A split that differs from theirs makes porting
  harder both ways.
- **Lazy loading.** The daemon loads the session on start, and some code is kept
  off that path on purpose (`notPlaced.ts`, `loadNoteGuard`'s lazy import of the
  markdown parser). The split must not pull heavy imports back on.

Story Studio has already split the same kit (its Refactoring cycle, closed
2026-11-08). So the question is mostly how much of their split we can port as it
is, and where ours has to differ.

## Current State

### Our files

Lines on `docs/kit-split-oversized-modules` at `9e3808af` (cut from develop).
"Biome" is the count Biome's `noExcessiveLinesPerFile` reports, which leaves out
the lines inside JSDoc blocks and template literals. It is the count Story
Studio chose for its limit. "30 days" is commits since 2026-10-17.

These counts, and the line ranges in the tables below, are a baseline, not the
numbers to freeze. The cycle's bug fixes landed after `9e3808af`, so on develop
on 2026-11-24 `session.ts` is 9,072 lines, `protocol.ts` 2,239, `verbs.ts` 2,160
and `DocumentPane.tsx` 2,416 (`wc -l`). G1 re-measures with Biome when it
freezes the overrides, and each step re-finds its ranges by name.

| File                                | `wc -l` | Biome | 30 days |
| ----------------------------------- | ------- | ----- | ------- |
| `src/kit/workspace/session.ts`      | 9,040   | 7,816 | 20      |
| `src/kit/workspace/server.ts`       | 5,357   | 4,876 | 27      |
| `src/bounty/backend/server.ts`      | 2,791   | 2,736 | 0       |
| `src/grapevine/backend/cli.ts`      | 2,562   | 2,392 | 2       |
| `src/bounty/backend/cli.ts`         | 2,552   | 2,333 | 0       |
| `src/kit/document/DocumentPane.tsx` | 2,405   | 2,104 | 22      |
| `src/kit/shell/WorkspaceShell.tsx`  | 2,341   | 2,029 | 21      |
| `src/kit/workspace/protocol.ts`     | 2,222   | 1,561 | 16      |
| `src/kit/workspace/verbs.ts`        | 2,040   | 1,855 | 19      |

The counts match the item's table of 2026-10-26: none of these files has changed
size since. Six more source files are over 1,200 by Biome's count, and any limit
has to list them too: `mind-mapper/backend/cli.ts` (1,889),
`imago/backend/server.ts` (1,853), `mind-mapper/backend/server.ts` (1,826),
`mind-mapper/surface/App.tsx` (1,719), `grapevine/backend/daemon.ts` (1,541) and
`kit/context/ContextSidebar.tsx` (1,271, 13 commits in 30 days).

### What session.ts is

The same shape Story Studio found in theirs, at two thirds the size:

| Lines     | What                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–274     | Imports                                                                                                                                                                               |
| 275–884   | Module-level: caps and constants, the doc facts, `AppDeclaration` and `checkApp`, the three error classes, name and path helpers, `FileEvent`, `RestoreReport`, the note guard loader |
| 885–8706  | **One class, `WorkspaceSession`**: 266 members, about half private                                                                                                                    |
| 8706–9040 | More module-level helpers: placing a note, the manifest refusals, `treeHash`, `entryAt`, copy and bundle names, `sideName`                                                            |

The class has only 16 section comments, and three of them cover most of it:
"structure" runs 1,111 lines and "a bundle's references" 1,827 (it holds the
whole read side: references, profiles, the link check, the graph and backlinks).
The state is the same four kinds as Story Studio's: the manifest `this.m`
(`context` 78 uses, `docs` 47, `openDoc` 23, `openImage` 18), the write ledger
(`owned`, `ownBundles`, `activeHash`, `lastActiveText`), the caches
(`linkCache`, `headingCache`, `profileReader`, `relationsReader`, `moves`,
`resolvable`) and a little chat. `persist()` is called from 57 places.

`server.ts` reaches the session through 108 distinct members (238 calls). Other
callers: `tasks.ts`, `testing.ts`, `index.ts` (re-exports), and Scriptorium's
`backend/kit/{wiki,hide,map,app,server}.ts`. 45 test files import `session.ts`
directly; 98 import `server.ts`.

### What server.ts is

One closure, `createWorkspaceDaemon` (911–5269), whose `boot()` (1007–5206)
holds everything the running daemon does, then `runWorkspaceDaemon`. Lines 1–911
are module-level: types (`WorkspaceDaemonOptions` alone is 210 lines), timing
constants, the op sets, `rebaseLines`, `headingLanding`, `graphOptions`. Inside
`boot()` the runs are those Story Studio named, minus the ones we never built
(asks, auto mode, projects, audio): the kernel, views, prefs, presence, the chat
on the tail, watching, trash, images coming in, switching versions, structure,
following links, the picker, what a message is about, the edit relay,
`handleClientOp` (662 lines), `handleAgentCmd` (389), `Bun.serve` (262), and
teardown.

### The start-up path, measured

What each entry loads at import, in a fresh `bun -e` process (a count of
`require.cache`), and what `bun build --target=bun --splitting` puts in each
chunk:

| Entry                                       | Modules | Ours | Third-party                  | Loads `session.ts` |
| ------------------------------------------- | ------- | ---- | ---------------------------- | ------------------ |
| `src/scriptorium/backend/cli.ts` (each CLI) | 98      | 26   | 72, all `yaml`               | no                 |
| `src/scriptorium/backend/kit/server.ts`     | 211     | 66   | 145: `yaml` and 27 micromark | yes                |
| `src/kit/workspace/session.ts` alone        | 178     | 33   | 145                          | yes                |

The daemon's bundle splits into a static part (135 + 76 inputs) and one lazy
chunk, `projection` (30 inputs: `mdast-util-from-markdown` and the GFM mdast
layer), loaded only by `loadNoteGuard`. `noteGuard.lazy.test.ts` already proves
the daemon starts without it.

Two findings the item didn't expect:

- **The CLI doesn't load the session at all.** The item says "the daemon and
  every CLI spawn load the session". By import tracing, a CLI verb loads
  `verbs.ts` and the wire helpers, and never `session.ts` or `server.ts`. A CLI
  spawn that starts a daemon spawns a separate process, which does. So the CLI's
  start path is a second, separate thing to protect: `verbs.ts` and anything it
  imports.
- **`yaml` is 72 of the CLI's 98 modules, by accident.** `verbs.ts` imports
  `docExtensions` and `isDocName` from `./tree`. `tree.ts` re-exports them from
  `../lib/docFormat.ts`, but it also imports `yaml`, the frontmatter splitter
  and the sidecar helpers. Over five runs, importing the CLI took 19 to 24 ms,
  `yaml` alone 11 to 16 ms, and the CLI's other modules without `tree.ts` 8 to
  12 ms. Importing the two names from `../lib/docFormat.ts` instead would
  roughly halve the CLI's import time on every verb. It's a one-line change, but
  it changes what loads, so it's not a move: see Decisions for Cole.

## Findings

### Story Studio's split, and the taxonomy it used

Sources: Story Studio's `docs/items/_archive/refactor-session-split/write-up.md`
and `refactor-large-files/write-up.md`, its cycle
`docs/cycles/_archive/2026-11-refactoring.md`, the resulting trees in
`packages/kit/src/`, its implementer playbook (rules 19 and 20), `biome.jsonc`,
and `tests/architecture/session-tiers.test.ts`.

**The problem they named: one class, not one file.** Their write-up says the
file mixes module-level code with one class whose methods share four kinds of
state through `this`. So splitting by line count, or into mixins, would split
the file and leave every piece able to touch every field. They split by **who
owns which state**.

**Three shapes, each split its own way** (the large-files write-up):

1. **A class or closure holding a running thing's state** (`session.ts`,
   `server.ts`, `verbs.ts`'s CLI closure). It becomes **parts**: each part owns
   its fields (a class with private fields, or a `create…` closure with its own
   `let`s and maps). A part is handed what it needs as an **object of
   functions**, never the facade or a higher part, so parts can move in any
   order.
2. **A React component holding a view's state** (`WorkspaceShell`,
   `DocumentPane`, `CanvasView`). It becomes **hooks that own state** plus
   **subcomponents that take props**.
3. **Pure code** (`protocol.ts`, `links.ts`). It splits **by topic**, with the
   old path kept as a re-export.

**The session's tiers.** Parts import only downward:

| Tier | What                                           | Story Studio's parts                                                                                                                        |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Pure, no session state                         | `errors`, `names`, `paths`, `facts`, `types`                                                                                                |
| 1    | The core every part takes                      | `state` (the manifest, `persist`), `places` (display, guards), `writes` (the write ledger)                                                  |
| 2    | The tree, what is on screen, the conversation  | `bundleStamps`, `context`, `top`, `placing`, `viewer`, `media`, `sidecars`, `chats`, `copyIn`                                               |
| 3    | Documents                                      | `documents`, `follow`, `tasks`, `unseen`, `images`, `audio`, `orders`                                                                       |
| 4    | What reacts, saves and reads across documents  | `reconcile`, `saving`, `compare`, `notes`, `readIndex`, `linkResolve`, `profiles`, `relations`, `markers`, `search`, `trash`, `copyRecords` |
| 5    | Changes that span the tree, and the whole view | `linkCheck`, `linkReports`, `relinkOnMove`, `structure`, `imageImport`, `copySource`, `projectMeta`, `views`                                |

**The daemon's tiers** (`workspace/daemon/`): 0 pure (`types`, `rules`,
`landings`); 1 the kernel (`core`: sockets, `send`, `emit`, `broadcastState`,
`closed`; `views`: `viewState`, `line`, `announce`); 2 `prefs`, `presence`,
`messages`, `watching`; 3 `saving`, `asks`, `trash`, `picker`; 4 `imagesIn`,
`adding`, `structure`, `linkFollow`, `appWork`, `auto`, `projects`; 5 the
dispatchers (`surfaceOps/{documents,chats,tree}.ts`, `agentOps`, `http`).
`server.ts` keeps the shell: building the parts, `ctx`, `close`,
`runWorkspaceDaemon`. Closure rules added: a factory only stores its needs and
never calls them while being built; state is never handed out, only functions
and reads (`closed()`); each part with timers returns `stop()`, called by
`close` in today's order.

**The rules that keep it split:**

- **Ownership.** A new manifest key or field belongs to one part, and only that
  part writes it. If no part owns it, add a part in the lowest tier that can
  hold it. Never add a method body to `WorkspaceSession`, only a delegate. Pure
  logic goes in a sibling module of `workspace/`, not in a part (playbook rule
  19).
- **A size limit.** Biome's `style/noExcessiveLinesPerFile`, 1,200 lines as
  Biome counts them, on source under `packages/` and `apps/`, tests left out.
  Each file already over it gets an override frozen at its size, which the
  splitting item lowers and then removes (`360e67eb`). Split by state, never
  `part2.ts` (rule 20).
- **A tier test.** `session-tiers.test.ts` holds a table of every part's tier
  and fails on an import cycle, on an upward import, on a part importing the
  facade or `server.ts`, and on a file in `session/` with no tier. Lint can't
  check imports, so this one stayed a test.
- **No test's expectations change.** A step that has to change what a test
  expects is not a move; it stops and reports.

**The playbook's lessons** (rule 20, from the steps that hit them):

- Keep hook and effect order: call each new hook where its block sat; leave
  earlier state where it is and pass it in (P3, P6). Never put a fresh object in
  a dependency list (C8).
- **Blind tests.** A test that replaces or counts a facade member stops seeing
  calls once code calls the part directly. Grep for it, repoint it, and show the
  counter still moves (D3, D4, D7, D9).
- **Free names.** In a new module, a name that was a local or a prop can resolve
  to a DOM or Bun global (`history`, `stop`, `name`, `close`), which compiles
  and runs wrong. Check every free name in moved code is bound (D7, C8).
- Measure with Biome, not `wc -l`.

**What it came to.** Session in eleven steps, then `server.ts` from 10,922 lines
to 1,155 in D1–D9, WorkspaceShell in W1–W5, DocumentPane in P1–P6, the protocol
in one step, `verbs.ts` in V1–V4. About fifty build items, landed over
2026-11-07 and 08 with behaviour unchanged. Their `session.ts` is 2,202 lines
today and is the one override left (2,123): its delegates go when the plugins'
calls move to the parts. Their largest part is `session/structure.ts` (1,088
lines); their parts average about 370.

### Where our kit matches theirs, and where it differs

Most of our session maps one to one onto their parts. The differences fall in
three groups.

**Theirs, not ours** (we skip the part): `projectMeta` (the project file,
`@studio`, nested projects, the thumbnail), `top`, `audio`, `copyIn`,
`copySource`, `copyRecords`, `markers`, `unseen`, `bundleStamps`, `orders`. In
the daemon: `asks`, `auto`, `projects`, `adding` (ours is one function),
`askStudio`, `vocabularyVersions`.

**Ours, not theirs** (we add a part, and offer it on kit-parity):

| Our code                                                                                                                                    | Lines (ours) | Proposed part             |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------- |
| Own places: `ownPlaces`, `notOwnPlaceOrDie`, `notOwnSourceOrDie`, `mayBeASetOrDie`, `pinDir`, `dirStillOrDie`, `ownFileOrDie`, `writeShown` | 1477–1635    | into `places` (tier 1)    |
| No home and the workspace: `setWorkspace`, `workspaceOverlap`, `overlapToSay`, `setAppHome`, `appSlot`, `updateApp`                         | 1269–1401    | `workspace` (tier 2)      |
| The scan filter: `scanGuard`, `scanSkip`, `filteredOut`, `refilter`                                                                         | 1843–1903    | into `context` (tier 2)   |
| Set promotion: `makeSet`, `unmakeSet`, `addFolder`                                                                                          | 5785–5995    | `sets` (tier 5)           |
| The move preview: `movePlan`, `planWorld`, `listedAfter`, `entryAfter`, `docsAfter`, `pinEdges`, `brokenEdges`                              | 4954–5160    | `movePlan` (tier 5)       |
| The app's link slot: `linkSlot`, `linkCheckOpts`, `resolvable`                                                                              | fields       | into `readIndex` (tier 4) |
| The manifest refusals: `refuseMalformedManifest`, `refuseForeignManifest`, `looksLikeScriptorium`, `migrateSlot`                            | 8738–8900    | `manifest` (tier 0)       |

**Same role, smaller here.** Our chat is one chat (`m.chat`, `addMessage`,
`messages`, 33 lines); theirs is a 498-line part with many chats and a timer.
We'd still call ours `session/chats.ts` with a `Chats` class, so their code
ports into the file of the same name. Likewise `protocol/project.ts` holds our
manifest and snapshot types though we have no projects. Keeping their names
where the role matches is what makes a later port a file-to-file diff.

**The gate already typechecks.** Story Studio's steps lean on typecheck ("a
component that closes over a parent variable it was not passed fails to
typecheck, which is the point"). Ours does too:
`grimoire/type-check-ward.test.ts` (Cole, 2026-09-10, type-debt T37) runs
`tsc --noEmit` over every area of the repo inside `bun test`, each spell that
has its own `tsconfig.json` under it, and fails on any error or on any file left
unexamined. `src/kit` and `src/scriptorium` are in it. _Corrected at G0,
2026-11-24: this section first said our gate ran no typecheck, and G0 planned a
separate kit `tsc` step; the ward's header argues against exactly that step (an
exit 0 cannot tell clean from unexamined), so G0 added none._

### The proposed module map: session.ts

Each part is a class in `src/kit/workspace/session/` that owns the fields and
manifest keys listed, takes the core and lower parts in its constructor, and
takes anything higher as an object of functions. `session.ts` stays at its path
as the facade, so no import outside the file changes. "From" is our line range;
sizes are estimates before the saving from repeated imports. A name in _italics_
is ours, not Story Studio's.

**Tier 0: pure** (the module-level code, about 950 lines)

| Part            | Owns                                                                                                                                                                        | From                        | ~Lines |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------ |
| `errors.ts`     | `SessionError`, `GoneError`, `UnseenChangeError`                                                                                                                            | 626–660                     | 60     |
| `names.ts`      | `contentHash`, `newSessionId`, `checkSessionId`, `nowIso`, `NAME_MAX_BYTES`, `fitName`, `caseInsensitiveAt`, `uncopied`, `copyName`, `bundleNameAt`, `sideName`, `slugBase` | 508–526, 662–712, 8935–9040 | 230    |
| `paths.ts`      | `realOr`, `overlapOf`, `tilde`, `treeHash`, `entryAt`, `bundleHolding`, the bundle refusals                                                                                 | 714–753, 8901–9010          | 170    |
| `facts.ts`      | The caps, `MANIFEST_FORMAT`, `IMPORTED_DIR`, `IMAGES_DIR`, `docFacts`, `cardFacts`, `relationUses`, `ruleView`                                                              | 275–535                     | 260    |
| `types.ts`      | `AppSlot`, `ScanAt`, `ScanRule`, `AppDeclaration`, `checkApp`, `FileEvent`, `RestoreReport`, `NewTask`, `isFinished`, `ContextIndex` and the plan types                     | 278–392, 543–623, 756–845   | 280    |
| _`manifest.ts`_ | The manifest refusals and `migrateSlot`, which `restore` runs on a raw record                                                                                               | 8738–8900                   | 170    |

**Tier 1: the core**

| Part        | Owns                                                                                                                                                        | From                                       | ~Lines |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| `state.ts`  | `m`, `dir`, `id`, `docsDir`, `versionPath`, `workspace`, `hasHome`, `markEnded`, `persist` with a hook for what other parts add                             | 1219–1306, 1442–1476, 1930–1943            | 220    |
| `places.ts` | `display`, `contextForm`, `coveringEntry`, `contextIndex`, `canonical`, `realInsideOrDie`, the `…OrDie` guards, `revealTarget`, and _our own-places guards_ | 1477–1635, 2199–2228, 3094–3133, 4257–4535 | 520    |
| `writes.ts` | `owned`, `ownBundles`; `writeVersion`, `writeOwned`, `adoptActive`, `writeActive`, `preserveOutside`, `isOwnWrite`, `wroteBundle`                           | 1636–1690, 4225–4229                       | 120    |

**Tier 2: the tree, what is on screen, the conversation**

| Part             | Owns                                                                                                                                                          | From                                                  | ~Lines |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------ |
| `context.ts`     | `m.context`; `addContext`, `removeContext`, `restoreContext`, `rescan`, `rescanAround`, `relink`, `refreshListed`, `shownAt`, `watchRoots`, _the scan filter_ | 1402–1441, 1691–1929, 4006–4013, 4630–4653, 5307–5327 | 380    |
| `placing.ts`     | `adoptNew`, `freeName`, `freeImageName`, `refuseExisting`                                                                                                     | 4602–4629, 4654–4690                                  | 90     |
| `viewer.ts`      | `m.openDoc`, `m.openImage`, `m.docAside`: the one rule for what the centre shows. Today 19 assignments in 8 methods repeat it                                 | (new; the 8 sites call it)                            | 100    |
| `media.ts`       | `imageNodeAt`, `bundleImageAt`, `imageFile`, `imageStamps`                                                                                                    | 2962–3093, 3167–3183                                  | 170    |
| `sidecars.ts`    | `sidecarDocOf`, `imageOfDoc`, `sidecarText`, `imageDescription`, `withDescription`, `sidecarFileOf`                                                           | 3235–3287                                             | 80     |
| `chats.ts`       | `m.chat`; `addMessage`, `messages`                                                                                                                            | 6020–6052                                             | 50     |
| _`workspace.ts`_ | `setWorkspace`, `workspaceOverlap`, `overlapToSay`, `setAppHome`, `appSlot`, `updateApp`, `m.overlapSaid` (Story Studio keeps these in `projectMeta`)         | 1307–1401, 1468–1476                                  | 140    |

**Tier 3: documents**

| Part           | Owns                                                                                                                                                                                                                             | From                                       | ~Lines |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| `documents.ts` | `m.docs`, `activeHash`, `lastActiveText`; `findDoc`, `docOrDie`, versions, `openPath`, `edit`, `editLeft`, `newVersion`, `activate`, `deleteVersion`, `activeText`, `isDirty`, `jsonProblemOf`, `refuseInvalidJson`, `heldPaths` | 1944–2464, 2584–2588, 2801–2827, 4065–4076 | 640    |
| `follow.ts`    | `moves`; `followMove`, `movedTo`, `movedFrom`, `movedTarget`                                                                                                                                                                     | 4536–4601, 7474–7533                       | 140    |
| `tasks.ts`     | `m.tasks`; the task verbs                                                                                                                                                                                                        | 6053–6152                                  | 110    |
| `images.ts`    | `openImage`, `closeImage`, `openImagePath`, `imageView`, through the viewer                                                                                                                                                      | 3134–3166, 3184–3234                       | 100    |

**Tier 4: what reacts, saves and reads across documents**

| Part             | Owns                                                                                                                                                                           | From                                       | ~Lines |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------ |
| `reconcile.ts`   | `onFileEvents`, `onFileEvent`, `shownBundleOf`, `markMissing`, `originalsUnder`, `refreshBundle`, `revert`, `forgetDoc`                                                        | 2926–2961, 3996–4064, 4077–4256            | 330    |
| `saving.ts`      | `save`, `closeDoc`                                                                                                                                                             | 2828–2925                                  | 110    |
| `compare.ts`     | `compare`, `merge`                                                                                                                                                             | 2465–2583                                  | 120    |
| `notes.ts`       | The note verbs, `placeNote`, and **the lazy note guard** (`loadNoteGuard`, `guardLoaded`)                                                                                      | 859–883, 2589–2800, 8709–8737              | 290    |
| `readIndex.ts`   | `linkCache`, `headingCache`, _`linkSlot`, `linkCheckOpts`, `resolvable`_; `candidates`, `markdownCandidates`, `readOf`, `entryFinder`, `pruneLinkCache`, the bundle references | 6260–6323, 6889–7069, 7462–7473, 7534–7548 | 330    |
| `linkResolve.ts` | `headingsAt`, `linkHeadings`, `linkTargets`, `resolveLink`, `resolveFrom`, `droppedLinks`, `embeds`, `contextDocs`                                                             | 6324–6434, 6623–6888, 8098–8133            | 440    |
| `profiles.ts`    | `profileReader`; `profiles`, `documentProfile`, `profileCheck`                                                                                                                 | 7070–7461                                  | 400    |
| `relations.ts`   | `relationsReader`; `relationsAt`, `relations`, `typedLinks`, `vocabularyHealth`                                                                                                | 6435–6622                                  | 190    |
| `search.ts`      | `search`, `searchEach`                                                                                                                                                         | 6192–6259                                  | 70     |
| `trash.ts`       | `trashPreview`, `trashed`                                                                                                                                                      | 3840–3995                                  | 160    |

**Tier 5: changes that span the tree, and the whole view**

| Part              | Owns                                                                                                                 | From                                       | ~Lines |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| `linkCheck.ts`    | `linkCheck` (one 514-line method), `linkSubject`, `imageInside`                                                      | 7549–8097                                  | 550    |
| `linkReports.ts`  | `linkGraph`, `backlinks`, `summaries`, `cardSummaries`, `linksAmong`, `documentText`, `outlinks`                     | 8134–8622                                  | 490    |
| `relinkOnMove.ts` | `pinLinks`, `planRelink`, `rebaseCopy`, `rewriteLinks`, `renameOrDie`, `removeCreated`, `forgetPath`                 | 5359–5784                                  | 430    |
| `structure.ts`    | `createDoc`, `createFolder`, `createBundle`, `duplicate`, `move`, `rename`, `renameBundle`, `seedJson`, `importText` | 4691–4953, 5161–5306, 5328–5358, 5996–6019 | 480    |
| `imageImport.ts`  | `m.importedAs`; describing, importing and replacing images, staging                                                  | 3288–3839                                  | 560    |
| _`movePlan.ts`_   | The move preview (the pure planner is the sibling `../movePlan.ts`)                                                  | 4954–5160                                  | 210    |
| _`sets.ts`_       | Set promotion: `makeSet`, `unmakeSet`, `addFolder`                                                                   | 5785–5995                                  | 210    |
| `views.ts`        | `docView`, `doc`, `view`, `checkup`, `reportedFindings`                                                              | 6153–6191, 8623–8705                       | 130    |

**The facade.** `session.ts` keeps `create`, `restore`, `listSaved`, the
constructor that builds the parts, and a delegate for each public member. That
is about 330 lines of lifecycle plus about 130 delegates, roughly 850 lines by
`wc -l`, under the limit with no override, which Story Studio's (2,202) is not.
It re-exports every name it exports today.

**Import graph.** The tiers above come from what each method calls. Moving each
section whole would create the same misfiled-helper edges Story Studio found,
and the map already rehomes them: `activeText` (filed under notes, called by
relink, search and structure) and `isDirty` (filed under trash) go to
`documents`; `refreshListed` (under structure) to `context`; `contextIndex` and
`canonical` (under documents) to `places`; `jsonProblemOf` and
`refuseInvalidJson` (under save) to `documents`; the `moved…` helpers (under the
link check) to `follow`. A build step finds any edge this missed: the tier test
fails on it.

**Start-up path, part by part.** Splitting moves imports; it doesn't add any.
Each part imports what its methods used, all of which `session.ts` imports
today, so the daemon's module set grows only by the part files themselves (about
40 small modules of our own, no third-party ones). Two parts need care:

- **`notes.ts` keeps the guard lazy.** `loadNoteGuard` moves with the note verbs
  and keeps its `await import("../../document/projection.ts")`. Story Studio did
  the same (their `session/notes.ts:34`). `notPlaced.ts` stays a file with no
  imports, and `notes.ts` imports `NOT_PLACED` from it, never from
  `projection.ts`, which re-exports it. `session.ts` re-exports `loadNoteGuard`,
  so the daemon and `noteGuard.lazy.test.ts` don't change.
- **Tier 0 stays light.** The pure parts are what other modules import names
  from. Today nothing on the CLI's path imports `session.ts`, but if a later
  change imports, say, `SessionError` into `verbs.ts`, it should get `errors.ts`
  (no imports), not a part that pulls in `links.ts` and micromark. The
  start-path test below fails if that happens.

### The proposed module map: server.ts

Story Studio's closure pattern, ported as it is: each part a `create…(needs)` in
`src/kit/workspace/daemon/` that returns its functions and keeps its `let`s and
maps inside. Ours has no asks, auto mode or projects, so the map is shorter.

| Tier  | Part                                                    | Owns                                                                                                                                                          | From                                       | ~Lines   |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------- |
| 0     | `types.ts`                                              | `WorkspaceDaemonOptions`, `WorkspaceDaemon`, `WorkspaceContext`, `VerbCall`, `VerbHandler`, `LogEvent`, `EmitOptions`                                         | 215–219, 538–858                           | 340      |
| 0     | `rules.ts`                                              | Timing constants, `AGENT_CMD_FIELDS`, `checkAgentCmd`, `STRUCTURE_OPS`, `SURFACE_OPS`, `CLIENT_OPS`, `SessionLockedError`, refusal sentences                  | 199–233, 307–435, 887–910, 3275–3336       | 260      |
| 0     | `landings.ts`                                           | `rebaseLines`, `isDotPath`, `headingLanding`, `graphOptions`, `edgeKinds`, `surfacePath`, `expandHome`                                                        | 239–306, 436–537, 859–886                  | 240      |
| 1     | `core.ts`                                               | Sockets, surface ids, the event log, SSE clients, `touch`, `send`, `emit`, `closed`, `broadcastState`, the edit timer                                         | 1157–1240                                  | 130      |
| 1     | `views.ts`                                              | `viewState`, `sendState`, `refreshAppView`, `line`, `announce`, `revealPath`                                                                                  | 1241–1405                                  | 170      |
| 2     | `prefs.ts`                                              | `readPrefs`, `setPrefs`                                                                                                                                       | 1053–1103                                  | 60       |
| 2     | `presence.ts`                                           | The held selection, the agent's tails and grace, `holdAgent`                                                                                                  | 1027–1052, 1177–1183, 4672–4707            | 110      |
| 2     | `messages.ts`                                           | The chat on the tail (`acknowledgedUntil`, `nudged`), `refsFor`, `aboutFor`, `viaOf`, `saveWakes`, `pickReplyHint`                                            | 1122–1124, 2981–3241                       | 290      |
| 2     | `watching.ts`                                           | Watchers, settle and recheck timers, `syncWatchers`, `announceOutside`, `handleFileEvent`                                                                     | 1465–1748                                  | 290      |
| 3     | `saving.ts`                                             | Switching versions (`switches`, `activate`), the edit relay (`relayEdit`, `editActive`, `editLeft`), deleting versions                                        | 2135–2181, 3242–3274, 3337–3462            | 210      |
| 3     | `trash.ts`, `picker.ts`                                 | Trash for the human, `trashMade`; the native picker                                                                                                           | 1749–1824, 2826–2843; 1104–1121, 2844–2980 | 100, 160 |
| 4     | `imagesIn.ts`                                           | Images coming in, arrivals, `addPaths`                                                                                                                        | 1825–2134                                  | 310      |
| 4     | `structure.ts`                                          | `structure` and its names                                                                                                                                     | 2182–2409                                  | 230      |
| 4     | `linkFollow.ts`                                         | Following links after a move, the relink offer, `applyInverse`, the history                                                                                   | 1125–1156, 2410–2825                       | 450      |
| 4     | `appWork.ts`                                            | `pushAppAct`                                                                                                                                                  | 1406–1434                                  | 40       |
| 5     | `surfaceOps.ts`, `surfaceOps/{documents,chats,tree}.ts` | `handleClientOp`'s cases by topic, merged in one map                                                                                                          | 3463–4124                                  | 4 × 180  |
| 5     | `agentOps.ts`                                           | `callVerb`, `showForAgent`, `handleAgentCmd`                                                                                                                  | 4125–4653                                  | 540      |
| 5     | `http.ts`                                               | `refusal`, `eventsResponse`, `Bun.serve`                                                                                                                      | 4654–4671, 4708–5020                       | 340      |
| shell | `server.ts`                                             | `createWorkspaceDaemon`, the lock, `boot()` building the parts and `ctx`, the pointer, the restore report, the attention timer, `close`, `runWorkspaceDaemon` | the rest                                   | 550      |

Same start-up story as the session: the parts import what `boot()` imports
today, so the daemon gains only its own part files. The one lazy chunk,
`projection`, is reached only through `loadNoteGuard`, which no daemon part
imports directly.

### The other files

| File                                    | Call                       | Why, and the seams                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kit/shell/WorkspaceShell.tsx` (2,029)  | **Split, W1–W5**           | Story Studio's seams fit: `ShellBody`'s sections already match theirs. W1 the components `TopBar.tsx`, `StatusBar.tsx`, `ChatColumn.tsx` (out of the 594 lines of JSX); W2 `useShellColumns.ts` (544–736) and `usePaneKeys.ts` (776–865); W3 `useHeldSelection.ts` (866–999) and `useReveal.ts` (1000–1098), in one step because of the effect-order comment; W4 `useDaemonNotices.ts` (1129–1392); W5 the right column, `useRightColumn.ts`, `rightTabs.ts`, `useRightTab.ts` (1393–1746). We have no project links or session-end hook to move. Theme (491–543) and the composer stay in `ShellBody`. |
| `kit/document/DocumentPane.tsx` (2,104) | **Split, P1–P6**           | P1 `paneHooks.ts` (`usePaneWidth`, `useDebouncedStats`, `useNow`) and `useFocusMode.ts`; P2 `useDocumentMenu.ts` (930–1365), the menu only, since the link picker sets state the link section owns (their P2 lesson); P3 `useLinkWriting.ts` (826–929), `useSaveRevert.ts` (754–825), `useDocumentDrops.ts` (images pasted and rows dragged in, 1410–1640); P4 `PaneHeader.tsx` and its controls; P5 `useRenderedReads.ts` (reader mode, 548–670); P6 `useCompare.ts` (671–732), `useAgentPointing.ts` (1641–1767), and _`useTextOffer.ts`_ (1366–1409, ours).                                          |
| `kit/workspace/protocol.ts` (1,561)     | **Split, one step (R1)**   | Types by topic, as theirs: `protocol/context.ts` (context, structure), `documents.ts` (comparing, authors, versions, notes, history), `chat.ts` (chat, tasks), `project.ts` (the manifest, link-follow, the snapshot), `reading.ts` (search, links, profiles: 910–1836), `frames.ts` (surface to daemon, agent to daemon). `protocol.ts` becomes `export type *` re-exports, plus our two runtime values (`resolveAppState`, `PICK_WANTS`) re-exported by name. 67 files import it; none changes.                                                                                                       |
| `kit/workspace/verbs.ts` (1,855)        | **Split, V1–V4**           | Same as theirs, verb for verb: V1 `verbs/parse.ts` (88–420); V2 `client.ts` (finding the daemon, 565–773); V3 `lifecycle.ts` and `tail.ts`; V4 `rows/{session,chat,notes,structure,reading}.ts` (our 39 rows in `ROWS`, 1282–1972, split at the same verbs as theirs), with a snapshot of every verb's `help` before and after. It's the CLI's start path: the parts may import only what `verbs.ts` imports today.                                                                                                                                                                                     |
| `bounty/backend/server.ts` (2,736)      | **Leave, frozen override** | No commits in 30 days. Not kit code, so port-back doesn't apply. Its `main()` is one 1,885-line closure; if bounty work resumes, the closure pattern above is the way to split it.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `bounty/backend/cli.ts` (2,333)         | **Leave, frozen override** | No commits in 30 days. It is already organised: helpers, then verbs, then the command table (1791 on). Split it along those lines when bounty next changes.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `grapevine/backend/cli.ts` (2,392)      | **Leave, frozen override** | Two commits in 30 days, outside the kit. The seams are clear if it grows: the daemon protocol (85–566), the verbs (568–1750), daemon enumeration (1752–1892), body guards (1893–2470).                                                                                                                                                                                                                                                                                                                                                                                                                  |

The six files over the limit that the item's table didn't list (`mind-mapper`
×3, `imago/backend/server.ts`, `grapevine/backend/daemon.ts`,
`kit/context/ContextSidebar.tsx`) get frozen overrides too. `ContextSidebar` is
the only one changing often (13 commits in 30 days) and the only one in the kit;
Story Studio left theirs whole (it was under 1,200 by Biome's count). Ours is 71
over. Its natural seam is theirs for `EntryTree`: `FolderView` and the create
row out. Leave it for now and split it the first time a change would push it
past its override.

### Options considered

**A. Do nothing.** Every port from Story Studio stays a hand rewrite, and
parallel branches keep colliding in `session.ts`. Cole has ruled this out.

**B. Design our own split.** We could pick our own seams, perhaps fewer, larger
parts. But every difference from Story Studio's tree becomes a translation in
both directions on every port, which is the cost this item exists to remove.

**C. Port Story Studio's split, adapted where our code differs** (recommended).
Their taxonomy, tiers, rules and names; their step order; our own parts only
where we have code they don't. Most of the design work is already done and was
proven over about fifty landed steps.

**D. Port only the guard now, split later.** The Biome limit stops growth, but
the first feature that needs to grow `session.ts` stops at the limit with
nowhere to put its code. It defers the cost to the next port.

## Recommendation

- [ ] **Propose a feature** — the work is big enough to plan
- [x] **File work items** — the work is a handful of tasks
- [ ] **No action needed** — the current state is acceptable
- [ ] **Monitor** — watch for named signals or thresholds
- [ ] **More research needed** — questions remain

**Rationale:** option C. The split is a sequence of moves of known code with an
unchanged surface, and Story Studio has already designed and proven it.
Following their tree is also what answers the port-back constraint.

### The build steps

Each step is behaviour-preserving and lands alone. Step names follow Story
Studio's numbering (our S2 is their session step 2, our D4 their D4), so the two
teams can say "after S7" and mean the same tree. "The gate" means
`bun run gate`, whose type-check ward typechecks every move. The rule for every
step: **no test's expectations change**. A test changes only where it reached
into private state that moved, and then only to reach the same state at its new
address.

| #     | Step                                                                                                                                                                                                                                                                                                                                                                                            | Proves it, beyond the gate                                                                                                                | Risks, and the lesson that applies                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0    | **Tooling.** Biome to 2.5.x (Story Studio's 2.5.15), where `noExcessiveLinesPerFile` is a `style` rule; in our 2.4.16 it exists only in `nursery`. The gate's type-check ward already covers `src/kit` and `src/scriptorium` (found at G0); no separate step.                                                                                                                                   | The gate passes; Biome's new findings, if any, fixed in the same step.                                                                    | A Biome minor can bring new lint findings across every spell. Keep it its own step so they don't mix with the guard.                                                                                                                                            |
| G1    | **The guard.** The 1,200-line limit on `src/**/*.{ts,tsx}` except tests, with 15 overrides frozen at today's Biome counts; `session-tiers.test.ts` (copied from their develop, with an empty table until S2); a start-path test; the ownership rule and the lessons as a playbook; Story Studio's `workspace-session.md` architecture page, copied from their develop; one line in `AGENTS.md`. | Grow a listed file by one line and the lint fails; revert. The start-path test passes today.                                              | Lanes that grow a listed file stop at the limit. Intended.                                                                                                                                                                                                      |
| S2    | **Tier 0 out**: `errors`, `names`, `paths`, `facts`, `types`, _`manifest`_. `session.ts` re-exports every name.                                                                                                                                                                                                                                                                                 | `session.test.ts`, `manifest.test.ts`, `manifestMigrate.test.ts`, `index.ts`'s exports by typecheck.                                      | `instanceof SessionError` still works (one class). An import cycle if a helper imports back from `session.ts`.                                                                                                                                                  |
| S3    | **The core**: `state`, `places` (with our own-places guards), `writes`. `this.m` becomes `this.core.m` at about 200 sites. **Alone.**                                                                                                                                                                                                                                                           | `session.test.ts`, `ownPlaces.test.ts` (repointed from `m.docs` to `core.m.docs`), `noHome.*`, `diskGuard.test.ts`, `saveUnseen.test.ts`. | The widest diff. A missed `owned` path makes the daemon's own write look foreign, which shows only as a watcher announcing it.                                                                                                                                  |
| S4    | **Chats and tasks.** Small for us (`chats` is 50 lines).                                                                                                                                                                                                                                                                                                                                        | `tasks.test.ts`, `waiting.test.ts`, `chatNames.server.test.ts`, `noteAsk.server.test.ts`.                                                 | Low. Could fold into S6.                                                                                                                                                                                                                                        |
| S5    | **The read side**: `readIndex`, `linkResolve`, `profiles`, `relations`, `linkCheck`, `linkReports`, `search`. About 2,500 lines out: the biggest dent.                                                                                                                                                                                                                                          | Every `links.*`, `*.cost.test.ts`, `profiles.*`, `relations.*`, `references.test.ts`, `search.*`, `headings.server.test.ts`.              | **Blind tests**: `profiles.cost`, `profiles.session`, `relations.cost` and `relations.session` reach `profileReader` and `relationsReader` on the session; repoint them to the part and show the counters still move. Run the `.cost` tests on their own after. |
| S6    | **Small tier 2 parts**: `viewer`, `media`, `sidecars`, `placing`. The 8 methods that set what is on screen call the viewer.                                                                                                                                                                                                                                                                     | `images.*`, `show.test.ts`, `fileGone.test.ts`, `trash.test.ts`.                                                                          | The viewer is a behaviour seam: a close that brought back the aside document must still do so. Read each of the 19 assignments against the viewer's rule before and after.                                                                                      |
| S7    | **Documents** with the misfiled helpers, then `follow`, `compare`, `saving`, `notes`, `tasks` if not in S4.                                                                                                                                                                                                                                                                                     | `session.test.ts`, `json.*`, `history.*`, `notes.test.ts`, **`noteGuard.lazy.test.ts`**, `editLeft.server.test.ts`, `saveUnseen.test.ts`. | `notes.ts` must keep the guard's `await import`. `DocumentPane.contextMenu.test.tsx` replaces `daemon.session.addNote`: it stays seeing calls while the daemon calls the facade, and goes blind at D-step caller moves. Repoint it then.                        |
| S8    | **The tree**: `context` (with the scan filter and `watchRoots`), _`workspace`_.                                                                                                                                                                                                                                                                                                                 | `tree.*`, `scanFilter.*`, `noHome.*`, `structure.test.ts`, `layers.test.ts`.                                                              | `relink` then the rescan run after nearly every change; keep their order.                                                                                                                                                                                       |
| S9    | **Reconcile and the watcher.** **Alone**, and the Linux CI green before the next step.                                                                                                                                                                                                                                                                                                          | `fileGone.test.ts`, `quietTail.test.ts`, `history.follow.server.test.ts`, `links.integration.test.ts`, `daemon.integration.test.ts`.      | Whose write was that: a mistake here reverts an outside edit or announces the daemon's own. Watch events differ by platform.                                                                                                                                    |
| S10   | **Changes that span the tree**: `relinkOnMove`, `structure`, `trash`, `imageImport`, _`movePlan`_, _`sets`_.                                                                                                                                                                                                                                                                                    | `structure.test.ts`, `relink.*`, `movePlan.test.ts`, `setPromotion.*`, `trash.*`, every `images.*`.                                       | The ordering inside `move` and `rename`: move line for line.                                                                                                                                                                                                    |
| S11   | **The top**: `views`. The facade is the lifecycle plus delegates; the tier test runs strict; the parts become public `readonly` fields (`session.documents`, …) as Story Studio's did at their D2.                                                                                                                                                                                              | `server.test.ts`, `show.test.ts`, `doctor.test.ts`; `session.ts` under 1,200 and its override removed.                                    | None new.                                                                                                                                                                                                                                                       |
| D1    | **Module-level code out**: `daemon/types.ts`, `rules.ts`, `landings.ts`; `server.ts` re-exports. Any time.                                                                                                                                                                                                                                                                                      | Typecheck; every test that imports a constant (`IMAGE_ARRIVAL_SETTLE_MS`, `rebaseLines`, `isDotPath`, …).                                 | None of note.                                                                                                                                                                                                                                                   |
| D2    | **The kernel**: `core`, `views`. **Alone.** From here on, each D step moves its `session.` calls onto the parts in a second commit.                                                                                                                                                                                                                                                             | `server.test.ts`, `events.test.ts`, the `tail-handoff.*` tests, `quietTail.test.ts`, `heartbeat.test.ts`.                                 | A broadcast that loses its throttle floods state frames.                                                                                                                                                                                                        |
| D3    | **Prefs, presence, messages.**                                                                                                                                                                                                                                                                                                                                                                  | `selection.test.ts`, `pointed.integration.test.ts`, `messageViaRefs.test.ts`, `messageAppAbout.server.test.ts`, `replyHint.test.ts`.      | The agent's grace timer moves to `presence.stop()`, at the same place in `close`. **Free names**: `history` and `close` are browser globals.                                                                                                                    |
| D4    | **Watching.** **Alone**, Linux CI green after.                                                                                                                                                                                                                                                                                                                                                  | `fileGone.test.ts`, `daemon.integration.test.ts`, `concurrentRestore.integration.test.ts`.                                                | The order of rescans and catch-up decides whose write a change was.                                                                                                                                                                                             |
| D5    | **Saving, trash, picker.**                                                                                                                                                                                                                                                                                                                                                                      | `editRelay.server.test.ts`, `editLeft.server.test.ts`, `trash.*`, `picker.test.ts`.                                                       | Blind tests on the edit relay.                                                                                                                                                                                                                                  |
| D6    | **Images coming in.**                                                                                                                                                                                                                                                                                                                                                                           | `images.import.*`, `images.paste.test.ts`, `images.rowDrop.test.ts`.                                                                      | The arrival settle timer stays with `lastImport` and the arrivals map.                                                                                                                                                                                          |
| D7    | **Structure and link-following**, which call each other; `appWork`.                                                                                                                                                                                                                                                                                                                             | `structure.test.ts`, `relink.*`, `history.follow.server.test.ts`, `links.integration.test.ts`.                                            | `move` then `relink` then the follow, line for line. **Free names** (their D7 hit `history`).                                                                                                                                                                   |
| D9    | **The dispatchers**: `surfaceOps/*`, `agentOps`, `http`; `server.ts` becomes the shell. (We have no D8: no auto mode or projects.)                                                                                                                                                                                                                                                              | Every `*.server.test.ts`; a test that the merged surface map's keys equal `CLIENT_OPS`; the tier test covers `daemon/`.                   | An op that falls into the wrong topic's map or `default`.                                                                                                                                                                                                       |
| R1    | **protocol.ts by topic.** Any time.                                                                                                                                                                                                                                                                                                                                                             | Typecheck.                                                                                                                                | A runtime value left out of `export type *`.                                                                                                                                                                                                                    |
| V1–V4 | **verbs.ts**: parse, client, lifecycle and tail, rows.                                                                                                                                                                                                                                                                                                                                          | Every `*.cli.test.ts`; `help` for every verb snapshotted before V4 and compared after; the start-path test.                               | A part importing something new onto the CLI's path.                                                                                                                                                                                                             |
| W1–W5 | **WorkspaceShell**, as in the table above.                                                                                                                                                                                                                                                                                                                                                      | The 17 `WorkspaceShell*.test.tsx`, which render the shell whole.                                                                          | **Hook and effect order**: call each hook where its section sat. W3 moves the selection and the reveal together.                                                                                                                                                |
| P1–P6 | **DocumentPane**, as in the table above.                                                                                                                                                                                                                                                                                                                                                        | The 21 `DocumentPane*.test.tsx`.                                                                                                          | Their P3 had to reorder effects to cut one section; a review checked each moved effect. Expect the same.                                                                                                                                                        |

**The guard, in detail.** Biome's rule in an `overrides` block, as Story
Studio's `biome.jsonc` has it, with `includes` for `src/**/*.ts` and
`src/**/*.tsx` minus tests. Fifteen overrides frozen at today's Biome counts:
`session.ts` 7,816, `server.ts` 4,876, `bounty/backend/server.ts` 2,736,
`grapevine/backend/cli.ts` 2,392, `bounty/backend/cli.ts` 2,333,
`DocumentPane.tsx` 2,104, `WorkspaceShell.tsx` 2,029, `protocol.ts` 1,561,
`verbs.ts` 1,855, `mind-mapper/backend/cli.ts` 1,889, `imago/backend/server.ts`
1,853, `mind-mapper/backend/server.ts` 1,826, `mind-mapper/surface/App.tsx`
1,719, `grapevine/backend/daemon.ts` 1,541, `ContextSidebar.tsx` 1,271. Each
split step lowers its file's number, and removes the entry once the file is
under 1,200.

**The start-path test** replaces `noteGuard.lazy.test.ts`'s first test with a
wider one, in fresh processes as that test does:

- the CLI entry (`scriptorium/backend/cli.ts`) loads no `workspace/session`, no
  `workspace/server`, no micromark and no mdast;
- the daemon entry loads no `document/projection` and no mdast until
  `loadNoteGuard` runs (today's test);
- the daemon's third-party packages are exactly today's 28 (`yaml` and the
  micromark family). A new one fails with its name, so whoever adds it decides
  in the open whether it belongs on the start path.

It counts packages, not modules, because the split adds about 60 small files of
our own, and that cost is the split's point.

**Order and lanes.** As Story Studio ran it, two lanes at most. Lane A runs the
session (S2 to S11), then the daemon (D2 to D9), which waits for S11 so each
`session.` call moves once. Lane B runs D1, R1, the W and P steps, and V1 to V4
beside it, but never beside S3, S9, D2 or D4, which run alone. In lane B the
shell comes first (W1, then W5), because the UX ports wait on it.

**Which open items wait on which step** (they are `blocked_by` this research
item today; the build items take over):

| Item                                                                   | Waits on | Why                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [kit-inbox](../kit-inbox.md)                                           | W1       | Story Studio's popover sits in `TopBar.tsx`; `shell/inbox.ts` is pure and ports any time. Also waits on kit-leave-an-agent-version.                                                               |
| [kit-icon-tabs](../kit-icon-tabs.md)                                   | W5       | It changes `ChatColumn.tsx`, `rightTabs.ts`, `useRightTab.ts`.                                                                                                                                    |
| [kit-activity-tab](../kit-activity-tab.md)                             | W5, D2   | The tab is the right column's; each line's side is marked where `line` and `announce` are said, which is `daemon/views.ts`.                                                                       |
| [kit-back-and-forward](../kit-back-and-forward.md)                     | W1, W3   | The arrows sit in `TopBar.tsx`; the controller hooks into opening and the reveal. Its daemon facts (`navFacts.ts`) are a new module that needs only D2 (an inference: I didn't trace their code). |
| [kit-page-key](../kit-page-key.md)                                     | D9       | Their change is in `daemon/http.ts`, which only D9 creates.                                                                                                                                       |
| [kit-stale-build-detection](../kit-stale-build-detection.md)           | D2       | A stamp at start (the shell) and a notice in the state and the tail (`views.ts`). Their version lives in a service we don't have, so it's new code either way.                                    |
| [kit-leave-an-agent-version](../kit-leave-an-agent-version.md)         | S7, D9   | `session/documents.ts` for the `left` mark; `surfaceOps/documents.ts` and `agentOps.ts` for the op and the verb.                                                                                  |
| [kit-raw-undo-survives-rendered](../kit-raw-undo-survives-rendered.md) | S7       | Only its session change waits; `DocumentView.tsx` isn't in this split (1,079 by Biome).                                                                                                           |

## Message for kit-parity (draft)

For the lead to send. It asks Story Studio the things that would change our tree
if they answered differently.

> Spellbook is about to split its kit the way you split yours in the Refactoring
> cycle, and we'd like to port your shape rather than invent one. The plan is in
> Spellbook's `docs/items/kit-split-oversized-modules/write-up.md`.
>
> In short: `session.ts` into parts under `workspace/session/` with your five
> tiers, your part names, your facade and your object-of-functions rule;
> `server.ts` into `workspace/daemon/` closure parts; WorkspaceShell,
> DocumentPane, `protocol.ts` and `verbs.ts` along your W, P, R and V seams.
> We'll guard it the way you did: Biome's 1,200-line limit with frozen
> overrides, and your `session-tiers.test.ts`. Our steps carry your numbers (our
> S7 is your session step 7, our D4 your D4), so "after S7" means the same tree
> on both sides.
>
> Where we differ:
>
> - **Parts you have and we don't**: `projectMeta`, `top`, `audio`, `copyIn`,
>   `copySource`, `copyRecords`, `markers`, `unseen`, `bundleStamps`, `orders`;
>   and in the daemon `asks`, `auto`, `projects`, `adding`.
> - **Parts we add**: `session/manifest.ts` (tier 0, the manifest refusals),
>   `session/workspace.ts` (tier 2: no home, the workspace and its overlap,
>   which you keep in `projectMeta`), `session/movePlan.ts` and
>   `session/sets.ts` (tier 5), our own-places guards inside `places.ts`, the
>   scan filter inside `context.ts`, and the app's link slot inside
>   `readIndex.ts`.
> - **Same name, smaller part**: our `session/chats.ts` holds one chat, and
>   `protocol/project.ts` holds our manifest and snapshot though we have no
>   projects. We kept your names so a port is a diff between files of the same
>   name.
>
> Questions:
>
> 1. Has anything in `session/` or `daemon/` moved since the cycle closed on
>    2026-11-08 that we should copy rather than follow the write-ups (the
>    plugin-callers move, renamed parts, new tiers)?
> 2. Would you take any of our extra parts into your tier table, so the two
>    tables stay one table with some rows unused on each side?
> 3. Any lesson from the build that isn't in your playbook's rule 20 yet?
> 4. Do you mind us porting `session-tiers.test.ts` and
>    `docs/architecture/workspace-session.md` nearly verbatim?

## Story Studio's answer

Kit-parity message 73, 2026-11-24, answering message 71:

1. **What moved since 2026-11-08:** six parts were added, and nothing was
   renamed or moved between tiers. In `session/`: `markers.ts` (tier 4,
   `864b149e`) and `copyRecords.ts` (tier 4, `6c6d2ec2`). In `daemon/`:
   `askStudio.ts` (`fc578a7c`), `navFacts.ts` (`27589601`, which
   [kit-back-and-forward](../kit-back-and-forward.md) already cites),
   `verbChain.ts` (`f31ee03a`) and `vocabularyVersions.ts` (`ae40bd49`). None is
   a part we need for the split; the four daemon parts belong to Story Studio
   features we haven't ported. `docs/architecture/workspace-session.md` and
   `tests/architecture/session-tiers.test.ts` are current on their develop: **G1
   copies them from there, not from the write-ups.**
2. **Our extra parts in their tier table: no.** Their table lists only their
   parts, so it doesn't drift with ours. It now notes that Spellbook split along
   the same tiers and names, with parts of its own, and that our doc records
   them (their develop `d41d01fa`). Keeping the shared names is what matters to
   them. So our `workspace-session.md` is the record of our extra parts, and our
   tier test lists them.
3. **Lessons:** nothing beyond rule 20 of their implementing-a-branch playbook:
   split by what owns which state, never by line count, and a split is a pure
   refactor with no behaviour change. G1's playbook carries it.
4. **Porting the tier test and the architecture page nearly verbatim: yes.**

On #137 they are covered: their CLI requires `--project` on every verb that
talks to a session (`project_required`).

## Decided

Cole, 2026-11-24: all eight decisions as recommended.

1. Build option C, Story Studio's split adapted, as the next cycle opens.
2. Keep Story Studio's names, even where the noun doesn't fit us.
3. The limit is 1,200 lines as Biome counts them, tests left out, with 15 frozen
   overrides.
4. Biome to 2.5.x and a kit typecheck in the gate come first, as G0. _(At G0 the
   gate turned out to typecheck already; see "The gate already typechecks".)_
5. The end state is public parts, callers moved, delegates retired.
6. `yaml` comes off the CLI's start path, as its own small item.
7. The bounty, grapevine, mind-mapper and imago files stay whole under frozen
   overrides.
8. Two lanes at most, with S3, S9, D2 and D4 alone.

## Next Steps

1. ~~The lead sends the message above on kit-parity and records Story Studio's
   answer.~~ Sent as message 71; answered in message 73, 2026-11-24. See Story
   Studio's answer.
2. ~~Cole answers the decisions below (box 5).~~ Done 2026-11-24; see Decided.
3. ~~The build items are filed from the step table.~~ Done 2026-11-24, under
   [the kit-split feature](../../features/kit-split/feature.md), each
   `blocked_by` the one before in its chain: [G0](../kit-split-g0.md),
   [G1](../kit-split-g1.md); the session [S2](../kit-split-s2.md),
   [S3](../kit-split-s3.md), [S4](../kit-split-s4.md), [S5](../kit-split-s5.md),
   [S6](../kit-split-s6.md), [S7](../kit-split-s7.md), [S8](../kit-split-s8.md),
   [S9](../kit-split-s9.md), [S10](../kit-split-s10.md),
   [S11](../kit-split-s11.md); the daemon [D1](../kit-split-d1.md),
   [D2](../kit-split-d2.md) (after S11 and D1), [D3](../kit-split-d3.md),
   [D4](../kit-split-d4.md), [D5](../kit-split-d5.md), [D6](../kit-split-d6.md),
   [D7](../kit-split-d7.md), [D9](../kit-split-d9.md); [R1](../kit-split-r1.md);
   [V1](../kit-split-v1.md) to [V4](../kit-split-v4.md);
   [W1](../kit-split-w1.md) to [W5](../kit-split-w5.md);
   [P1](../kit-split-p1.md) to [P6](../kit-split-p6.md); and
   [cli-yaml-off-start-path](../cli-yaml-off-start-path.md) for decision 6. D1,
   R1, V1, W1, P1 and the yaml item wait only on G1. The eight items above, and
   [kit-profile-layers](../kit-profile-layers.md) (S5), now wait on their steps
   instead of this research item.
4. After that, mark this item done:
   `bun scripts/pdocs/cli.ts set item/kit-split-oversized-modules --lifecycle done`.

## Decisions for Cole

_Ruled 2026-11-24; see Decided._

1. **Build Story Studio's split, adapted, as the next cycle opens?**
   Recommended: yes, option C, with the steps above. You've ruled the timing;
   this asks you to approve the shape.
2. **Keep their names even where the noun doesn't fit us** (a `chats.ts` that
   holds one chat, `protocol/project.ts` with no projects)? Recommended: yes.
   Every rename is a translation on every port, both ways.
3. **The limit: 1,200 lines as Biome counts them, tests left out, 15 frozen
   overrides?** Recommended: yes, the same as Story Studio's.
4. **Upgrade Biome to 2.5.x and add a kit typecheck to the gate first (G0)?**
   Recommended: yes. In our Biome 2.4.16 the size rule exists only as a
   `nursery` rule, which may change. And Story Studio's moves were made safe by
   typecheck. _(At G0 our gate turned out to typecheck already, through the
   type-check ward; no separate step was added.)_
5. **Facade end state: public parts, callers moved, delegates retired?**
   Recommended: yes, as Story Studio chose. The daemon's code then calls
   `session.documents.findDoc(…)` as theirs does, so daemon code ports as it is.
   Our facade would fit under the limit even with every delegate kept, so this
   is about port-back, not size.
6. **Take `yaml` off the CLI's start path?** `verbs.ts` gets two name helpers
   from `tree.ts`, which pulls in `yaml`: 72 of the CLI's 98 modules, about half
   its import time on every verb. Importing them from `lib/docFormat.ts` instead
   is a one-line change. Recommended: yes, as its own small item, which the
   start-path test then locks in. It isn't a move, so it stays out of V1.
7. **Leave the bounty, grapevine, mind-mapper and imago files whole, under
   frozen overrides?** Recommended: yes. None is kit code, and none has changed
   more than twice in 30 days. Split each the first time a change would push it
   past its number.
8. **Lanes: two at most, with S3, S9, D2 and D4 alone?** Recommended: yes, as
   Story Studio ran it.

## Open Questions (Optional)

- **The estimates are estimates.** Part sizes come from line ranges. Story
  Studio's `CanvasView` came out at 2,446 against an estimate of about 1,000.
  Ours are all well under the limit, so a miss means a bigger part, not a failed
  step.
- **The import graph is read, not computed.** Story Studio built a call graph
  over the class; I mapped ours from its members and a sample of their bodies.
  The tier test is what will prove it, step by step. A misfiled helper I missed
  shows up as a failing tier test in the step that moves it, and the fix is to
  rehome the helper, as theirs did.
- **Story Studio's last week.** Their split closed on 2026-11-08; anything
  they've changed in `session/` or `daemon/` since is what question 1 of the
  message asks.

### How this was measured

On this branch at `9e3808af`, and Story Studio's working tree on 2026-11-17:

- Sizes: `wc -l`, and Biome's count from `biome lint` with
  `nursery/noExcessiveLinesPerFile` at `maxLines: 1` in a scratch config. Churn:
  `git log --since=2026-10-17 --name-only`.
- The session's map: its members listed by line with an `awk` over the class
  body, grouped by section and by what each calls (`this.…` uses in the larger
  methods). Manifest field uses: `grep -oE "this\.m\.[a-zA-Z]+"`. Callers:
  `grep -oE "\bsession\.[a-zA-Z]+"` over `server.ts`.
- The daemon's map: the `const`, `let` and `function` declarations at the top
  level of `boot()`, by line.
- Start path: in a fresh `bun -e`, `await import(entry)` then
  `Object.keys(require.cache)`, split by `node_modules`;
  `bun build --target=bun --metafile` and `--splitting` for the chunks; import
  times over five runs each with `performance.now()`.
- Typecheck: `tsc --noEmit -p tsconfig.json` over the repo.

---

**Related Documents:**

- [Split the kit's oversized modules, starting with session.ts](./item.md)
- [Story Studio document UX, since the last scan](../story-studio-document-ux-port/write-up.md)
- [`session.ts`](../../../src/kit/workspace/session.ts)
- [`server.ts`](../../../src/kit/workspace/server.ts)
- [The note guard's lazy test](../../../src/kit/workspace/noteGuard.lazy.test.ts)
- Story Studio: `docs/items/_archive/refactor-session-split/write-up.md`,
  `docs/items/_archive/refactor-large-files/write-up.md`,
  `docs/cycles/_archive/2026-11-refactoring.md`,
  `docs/playbooks/implementing-a-branch-playbook.md` (rules 19 and 20),
  `tests/architecture/session-tiers.test.ts`, `biome.jsonc`
