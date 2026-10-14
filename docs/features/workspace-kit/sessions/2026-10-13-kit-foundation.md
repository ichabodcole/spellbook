---
type: session
title: Kit foundation — 2026-10-13
description:
  "The first Workspace Kit cycle: Story Studio's lib, wire, theme, ui and cli
  ported into src/kit, and Scriptorium moved onto the kit's primitives, each
  verified by a no-stake reviewer."
tags: [kit, scriptorium, story-studio]
status: stable
generated: { by: claude-opus-5-5, at: 2026-10-13 }
---

# Kit foundation — 2026-10-13

Part of [Kit foundation](../../../cycles/2026-10-kit-foundation.md).

## Context

This is the first cycle of [Workspace Kit](../feature.md). It ports the
foundation tier of Story Studio's kit into `src/kit`: `lib`, `wire`, `theme`,
`ui` and `cli`. Scriptorium is the first spell to adopt the kit's UI primitives.
Cole approved the feature, the cycle and its items on 2026-10-13. Before that,
he had ruled on how Spellbook's earlier chat and context thinking meets Story
Studio's kit
([the prior-direction write-up](../../../items/workspace-kit-prior-direction/write-up.md)).

The work ran as delegated phases on the `cycle/kit-foundation` branch. Each item
had a read-only scoping pass where it needed one, an implementer briefed in its
own worktree, and a no-stake verifier that ran the claims. Fix rounds went back
to the same implementer, and the verified commits were cherry-picked onto the
cycle branch.

## What Happened

- **`lib` and `wire`.** Scoping found that most of Story Studio's 4,400-line
  `lib` belongs to the workspace stack, so only `cn` and `storage` came across.
  In `wire`, the port took:
  - the drain skip;
  - the exit codes 124 and 130, and an error `token`;
  - a `Host` guard against DNS rebinding;
  - the session-pointer API;
  - `startDaemon`.

  Where Spellbook was ahead, its version won: `tailHandoff`'s `by`, `closedBy`
  and `goneBy`, the `spell` key and the error envelope's `server` key. Story
  Studio had renamed those last two, which would have broken eight spells. The
  `Host` guard also accepts the host the server is bound to, so `--host` keeps
  working.

- **Theme and ui.** Story Studio's token structure came across with Spellbook's
  palette kept (Cole). The new tokens were derived from mind-mapper's values.
  The happy-dom harness arrived with a `domGuard` preload after the verifier
  found a load-time DOM leak. Cole kept the popup animations that
  `tw-animate-css` turns on in bounty, grapevine and Scriptorium.
- **The primitives rule.** `registry-primitives-variant-extends-recipe` named
  its own repeal ("when the kit ships the primitives itself"), and this cycle
  fired it. The rule now points spells at `src/kit/ui`. Cole's opt-out (kit UI
  is a default, not a requirement) keeps the registry rule for a spell that
  holds its own `surface/ui/`.
- **Scriptorium on the kit.** Scriptorium's own primitives, `components.json`
  and path alias are gone. Where its look differed from a recipe, it became a
  variant inside the kit. Two verifications compared 52 screenshot pairs, and
  the result is pixel-identical apart from timestamps.
- **Per-verb help.** Every registry spell answers `help <verb>` and
  `<verb> --help`. The hard-coded exit codes went too.
- **The finalize review** came from two reviewers and returned "With fixes". One
  fix round followed, re-verified as "Yes":
  - component tests no longer depend on file order;
  - a bracketed IPv6 `--host` works;
  - the origin ward checks for the bound hostname;
  - `startDaemon` was hardened;
  - an unused dependency went;
  - the conflict test no longer passes vacuously;
  - two stale doc claims were corrected.

The Atlas comparison moved out of the cycle, to after the shell port (Cole). The
primitives already converge on the kit, and the shell brings Atlas's layout by
default. Story-ordering numbers came out of the items, because the cycle carries
the order.

## Notable Discoveries

- **The kit's `cn` only joins classes, and the recipes assumed tailwind-merge.**
  The button's base `rounded-lg` beat every size's own radius, and Story
  Studio's kit has the same bug. Each size now owns its radius, text size and
  icon size, and `recipe-conflicts.test.tsx` guards every primitive. The fix
  went to Story Studio on `kit-parity`.
- **`--help` in a flag's value slot was turned into help at exit 0, and the
  command was dropped.** `add t --notes --help` added nothing, and the exit code
  said success. Two narrower rules each leaked a new shape. The fix that holds
  lets the parser decide: `--help` counts only when a strict `parseArgs` reads
  it as the help flag. Story Studio's registry still has the raw scan; the fix
  went to them as well.
- **Test files under `src/kit` are scanned by Tailwind.** A test's example class
  strings shipped in every spell's CSS until the tests were rewritten to avoid
  them.
