---
type: item
title: A kit whole-manifest migrate hook, and Scriptorium's session converter
description:
  Add a hook that rewrites a whole manifest before restore, and Scriptorium's
  converter for shipped sessions, dry-run against copies of real sessions.
status: stable
lifecycle: ready
id: 01a1478f-34ad-7712-b515-b36144069584
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
cycle: 2026-10-wiki-layer
parent: feature/workspace-kit
---

# A kit whole-manifest migrate hook, and Scriptorium's session converter

At the cutover, the kit must open the sessions the shipped Scriptorium wrote.
The kit's app-slot migrate only rewrites the app's own slot, and the core
manifest differs
([write-up, 3h](../items/workspace-stack-port-shape/write-up.md#3h-sessions-under-scriptorium-and-the-migration)):

- times in milliseconds, not ISO;
- chat `who`, not `from`, with no `type` or `about`;
- tasks with `text`, `who` and other statuses;
- versions with `author` and `from`;
- notes with `who`;
- `context[].hidden`, which moves to the app slot.

The write-up prefers a hook that runs before restore, so each session migrates
lazily and the version files never move. Story Studio has no migration of its
own, so the hook is offered back but not needed there.

## Definition of done

- [x] The kit's app declaration can supply a whole-manifest migrate, run before
      the format check. A manifest it can't convert is refused with the reason
      and left unwritten.
- [x] Scriptorium supplies a converter for every manifest shape the shipped app
      has written, with a test per shape.
- [x] The old default workspace becomes an ordinary added folder, as
      [scriptorium-no-default-workspace](./scriptorium-no-default-workspace.md)
      requires.
- [x] A dry run against copies of Cole's real sessions, made under a scratch
      home, converts every one, and each restores on the flagged daemon. Any
      that can't convert are listed with the reason. The real `~/.scriptorium`
      is only read.
- [x] The converter stays off the default path until the cutover.

## Done and verified

There are four commits on `impl/kit-manifest-migrate-hook-2`, rebased onto
`cycle/wiki-layer` after `kit-set-promotion` and `kit-tree-scan-filter` landed
there: the kit hook (d0d643b2), Scriptorium's converter (ed2a27ce), this doc
(897a524c), and a fix round on top (the real-home guard by any spelling, the
slot at its current version, and the ask only for a human).

- **The hook.**
  `AppDeclaration.migrateManifest(raw, {sessionId, dir, sessionsRoot})` returns
  `{manifest, note?}`, or null when there is nothing to do.
  `WorkspaceSession.restore` runs it on the parsed manifest, before the format
  check and the foreign-manifest guard (`src/kit/workspace/manifestMigrate.ts`).
  - A throw refuses the restore (409, "could not be converted … Nothing was
    changed"), and nothing is written.
  - What the hook returns then passes every check a stored manifest does.
  - A conversion is persisted once, and the bytes it replaced are kept as
    `manifest.pre-migrate.json`. The daemon says so in the chat (system fact
    `manifest.migrated`).
  - Version files never move.
- **Every shape.** `git log -p` on the shipped `session.ts` and `protocol.ts`
  shows one manifest whose optional parts arrived over time:
  - `admitted` (1f328241);
  - `workspace` and `context[].hidden` (923ee09a);
  - `nextVersion` (e2a756e6);
  - `notes` (8c5d5e9a), and their `editedAt` (38a378e1);
  - `tasks` (c810d3dd);
  - E65's `editedBy`, `reopenedAt`, `reopenedBy` and `chat[].note` (e9c219c0,
    8a65c39d);
  - `ended` (56929d27).

  `src/scriptorium/backend/kit/convert.ts` has the field map. `convert.test.ts`
  has a test per shape, and one for a manifest the shipped `Session` writes
  today.

- **Deliberate choices.**
  - The old workspace becomes a mirrored entry, `c-workspace`. It is left out,
    and the chat line says why, when the manifest has none (the shipped app then
    used the home folder), when it is the home folder, when it is gone, or when
    a set already shows it.
  - `workspace` becomes the session's own `imported/`, so nothing writes to a
    folder nobody chose.
  - `hidden` moves to `app.hidden[<entry id>]`, the key the tree-scan filter
    reads.
  - The app slot is written at the app's current version
    (`scriptoriumApp.slot.version`, 2 since the tree-scan filter), never a fixed
    number. So the same restore has no slot migrate to run, and the chat gets
    one conversion line and no `slot.migrated` line (tested in process and
    through the launchers).
  - A task with a step is `running`, and the step becomes its `detail`.
  - An E65 ask becomes `via: "ask"` with `about.noteId`, for a human's message
    only. An agent's or the system's message naming a note keeps `about.noteId`
    and gets no `via`.
  - `nextVersion` is set past every version file on disk.
  - A second conversion, of an old manifest put back by hand, keeps the bytes it
    replaced.
- **Off until the cutover.** The converter runs only when
  `SCRIPTORIUM_KIT_MIGRATE=1` is set alongside `SCRIPTORIUM_KIT=1`.
  - That one flag turns the converter on and also points the kit path at the
    shipped root (`$SCRIPTORIUM_HOME/sessions`), so the two can never happen
    apart.
  - A rule like "convert what is under the shipped root" would never fire,
    because the kit path never reads that root.
  - The flag is refused unless `SCRIPTORIUM_HOME` is set and is not
    `~/.scriptorium`. This matters because a converted manifest is the kit's,
    and the shipped daemon refuses it.
  - "Not `~/.scriptorium`" holds by any spelling. The real home is found apart
    from `HOME` too (`accountHome()` in `src/kit/lib/home.ts`, the account's
    home from the user database), and paths are compared as the disk resolves
    them (the realpath of the nearest folder that exists). So it refuses a moved
    `HOME` with the real path spelled out, a `SCRIPTORIUM_HOME` that is a
    symlink to the real one, and a scratch home whose `sessions` is a symlink to
    the real sessions or into them. `app.test.ts` covers each route against a
    fake real home it builds itself; it never points at the real one. A symlink
    to a real session folder planted _inside_ a scratch `sessions` is not
    checked.
  - Without the flag, the kit path still refuses a shipped manifest.
  - The cutover drops the flag and the home check.
- **Dry run, 2026-10-16.** The real `~/.scriptorium/sessions` (54 sessions) was
  copied read-only into a scratch home.
  - **Converted in process:** 54 of 54. Of the old workspaces, 51 became added
    folders, 2 were already shown, and 1 was gone.
  - **Restored on the flagged daemon:** 54 of 54, through the launchers with a
    scratch `HOME`, `SCRIPTORIUM_HOME` and `TMPDIR`. Each was closed by its own
    id, and none was left running.
  - **Results:** every manifest is now the kit's, every original was kept byte
    for byte, every version file is unchanged, and every chat carries the
    conversion line.
  - **Refused:** none. Nothing in `~/.scriptorium` was written.
  - The dry run ran before the fix round and was not re-run on it.
