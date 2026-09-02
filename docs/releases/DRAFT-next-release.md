<!-- DRAFT — NOT SHIPPED. Written 2026-09-02 by a fresh agent from the tree
     (land skill §3), then cold-read (§4). The release was HELD by Cole, not
     because of anything here: `bounty update --stdin` destroys card titles while
     returning {"ok":true}, its repair is scheduled into spell-hardening sprint
     06 phase 1, and sprint 05's own merge commit promised "05 and 06 ship
     together". Holding keeps that promise.

     ⚠ EVERY NUMBER BELOW DECAYS. Re-measure before shipping; do not inherit.
     Ruling 2026-09-02 (Cole): size figures are ROUNDED on purpose — a number
     should be sized to the decision it informs, and no one installs or declines
     over bytes. Exact where something re-runs it, rounded where a human reads
     it.

     Known corrections still to apply, from the cold read:
       - `acc` is described as an "external"/"independent" standard. It is
         git+github.com/ichabodcole/agent-cli-conformance — the same author's
         repo. A cold reader took it as third-party validation, unprompted.
       - only 3 of 4 spells carry an acc.config.json (grapevine has none), and
         NOTHING re-runs acc — not package.json, not CI. "Checked against"
         implies an ongoing property that does not exist. knownFailures = 0 on
         the three that have configs, so they did pass when run by hand.
       - the title garden-paths: "refuse bad commands in JSON" reads as
         "reject commands written in JSON".
       - "Four spells still do not build" reads as broken; it means not yet
         converted.
       - the bounty title-destroying bug sits under "what this does not reach",
         a scope heading. It is an active hazard and needs its own section.
       - the stylesheet paragraph frames a reduction, then concedes that against
         what v2.2.0 ACTUALLY shipped the bytes went UP. Pick one framing.
-->

Spells install where nothing is installed, and refuse bad commands in JSON

## Why this release exists

Two separate lines of work landed here. They are not one story, and reading them
as one will mislead you.

**Spells could not actually be installed.** A spell ships as a folder you copy —
but three of them needed a `node_modules` above them to run at all, which only
existed inside this repo. imago was the worst case: its daemon statically
imported `sharp`, a native image addon that is not in the shipped folder, at
load time. In the released v2.2.0 plugin **imago's daemon could not boot at an
installed destination**, network or no network. That is fixed here, and the
underlying packaging problem is fixed with it.

**Spell CLIs answered wrong invocations by ignoring them.** Run
`magpie say --bbox 1,2,3,4` against v2.2.0 and it parsed clean, did nothing, and
exited 0. Failures came back as prose on stdout, `--version` did not exist, and
a bare invocation reported success. Four CLIs are now checked against an
external conformance standard (`acc`, an independent CLI-contract checker) and
answer in a machine-readable form.

## What you receive that you did not have

**Spells that run with no dependencies at the destination.** astrolabe, imago
and magpie now ship a pre-built `dist/` — the surface, React, Tailwind and all,
bundled into the folder. astrolabe and magpie also ship their CLI built, behind
a three-line launcher at the same `scripts/cli.ts` path the docs have always
named. imago's daemon starts offline (`sharp` → Bun's built-in `Bun.Image`).
Each was verified by copying only what ships to a path with no dependencies on
any parent directory and driving the board in a browser.

**Machine-readable failure on four CLIs** — grapevine, magpie, astrolabe and
mind-mapper. Every failure is one JSON envelope on **stderr** with stdout empty:
`{ok:false, error:{kind, exit_code, retryable, message, hint?, choices?}}`.
Branch on `kind`, never on the message text. Exit codes distinguish "your
command is wrong" (2) from "the spell is wrong" (1), plus `not_found` (5) and
`conflict` (6). `--version` / `-V` / `version` answers on all four.

**Flags are scoped to the verb they belong to.** Previously one global registry
meant every verb accepted every other verb's flags. A census across magpie's 17
command paths measured 289 flag/path pairs that were accepted but belonged
elsewhere; after scoping, 0. A rejection now names the verb and lists what that
verb accepts, and distinguishes an unknown token from a real flag used in the
wrong place.

**`grapevine schema`** — a new verb that emits grapevine's own interface
description, generated from the same registry that drives dispatch, so it cannot
drift from the parser.

**bounty tells you when a restore failed.** `restoreFailed` (`{path, reason}`)
is now on the `open` envelope and the daemon boot log, and is a different
situation from `restoreSkipped`: skipped means never attempted (fix your
command), failed means attempted and the snapshot could not be read (the board
comes up empty and your snapshot is the damaged thing). bounty also gains a
feedback touchpoint it was the only spell missing.

## Breaking changes — read this part

These affect callers of grapevine and magpie in particular.

- **A bare invocation is now a usage error** (exit 2, stdout empty, usage on
  stderr) on grapevine and magpie, where it previously exited 0. `help` /
  `--help` remains the help path at exit 0. The reasoning: these are
  agent-driven CLIs, so an empty argument list is a caller that failed to say
  what it wanted, and exit 0 tells it that worked.
- **Unknown flags are now rejected** rather than accepted and ignored. On
  grapevine, all 26 flags previously parsed on every verb. Each verb now accepts
  its own set plus the global identity pair `--as`/`--from`. Measured cost of
  the change inside this repo was ~0 — 107 pre-existing grapevine tests passed
  unmodified.
