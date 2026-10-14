---
type: write-up
title: How to port the workspace stack
description:
  Port from 027d7a3 plus five clean generic picks; nothing there leans on the
  new workspace model; split into five cycles on a flagged second Scriptorium
  beside the shipped one, daemon first; six kit slots are missing for the wiki
  layer.
tags: [kit, scriptorium, story-studio]
status: draft
generated: { by: claude-opus-5-5, at: 2026-10-13 }
---

# How to port the workspace stack

**Outcome:** Work items to file. The first cycle is drafted below, ready to
file, and four more cycles are sketched.

## Summary

- **The port base.** Port from `027d7a3` and take five later commits on top:
  `55df89e`, `d7ef948`, `a538a2e`, `0ff5698`, and the kit half of `5b87ad0`.
  - Nothing at `027d7a3` leans on the new workspace model. The model's four
    commits come after it, and the one earlier piece it replaced is the step-out
    rule with `imported/`. That rule is exactly what E71 asks for, and it is
    present and tested at `027d7a3`.
  - Applied in commit order to a scratch tree, the five picks apply cleanly,
    typecheck, and pass the whole kit suite (2,619 pass, 0 fail).
- **The split.** Five cycles, daemon first. Scriptorium's wire and the kit's
  differ on every frame, so no pane can be swapped in over Scriptorium's own
  daemon.
  - Cole's eased rule (no release until the stack is done) allows the
    lowest-risk shape: a second Scriptorium on the kit, behind
    `SCRIPTORIUM_KIT=1`, grows beside the shipped one cycle by cycle.
  - The last cycle flips the default, migrates sessions and deletes the old
    code.
  - That last step is a cutover, but not a big-bang one. By then the new path
    has been driven and tested on its own for four cycles.
- **The seams.** Most of the wiki layer fits the existing extension points, but
  six slots are missing:
  - extra link edges;
  - a tree-scan filter;
  - set promotion that keeps the entry id;
  - a pre-move confirm;
  - a whole-manifest migrate;
  - a shell storage adapter.
- **The kept features.**
  - E53 comes across whole.
  - E65 comes across about one third done.
  - E64's floating composer has not landed in Story Studio:
    `kit-floating-composer` is in its `backlog`.
  - E71 is already in the kit.
  - `tailHandoff`'s `by` is identical in both.
  - Neither side can migrate a session manifest. Both are `format: 1`, and the
    kit's restore would misread a Scriptorium manifest without refusing it.

## Question

The item asks three things, narrowed by Cole's ruling of 2026-10-13: port from
`027d7a3`, without Story Studio's new workspace model.

1. **The port base.**
   - Does anything at `027d7a3` already depend on the new model (`a8776ab`,
     `6b3d943`, `7afe5d9`, `bc88014`)?
   - Which other later kit commits are generic fixes, and do they apply without
     the model?
   - What Story-specific code in the five modules has to be cut or made a slot?
2. **The split.** How the stack divides into cycles that keep Scriptorium
   workable, in the feature's port order. And which goes first, the kit's daemon
   or its panes.
3. **The seams.**
   - Where the wiki layer plugs into the four extension points.
   - How each kept feature comes across: E53, E65, E64, the links-cycle
     extraction, E71, `tailHandoff`'s `by`, sessions under `~/.scriptorium`, and
     the SKILL and acc.

The answer feeds the next cycle's scope.

**Constraint eased mid-investigation (Cole, through the lead):** there is no
release until every workspace-stack cycle is done. A cycle only has to stay
workable for development, with the gate and acc green on its branch. It does not
have to leave Scriptorium shippable to users.

## Method

