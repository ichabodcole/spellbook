---
type: session
title: Workspace daemon — 2026-10-14
description:
  "The second Workspace Kit cycle: Story Studio's workspace daemon ported into
  src/kit/workspace, held to Scriptorium's links and E65, and a flagged second
  Scriptorium running on it beside the shipped one."
tags: [kit, scriptorium, story-studio]
status: stable
generated: { by: claude-opus-5-5, at: 2026-10-14 }
---

# Workspace daemon — 2026-10-14

Part of
[Workspace daemon](../../../cycles/_archive/2026-10-workspace-daemon.md).

## Context

This is the first of the five workspace-stack cycles in
[Workspace Kit](../feature.md), split as the
[port-shape write-up](../../../items/workspace-stack-port-shape/write-up.md)
proposed.

The port base is Story Studio's `027d7a3` plus the workspace halves of
`55df89e`, `d7ef948`, `a538a2e` and `5b87ad0`. Story Studio's newer workspace
model is excluded (Cole).

Cole also ruled four open questions on 2026-10-14:

- links in raw HTML follow the kit's rule;
- Scriptorium keeps its workspace undo for now;
- `note.edited` and `note.reopened` are kept (later superseded; see below);
- a second Scriptorium on the kit runs side by side, behind `SCRIPTORIUM_KIT`.

The work ran as delegated items on `cycle/workspace-daemon`. Each item had an
implementer briefed in its own worktree and a no-stake verifier that ran the
claims. Fix rounds went back to the same implementer, and verified commits were
cherry-picked onto the cycle branch. Story Studio's agent took part throughout
on `kit-parity` (messages 28 to 40).

## What Happened

- **The port** (`kit-port-workspace`): about 22k lines in `src/kit/workspace`,
  plus lib pieces and `wire/stdinPeek`. Every test now runs under a scratch
  `HOME` from the `src/kit/lib/scratchHome.ts` preload, which every spell's
  `bunfig.toml` loads. `homeDir()` refuses the real home in a test run. An
  AST-based ward holds both rules.
- **The manifest guard** (`kit-workspace-manifest-guard`): the kit refuses a
  manifest that isn't its own, Scriptorium's shape included. A daemon whose
  start fails after binding stops listening.
- **The links differential** (`kit-links-differential`): the kit's extractor and
  resolver are held to Scriptorium's link cases, in 141 tests. Verification
  found `place()` quadratic on any dense line; it is now linear. Cole ruled that
  every declared difference takes the kit's behaviour, except relation names,
  which both kits now lowercase on read. Story Studio took the fold as
  `e82d3ff`.
- **E65** (`kit-workspace-e65-daemon`): Spellbook's first daemon half
  (`d1ca788d`) was reverted. In its place, Story Studio's `85a319e` workspace
  half was ported byte for byte, plus a one-ask guard for "Ask the agent" (Cole:
  converge on theirs). Cole then ruled, in Story Studio, that the kit's buttons
  get their own `via` values. The guard therefore moves to `via: "ask"` when we
  port Story Studio's via-and-refs daemon half; Story Studio built that version
  from our `askOutstanding` in `4ab0087`.
- **The flagged Scriptorium** (`scriptorium-on-kit-daemon`): with
  `SCRIPTORIUM_KIT=1`, Scriptorium's CLI and daemon run on the kit. Their
  sessions live under `$SCRIPTORIUM_HOME/kit/`, and acc is conformant on both
  paths. Without the flag, the help, the verbs, a scripted tail and the boot
  errors are byte-identical to `develop`. The shipped code changed in one way:
  its restore refuses a kit manifest, and the hint reaches `open`.
- **Story Studio's via and refs**: reviewed twice from `git show` only. The
  first review gave seven asks. Cole ruled the four product questions in Story
  Studio. The fix round, `4ab0087`, was judged "land as is", with one missing
  test cell asked for in both kits.

## Notable Discoveries

- **A bundler define silently removed the safety guards.** The backend build
  defines `process.env.NODE_ENV` as `"production"`. That folded the kit's "real
  home in a test run" refusal and its under-test Trash refusal to `false` in
  every built bundle. A built daemon under test would have moved a scratch file
  into Cole's real Trash. The guards now read `NODE_ENV` through a parameter,
  which the build cannot fold.

  `bun test` also keeps a `NODE_ENV` that is already set. So the preload sets it
  to `"test"`, and a scratch-shaped `HOME` counts as under test too. Both fixes
  went to Story Studio (message 36).

- **Lowercasing turns `İ` into a combining mark.** `"İlgili".toLowerCase()` ends
  with U+0307, which the relation pattern rejected, so the fold silently dropped
  those rels. The pattern now allows marks after the first character, and the
  reader, the vocabulary and the writer agree. A brute force over every code
  point found nothing the writer emits that the reader drops.
- **The two kits had built E65 in parallel.** Converging cost one revert, but
  left a single wire for both apps. When Cole's `via` ruling arrived, it removed
  a second marker for the same fact (`about.ask`): the kits now have one state
  with one meaning.
- **Reviews keep finding untested invariants that are correct today.** In both
  kits, removing `from === "human"` from the guard survived every test. Cells
  now pin it.
- **Gate versus worktrees, again.** A full gate run from the main checkout
  failed on the nested `biome.json` files in finished agent worktrees. Removing
  them first is now the habit.

## Changes Made

- `src/kit/workspace`, `src/kit/lib` and `src/kit/wire/stdinPeek.ts`: the port,
  with E65 converged, the rel fold, the manifest and malformed-manifest guards,
  `/cmd` field checks, and the `refuseScriptorium` app hook.
