---
type: item
title:
  "Scriptorium on the kit: no default workspace; new files go where you point"
description:
  "Scriptorium on the kit drops the hidden default workspace: a new file or
  folder goes into the selected document's set or folder, asks for a location
  (last one preselected) when nothing is selected, and the agent names where it
  creates; the opening folder becomes an ordinary added folder."
status: stable
lifecycle: done
id: 01a14606-4a31-7535-9dbd-5f19712c490c
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium, workspace]
parent: feature/workspace-kit
cycle: 2026-10-wiki-layer
---

# Scriptorium on the kit: no default workspace; new files go where you point

Scriptorium has a default workspace today. A file or folder created at the root
of the tree is saved there, beside folders added from anywhere else. Two things
go wrong:

- **The name.** "Workspace" says the tree's contents live there, and most of
  them don't. It is only a default save location.
- **Nobody chose it.** It is set by wherever the agent opened the session, not
  by you. The sidebar's workspace picker does show it, but quietly, so it's easy
  to lose track of where new files will land.

Cole ruled this on 2026-10-16, from his braindump
`fragments/scriptorium-default-workspace.md` in the Spellbook Operator workspace
and the discussion that followed.

**The rule:**

- **With a selection,** a new file or folder goes beside or inside the selected
  document or folder.
- **With nothing selected,** Scriptorium asks for a location, with the last one
  used already selected.
- **The agent** names where it creates a file, or puts it beside the document
  being discussed. Where the session was opened decides nothing.
- **The folder the session opened in** becomes an ordinary added folder in the
  tree, not a hidden destination.

**What follows from it:**

- Turning a document into a set (`make-set`), and creating a folder at a
  location you pick, are how you make room for new files.
- The kit path does not need undo for setting the workspace.
- When shipped sessions are converted at the cutover, the old default workspace
  becomes an ordinary added folder.

## Definition of done

- [x] The kit's app declaration can say an app has no home workspace, and
      Scriptorium on the kit declares none. Story Studio's model is unchanged.
- [x] On the kit path, no verb or daemon command writes a new file or folder to
      a destination the caller did not name or select. A create with no location
      is refused, and the refusal says how to name one.
- [x] The session's opening folder appears in the tree as an ordinary added
      folder.
- [x] The agent's create verbs take a location, and the SKILL delta says the
      agent names it or uses the document under discussion.
- [x] The surface's "ask for a location, last one preselected" behaviour is
      recorded as a requirement for the panes cycle. It is not built here.
- [x] The session converter's item records that the old default workspace
      becomes an added folder.

## Requirement for the panes cycle: ask for a location

Recorded here for cycle 3 (the panes). Nothing of it is built in this cycle.

- **With a selection,** New File and New Folder create beside the selected
  document, or inside the selected folder or set. They do not ask.
- **With nothing selected,** the surface asks where to create. It offers the
  session's sets and the folders inside them, with the last location used
  already selected, so creating several files in a row is one confirm each.
- **The last location** is remembered for the session. If it is gone or no
  longer in the tree, nothing is preselected and the human picks one.
- **A drop on the context list** with no set or folder under it asks the same
  way. It never lands in a hidden folder.
- **Making room:** the same dialog offers "new folder at a path" (the daemon's
  `folder.add`, a new set anywhere) and points to `make-set` for a document.
- **The daemon already refuses** a create, import or drop that names no place
  (400, with the app's hint), so the surface must send a `dir` on every
  `doc.create`, `folder.create`, `bundle.create` and `import`. A surface that
  forgets one gets that refusal, never a file in a default folder.

## Done and verified

Commits on `impl/scriptorium-no-default-workspace`:

- `c079f872` **kit slot.** `AppDeclaration.homeWorkspace: false`, with an
  optional `locationHint` (the app's own words for naming a place;
  `src/kit/workspace/noHome.ts`). With it, the session keeps no workspace
  folder, every write that names no place (or a place outside every set) is
  refused 400 with the hint, `workspace.set` is refused, the set overlap no
  longer applies, and the snapshot and handshake carry no `workspace`. The CLI
  drops the `workspace` verb, gives `import` a required `--into`, and `open`
  with no paths adds the folder it ran in. An app that says nothing is
  byte-identical: the fixture CLI's help and refusals were compared before and
  after, and every kit test passes unchanged.
- `1b812f32` **Scriptorium on it.** The kit path declares no home workspace. The
  converter stops writing a `workspace`. The kit census drops `workspace` and
  re-records `import`.

Deliberate choices:

- **`open` with no paths** adds the folder it ran in as an ordinary set, which
  the human sees and can remove. It does not when that folder is the home folder
  or above it, the top of the disk, or among the sessions' own folders; then the
  session opens empty and the answer's `note` says why. **`open` with paths**
  adds only those paths. The caller pointed, and "where the session was opened
  decides nothing". Adding the folder it ran in too would mirror, say, a whole
  repository around one document. Cole confirmed this reading on 2026-10-17, to
  be revisited if it feels wrong in real use.
- **The `workspace` verb is removed, not answered.** The ruling takes away the
  concept along with the default. A verb that printed "there is no workspace"
  would keep the name in the help and teach it to every agent that reads it.
  Calling it now gets the CLI's unknown-command refusal, which lists the verbs.
- **A refusal, not a fallback.** A create outside every set is refused even when
  the folder exists on disk. `add-folder <path>` and `add <folder>` are how a
  new place is made, so the session always shows where its files went.
- **`version-new --doc <path>`** already needed a document that exists in the
  context. It never creates a file, so it needed no change.

A fix round after a no-stake verification, in one commit on
`impl/scriptorium-no-default-workspace-fix` ("no destination by default on any
route; the opening folder never holds the sessions"):

- **`/cmd` no longer resolves a path against the daemon's cwd.** The daemon's
  cwd is the folder `open` ran in, which nobody named. So an empty or relative
  `dir`, `into` or `path` on a structure op is refused
  (`"" is not a full path: start it with / or ~/`), as the surface's socket
  already refused it. `~/` still expands. This is applied for every app, not
  only those with no home workspace. The kit's CLI resolves a relative path in
  the agent's own directory before it posts, so no CLI verb changes. A test runs
  `new-doc` from a folder other than the one `open` ran in, and the document
  lands in the agent's folder.
- **A create with no `dir`** (`doc.create`, `folder.create`, `bundle.create`) is
  refused 400 with the app's location hint on both routes. Over the socket, it
  used to fail with a raw Node error. The socket's `error` frame now carries a
  `hint` whenever the refusal has one.
- **`open` never adds a folder that holds the sessions.** It skips a folder that
  holds the sessions root or lies inside it. It also skips the app's own home or
  any folder inside it (`WorkspaceCliOptions.appHome`, which is
  `$SCRIPTORIUM_HOME` for Scriptorium). All of these are compared by realpath.
  The check lives in one place (`notAddedWhole`, `noHome.ts`).
- **A kit session saved with a workspace keeps its files.** On restore, an app
  with no home workspace adds the stored workspace folder as an ordinary set
  when that folder holds files, and the chat says so once (`workspace.added`).
  This is what the converter does with `c-workspace`. The folder is not added
  when it is the session's own `imported/`, lies among the sessions, is empty,
  is gone, or is already shown by a set.
