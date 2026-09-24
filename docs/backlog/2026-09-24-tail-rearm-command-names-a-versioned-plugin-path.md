---
type: backlog
title: "The tail's re-arm command names a versioned plugin path"
description:
  The handoff line prints the launcher's full path, which for an installed
  plugin is a versioned cache directory; across an upgrade the command first
  runs stale code, then fails with "module not found" once the old directory is
  deleted. Resolve before the release that ships the handoff
tags: [tail, monitor, plugin-install, release]
status: draft
lifecycle: done
generated: { by: claude-opus-5.5, at: 2026-09-24 }
---

# The tail's re-arm command names a versioned plugin path

> ✅ **Resolved before the release, on `fix/tail-rearm-without-plugin-path`:**
> the printed command names no path (see Built, below). The warning that stood
> here, kept for the record: the tail handoff (`feat/tail-quiet-handoff`) is on
> `develop` and in no release yet: the latest tag, `spellbook-v3.0.1`, does not
> contain it. So the next release is the first to print these commands, and it
> will print them with the flaw. Once they are printed, they are fixed in the
> agent's context. A fix in any later release cannot reach commands the next
> release has already printed.

## What happens

Every handoff line (`tail.window`, `tail.quiet`, `tail.woke`, `tail.closed`,
`tail.lost`) carries a `command` that runs as printed. Its head is
`selfCommand()` in `src/kit/wire/tailHandoff.ts`, which is
`["bun", process.argv[1]]`: the launcher's own full path. For an installed
plugin, that path is inside a **versioned** cache directory:

```
~/.claude/plugins/cache/spellbook-marketplace/spellbook/<version>/skills/<spell>/scripts/cli.ts
```

`installed_plugins.json` records the same versioned `installPath`, and
`$CLAUDE_PLUGIN_ROOT` resolves to it too, so the skills' own
`${CLAUDE_PLUGIN_ROOT}/…` launch lines are no more stable. The kit's header
already names this as a known limit, "noted, not redesigned".

## What an upgrade does to the old directory (measured 2026-09-24, this machine)

**It leaves the directory, marks it, and deletes it later.**

- **Marked, not removed.** The cache still holds `2.2.0/`, `3.0.0/` and
  `3.0.1/`. The two old ones each carry an `.orphaned_at` timestamp, one for
  each upgrade: 2026-09-14 20:15 (→ 3.0.0) and 2026-09-17 13:17 (→ 3.0.1).
  `installed_plugins.json` points only at `3.0.1`.
- **Held open by live sessions.** Each version directory has an `.in_use/`
  folder of files named by PID (`{"pid":…,"procStart":…}`). This session's
  `$CLAUDE_PID` is one of the entries under `3.0.1/.in_use/`. So a Claude Code
  session registers the version it loaded.
- **Deleted eventually.** The plugin has been installed since 2026-06-11 (the
  1.x line) and the repo has cut 23 `spellbook-v*` tags, yet only three version
  directories remain. Orphaned versions are therefore removed at some point.
  _The exact policy (delay, lock check) is Claude Code's and is not visible
  here. What is observed is that `3.0.0/` is still present 7 days after being
  orphaned, and its `.in_use` PIDs are all dead._
- **PID reuse can pin an orphan.** One entry under `2.2.0/.in_use/` is
  PID 89545. That process is live today, but it is Figma's agent, started
  2026-09-23. The PID was recycled. If the lock check is by PID alone, an orphan
  can outlive its sessions by accident. This does not change the verdict, but it
  makes the deletion time unpredictable.

## Verdict: the command does both, in sequence

1. **Right after an upgrade it keeps working, against a stale copy.** The old
   directory is still there, so `bun <old path> tail …` runs the **old** code.
   In the session that printed it, that is harmless: the session loaded the old
   version and its daemon was spawned by it. It goes wrong when the session is
   resumed after the upgrade (a new Claude process, which loads the new plugin)
   and the agent follows the last handoff line from its context, as the skills
   tell it to. Now old tail code is talking to whatever daemon is running. If
   the daemon was restarted by a new-version `open --restore`, that is
   new-version code on the other end. Nothing checks that the two versions
   agree.
2. **Once Claude Code deletes the orphaned directory, it breaks, loudly.** `bun`
   on a missing path prints `error: Module not found "<path>"` and exits `1`
   (checked). A Monitor ends at once. A background `--once` exits at once and
   wakes the agent. So it does not hang. But the agent gets no line naming its
   next act, and the skills' rule, "do what the last line says", points it back
   at the same dead path.

Both are reached by an ordinary sequence: a session idles in `tail --once`
overnight, the plugin updates, and Cole resumes the session in the morning.

## What a fix could look like