- **Story Studio**, read-only, at
  `/Users/colereed/Projects/dreamwood/story-studio`.
  - A scratch worktree at `027d7a3` and a pristine `git archive` export were
    made in this session's scratchpad. Both are removed at the end.
  - Kit paths below are relative to `packages/kit/src` at `027d7a3` and are
    written **K/**. Line numbers are the pristine export's.
  - The five picks were applied in commit order with `git apply` (kit paths
    only). Then:
    - `bun install --ignore-scripts`, which skips Story Studio's `husky` hook,
      since that hook would write to the real repo's git config;
    - `tsc --noEmit` on the kit;
    - `bun test --parallel packages/kit`, under a scratch `HOME` and `TMPDIR`.
- **Spellbook** at `e592924b`: `src/scriptorium` (written **S/**), `src/kit`,
  and the SKILL and acc under `plugins/spellbook/skills/scriptorium/` (written
  **SK/**).
- **Two read-only research agents.**
  - One inventoried the Story-specific code and the kit's import graph.
  - The other compared the wire, the CLI, the manifests, the wiki layer and the
    kept features.
- **Claims re-checked by hand:**
  - the exclusion list in `K/workspace/layers.test.ts:1-49`;
  - the shell's `localStorage` (`K/shell/WorkspaceShell.tsx:24,166,342,394`);
  - Scriptorium masking only HTML comments (`S/backend/links.ts:115-126`);
  - the kit's restore reading `tasks` unguarded (`K/workspace/session.ts:881`);
  - the absence of `notesWaiting` from the kit.
- **Not run:** no daemon of either app, and nothing against a real home folder.

## Findings

### 1. The port base

#### 1a. Nothing at `027d7a3` depends on the new workspace model

_Confidence: high._

**The history.**

- `git log fd06b41..5e5ffed -- packages/kit` lists eleven commits. `027d7a3` is
  the earliest of them.
- Story Studio's cycle doc says the order was on purpose: "Spellbook is
  re-basing on this kit, so its fixes come back first, before the kit's core
  moves" (`docs/cycles/2026-10-workspaces.md`, at `5e5ffed`).
- So `027d7a3` is `fd06b41` plus the links and tail port-back, and nothing else.
- No file of the model exists at `027d7a3`:
  - `copyIn.ts` is created by `6b3d943`;
  - `provenance.ts` is created by `6b3d943`;
  - `sharing.ts` is created by `bc88014`;
  - `workspaceChange.ts` and `workspaceTop.test.ts` are created by `a8776ab`;
  - `folderDrop.ts` and `copyInRules.ts` are created by `7afe5d9`.

**The earlier piece the model built on.** That piece is
`kit-workspace-set-overlap` (Story Studio `8696830`, before `fd06b41`). It is
E71, and it is present and tested at `027d7a3`:

| E71 part                                                      | At `027d7a3`                                                                                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open <folder>` makes the containing folder the workspace     | `defaultWorkspace`, K/workspace/verbs.ts:272 (steps out of every opened folder)                                                                                                         |
| Fallback at home or `/`                                       | the same function returns `undefined`, which means the session's own `imported/` (`IMPORTED_DIR`, K/workspace/session.ts:454)                                                           |
| `workspace <inside a set>` refused                            | `setWorkspace`, K/workspace/session.ts:967 (`overlapOf`, defined at :585)                                                                                                               |
| A saved overlapping session opens, and `doctor` names the fix | restore at session.ts:829-838; finding `workspace.overlap` at K/workspace/doctor.ts:38,136; said once per session (`overlapToSay`); tests in `structure.test.ts:236-320`                |
| Undo back to an overlapping workspace                         | **Moot.** The kit records no undo for a workspace change (`case "workspace.set": return null`, K/workspace/history.ts:198). Scriptorium does record one (S/backend/history.ts:169-174). |

`a8776ab` is the commit that removes this: "The step-out rule, imported/ and the
manifest default are gone." Porting from `027d7a3` keeps E71's behaviour exactly
as Story Studio first built it.

One E71 difference needs a ruling. In the kit, setting the workspace cannot be
undone; in Scriptorium today it can. This was not in E71's list.

#### 1b. The other later kit commits

Each commit was applied in order on `027d7a3` (kit paths only). The whole stack
then typechecked and passed **2,619 tests, 0 fail**.

| Commit                                     | What it is                                                                                                        | Modules touched                                                         | Applies on `027d7a3`?                                                                 | Take?                                                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `55df89e`                                  | Holds the quadratic image-in-label test to 10,000 characters (`kit-links-image-label-quadratic`, in triage there) | workspace (test only)                                                   | Yes, alone                                                                            | **Take.** It is a CI guard on the extractor we keep. The quadratic cost itself is unfixed in both repos.                                                                                                        |
| `d7ef948`                                  | "New set" at the root, "New folder" inside a set                                                                  | workspace (`history`, `server`, `session`) + context (`ContextSidebar`) | Yes, alone                                                                            | **Take.** It is generic, and Scriptorium has "sets" too. Split it: the workspace half in cycle 1, the context half in cycle 3.                                                                                  |
| `a538a2e`                                  | Two CI races made to hold                                                                                         | workspace (`images.guards.test`) + context (`daemonClient.test`)        | Yes, alone                                                                            | **Take,** split by module the same way.                                                                                                                                                                         |
| `0ff5698`                                  | A pending edit is sent before a version switch                                                                    | context (`daemonClient`) + document (`DocumentPane`)                    | **Only after `a538a2e`.** Its `daemonClient.test.ts` hunk sits on `a538a2e`'s change. | **Take,** in cycles 3 and 4. It is a data-loss fix (typed text landing in the wrong version). Its follow-up, `kit-agent-activate-pending-edit` (Story Studio triage), is the agent-side half and is still open. |
| `5b87ad0` (kit half)                       | The `hooks.followMove` daemon hook (an app follows a rename or move, with undo)                                   | workspace (`history`, `server`, `index`)                                | **Only after `d7ef948`.** It conflicts alone at `server.ts:1910` (`madeSet`).         | **Take, optional.** It is a generic, opt-in slot and inert unless set. Scriptorium has no use for it yet. Taking it keeps `server.ts` closer to Story Studio's for later picks.                                 |
| `7afe5d9`, `6b3d943`, `a8776ab`, `bc88014` | The workspace model                                                                                               | —                                                                       | —                                                                                     | **Do not take** (ruled). `bc88014` also changes `wire/discovery.ts` (+87) for shared workspaces; that goes with it.                                                                                             |

**The cost of the ruling, measured.** Non-test changes to the kit from `027d7a3`
to `5e5ffed`:

| Module    | Lines changed (+/−)                                     |
| --------- | ------------------------------------------------------- |
| workspace | +2,996 / −423 (`session.ts` +1,213, `server.ts` +1,085) |
| context   | +533 / −80                                              |
| shell     | +283 / −4                                               |
| lib       | +164 / −0                                               |
| wire      | +87 / −1                                                |
| document  | +5 / −6                                                 |
| chat      | none                                                    |

The feature counts on "later Story Studio fixes port nearly as they are". That
still holds for chat, document and most of shell. For the daemon (`session.ts`,
`server.ts`) it is now weak: future Story Studio daemon fixes will often need
porting by hand. The ruling made this choice; it is recorded here as a cost.

#### 1c. Story-specific code at `027d7a3`, and what to do with it

_Confidence: high on location, medium on the line counts, which are grep and
method-range estimates, not trial deletions._

**Two items on the feature's out-of-scope list are not in the kit at all.**

- **World and impact check.** `_world.json` appears only as a reserved name in a
  comment (`K/workspace/profiles.ts:16`). There is no impact report in the kit.
  `6b3d943`'s "impact report's mixed names" is Atlas code.
- **Media Forge.** It appears only as the `generated` source's provenance fields
  on image sidecars (`K/lib/sidecar.ts:44-79`).

| Item                                                                                                          | Where                                                                                                                                                                                                                                                                                                                                                                                   | Verdict                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cues/` (244 lines)                                                                                           | Its own subpath. None of the five modules imports it (`K/cues/index.ts:1`).                                                                                                                                                                                                                                                                                                             | **Cut.** Do not port it.                                                                                                                                                                                                                                                                                                                                                             |
| `pushLoop` / `pushWithHandoff`                                                                                | `K/wire/pushLoop.ts`, `wire/tailHandoff.ts:422-518`. The workspace module uses only `tailWithHandoff` (`K/workspace/verbs.ts:53-59`).                                                                                                                                                                                                                                                   | **Already cut.** Spellbook's `src/kit/wire` has no `pushLoop`.                                                                                                                                                                                                                                                                                                                       |
| `generated` image provenance (Media Forge)                                                                    | `K/lib/sidecar.ts:44-79`; `ui/ImageDescription.tsx:94-110`; `image.describe --source`                                                                                                                                                                                                                                                                                                   | **Cut** the `generated` source (about 40 lines), or make the provenance table an app option. Image description sidecars themselves are generic: **keep**.                                                                                                                                                                                                                            |
| Bundles                                                                                                       | `K/lib/bundles.ts` (371), `workspace/testing.ts` (224). Spread inline through `session.ts` (about 300 lines), `tree.ts`, `protocol.ts`, `server.ts`, `EntryTree`, `ContextSidebar`, `DocumentPane`, `WorkspaceShell`.                                                                                                                                                                   | **Keep for the port.** It is already a slot: an opt-in registry (`registerBundleType`, `lib/bundles.ts:166`), dead code with no type registered. Cutting it would remove about 1,600–1,900 source lines, but the edits are spread inline through `session.ts`. That would be the riskiest edit of the port, and it would widen the gap from Story Studio. Revisit after the re-base. |
| Document profiles and relations (`_meta/profiles/`, `_relations.json`)                                        | `K/workspace/profiles.ts` (821), `relations.ts` (383), `session.ts:5429-5820`, `document/ProfileChip.tsx`, `profileHeader.ts`, `LinkPicker`                                                                                                                                                                                                                                             | **Keep.** The feature turns profiles on in Scriptorium. They are inert without a `_meta/profiles/` folder. Where the schemas live is still the feature's open question.                                                                                                                                                                                                              |
| `STORY_STUDIO_TAIL_WINDOW_MS`, `STORY_STUDIO_SURFACE_MODE`                                                    | `K/wire/tailHandoff.ts:67,308`, `wire/serveDist.ts:27`, `workspace/fixtures/tailRig.ts:83`                                                                                                                                                                                                                                                                                              | **Already renamed** in Spellbook's wire (`SPELLBOOK_*`). The fixture follows.                                                                                                                                                                                                                                                                                                        |
| `story-studio` names                                                                                          | Header `x-story-studio-not-presence` (`K/workspace/heartbeat.ts:54`); MIME type `application/x-story-studio-rows+json` (`context/rowDrag.ts:18`); `story-studio:view-mode` (`document/pane.ts:16`, already a prop); `storageKey = "story-studio"` (`shell/WorkspaceShell.tsx:342`, a prop); `story-studio:panes:open` (`shell/columns.ts:50`, prefixed **twice**); `story-studio:theme` | **Rename** in each module's cycle. Derive from the app name, or use a `spellbook:` prefix. Fix the double prefix rather than copy it.                                                                                                                                                                                                                                                |
| Atlas-motivated daemon hooks (`messageAbout`, `beforeKitAct`, `rewriteHeld`, `beforeClose`, `onSurfaceClose`) | `K/workspace/server.ts:530-594`                                                                                                                                                                                                                                                                                                                                                         | **Keep.** They are generic, optional slots.                                                                                                                                                                                                                                                                                                                                          |
| Hard-coded app names (atlas, stage, canvas, Dreamwood)                                                        | Comments and fixtures only. No string literals in code.                                                                                                                                                                                                                                                                                                                                 | **Rewrite the comments.** The fixtures go with the tests they serve.                                                                                                                                                                                                                                                                                                                 |

**What the workspace port brings beyond the five modules.**

- The rest of `lib`: markdown, `markdownCode`, headings, `headingAnchor`,
  `linkTarget`, `docFormat`, `json`, `sidecar`, `imageImport`, `fuzzy`,
  `relationUse`, `bundles`, about 2.5k lines. The foundation took only `cn` and
  `storage`.
- `wire/stdinPeek`, as the feature anticipated.
- The workspace imports `cli/registry` (`K/workspace/verbs.ts:40`), which is
  already ported.

**What the imports allow** (all checked):

- Every surface-to-daemon import is `import type`: 43 of them.
- The daemon layer (workspace, lib, wire, cli) imports no surface code.
- `chat` and `context` do not import each other.
- `document` imports both.
- `shell` imports chat and context but **not** document. The app passes the
  document pane in as `centre`.

### 2. The split

#### 2a. Daemon or panes first: the daemon, and not by swapping

_Confidence: high._

**The two wires differ on every frame.**

- Scriptorium discriminates frames on `type` (S/backend/protocol.ts:514-732);
  the kit uses `op` (K/workspace/protocol.ts:1506,1635,1734).
- Times are milliseconds in Scriptorium and ISO strings in the kit.
- `ChatMessage{who, selection, activePath, note}` (S protocol.ts:331) becomes
  `Message{from, type, about}` (K protocol.ts:308-338).
- Tasks, versions and notes are reshaped.
- `structure.done{op}` becomes `{of}`.
- `graph` becomes `link.graph`, with another shape.
- About 15 kit ops have no Scriptorium implementation, among them:
  - the `link.*` family;
  - `profile`;
  - `trash`;
  - `relink`;
  - `task.create` and `task.cancel`;
  - `doc.close`.

So each of the four options is:

| Option                                                                                                                                                                                                             | What it costs                                                                                                                                                                                                                                                                        | Verdict                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| **Panes first**: kit panes over Scriptorium's daemon                                                                                                                                                               | Scriptorium's daemon would have to speak the kit's whole protocol, including about 15 ops it does not implement. That rebuilds the kit's daemon inside Scriptorium in order to throw it away.                                                                                        | Rejected                   |
| **Daemon first, in place, with a surface shim**: Scriptorium's backend becomes the kit daemon, and `useDaemon.ts` (298 lines; about 43 `send(` calls in `App.tsx`) translates kit frames into Scriptorium's shapes | The shim translates every frame and state field: times, tasks, versions, notes, `about`. All of it is thrown away when the panes arrive. Each cycle then breaks and re-fixes the one Scriptorium that works.                                                                         | Workable, but the riskiest |
| **Daemon first, as a second Scriptorium behind a flag** (dual path)                                                                                                                                                | The kit-based Scriptorium grows cycle by cycle, reached with `SCRIPTORIUM_KIT=1`, beside the shipped one, which nobody touches. There is no shim; each cycle adds real code to the final shape. The cost is two Scriptoriums in the tree for four cycles, and a final cutover cycle. | **Recommended**            |
| **Everything at once**                                                                                                                                                                                             | About 44k lines and the wiki layer in one cycle.                                                                                                                                                                                                                                     | Rejected (big-bang)        |

The dual path was ruled out by the original "ship every cycle" rule only in
spirit: shipped code would carry a dormant second app. Cole's easing removes
that objection. Each cycle still keeps the gate and acc green, and the shipped
Scriptorium is never broken during development. The flagged path is driven by
its own tests and its own acc run.

**How the flag works.** It must not add a second launcher. Scriptorium's
launchers say "ADD NO LOGIC" (`SK/scripts/cli.ts`), and the build and roster
wards key off them.

- `S/backend/cli.ts` and `server.ts` read `SCRIPTORIUM_KIT` and hand off to the
  kit-based entry points, which are bundled into the same `dist/`.
- The kit path keeps its sessions in a **separate root**, for example
  `$SCRIPTORIUM_HOME/kit/sessions`, until the cutover. Both apps write
  `format: 1` manifests that the other would misread (finding 3h).

#### 2b. The cycles

The feature's port order holds:

- the workspace daemon first;
- then chat and context;
- then document;
- then shell.

The wiki layer and the session migration sit between the daemon and the panes.
Line counts are Story Studio source at `027d7a3`, without tests; the tests come
with each port and are about the same size.

| #   | Cycle                                | What the kit gains                                                                                                                                                                                                                                                                 | What the flagged Scriptorium switches to                                                                                                                                                                                                              | What stays the shipped Scriptorium's                           | Size                                                                                         |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **The workspace daemon in the kit**  | `src/kit/workspace` (from `027d7a3` + `55df89e` + the workspace halves of `d7ef948` and `a538a2e` + `5b87ad0`'s hook), the rest of `lib`, and `wire/stdinPeek`. E65's daemon half. Spellbook's `wire` names. A manifest discriminator. A differential test of the links extractor. | A daemon and a CLI on `createWorkspaceDaemon` / `createWorkspaceCli`, behind the flag, with no surface and no wiki layer. The agent's `message` carries `about`.                                                                                      | Everything users see                                           | About 21.5k + 2.5k ported (mechanical), plus about 0.5–1k new. **Large**, mostly mechanical. |
| 2   | **The wiki layer on the kit daemon** | The daemon-side missing slots (finding 3a): extra link edges, a tree-scan filter, set promotion, and a whole-manifest migrate.                                                                                                                                                     | App verbs: `meta`, `meta-init`, `meta-set`, `find`, `hide`, `unhide`, `make-set`, `move.plan`, `forget`, `note-edit`, `note-remove`, `info`. `docMeta` in `appState`. Trust tier and `stale`. The session migration, dry-run against copied sessions. | Everything users see                                           | About 2–3k moved or adapted from S/backend. **Medium.**                                      |
| 3   | **Chat and context panes**           | `src/kit/chat` and `src/kit/context`, with the context halves of `d7ef948`, `a538a2e` and `0ff5698`. E65's surface half. The chip stores and labels an app's `about` parts. `entryIds` gets a gesture or is removed. A pre-move confirm slot.                                      | A surface: a thin interim frame (about 150 lines, thrown away in cycle 5) holding `ContextSidebar`, `ChatSidebar`, Notes and Tasks. Hide, `set.make` and the move plan go in through `menuActions` and the confirm slot.                              | Everything users see                                           | 1.9k + 4.7k ported. **Medium.**                                                              |
| 4   | **The document pane**                | `src/kit/document`, with `0ff5698`'s `DocumentPane` half                                                                                                                                                                                                                           | `DocumentPane` as the centre. Trust through `frontmatterTrust`/`frontmatterChips`, shown only where `verified` exists (E69). The map as `appView`: `MapOverlay` + `forceLayout`, re-fed from `LinkGraph`. Profiles on, without `_world.json`.         | Everything users see                                           | 8.9k ported, plus about 0.7k of map moved. **Medium–large.**                                 |
| 5   | **The shell, and the cutover**       | `src/kit/shell`, with a storage adapter slot and the floating composer (finding 3c)                                                                                                                                                                                                | `WorkspaceShell` replaces the interim frame. **The flag flips to default.** Sessions migrate. The SKILL and acc move to the kit shape. `dist` is rebuilt.                                                                                             | Nothing: S/backend and S/surface (about 20k lines) are deleted | 3.3k ported, plus the composer and the deletions. **Medium.** Then the Atlas comparison.     |

**Alternatives inside the split:**

- **Shell before document.** Shell does not import document, so cycles 4 and 5
  could swap. The swap removes the interim frame but delays the centre. Keep the
  feature's order: E64's floating composer docks at the foot of the document
  pane, and the comparison wants the whole layout. The swap is a fallback if the
  interim frame proves costly.
- **Cycles 1 and 2 merged.** That would be about 25k lines with the riskiest
  seam (links) inside. Keep them apart. Cycle 1's own consumer, the flagged
  daemon, satisfies the "a foundation that has already been used" pattern the
  first cycle followed.
- **The workspace port in two cycles.** Not recommended. `session.ts` (6,826
  lines) and `server.ts` (4,335) are single classes and closures, so a partial
  port means carving them. The port's own tests (about 22.6k lines) are the bar,
  and they come whole.

### 3. The seams

#### 3a. The wiki layer against the four extension points

The extension points at `027d7a3`:

- **The app declaration:**
  `AppDeclaration{name, title?, slot:{version, migrate}, launcher?}`
  (K/workspace/session.ts:468-481).
- **`WorkspaceDaemonOptions`** (K/workspace/server.ts:478-623):
  - `runners`, `verbs` (`"<app>.<name>"`), `events`, `messageHint`, `appState`
    and `http`;
  - `hooks.{beforeVersionDelete, afterVersionDelete, onSurfaceClose, messageAbout, beforeKitAct, rewriteHeld, beforeClose}`;
  - with `WorkspaceCliOptions.commands` (K/workspace/verbs.ts:370) on the CLI
    side.
- **`WorkspaceShellProps`** (K/shell/WorkspaceShell.tsx:138-170): `centre`,
  `toolbar`, `menuActions`, `status`, `panels`, `badges`, `rowMarker`,
  `folderBadges`, `onShowDiff`, `storageKey` and `messageActions`.
- **`DocumentPaneSlots`** (K/document/DocumentPane.tsx:229-276):
  `rawExtensions`, `rawTokens`, `inlineWidgets`, `frontmatterChips`,
  `frontmatterTrust`, `versionDeleteWarnings`, `linkedFromAction`, `appView` and
  `formatViews`.

The kit names what it left out on purpose. Its `layers.test.ts:1-49` excludes
"links, frontmatter, the map, move plans, the workspace and hide model" from the
editor it was ported from. Links, search, profiles and relations were later
re-admitted by name.

| Wiki-layer piece                                          | In Scriptorium                                                                                                              | In the kit                                                                                                                                                                        | Where it plugs in                                                                                                                | Missing                                                                                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Link extraction**, backlinks, dangling links, the graph | S/backend/links.ts (815; `extractLinks` 262-394, `buildGraph` 597-815)                                                      | **Native.** K/workspace/links.ts (1,223; `extractLinks`/`readLinks` 539-710) on `K/lib/markdownCode.ts`'s `maskCode`. Also `link-check`, shared names, `linkGraph` and relink.    | Nothing: Scriptorium's copy goes                                                                                                 | Frontmatter-reference edges (`fieldRefs`/`looksLikeRef`, S links.ts:396-460). The kit has none, and there is **no slot for extra edges** in its link cache or graph. |
| **Trust tiers** (`verified`, `stale`)                     | S/backend/frontmatter.ts:65-81 (`trustTier`, `isStale`); `docMeta` on every snapshot; `MetaHeader.tsx`                      | Header only: `K/document/frontmatter.ts:84-96` through the `frontmatterTrust`/`frontmatterChips` slots                                                                            | `DocumentPane` slots for the header. `appState` for the sidebar's per-document meta. `rowMarker`/`badges` for the tree.          | None (all within existing slots)                                                                                                                                     |
| **`meta`, `meta-init`, `meta-set`, `find`**               | S/backend/session.ts:2047-2499 (about 450 lines, graph and backlinks included). The handlers are in `server.ts`.            | None                                                                                                                                                                              | `verbs` + CLI `commands`; `docMeta` in `appState`; the "add frontmatter" affordance through `toolbar`/`menuActions` or `appView` | None                                                                                                                                                                 |
| **`move.plan`**                                           | S/backend/session.ts:1532-1547; `useDaemon.ts:77,126,226`; `ContextSidebar.tsx:270`                                         | None. The kit's sidebar moves directly: `onStructure({op:"move"})`, K/context/ContextSidebar.tsx:290.                                                                             | The plan as a verb                                                                                                               | **A pre-move confirm on the surface.** `beforeKitAct` can refuse a move but cannot ask the human.                                                                    |
| **`hide` / `unhide`**                                     | S/backend/session.ts:1605-1676, 1868-1887; `ContextEntry.hidden` (S protocol.ts:52)                                         | None. Excluded on purpose; the kit's removal is `trash`, the human's alone (E68).                                                                                                 | The menus through `menuActions`; the state in `appState` or the app slot                                                         | **A tree-scan filter.** The mirror scan (`rescan`) is internal to the session.                                                                                       |
| **`set.make`**                                            | S/backend/session.ts:1888-1917 (switches an entry from listed to mirrored and keeps its id)                                 | None                                                                                                                                                                              | A verb plus `menuActions`                                                                                                        | **A session API that promotes an entry and keeps its id**                                                                                                            |
| **The map**                                               | `S/surface/components/context/MapOverlay.tsx` (512) + `forceLayout.ts` (125); data from `graphFor` (S session.ts:2162-2216) | Data native (`link.graph`, `graph` with focus, hops, rel, kind and within). Drawing it is the app's job, as Atlas does in `apps/atlas/surface/map/MapPane.tsx` through `appView`. | `DocumentPane.appView` (K/document/DocumentPane.tsx:262-270, 321-332), re-fed from `LinkGraph`                                   | None                                                                                                                                                                 |

**Two more missing slots, not part of the wiki layer:**

- **A whole-manifest migrate.** See 3h.
- **A shell storage adapter.** `WorkspaceShell` keeps its layout in
  `localStorage` (K/shell/WorkspaceShell.tsx:24,394). Scriptorium keeps it in
  the daemon's prefs on purpose, because every session gets a new port, and so a
  new origin (S protocol.ts:378-384). On the kit shell as it is, Scriptorium's
  layout would reset on every `open`.

**Each missing slot is a change to the kit's shared behaviour.** Each should be
built so it can go back to Story Studio through `kit-port-back-from-spellbook`,
as the prior-direction write-up asked of every evolution.

#### 3b. E53, the message waiting mark: comes across whole

_Confidence: high._

- `K/workspace/waiting.ts:53-98` matches Scriptorium's `waitingOn`
  (S/backend/waiting.ts:59-105), and adds `acknowledged`.
- The nudge (K server.ts, from 4189) has the same shape:
  `{message_id, seconds, text?, hint}`.
- The `working` snooze is there too.
- `K/chat/WaitingBadge.tsx` adds an `unheard` state driven by `agentListening`,
  which is a gain.

#### 3c. E64, the floating composer: not in Story Studio

_Confidence: high._

- Story Studio's `kit-floating-composer` is `status: draft, lifecycle: backlog`
  at `5e5ffed`. It has not landed.
- At `027d7a3`, a collapsed chat column becomes a 40 px rail with a reopen
  button and an unread dot (`K/shell/columns.ts:53-57`, `shell/rail.ts`). There
  is no composer. That breaks E64's ⛔ rule: talking to the agent must never
  need the column.
- Reader mode (`K/document/reader.ts`) and split room (`document/pane.ts:34-41`)
  are present.
- **For cycle 5:** if `kit-floating-composer` has still not landed, port
  Scriptorium's composer into the kit shell
  (S/surface/components/ChatComposer.tsx:15-119, `App.tsx:830-847,1103-1147`,
  with the draft lifted to one owner as E64 rules) and offer it back to Story
  Studio.
- Ask Story Studio's agent on `kit-parity` before cycle 5 starts, so the two
  versions are not built twice.

#### 3d. E65, the note waiting mark: about a third is present

_Confidence: high on what is present and what is missing._

**Present at `027d7a3`:**

- `NOTE_TEXT_MAX` and `noteEventFacts` (K/workspace/waiting.ts:107-151);
- `note.added` carrying the passage, the body and the lines, or
  `passage: "gone"`;
- `about.noteId` on `say`, with a note-specific hint;
- the chat label "a note" (`K/chat/ChatMessageView.tsx:67`).

**Missing:**

- `notesWaiting` in state. The attention key covers messages only (K
  waiting.ts:96).
- `askedIn`.
- The one-ask-at-a-time `say` guard (S/backend/server.ts:718-751).
- The note fields `editedAt/editedBy` and `reopenedAt/reopenedBy`. The kit's
  note has only `resolvedAt`.
- A human edit that wakes the agent with the note's facts. The kit emits
  `system{fact:"note.edited"}` with none.
- The notes panel's badge and "Ask the agent" (`K/chat/NotesPanel.tsx` has no
  `waiting`/`onAsk` props).
- The tab dot, the per-document "owed" lines, and the floating composer's note
  line.

**How it is carried:**

- The daemon half goes in cycle 1. The surface half goes in cycles 3 and 5; the
  composer line needs the composer.
- Story Studio has it as `kit-per-note-waiting` (backlog). Its cycle doc parks
  that item, and `kit-message-via-refs`, "until Spellbook's port reaches the
  chat layer".
- So Spellbook builds E65 first, in the shape Story Studio can take back.

#### 3e. The links-cycle extraction: confirmed in `027d7a3`, with one ruled divergence and seven smaller ones

_Confidence: high on the code reading. The differences have not been run as
tests._

`027d7a3` ported Spellbook's links fixes:

- the renderer's parser;
- no links inside code, code spans, escapes or comments;
- a link around an image counts by its outer target;
- rename rewrites exactly each target's span;
- folder links and dotted names;
- `ctime` in cache stamps;
- plus the tail's `closedBy` and the `ended` record.

**The divergence Story Studio's user ruled on.** The kit masks **all** raw HTML
(`maskCode(body, {html: true})`, K/workspace/links.ts:515;
`lib/markdownCode.ts:182-198`). Scriptorium masks only HTML that opens a comment
(S/backend/links.ts:115-126). Scriptorium's own renderer escapes raw HTML
(`S/surface/state/markdown.ts:5`). So today Scriptorium counts links that its
own view shows as text, and the kit's rule is the more consistent of the two.
**Recommend adopting the kit's rule**, as a ruling for Cole, not a silent
change.

**Other differences** (from the comparison agent; each needs a test either way):

1. Image embeds count as links in the kit (`embed: true`). Scriptorium drops
   them.
2. Line numbers count from the top of the file in the kit, and from the start of
   the body in Scriptorium. SK/SKILL.md:253-255 documents Scriptorium's split.
3. Any `word:` prefix is a scheme in Scriptorium. The kit's `linkScheme` treats
   `Chapter2:intro.md` as a path (`K/lib/linkTarget.ts:77-83`).
4. Same-page `#x` anchors are kept as `fragments` in the kit and dropped in
   Scriptorium.
5. Wiki raw text is trimmed in the kit and not in Scriptorium.
6. Frontmatter-reference edges exist only in Scriptorium. This one needs the
   extra-edges slot.
7. Resolution states are renamed: `in-bundle` becomes `in-context`, and
   `not-a-doc` is new.

**The bar.** The feature asks for one extractor, with the links-cycle tests as
the bar. That extractor is now the kit's. Run Scriptorium's `links.test.ts` (922
lines) against it as a differential test in cycle 1. Each failure becomes either
a ruled divergence (like the HTML one) or a fix. The foundation cycle's lesson
applies: ported code that interprets input needs a differential test against the
base, not fixes made shape by shape.

#### 3f. E71: already in the kit

See 1a.

- Settled: the fallback (`imported/` inside the session) and pre-existing
  overlaps (they open, and `doctor` names the fix).
- The undo question becomes a different one: the kit cannot undo a workspace
  change at all. Cole should rule whether Scriptorium keeps E24/E60's undo of
  it. If it does, that is one more change to shared kit behaviour.

#### 3g. `tailHandoff`'s `by`: identical

- `closedBy`/`goneBy` and the "the human ended it, do not reopen" hint match in
  Spellbook's `src/kit/wire/tailHandoff.ts` and the kit's.
- The kit's workspace calls `tailWithHandoff` with the field named `app`.
  Spellbook's wire kept `spell`, along with the error envelope's `server` key.
- So cycle 1 adapts `K/workspace/verbs.ts`'s calls to Spellbook's wire. It does
  not adapt the wire.

#### 3h. Sessions under `~/.scriptorium`, and the migration

_Confidence: high on the shapes. The kit's behaviour on a Scriptorium manifest
was read, not run._

- **Both manifests are `format: 1`**: S/backend/session.ts:104 and
  K/workspace/session.ts:234.
- **The version-file layout is the same**: `docs/<slug>/v<n><ext>`.
- **The kit's restore does not refuse a Scriptorium manifest.** It checks only
  the format and the session id (K session.ts:810-818), then:
  - it reads `s.m.tasks` unguarded at :881, so it throws on an older manifest
    that has no `tasks`;
  - it silently misreads one that has them: `who`/`from`, millisecond and ISO
    times, `author`.
- **The reverse is true too:** Scriptorium would accept a kit manifest.
- **The `app` key is the one reliable discriminator.** Cycle 1 should make
  Spellbook's kit refuse a manifest without `app`, or bump `MANIFEST_FORMAT`.

**The migration the feature names cannot work.** The app slot's `version` and
`migrate` (K session.ts:468-471; `migrateSlot` at 6660) migrate **only `app`**.
What has to change is the core manifest:

- times from milliseconds to ISO;
- chat `who` to `from`, plus `type`, plus `about`;
- tasks: `text` to `title`, `who` to `by`, and the status mapping;
- versions: `author` to `by`, and `from` to `fromVersion`;
- notes: `who` to `by`, and the E65 fields once the kit has them;
- `context[].hidden`, which moves to the app slot.

The kit has no hook that runs before restore. So cycle 2 adds one of these:

- a whole-manifest migrate hook (for example
  `AppDeclaration.migrateManifest(raw)`, run before the format check);
- or a one-shot converter in Scriptorium's CLI, run at the cutover.

Prefer the hook. It is lazy, per session, and testable. Keep the sessions root
at `$SCRIPTORIUM_HOME/sessions` after the cutover, so the version files never
move. Prefs (`$SCRIPTORIUM_HOME/prefs.json`) sit where the kit expects them,
`dirname(sessionsRoot)/prefs.json` (K server.ts, around 811).

#### 3i. The SKILL and acc

- **acc needs almost nothing for the `about` change.** `SK/acc.config.json` is
  only `{"defaultOutput":"json"}`, and `acc.recorded-surfaces.json` records
  usage-error probes, not event fields.
- **The CLI's surface does change.**
  - `dangling` becomes `link-check`.
  - `graph --entry` takes the kit's options.
  - New verbs arrive: `show`, `relink`, `describe-image`, `profiles`, `profile`,
    `relations`, `reveal`, `task-cancel`.
  - `task-remove` and `tasks-clear` have no kit equivalent; `task-cancel` means
    something else.
  - So acc's census must be re-run for the flagged CLI from cycle 1, and for the
    default at cycle 5.
- **SKILL passages that change:**
  - 147-149 and 189: what a `message` carries, which becomes `about`.
  - 199-200: `note.edited` and `note.reopened` become a `system` fact and
    `note.resolved{resolved:false}`, unless the E65 merge keeps Scriptorium's
    events. **Recommend keeping them.**
  - 233-238: the note ask becomes `about.noteId`, with no `doc` field.
  - 246-258 and 310: the wiki verbs, and link lines counted from the body.
  - The shipped SKILL changes only at the cutover. The flagged path's
    differences are recorded in each cycle's items until then.

## Recommendation

- [x] **File work items**, in a feature that already exists (Workspace Kit).

**The port base:** `027d7a3`, plus `55df89e`, `d7ef948`, `a538a2e`, `0ff5698`
and the kit half of `5b87ad0`.

- Apply them in that commit order.
- Split each by module, so each lands in the cycle that ports its module.
- None of them needs the new workspace model.
- E71 comes with the base.

**The split:** five cycles, daemon first, on a flagged second Scriptorium. It
uses Cole's eased constraint where it lowers risk:

- The shipped Scriptorium is never edited until the cutover.
- No translation shim is written and then thrown away.
- Every cycle's work is code in its final shape.

The price is two Scriptoriums in the tree for four cycles and a cutover cycle at
the end. The new path is driven by its own tests and its own acc for four cycles
before that, so the cutover is a switch, not a big-bang.

**When to reconsider:** if Cole wants Scriptorium itself to show the kit's gains
before the stack is done, the in-place shim is the only route. Price it as about
300–600 lines of throwaway translation per cycle.

### Cycle 1: the workspace daemon in the kit

**Appetite:**

- Stop when the flagged Scriptorium daemon and CLI run on `src/kit/workspace`
  with E65's daemon half, and the gate and acc are green on the branch.
- Anything that needs the surface or the wiki layer is filed for cycles 2–3.

Items to file, each `parent: feature/workspace-kit`, `kind: task`. The first is
the one the rest depend on.

1. **`kit-port-workspace`: port the workspace daemon into the kit**
   - Bring Story Studio's `workspace` module, at `027d7a3` plus the workspace
     halves of `55df89e`, `d7ef948`, `a538a2e` and the kit half of `5b87ad0`,
     into `src/kit/workspace`. Bring with it the rest of `lib` it imports and
     `wire/stdinPeek`.
   - **Done when:**
     - [ ] its tests pass under Spellbook's gate, with a scratch `HOME` enforced
           for every test (the stand-in home arrived only in `a8776ab`);
     - [ ] `cues`, `pushLoop` and the `generated` image provenance are not
           ported;
     - [ ] no `STORY_STUDIO_*` or `story-studio` name remains;
     - [ ] calls into `wire` use Spellbook's names (`spell`, `server`,
           `SPELLBOOK_*`);
     - [ ] the import-boundary, strict-parse, origin and spawn-path wards pass
           without being loosened;
     - [ ] Tailwind does not scan the kit's test files (a foundation-cycle
           finding);
     - [ ] E71's tests (`structure.test.ts`'s overlap block, and
           `defaultWorkspace`) pass.
2. **`kit-workspace-manifest-guard`: the kit refuses a manifest that is not its
   own**
   - A manifest without `app`, or of another format, is refused with a hint,
     never misread.
   - **Done when:**
     - [ ] a Scriptorium manifest (`format: 1`, no `app`, with and without
           `tasks`) is refused with a 409 and a hint, by a test;
     - [ ] the kit's own manifests still restore.
3. **`kit-links-differential`: one extractor, held to Scriptorium's links
   tests**
   - Run S/backend/links.test.ts's cases against the kit's `extractLinks` and
     `resolveTarget` equivalents. Each difference becomes a ruling or a fix.
   - **Done when:**
     - [ ] a differential test exists;
     - [ ] each of the eight differences (3e) is either matched or listed for
           Cole with a recommendation, the HTML rule among them;
     - [ ] the quadratic image-in-label case is filed if it is not already
           tracked here.
4. **`kit-workspace-e65-daemon`: a note shows that it is with the agent, on the
   daemon**
   - E65's daemon half in the kit:
     - `notesWaiting`, `askedIn` and the one-ask `say` guard;
     - `editedBy`, `reopenedAt` and `reopenedBy`;
     - a human edit or reopen carrying the note's facts;
     - the shared `badgeFor`.
   - Written to go back to Story Studio as `kit-per-note-waiting`.
   - **Done when:**
     - [ ] E65's rules hold, by tests ported from S/backend/waiting.test.ts and
           the server's note tests:
       - two notes then one reply clears both;
       - a human rewrite or reopen re-arms;
       - a double ask sends one message;
       - the state survives a restore;
     - [ ] `PublicState.notesWaiting` exists;
     - [ ] Story Studio's agent has been offered the diff on `kit-parity`.
5. **`scriptorium-on-kit-daemon`: the flagged Scriptorium daemon and CLI**
   - With `SCRIPTORIUM_KIT=1`, Scriptorium's CLI and daemon run on
     `createWorkspaceDaemon` and `createWorkspaceCli`:
     - with an app declaration (`scriptorium`, slot version 1);
     - with sessions under `$SCRIPTORIUM_HOME/kit/sessions`;
     - with no surface and no wiki layer yet.
   - **Done when:**
     - [ ] the launchers are unchanged; the hand-off is in S/backend;
     - [ ] with the flag, `open`, `add`, `say`, `note`, `tail`, `version-new`,
           `close` and `doctor` work, by an integration test under a scratch
           `HOME`;
     - [ ] the tail's `message` carries `about`;
     - [ ] acc's census is conformant for the flagged CLI, and for the default;
     - [ ] without the flag, Scriptorium is byte-for-byte the shipped one: its
           tests pass unchanged;
     - [ ] the SKILL delta for the kit path is recorded in this item, not in the
           shipped SKILL.

**Size:** about 24k source lines ported, mostly mechanically, with about 23k
lines of tests. About 1k lines new. This is bigger than the foundation cycle
(about 8.7k). Run it as the foundation ran, with an implementer per item and a
no-stake verifier. Run item 1 first, then 2–4 in parallel, then 5.

### Risks for cycle 1

1. **Tests touching the real home.**
   - Before `a8776ab`, Story Studio's kit tests had no stand-in home, and
     `defaultWorkspace` reads `homedir()`.
   - A ported test can write into `~` (a foundation-cycle verifier already made
     a stray grapevine channel this way).
   - _Mitigation:_ a test preload that sets a scratch `HOME`, and a ward or
     check that fails when one is not set.
2. **The cross-format misread** (3h). Until item 2 lands, a kit daemon pointed
   at `~/.scriptorium/sessions` could misread a real session.
   - _Mitigation:_ the separate sessions root in item 5, and item 2 before
     item 5.
3. **Wards against 24k lines.**
   - The import boundary: `lib/bundles.ts` imports `type ReactNode` from react
     on the daemon side.
   - Also strict-parse counts, spawn paths, and surface-build mode for a
     surface-less daemon.
   - Each break is a finding to rule on, never a ward loosened quietly.
4. **The links seam.** The differential test may find more than the eight known
   differences. That is the feature's named riskiest seam.
   - _Mitigation:_ run item 3 early, and treat its rulings as Cole's.
5. **Divergence from Story Studio starts here.** E65 and the manifest guard
   change the daemon. Measured, the daemon is where Story Studio has already
   moved most (+2,996 lines since `027d7a3`).
   - _Mitigation:_ write each change as a port-back, and offer it on
     `kit-parity` when it lands.
6. **Size and attention.** It is the largest single port in the feature.
   - _Mitigation:_ the appetite line above, and item 1 split into implementer
     passes by area (session and server, links and profiles, images, verbs) if
     its verifier asks.

## Next Steps

1. The lead files cycle 1's five items and the cycle document from the list
   above. Cole approves them.
2. **Rulings to ask Cole for**, best before cycle 1 starts:
   - the HTML rule for links (recommend the kit's: mask all raw HTML);
   - whether Scriptorium keeps an undo for setting the workspace (the kit has
     none);
   - whether Scriptorium's `note.edited` and `note.reopened` events stay as they
     are (recommend yes, as part of the E65 merge);
   - `SCRIPTORIUM_KIT` and a separate sessions root as the dual path's
     mechanism.
3. On `kit-parity`, tell Story Studio's agent the port base and the picks, and
   ask about `kit-floating-composer`'s timing before cycle 5.
4. The item's definition-of-done line "the next cycle is drafted from the
   ruling" is met by the cycle 1 section above, once the lead files it.

## Open Questions

- **Should profiles and relations be cut** instead of kept latent? That is a
  product call. They are about 2,300 source lines in the workspace module, and
  the feature turns profiles on.
- **Where profile schemas live** (`_meta/profiles/`) is still the feature's open
  question. Cycle 4 needs the answer.
- **Atlas's three unchecked items** (`kit-watcher-missed-write-macos`,
  `ended-session-recovery`, `kit-surface-csp`). Check them against the ported
  code in cycles 1 and 5, as the feature says.

### What I could not determine

- **How the kit's restore behaves on a real Scriptorium manifest.** It was read
  (session.ts:881 throws without `tasks`), not run.
- **Exact line counts for cutting** bundles, profiles and the `generated`
  provenance. These are grep estimates, not trial deletions.
- **How the agent experiences the `about` shape.** That needs cycle 1's flagged
  path and an acc run.
- **Whether `kit-agent-activate-pending-edit`** (Story Studio triage, the
  agent's own `activate` losing typed text) also affects Scriptorium today. I
  did not check.

### Sources

- Story Studio, read-only:
  - `packages/kit/src` at `027d7a3`;
  - the commits `55df89e`, `d7ef948`, `a538a2e`, `0ff5698`, `5b87ad0`,
    `a8776ab`, `6b3d943`, `7afe5d9` and `bc88014`;
  - `docs/cycles/2026-10-workspaces.md` and the items `kit-floating-composer`,
    `kit-per-note-waiting`, `kit-message-via-refs` and
    `kit-port-back-from-spellbook` at `5e5ffed`.
- Spellbook:
  - [Workspace Kit](../../features/workspace-kit/feature.md);
  - [Kit foundation](../../cycles/2026-10-kit-foundation.md) and
    [its session](../../features/workspace-kit/sessions/2026-10-13-kit-foundation.md);
  - [the prior-direction write-up](../workspace-kit-prior-direction/write-up.md);
  - [Message via and refs](../message-via-and-refs.md);
  - [Scriptorium's decision log](../scriptorium/decision-log.md), E53, E64, E65,
    E67 and E71;
  - `src/scriptorium` and `src/kit` at `e592924b`;
  - `plugins/spellbook/skills/scriptorium/` (the SKILL, acc and launchers).

---

**Related Documents:**

- [How to port the workspace stack](./item.md)
- [Workspace Kit](../../features/workspace-kit/feature.md)
- [Where our messaging and context direction meets Story Studio's kit](../workspace-kit-prior-direction/write-up.md)
- [Message via and refs](../message-via-and-refs.md)
- [Scriptorium decision log](../scriptorium/decision-log.md)