- `src/kit/lib/scratchHome.ts` and `home.ts`: the test-home preload, and
  under-test guards that survive the build.
- `src/scriptorium/backend/kit/`: the flagged Scriptorium. `backend/cli.ts` and
  `backend/server.ts` hand off to it, and `backend/session.ts` gains the restore
  guard.
- `src/scriptorium/backend/links.differential.test.ts`.
- Wards:
  - new: `kit-scratch-home-ward`;
  - extended: `terminator-invariant` (reads a CLI factory) and `spawn-path` (one
    opaque `serveFromDist` row, matched exactly once);
  - re-pinned: `gate-honesty`.
- `.claude/skills/ward/SKILL.md`: the new-spell checklist names the preload.
- `bunfig.toml` at the root and in all nine spells: the preload.
- Every spell's committed CSS lost `.table`, `.ring` and `.bg-danger`, because
  `base.css` no longer scans the kit's test files. No spell uses them.
- Scriptorium's `dist`: `server.js` grew from 1.67 MB to 4.6 MB, and `cli.js`
  from 413 KB to 1.58 MB. Start-up is within a few milliseconds of before.

## Review

The reviewer census was read from the Agent tool's list of dispatchable agent
types in this session.

- **Chosen:** `general-purpose` (tools `*`, so it has a shell), twice in
  parallel.
- **Rejected:**
  - `feature-dev:code-reviewer` and `feature-dev:code-architect`: they have
    `BashOutput` and `KillShell` but no `Bash`, so they are read-only.
  - `Explore`: it locates code rather than reviewing it.
  - `codex:codex-rescue`: it is for second implementations.
  - `doc-reviewer` and `project-docs:docs-curator`: they review documents.
  - `code-simplifier`: it edits.

**Plan alignment.** The reviewer:

- rebuilt Story Studio's reference tree read-only and diffed it against
  `src/kit/workspace`;
- grepped for leaks of the excluded model;
- ran a default-path invariance script against `develop` (1,298 lines,
  invariant);
- drove the flagged CLI under a scratch home;
- ran `acc check` on both CLIs;
- ran the targeted suites (273 pass) and the gate (exit 0, 5,118 pass).

Verdict: With fixes. The fixes were stale item docs (E65 boxes unticked, and
contradictions in the links item), the kit path's `os.homedir()`, and the ward
SKILL's checklist. It also raised the release question below.

**Bugs and security.** The reviewer drove a live kit daemon under a scratch
home:

- forged `Host` and `Origin` headers, and WebSocket upgrades: all refused;
- path traversal and symlink probes;
- `/cmd` validation;
- 16 forged manifests;
- concurrent restores;
- a stale pointer after `kill -9`;
- link scaling up to 200k characters.

It planted four regressions; three were caught. Verdict: With fixes:

- the under-test guards trusted a preset `NODE_ENV`, which could reach the real
  Trash;
- no test pinned that only a human's mark counts;
- `/cmd` accepted malformed input;
- a failed restore had already rewritten its manifest.

Its `reveal` probes opened Finder on scratch files during the first pass. It
stubbed `open` on the re-check.

One fix round covered both reviews, and Cole approved landing. The bugs reviewer
re-verified it from a detached checkout:

- re-ran every probe;
- re-planted the guard regression, now caught;
- drove every agent verb of both CLIs, and nothing valid was refused;
- restored every real and legacy manifest shape;
- ran the gate (exit 0, 5,125 pass).

Its verdict: Ready to merge: Yes.

**Release.** `develop` still cuts releases, and release-please has no path
filter. The next `develop` → `main` release would ship this cycle's `feat`
commits, the hidden flag, and Scriptorium's larger `dist`. Cole has said there
is no release until the whole stack is done, so releases from `develop` wait for
the cutover cycle. Whoever cuts one should check this first.

## Follow-up

Filed during the cycle, all in triage:

- [kit-links-images-in-one-label](../../../items/kit-links-images-in-one-label.md):
  a link holding many images is still quadratic, in both kits.
- [acc-census-flag-staleness](../../../items/acc-census-flag-staleness.md)
- [kit-workspace-cli-hints](../../../items/kit-workspace-cli-hints.md): the
  wrong unknown-session hint, the non-JSON keepalive, `close` naming another
  session, and the pointer left after SIGTERM. Also, `/cmd` treats `null` as
  present on some read ops (`backlinks` and `profile` give a 500).
- [kit-workspace-concurrent-restore](../../../items/kit-workspace-concurrent-restore.md):
  inherited.
- [kit-workspace-symlinked-sets](../../../items/kit-workspace-symlinked-sets.md):
  inherited.

Carried into the next cycles:

- **Port Story Studio's via-and-refs daemon half by hand.** It landed there as
  `bbc54fd` (kit-parity message 41), from `7431766` and `4ab0087`. In the same
  port, drop `about.ask`, key the guard on `via: "ask"`, and tighten the agent
  `say`'s `about` (already done here).
- **Port the picker-side rel fold from `e82d3ff` with the document pane.**
- **At the cutover:**
  - the SKILL delta recorded in the Scriptorium item;
  - migration of shipped sessions;
  - the surface;
  - `NODE_ENV=test` with a real home gets a refusal.

---

**Related Documents:**

- [Workspace Kit](../feature.md)
- [Kit foundation — 2026-10-13](./2026-10-13-kit-foundation.md)
