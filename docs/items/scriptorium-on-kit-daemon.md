---
type: item
title: A flagged Scriptorium daemon and CLI on the kit
description:
  With SCRIPTORIUM_KIT=1, Scriptorium's CLI and daemon run on the kit's
  workspace daemon with their own sessions root, beside the shipped Scriptorium.
status: stable
lifecycle: done
id: 01a1393e-adb9-73df-aa57-15a8422d444f
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [scriptorium, kit]
cycle: 2026-10-workspace-daemon
parent: feature/workspace-kit
blocked_by:
  [01a1393e-aab6-7627-8b3c-f7785e244373, 01a1393e-ab7a-76ef-b520-5fd5ea18f624]
from: items/workspace-stack-port-shape/write-up.md
---

# A flagged Scriptorium daemon and CLI on the kit

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s workspace-stack
port ([the port-shape write-up](./workspace-stack-port-shape/write-up.md)).
**Ruled (Cole, 2026-10-14):** a second Scriptorium is built on the kit and runs
side by side with the shipped one, until the cutover cycle. Nothing is released
until the whole stack is done.

With `SCRIPTORIUM_KIT=1`, Scriptorium's CLI and daemon run on
`createWorkspaceDaemon` and `createWorkspaceCli`:

- with an app declaration (`scriptorium`, slot version 1);
- with sessions under `$SCRIPTORIUM_HOME/kit/sessions`;
- with no surface and no wiki layer yet.

Scriptorium keeps its undo for setting the workspace for now (Cole). The kit has
none, so on this path it becomes a seam for a later cycle.

**Done and verified (2026-10-14).** The flag is `SCRIPTORIUM_KIT`, and only the
exact value `1` turns it on. The code lives in `src/scriptorium/backend/kit/`:

- `app.ts`: the flag, the homes, and the `scriptorium` declaration at slot
  version 1.
- `cli.ts`: `createWorkspaceCli`.
- `server.ts`: `createWorkspaceDaemon`, plus a "no surface yet" page at `/`.

`backend/cli.ts` and `backend/server.ts` hand off to it when the flag is set.
The launchers are byte-unchanged, and the kit daemon is spawned through the same
`scripts/server.ts`, with the flag set in its environment.

Kit sessions, logs and prefs live under `$SCRIPTORIUM_HOME/kit/`, with pointers
named `scriptorium.<id>.json`; the shipped ones are named
`scriptorium-<id>.json`. A no-stake verifier checked three passes by running
them:

- Cross-talk is refused both ways.
- Each restore refuses the other's manifest without writing anything.
- The default path's help, verbs, scripted tail and boot errors are
  byte-identical to the base.
- acc is conformant for both CLIs.
- Cole's real `~/.scriptorium` was untouched.

**One change to shipped code:** `Session.restore` refuses a kit manifest (one
with `appName`, or a non-numeric `createdAt`) with a 409, and its hint now
reaches the `open` envelope. A read-only scan of Cole's 51 real manifests found
none it would refuse.

**Kit changes made here, offered to Story Studio:**

- `AppDeclaration.refuseScriptorium`: an app's own words for the
  Scriptorium-shape refusal.
- The kit's under-test guards (`homeDir()`'s scratch-home refusal and the Trash
  fallback) now read `NODE_ENV` at runtime. Before, the build folded them away.

**The kit census** is in
`src/scriptorium/backend/kit/acc.recorded-surfaces.json`. To make it:

1. With the flag set, run `bun scripts/cli.ts schema > kit-decl.json`.
2. Run
   `bunx acc probe-plan scripts/cli.ts --declaration kit-decl.json --out kit-capture.sh`.
3. Run `sh kit-capture.sh -o <batch>` with `SCRIPTORIUM_KIT=1` under a scratch
   home.

It is kept outside the skill folder, because the acc ward passes the folder's
batch to the default CLI. `acc.test.ts` fails the gate if a verb is added or
removed. A changed flag goes unnoticed; that is filed as
[acc-census-flag-staleness](./acc-census-flag-staleness.md).

