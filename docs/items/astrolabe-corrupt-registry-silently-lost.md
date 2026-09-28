---
type: item
title: A corrupt astrolabe registry is read as empty and then overwritten
description:
  A corrupt registry.json boots the daemon empty and its next save overwrites
  the file, so the registry is lost with no word; cold refusals say unknown
  project with empty choices.
status: draft
lifecycle: triage
id: 01a0e711-ee2e-76c4-a20b-9017891d4e5e
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
cycle: 2026-09-data-you-cant-get-back
---

# A corrupt astrolabe registry is read as empty and then overwritten

Found by the no-stake verifier of
[cycle/2026-09-one-act-one-answer](../cycles/2026-09-one-act-one-answer.md),
2026-09-28, on `a7c041d3`, under a scratch `HOME`; filed, not chased. Its
scripts were `t1.sh`–`t9.sh` in that session's scratchpad (not kept).

Tried: invalid JSON, `{"projects":"x"}`, and `registry.json` as a directory.

- **The CLI (new this cycle):** a cold refusal says `unknown project 'beta'`
  with `choices: []`, and never mentions that the registry could not be read.
- **The daemon (older):** it boots empty from a corrupt file, and its next save
  overwrites the file, so every registered project is lost without a word.

A registry that can't be read is not the same thing as an empty one. The likely
fix is to refuse or warn with the file's path, and not to overwrite a file the
daemon could not parse (move it aside first). An invalid single entry is already
dropped consistently by both sides; that part is fine.

## Fixed (2026-09-28)

Reproduced as filed first, through the shipped launcher on a scratch
`ASTROLABE_HOME`, for invalid JSON, `{"projects":"x"}` and a directory: the cold
`status alpha hi` exited 2 with "unknown project" and `choices: []`, and `open`
booted with no file set aside.

"Unreadable" now means: the file can't be read (a directory, permissions), it
isn't JSON, or it isn't the shape the daemon writes (an object whose `projects`
is an array). The check is `registryShapeError` in `scripts/state.ts`, beside
`restoreRegistry`. The disk half is new, in
`src/astrolabe/backend/registryFile.ts` (`readRegistry`, `setAside`,
`listSetAside`, `recoverAct`), and both the daemon and the CLI call it, so the
two can't disagree about what's readable.

- **The daemon's boot moves it aside before anything can save.** It renames the
  file (or directory) to `registry.json.unreadable-<ISO time>` and starts an
  empty board. It's a rename, so the bytes aren't touched. If the rename fails,
  the daemon exits 1 instead of booting, because an empty board saved over bytes
  it couldn't read is the one outcome ruled out.
- **The cold CLI refuses instead of guessing.** `add` and every verb naming an
  id are refused as `conflict` (exit 6) with the file's path and the reason. The
  hint names two ways forward: fix the file, or `open` to set it aside. The CLI
  doesn't move the file itself. A refused call touches nothing, and `open` is
  the one act that sets the file aside.
- **While a set-aside file exists, every answer reports it.** This is re-read
  from the directory on every call. There's no "already told" flag. A success
  prints one `# warning:` line on stderr. An unknown-project refusal, cold or
  warm, says the registry was set aside, where, and that the id may be in it,
  and its hint gives the recovery. `info`, `state` and `list` carry
  `registry_set_aside: [{path, recover}]`, and a healthy registry's answers are
  unchanged.
- **The recovery, as the notice words it:** `close` first (the daemon saves on
  close), fix the JSON in the set-aside file, move it back to `registry.json`
  (this replaces anything registered since), then `open`. Or delete the file to
  keep the current board. No command was built for this. A candidate is
  `astrolabe registry restore <file>`: refuse while a daemon is up, validate
  with `readRegistry`, and move the file back. It's worth building only if real
  use shows that hand recovery gets done wrong.

Tests (`plugins/spellbook/skills/astrolabe/scripts/cli.test.ts`,
`an unreadable registry is set aside, never lost`). The first two run for each
of invalid JSON, the wrong shape, and a directory:

- `…: the cold CLI refuses (conflict, exit 6), starts nothing and moves nothing`
- `…: the daemon's boot sets it aside, and the bytes survive a later save` (this
  one also covers the warm unknown-project notice, the `info`/`state`/`list`
  field, the cold notice after `close`, and the notice going away once the file
  is deleted)
- `a valid registry behaves exactly as before: nothing moved, nothing warned`

Run red first: 6 failed, and the valid-registry case passed.

The error-choices census pin for astrolabe moved 16/2 → 17/2. The new site is
the cold `conflict` refusal, which has no closed set in hand. The golden
snapshot didn't change.

**Follow-up, same day:** the warm path no longer recognises the daemon's
"unknown project" refusal by its text. The daemon's reply carries
`reason: "unknown-project"` and `project: "<id>"`, and the CLI reads those
(`refusalWords` in `src/astrolabe/backend/cli.ts`, tested with a reworded
message).

**Follow-ups from the no-stake verifier, same day:**

- **A rename that fails is reported at once, with its reason.** When the daemon
  couldn't set the file aside (a read-only directory, or `chflags uchg` on the
  file), it exited 1 as designed, but `open` waited the full 45 s and then said
  only "astrolabe daemon failed to start within 45s": the spawn ignored the
  daemon's stderr. Now the spawn points the daemon's stderr at a per-spawn file
  in the OS temp dir, watches for the process exiting, and stops waiting the
  moment it does. `open` then fails as `internal`, exit 1, with the daemon's own
  words: the file couldn't be read (why), couldn't be set aside (the OS error),
  and its bytes were left in place. The hint says what makes the rename
  possible. The daemon's JSON line rides along verbatim under `error.server`.
  It's a file, not a pipe, because a pipe outlives the CLI inside the detached
  daemon. It's in the temp dir, not `$ASTROLABE_HOME`, because an unwritable
  home is one of the failures being reported. The file is deleted once read. Any
  other early exit gets the same treatment: a bind error carries its own
  `message`, and a crash is quoted from its stderr tail (`startFailure` in
  `src/astrolabe/backend/cli.ts`). A daemon that stays up but can't write its
  port file (a read-only home with a readable registry) still waits out the 45
  s. That case doesn't exit, and it's out of this item's scope.
- **The recovery is worded by cause.** It used to say "fix the JSON" for a valid
  registry at mode 000 and for a directory. `readRegistry` now returns a `cause`
  (`json`, `permissions`, `directory`), and `repairAct` words the fix: fix the
  JSON, fix the permissions (`chmod u+rw`), or move the directory's contents out
  or delete it. The cold refusal's hint uses it. So does every `recover`, which
  re-reads the set-aside copy each time, so a copy the human has already made
  readable gets no repair step.

Tests: a fourth fixture, a valid registry at mode 000, runs through both
set-aside tests, and every fixture now checks its cold hint and its `recover`
text against its cause.
`a rename that fails: open fails at once with the daemon's reason, bytes left in place`
covers the first follow-up, and `startFailure` has unit tests in
`src/astrolabe/backend/cli.test.ts`. Run red first: the rename test failed after
45 s on "failed to start within 45s", and the directory and mode-000 fixtures
failed on "fix the JSON" (5 failed, 5 passed). The census pin stays 17/2, and
the golden snapshot didn't change.