- **A root `--flag` now parses as a flag**, and missing or excess positionals,
  and non-numeric values on numeric flags, error before the verb runs.
- **astrolabe** gains exit `1` for an internal fault (the daemon failed to
  start) and now puts failures on stderr as an envelope.
- **mind-mapper's exit codes moved** (needs-project and the 409 family from 2 to
  6, unknown entity to 5). This reaches no installed consumer — see below — but
  it is real for anything driving it in-repo.

Each affected spell's `SKILL.md` documents its own change; grapevine's carries a
V2.0 banner naming both breaking items.

## Download size grew, and nobody has ruled on it

The shipped plugin goes from **5.7 MiB to 8.9 MiB** (measured by summing git
blob sizes under `plugins/spellbook` at `main` vs `develop`). Per spell:
astrolabe 135 KiB → 1.2 MiB, imago 470 KiB → 1.4 MiB, magpie 435 KiB → 1.6 MiB.
That is React and Tailwind bundled into each spell's chunks, which is exactly
what makes a dependency-free destination possible — the cost and the capability
are the same bytes.

**This is deliberately unruled, not overlooked.** Both `docs/PROJECT-SUMMARY.md`
and the spell-kit project ledger record "what does a consumer receive per spell"
as an open product question owned by Cole since 2026-08-10, and record that the
build work did not wait on it.

Stylesheets moved the other way. All four shipped stylesheets total **196,316
bytes** on `develop` (summed from the tree). A bare `@import "tailwindcss"`
roots Tailwind's content scan at the build's working directory, so every spell's
stylesheet was being compiled out of every other spell's text — including class
names that appear only in comments and prose. Scoping each spell to its own
surface removed roughly two thirds of it with zero classes lost, verified by two
instruments that fail in opposite directions plus a computed-style comparison
over a running board. Note that the "before" figure quoted in the merge commit
(605,785 B) is a mid-sprint measurement, not a v2.2.0 one — v2.2.0 shipped
exactly one stylesheet (mind-mapper's, 165,575 B); the other three did not exist
yet.

## What is now checked, and what that check does not mean

The repo gains its first CI check, named `gate`, on every pull request: build,
lint, full test suite, then a rebuild-and-diff proving the committed `dist/`
matches its own committed source. `bun test` on `develop` is **1539 pass / 0
fail across 118 files** (run against this tree; the smaller figures in
individual merge commits were true at their own commits, not here). A fresh
`bun run build` on `develop` leaves the working tree clean.

That last arm exists because a stale build artifact produces a **working** board
— the daemon simply serves the previous build — so it is invisible to tests, to
the linter, to a browser drive, and to a reviewer. One had already slipped onto
`develop` and was caught by hand.

Two limits on this, stated plainly:

- **The check has to be marked required in GitHub's settings, and no agent can
  do that.** Until a human does, a red `gate` does not block a merge. It is
  filed as `docs/backlog/2026-08-31-the-pr-check-must-be-marked-required.md`.
- **None of it asserts that a board works.** These checks prove `dist/` is the
  faithful build of its committed source. They say nothing about whether that
  source is correct. The install simulation that proved the ported spells run is
  a manual recipe run by hand, not a script in the gate. Both are filed.

## What this deliberately does not reach

**Four spells still do not build**, at three different distances: glamour is a
straight relocation (already React and Tailwind); bounty and grapevine are
Alpine single-page surfaces and need a rewrite first; digestify ports only when
it becomes dynamic enough to want a build, a trigger Cole owns.

**Shared code between spells is a capability, not a cleanup.** The shared kit
holds four modules. Other spells still carry their own copies of the helpers on
purpose. If you adopt a kit component, you must also import the kit stylesheet —
importing only the component ships the component with none of its utilities,
silently, and everything stays green.

**mind-mapper is not a released spell.** It ships files and a `dist/` (2.9 MiB,
about a third of the plugin download) but has no `SKILL.md` and is absent from
every listing on purpose — it is unfinished, and Cole ruled that a spell that
has not coalesced should not claim a roster slot. Nothing in this release
changes that.

**Known defects were found and held out on purpose.** The most severe:
`bounty update --stdin` writes the **title**, not notes — the previous title is
destroyed, the envelope says `{"ok":true}`, and `valuesIgnored` reports `null`.
This release ships a prominent warning in bounty's `SKILL.md`; **the code is
unchanged**. Use `--notes` instead. Also still open: `bounty tail` against a
target it cannot resolve retries forever at exit 0 while looking alive (GitHub
#98); `astrolabe close` can exit 0 while carrying an error envelope; and a real
flag can still be silently swallowed as a positional after a `--` terminator.

The sprint that was scoped to drain that queue exists as an argued plan with no
branch cut. An earlier merge commit in this range said the gate work and the fix
queue would "ship together" — **that no longer holds, and this release ships the
gate without the fixes.**

**Conformance is a claim about the rules a checker could apply, not a claim of
correctness.** glamour has not been through it and does not pass. bounty's gaps
are measured and filed. grapevine's remaining prose errors predate the house
error contract and are unconverted.