### SKILL delta for the kit path

Not yet in the shipped SKILL. It goes in at the cutover.

- **Shipped only:**
  - `dangling`.
- **The same as shipped**
  ([scriptorium-kit-wiki-verbs](./scriptorium-kit-wiki-verbs.md)):
  - `meta`, `meta-init`, `meta-set`, `find`, `forget` and `note-remove` give the
    same answers, refusals and chat lines for the same world. Two refusals
    differ in punctuation: the kit's "no document is open: name one with --doc"
    where shipped has a dash.
  - `meta`, `meta-init` and `meta-set` read the file on disk. `meta-set` writes
    the file. An open document with no unsaved edits reloads it, and one whose
    active version differs is marked changed outside, as shipped.
  - `meta` and `find` cover what the kit's context shows: `.json` documents are
    included (no frontmatter), and `.mdx` files are not shown.
- **Kit only:**
  - `show`, `task-cancel`, `relink`, `reveal`;
  - `describe-image`, `image-settings`;
  - `link-check` (in place of `dangling`);
  - `profiles`, `profile`, `profile-check`, `relations`;
  - `note-edit`;
  - `add-folder <path>`: an empty folder at a path you name, anywhere on disk
    whose parent exists. Outside every set it is a new set in the context (its
    `entry` and `set: true` are printed); where a set shows folders, a folder
    there.
  - `move-plan <path> <into>`: what `move` would do, and it writes nothing. It
    prints the shipped plan (`from`, `into`, `name`, `folder`, `docs`, `repo`,
    `leavesRepo`), plus `to`, and `links`: the links the move would break, by
    document, each with the rewrite `move --update-links` would offer. `wiki`
    lists wiki links it would break, which are never rewritten. `edges` lists
    the frontmatter references it would break (`kind`, `source`, `key`, `raw`),
    which are reported, never rewritten; `checked` counts them with the links.
    `references` counts board references, which are not judged. It refuses what
    `move` refuses. `docs` counts the documents the context shows under the
    item; shipped counted the markdown files on disk.
  - `move --update-links` also prints `edges`: the frontmatter references the
    move broke, as `move-plan` lists them. They are not rewritten.
- **Changed:**
  - `task-remove` and `tasks-clear` are thin verbs on the kit's own removal, and
    they are built, not mapped: `task-cancel` ends a task, it does not forget
    it. The kit's rule holds. Only a finished task (done, failed or cancelled)
    can be removed, so `task-remove` on an open or running one is refused with
    "cancel it before removing it", where shipped removed it. To remove a task
    started by mistake, run `task-cancel` and then `task-remove`. `tasks-clear`
    clears done, failed and cancelled tasks.
  - `info` prints the kit's pointer (`url`, `port`, `session_id`, `dir`, `pid`),
    where shipped has `home` and `mode` in place of `pid`.
  - `make-set` is the kit's `set.make`. It keeps the entry's id as before, and
    is undoable from the context's arrows (the document goes back, listed by the
    same entry). It prints `broken`, the links the move into the folder broke,
    each with the target that lands; it does not rewrite them, and `relink` does
    not apply to it.
- **Flags:**
  - `tail` adds `--all`;
  - `task` adds `--parent`;
  - `task-done` adds `--failed`;
  - `move` and `rename` add `--update-links`;
  - `import` requires `--into` (see "No default workspace" below);
  - `graph` takes
    `--bundles --edge --focus --hops --kind --kindless --limit --rel --untyped --within`
    in place of `--entry`;
  - `backlinks` takes `--doc` in place of a positional, and `--edge`;
  - `link-check` takes `--edge`.