- **Grapevine collaboration with Story Studio's agent** (`kit-parity`) settled:
  - `via` and `refs`
    ([Message via and refs](../../../items/message-via-and-refs.md));
  - E65 going back to Story Studio;
  - the floating composer, with its rail and composer-closed state;
  - no `pointedDocs` mirror.
- **One verifier slip.** A comparison script that didn't isolate `HOME` created
  a stray channel on Cole's real grapevine daemon. Cole approved deleting it,
  and it is deleted. Verifier briefs now say to use a scratch `HOME` for every
  spell CLI they drive.

## Changes Made

- `src/kit/lib`: `cn`, `storage`, and the happy-dom harness (`afterIo`,
  `registerDom`, `testDom`, `domGuard`).
- `src/kit/wire`: `housekeeping`, `errors`, `origin`, `discovery`, `detach` and
  `daemon.test`.
- `src/kit/theme` and `src/kit/ui`: the theme, the primitives, and the
  recipe-conflict test.
- `src/kit/cli/registry.ts`: per-verb help and `asksForHelp`.
- Every spell server now passes `srv.hostname` to the origin guard. Five use the
  exit-code constants.
- Scriptorium's surface imports from `src/kit/ui`.
- Root `bunfig.toml` gains the test preload. `package.json` gains the kit's root
  dependencies, and `happy-dom` is pinned.
- `grimoire/house-style.md`: the primitives rule rewritten, and the surface dep
  cap amended. Wards re-pinned as follows:
  - gate-honesty: `base.css` and Scriptorium's `styles.css`;
  - import-boundary: one line number;
  - strict-parse: 11 calls to 12;
  - the origin ward extended.

## Review

The reviewer census was read from the Agent tool's list of dispatchable agent
types in this session.

- **Chosen:** `general-purpose`, with tools `*`, so it has a shell.
- **Rejected:**
  - `feature-dev:code-reviewer` and `feature-dev:code-architect`: they have
    `BashOutput` and `KillShell` but no `Bash`, so they are read-only.
  - `project-docs:docs-curator`: it reviews documents, not code.
  - `code-simplifier`: it edits.
  - `Explore`: it locates code rather than reviewing it.

Two `general-purpose` reviewers ran in parallel against
`git diff develop...HEAD`.

**Plan alignment.** Execution log:

- `git diff` views;
- a clean clone with `bun install`, `bun run build`, `bun run check` and
  `bun test` (3,475 pass);
- `bun test grimoire` (303 pass);
- the launchers' `help` and `--help`, including `add t --notes --help` exit 2;
- `acc check` on all nine spells (conformant, 0 known failures);
- a live Scriptorium daemon that refused a forged `Host` with 403.

Verdict: With fixes, for three stale doc claims and an unused dependency.

**Bugs and security.** Execution log:

- scratch probe scripts for `srv.hostname`, `ownHost` edge cases, a live server
  with `curl` (rebinding, empty, absolute-form and duplicate `Host`),
  `startDaemon` parent and child, about 25 argv shapes, drain timing, pointer
  edge cases, and a function `className`;
- `bun test` on scratch DOM file orderings;
- `bun test src/kit` (378 pass);
- the touched spells' tests (1,608 pass).

Verdict: With fixes, for the order-dependent DOM harness, the IPv6 brackets, the
ward's missing hostname check and `startDaemon`.

Cole approved the fix round. Re-verification by the bug reviewer (log: a
detached scratch worktree, each finding re-driven, planted failures for the ward
and the render assertions, `bun test src/kit` 385 pass, the gate exit 0 with
3,483 tests) returned: Ready to merge: Yes.

Every item's no-stake verification during the cycle also ran its claims, with
planted failures and live daemons, as recorded in the items.

## Follow-up

These came from the review and verification, all in triage:

- [kit-discovery-pointer-hardening](../../../items/kit-discovery-pointer-hardening.md)
- [kit-cli-registry-followups](../../../items/kit-cli-registry-followups.md)
- [origin-ward-same-server](../../../items/origin-ward-same-server.md)
- [scriptorium-cn-semantics](../../../items/scriptorium-cn-semantics.md)

Also filed during the cycle:

- [kit-dom-harness-gaps](../../../items/kit-dom-harness-gaps.md), now with the
  extensionless-import case;
- [kit-primitives-css-opt-in](../../../items/kit-primitives-css-opt-in.md);
- [declare-micromark-gfm](../../../items/declare-micromark-gfm.md).

Next cycle is the workspace stack. The Atlas comparison
([kit-atlas-scriptorium-comparison](../../../items/kit-atlas-scriptorium-comparison.md))
follows the shell port.

---

**Related Documents:**

- [Workspace Kit](../feature.md)
