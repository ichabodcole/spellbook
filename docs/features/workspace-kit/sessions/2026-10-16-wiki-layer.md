---
type: session
title: Wiki layer — 2026-10-16
description:
  "The third Workspace Kit cycle, the second of the workspace stack: four kit
  slots and Scriptorium's wiki layer on them, no default workspace, a session
  converter, and a disk-write guard the final reviews forced."
tags: [kit, scriptorium, story-studio]
status: stable
generated: { by: claude-opus-5-5, at: 2026-10-17 }
---

# Wiki layer — 2026-10-16

Part of [Wiki layer](../../../cycles/_archive/2026-10-wiki-layer.md).

## Context

The second of the five workspace-stack cycles in [Workspace Kit](../feature.md),
as the
[port-shape write-up](../../../items/workspace-stack-port-shape/write-up.md)
split them. The flagged Scriptorium (`SCRIPTORIUM_KIT=1`) gains its wiki layer
on new kit slots; the shipped Scriptorium is untouched.

Cole ruled during planning, on 2026-10-16:

- Scriptorium on the kit has no default workspace: new files go where the caller
  points
  ([scriptorium-no-default-workspace](../../../items/scriptorium-no-default-workspace.md),
  from his Operator braindump). On 2026-10-17 he confirmed that only a bare
  `open` adds the folder it ran in.
- The move plan is a daemon command now; its confirm dialog waits for cycle 3.
- The agent's `say` converges on Story Studio's rule for a bad entry id.

The work ran as in cycle 1: an implementer per item in its own worktree, a
no-stake verifier that ran the claims, fix rounds, then cherry-picks onto
`cycle/wiki-layer`. Four slot items ran in parallel.

## What Happened

- **`kit-port-via-refs`:** the workspace halves of Story Studio's `bbc54fd` and
  `4e6d4d4`. The one-ask guard keys on a human's `via: "ask"`, and `about.ask`
  is gone.
- **`kit-link-edges-slot`:** app-supplied edges with a kind and an app resolver.
  Scriptorium's frontmatter references and wiki forms ride on them. Verification
  found references to `.markdown` and `.txt` documents silently dropped by a
  name sift, and an uncapped resolver; both fixed.
- **`kit-tree-scan-filter`:** `AppDeclaration.scan`, with `hide` and `unhide` on
  it. Verification found a hidden document that had been opened still leaking
  into search and links; fixed, with `restoreContext` for undo parity.
- **`kit-set-promotion`:** `makeSet`, `unmakeSet`, `addFolder`; symlink bypasses
  of its guards were found and closed.
- **`kit-manifest-migrate-hook`:** a whole-manifest migrate before restore, and
  Scriptorium's converter behind `SCRIPTORIUM_KIT_MIGRATE=1`. Verification found
  its real-home refusal could be bypassed with `HOME` set to scratch; fixed.
- **`scriptorium-no-default-workspace`:** `AppDeclaration.homeWorkspace: false`.
- **`scriptorium-kit-wiki-verbs`:** `meta`, `meta-init`, `meta-set`, `find`,
  `forget`, `move-plan`, the remove verbs, `info`, and `docMeta` in `appState`.
  A plan-versus-move fuzzer found 43 mismatches; after the fix, 0 across five
  seeds.
- **The final reviews** (plan alignment, and bugs and security) passed the
  combined branch on behaviour but found ways for the agent to write outside the
  folders it should touch. Four security fix rounds followed, each checked by a
  fresh reviewer, ending with every disk write in the kit and Scriptorium's kit
  code going through `src/kit/workspace/disk.ts`, held by a ward.

## Notable Discoveries

- **Merges can drop features silently.** Two items each added a `commands:` key
  to the same options object; the merge was clean, and the second key replaced
  the first, removing `make-set` and `add-folder`. Every later brief named the
  trap, and the combined branch was checked for each verb.
- **Per-call-site security patches leak.** Round one guarded set-making routes;
  the next reviewer found four write sites it missed. Only routing every write
  through one module, with a ward that fails on a raw write, stopped new holes
  from appearing, and even then each review found link shapes (temp names,
  dangling links, `..` through a link, hard-linked twins) the previous round had
  not modelled.
- **Cole drew the threat line.** Defend against links and hard links planted
  where the kit writes; do not try to win races against a concurrent attacker
  with raw disk access, and leave read exposure through legacy sets. Both
  residues are filed.