- **No default workspace**
  ([scriptorium-no-default-workspace](./scriptorium-no-default-workspace.md)):
  - You name where every new file or folder goes. Use the folder of the document
    under discussion when there is one; otherwise name a place inside a set
    (`state` lists them). Where the session was opened decides nothing.
  - `new-doc <path>` and `new-folder <path>` create at that path, which must be
    inside a set or a folder in one. Anywhere else is refused (`usage`, exit 2),
    and the hint says how to name a place.
  - `import <file> --into <folder>`: `--into` is required. Without it the verb
    is refused before anything is read; there is no default folder.
  - `version-new --doc <path>` takes a document that exists in the session (it
    is opened if it is not open yet). It never creates a file.
  - To make a new place: `add-folder <path>` (anywhere whose parent exists, as a
    new set), `make-set <doc>`, or `add <folder>` for a folder that exists.
  - `open` with no paths adds the folder it ran in as an ordinary set, which
    shows in `entries` (not your home folder or above it: then nothing is added,
    and `note` says so). Given paths, those are the session, and the folder it
    ran in is not added. The handshake and `state` carry no `workspace`.
  - **Shipped only:** `workspace`. It is gone, not answered: there is no
    workspace to print or set. The daemon refuses `workspace.set` (400).
- **Frontmatter references** (kit-link-edges-slot):
  - They are edges of kind `frontmatter`, read by the shipped rule (any key, by
    shape). `--edge a,b` keeps those edge kinds on `graph`, `backlinks` and
    `link-check`; `link` names the body links.
  - `backlinks` lists them under `edges` (`edge`, `raw`, `key`, `rel`), counted
    in `edgeCount`, where the shipped verb says `related` (`path`, `title`,
    `key`). The body links stay in `backlinks`, where the shipped verb says
    `links`.
  - `graph` marks each one `edge: "frontmatter"` and counts both kinds in
    `edgeKinds`; the shipped `source: "frontmatter"` and `source: "link"` go.
  - `link-check` reports a reference nothing answers under `edges` (`raw`,
    `key`, `tried`), counted in `count`, where the shipped `dangling` says
    `source: "frontmatter"`.
  - Wiki forms resolve as in the shipped Scriptorium (a `type/slug` key, a bare
    name, a path from the repo root), after the kit's own lookup.
