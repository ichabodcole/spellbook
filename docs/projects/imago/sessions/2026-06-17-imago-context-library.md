# Session — imago Unified Context Library

**Date:** 2026-06-17 · **Branch:** `feat/imago-context-library` (off `develop`)
· **Spell:** imago

## What shipped

Collapsed imago's two separate reusable-text stores (`styles[]` + `prompts[]`)
into **one passive Context Library** (`library: ContextEntry[]`), where every
consumption site is a **linked set** of ids over that catalog:

- `activeContextIds` — styles attached to the next generation (the
  active-context tray).
- `quickPromptIds` — prompts surfaced in the composer.

The everyday ✕ is an **unlink** (non-destructive — the entry stays in the
library); the **only** destroy is a guarded two-step `context.delete` in the
library pane. This kills the prior destructive-delete footgun (cole had lost the
seeded "anime" style). `kind` (`prompt`/`style`/`skill`/`context`) drives
behavior + default filter but is **not** a hard router — membership (the link)
surfaces an item. No `archived` flag (by design — unlink replaces it).

Design + plan: `context-library-design.md`, `context-library-plan.md`. Prior art
mined: StoryLoom's context library (`~/Projects/dreamwood/story-loom`) — its
"passive catalog, consumers hold references" lesson is the model here.

## Surface

- A skinny **vertical icon rail** switches the left pane between **Images**
  (`GenerationsRail`, untouched) and **Context** (new `ContextLibrary` pane).
- **Context pane**: kind facets (All/Prompts/Styles), entry cards with edit /
  link / two-step delete, per-kind "+ New".
- **Active-context tray** in the bottom drawer (mirrors the References tray):
  drag a style in or use the picker to link; ✕ unlinks.
- **Reusable `LibraryPicker`** — the universal "link from library" UI, used by
  the tray and the composer; renders via a `document.body` **portal** (fixed,
  anchored to the trigger) so it escapes drawer/dropdown stacking + overflow.
- **Composer quick-prompts** read `quickPromptIds`: pick fills the composer, "+
  New prompt" creates-and-links in one step, "Link from library" adds an
  existing prompt, ✕ unlinks.
- **Style capture** rewired to `context.capture`; the agent answers with
  `context.add { kind:"style", …, link:"active" }`.

## Contract / server / CLI

- Contract (`types.ts`): `ContextEntry`/`ContextKind`/`ContextSet`; messages
  `context.add/update/delete/link/unlink/capture` (browser) + `context.add`
  (agent); `AGENT_EVENT_TYPES` `style.capture` → `context.capture`.
- Server: handlers + `addContextEntry`/`linkContext`/`unlinkContext`; style
  upsert-on-normalized-name; `context.delete` cleans both sets **and** the
  on-disk `imagePath`; lean projection strips `image`, passes the sets through.
- Restore migration: legacy `styles[]`/`prompts[]` → unified `library` + sets,
  resetting the default-seeded collections first (gated on `isLegacyContext`) so
  legacy snapshots don't produce duplicate ids; deterministic `style-<slug>`
  ids.
- CLI: `style`/`prompt` verbs replaced by one
  `context <kind> <name…> [--content --image --link --tags]` posting
  `context.add`.
- SKILL.md updated to the new agent contract; stale `state.refs[].selected`
  corrected to `state.batches[].variants[].refSelected`.

## How it was built

Subagent-driven (fresh implementer + spec/quality review per task; whole-branch
review at the end). **10 tasks** (3 strict-TDD server/contract, 1 pure-helper
TDD, 5 live-verified surface) + a **CLI migration (Task 10, a plan gap caught at
Task 9)** + a **fixes commit**. One fix loop in Task 3 (a Critical duplicate-id
on legacy restore). Whole-branch review (opus): **ready to merge**, no
Critical/Important.

## Live e2e (fresh daemon, Playwright)

Verified the full loop: switcher, context pane + facets, link via button **and**
picker, non-destructive unlink, two-step delete (line art genuinely removed —
confirmed against `/state`), quick-prompts pick/list, data integrity
(`activeContextIds`/`quickPromptIds`/deterministic ids). Caught two real UI bugs
fixed before merge: the **LibraryPicker stacking/clipping** (→ portal) and a
context-pane prompt-card mislabel. Capture loop not live-walked (needs a focused
generation); the button is correctly focus-gated and the event emission is
unit-tested.

## Result

107 tests pass (was 97 pre-feature). Tests, build, biome all green.

## Deferred (non-blocking)

- ContextLibrary "All" facet renders `library` raw — would show reserved
  `skill`/`context` kinds if any existed (none do).
- LibraryPicker scroll-orphan edge (picker floats if the trigger scrolls fully
  out of view while open) — cosmetic.
- `cli.test.ts` covers `parseArgs`, not the assembled `context.add` message (the
  live e2e exercised the real verb→server path).
- Reserved kinds `skill` / `context` (world-context) — future passes.
- Projects (per-project scoping of the linked sets) — the sets are the seam;
  separate backlog item.