- **The dry run has to follow the code.** The first 54-session dry run predated
  three converter changes; the cycle's claim rests on a re-run against the final
  code (54 of 54, version files untouched, the real folder changed only in
  Cole's live session from his own daemons).
- **The two kits diverge on the workspace model.** Story Studio has landed a
  single-workspace model and a plugin host since `027d7a3`; our no-home option
  is the opposite model, and the new slots have no plugin-level home there. The
  port back will be a reconciliation, not a patch series.

## Changes Made

- `src/kit/workspace`: `linkEdges.ts`, `movePlan.ts`, `manifestMigrate.ts`,
  `noHome.ts`, `safeNames.ts`, `disk.ts`; `session.ts`, `server.ts`, `verbs.ts`,
  `links.ts`, `tree.ts`, `protocol.ts`, `events.ts` and `waiting.ts` extended;
  `src/kit/lib/home.ts` gains `accountHome()`.
- `src/scriptorium/backend/kit`: `hide.ts`, `links.ts`, `convert.ts`,
  `commands.ts`, `wiki.ts`, `wikiCommands.ts`; `app.ts` (slot v2, the migrate
  refusals), `cli.ts` and `server.ts`.
- Wards: new `kit-disk-write-ward`; `layers.test.ts` admits move plans;
  `terminator-invariant`, `error-choices-census` and `gate-honesty` pins moved.
- Scriptorium's `dist` rebuilt. The shipped path is byte-identical in behaviour
  throughout (checked by every verifier with its own harness).
- Docs: the seven items, the SKILL delta in `scriptorium-on-kit-daemon.md`, nine
  follow-up items, the feature's migration risk.

## Review

The reviewer census was read from the Agent tool's dispatchable types.
`general-purpose` (tools `*`) was chosen for every implementer, verifier and
reviewer; `feature-dev:code-reviewer` and `feature-dev:code-architect` were
rejected as read-only (`BashOutput` and `KillShell`, no `Bash`); `Explore`
locates code rather than reviewing it.

- **Plan alignment:** With fixes. Every item's done box held on the combined
  branch, including the cross-item cases (hidden documents leave link edges,
  `docMeta`, `find` and `move-plan`). Findings: the converter's workspace entry
  skipped the later guards, `make-set` among the sessions, the dry run predating
  the code, and stale docs. All fixed.
- **Bugs and security:** With fixes: a manifest `slug`/`ext` traversal letting
  `version-new` overwrite any file, the converter adding dangerous roots, set
  routes reaching the sessions folder, a boot-only migrate check, relative paths
  on app verbs. Fixed in `e1039896`.
- **Three re-verifications** found, in turn: four write sites outside the guard
  (fixed by `disk.ts`, `59402838`); temp-name, dangling-link and hard-link
  bypasses and ward gaps (`d6bad8f0`); `..` through a link and more ward shapes
  (`855a6d0f`). Each verifier planted its own regressions; the last found every
  in-scope shape refused and no over-refusal beyond the documented hard-link
  case.
- **Gate on the combined branch:** exit 0, 5,526 pass, 0 fail. acc conformant on
  both CLIs.

## Follow-up

Filed during the cycle:

- [meta-set-byte-safety](../../../items/meta-set-byte-safety.md) (shipped too)
- [kit-docmeta-push-cost](../../../items/kit-docmeta-push-cost.md)
- [kit-mdx-documents](../../../items/kit-mdx-documents.md)
- [set-make-relink-offer](../../../items/set-make-relink-offer.md)
- [kit-ended-session-hint](../../../items/kit-ended-session-hint.md)
- [kit-write-race-hardening](../../../items/kit-write-race-hardening.md)
- [kit-legacy-sets-show-sessions](../../../items/kit-legacy-sets-show-sessions.md)
- [spell-favicons](../../../items/spell-favicons.md) (Scriptorium done)

Carried forward:

- **Kit-parity:** offer the slots to Story Studio, with the open questions
  (aliases in the name sift, the 16-candidate cap, `restoreContext`, a generic
  `move.plan` op, the relative-path refusal and refusal wording that now reach
  every app, `appHome`), and the workspace-model divergence.
- **Cycle 3 (panes):** the move-plan confirm dialog; "ask for a location, last
  one preselected"; the map.
- **At the cutover:** turn the converter on, drop its flag and home check; 31 of
  Cole's 54 sessions will mirror a whole repository as their old workspace.

---

**Related Documents:**

- [Workspace Kit](../feature.md)
- [Workspace daemon — 2026-10-14](./2026-10-14-workspace-daemon.md)