There is **no version-independent launcher path in the install**. The cache
directory is versioned, `$CLAUDE_PLUGIN_ROOT` is versioned, and in an agent's
Bash tool `$CLAUDE_PLUGIN_ROOT` is **unset** (checked in this session; the
bounty and magpie skills already warn about this). So "print a stable path
instead" has nothing to print. The options:

- **A. Print the args, and let the agent supply the launcher.** Keep `command`
  for the common case, add the verb and its flags on their own (for example
  `args: "tail --since 41@e3 --once"`), and have the hint and the skills say: if
  `command` fails with "module not found", run `args` with this skill's
  launcher. The skill's base directory in a resumed session is the **new**
  version's, so the agent's own path is the right one. This gives up a little of
  "runnable as printed" (the kit header's ⚖ entry) in exchange for a recovery
  that is named.
- **B. The launcher notices it is orphaned.** At start, `cli.ts` checks whether
  its version directory carries `.orphaned_at` and a newer sibling exists. If
  so, it re-execs the newer launcher, or refuses with a line naming it. This
  fixes both halves (stale code and a missing path) for as long as the old
  directory still exists. But it depends on a Claude Code internal marker, and
  it does nothing once the directory is gone.
- **C. A + B.** B covers the stale window, and A covers the deleted one.

A (or C) is the smallest change that makes the break recoverable. Whichever
lands, the handoff cells should include one that runs a printed command against
a moved launcher.

## Acceptance Criteria

- [x] After an upgrade, a re-arm taken from a pre-upgrade handoff line either
      runs the installed version or fails with a line that names how to recover.
      _Met by the ruling: the line names no path, so the agent's own launcher
      (the installed version) runs it; a form that version does not accept is a
      usage error naming the forms it does (`readSince`)._
- [x] ~~A cell drives it: print a handoff line, move the launcher's directory,
      run the printed command, and assert the agent-facing outcome.~~ _Moot
      under the ruling: no printed command names a directory to move. What the
      cells assert instead is that every tail's printed command names no
      launcher or path (each spell's own cell), and that a foreign `--since`
      form is refused (`grimoire/tail-since-refusal.test.ts`)._
- [x] The kit header's "KNOWN LIMIT, NOT FIXED" entry is updated to match. _It
      is now the ruling, "THE COMMAND NAMES NO PATH"._

## Built (fix/tail-rearm-without-plugin-path, 2026-09-24)

**Cole's ruling:** the printed command must not name the plugin's path. It
prints the verb and its arguments only, and the skill supplies its own launcher,
which is always the version the session loaded. His reasoning: the worst case is
that the plugin's CLI changed and the agent gets an error, and if the tools are
designed right, that error says what went wrong. So this is option A without the
path, not A, B or C as written above. The kit header records the ruling and the
options not taken.

- **The line** (`src/kit/wire/tailHandoff.ts`). `command` is launcher-free, for
  example `tail --session s1 --since 12@<epoch> --once`, and the line carries
  `spell`. Every hint says to run
  `bun <this skill's directory>/scripts/cli.ts <command>`. The come-back
  commands are launcher-free too: `open --restore <id> --no-open`,
  `open --session-key K --no-open`, `open --no-open`, `doctor`. `selfCommand()`
  is gone.
- **The shared skill rule** (seven skills plus mind-mapper's help) says to run
  `command` with this skill's own launcher, shows the full form with an example,
  and says never to reuse a launcher path from an earlier line.
  `grimoire/tail-rule-parity.test.ts` holds the copies word-for-word equal.
- **The error when versions disagree.** Every tail reads `--since` through the
  kit's `readSince`, so a form it does not accept is a usage error naming the
  accepted forms, the same way on all eight tails. Before, the four no-epoch
  spells read `4@<epoch>` as `4` with `parseInt`, and mind-mapper and astrolabe
  read junk as a whole replay. `grimoire/tail-since-refusal.test.ts` drives each
  launcher.
- **What the acceptance criteria became.** No printed command names a path, so
  no printed command can point at a moved or deleted directory. The cells run a
  printed command the way the skill says, with the launcher the test knows. The
  "moved launcher" cell is moot.

## References

- `src/kit/wire/tailHandoff.ts`: `tailCommand()`, `readSince()`, and the
  header's "THE COMMAND NAMES NO PATH" entry (`selfCommand()`, named in "What
  happens" above, was removed by the fix)
- `~/.claude/plugins/installed_plugins.json`,
  `~/.claude/plugins/cache/spellbook-marketplace/spellbook/*/.orphaned_at`,
  `…/.in_use/`
- Session:
  [the tail hands off before the cap](../projects/scriptorium/sessions/2026-09-23-the-tail-hands-off-before-the-cap.md#known-and-not-built)
- Cycle: [Scriptorium from real use](../cycles/2026-09-scriptorium-real-use.md)