- **Wire:**
  - A `message` carries `about` (`doc`, `version`, `path`, `fromLine`, `toLine`,
    `text`, `noteId`) in place of `selection`, `activePath` and `note`.
  - A `message` always carries `via`, the gesture that sent it: `chat` when
    typed, `describe`, `fix` or `ask` for a button. Tell a typed question from a
    pressed button by it.
  - `about.refs` lists what the message draws on beside its one subject (`path`,
    and `doc`, `version`, `role`, `label`, `text` when given). Each is a
    document or image in the context, never the subject, at most 50.
    `about.docs` is no longer written.
  - A `message` carries `warning` when the page's `via`, refs or named subject
    were not taken as sent (dropped refs, an unknown value).
  - `say` takes `--via`. Leave it out for your own messages; a button's value is
    stored, with a warning on stderr.
  - Chat uses `from` in place of `who`, and times are ISO strings.
  - `version.created` and `note.added` are events.
  - `make-set` and `add-folder` are `set.make` and `folder.add` system facts,
    each carrying the `entry` id.
  - A human edit is a `note.edited` system fact, and a reopen is
    `note.resolved{false}`.
  - `note-edit` keeps `replacedBody` for the human to put back.
  - `--version` adds `path: "kit"`.
  - Each document's frontmatter summary is `appState.docMeta` (by path: `type`,
    `title`, `status`, `tags`, `lifecycle`, the trust tier `trust` and `stale`),
    with `appState.docMetaTruncated` past 500 documents. Shipped has them as
    `docMeta` and `docMetaTruncated` at the top of the state.
  - The move plan is the daemon op `scriptorium.move.plan` (`path`, `into`). A
    page that sends it gets a `scriptorium.move.plan` frame with `plan`; shipped
    answered `move.plan`.
  - `meta-init`, `meta-set`, `forget` and `note-remove` post the shipped
    `system` facts (`meta.init`, `meta.set`, `doc.forgotten`, `note.removed`).
  - What `hide` left out is `appState.hidden` (rels by entry id) in the state,
    not `hidden` on each context entry. `hide` and `unhide` answer with the
    shipped fields and the kit's `ok: true`; the chat line is a `system` fact
    `hide` or `unhide`. Undo of a whole-entry hide brings back the same entry id
    (shipped re-adds it under a new one), and a redo's chat line repeats the
    act's label ("You redid: removed solo.md from the context.").
  - `hide` takes a document out of Scriptorium's views, but it is not a
    confidentiality boundary: a document opened before it was hidden keeps its
    notes and versions.
  - The app verbs (`hide`, `meta`, `meta-init`, `meta-set`, `move-plan`) take a
    full path or one from `~/` on `/cmd` and the socket, as the kit's own ops
    do; a relative one is refused.
  - `meta-set`, `meta-init`, `describe-image` and `relink` never write a file
    among the sessions or in `$SCRIPTORIUM_HOME`, even where a set shows it (an
    old manifest's set, a link in an added folder): the verb is refused (409),
    and `relink` lists such a document in `skipped`.
- **The ask:** `via: "ask"` with `about: { noteId }` (there is no `about.ask`).
  A second ask while the note is owed gets an error frame for its `rid`. Only a
  human's ask counts; any other `via` naming the note is a typed follow-up, and
  always goes.
- **Converted sessions**
  ([kit-manifest-migrate-hook](./kit-manifest-migrate-hook.md)): a session the
  shipped Scriptorium wrote opens on the kit path converted, and its first chat
  line says so and where the old manifest is kept (`manifest.pre-migrate.json`,
  system fact `manifest.migrated`). Its old workspace is an ordinary added
  folder: name where a new file goes. Its tasks read `open`, `running` (the old
  step is `detail`) or `done`. Until the cutover this happens only under
  `SCRIPTORIUM_KIT_MIGRATE=1` on a scratch copy; the SKILL says nothing about
  the flag.
- **From 85a319e's SKILL for Atlas:** say that a note shows it is with the agent
  until the agent replies, resolves it, or rewrites it with `note-edit`, and
  that a human rewrite asks again.

### Seams for later cycles

- **No workspace undo on the kit path** (Cole: the shipped path keeps it).
- **No surface.** `/` is a placeholder page. Revisit the spawn-path ward's
  opaque `serveFromDist` row once the kit path passes `surface.distDir`.
  `launcher` is unset in the declaration.
- **No wiki layer:** `meta`, `find`, `hide`, `make-set`, `forget` and `info`
  (cycle 2).
- **No migration.** The kit path can't open shipped sessions until the cutover.
- **Bundle size.** `dist/server.js` grew from 1.67 MB to 4.6 MB, and
  `dist/cli.js` from 413 KB to 1.58 MB. `--version` takes 22 ms against 19 ms.
- **The manifest guards go by shape only.** A hand-forged manifest can pass
  either side.
- **At the cutover:** anyone with `NODE_ENV=test` exported and a real `HOME`
  (for example, running inside Vitest) gets a loud refusal from `open`.
- **The spawn-path ward's `FAMILY_CALL`** misses a member-expression argument,
  such as `serveFromDist(opts.x, …)`. This predates the cycle.

## Definition of done

- [x] The launchers are unchanged; the hand-off lives in
      `src/scriptorium/backend`.
- [x] With the flag, `open`, `add`, `say`, `note`, `tail`, `version-new`,
      `close` and `doctor` work, by an integration test under a scratch `HOME`.
- [x] The tail's `message` carries `about`.
- [x] acc's census is conformant for the flagged CLI and for the default one.
- [x] Without the flag, Scriptorium is byte-for-byte the shipped one: its tests
      pass unchanged.
- [x] The SKILL delta for the kit path is recorded in this item, not in the
      shipped SKILL.

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
