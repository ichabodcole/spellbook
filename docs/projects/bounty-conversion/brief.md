# Bounty Conversion — the brief

**Created:** 2026-09-06 · **Author:** Cole Reed (rulings) + Claude Code
(orchestrator) · **Mode:** loose — a brief, not a plan. Write your own plan
under this folder if you want one, or work straight from this document.

**There is no proposal for this branch, and that is deliberate.** Grapevine's
conversion needed one because nobody had done a rewrite yet. That question is
settled: [the porting playbook](../../playbooks/porting-a-spell-playbook.md) now
carries **Phase R** (rewrite) and **Phase S** (registry), both written from
grapevine's journals. **The playbook is the plan. This brief is the delta.**

---

## The mission

Rewrite bounty's board surface — today one hand-written 1,003-line HTML file,
`plugins/spellbook/skills/bounty/scripts/template.html` (Alpine over CDN,
hand-rolled CSS, no tests) — as a component-oriented React surface at
`src/bounty/surface/`, built through the spell pipeline, shipped as a committed
`dist/` the daemon serves. **Bounty becomes the seventh buildable spell.**

**Fidelity ruling (Cole, 2026-09-06): behaviour-faithful, restyled.** Same
routes, same WebSocket frames, same features, same failure handling. The look
moves onto the house token layer and shadcn primitives, so it will not be
pixel-identical, and it is not meant to be. **No new features** — a rewrite that
adds behaviour cannot be verified against the old one. File anything you want to
add under `docs/backlog/`; do not build it.

## Read this first, in this order

1. **The playbook, Phases 0 → R → S → 1 → 2 → 3, and every Gotcha.** Phases R
   and S were written for exactly this run. Read R7 twice — it is about you.
2. `docs/projects/grapevine-conversion/` — the exemplar.
   `behaviour-inventory.md` is the shape yours should take; `rewrite-journal.md`
   and `verify-journal.md` are what the playbook was compressed from, and they
   carry detail the playbook dropped.
3. `docs/projects/grapevine-shadcn/` — Phase S end to end, as its own branch.
   **You are not doing it as its own branch** (see below).

## The four things that make this port different from grapevine's

### 1 · The playbook is no longer silent — so your journal's job changed

Grapevine's implementer journalled because there was no phase to follow. You
have one. **Your journal is therefore a falsification record, not a discovery
record:** for each step of Phases R and S, note whether it held, where it was
_silent_ and you had to invent, and where it was _wrong_. A step that worked
exactly as written gets one line saying so — that is a real signal, because a
second confirming run is what promotes a phase from "written from one case" to
canon. Digestify is converted next by another agent against whatever this run
leaves behind.

### 2 · R7 — the b16 lockstep, and the seam it forces

`template.html` hand-mirrors tested `server.ts` helpers in Alpine. `server.ts`
exports 20 names; the pure predicates are the ones that matter —
`cardPassesFilter`, `cardOverdue`, `ownersOverWip`, `expectedMinutes`,
`computeDuePokes`, `isNoOpMove`, `isNoOpUpdate`, `validateTask`, `cleanTags`,
`snapshotTaskCount`. `server.test.ts` is 4,765 lines and tests them; the Alpine
mirror is tested by nothing. **No test guards that drift** — it is a known house
hazard, recorded in the orchestrator's memory as
`bounty-surface-lockstep-mirror`.

**The rewrite's job is to delete the mirror, not port it.** The R2 state modules
**import** the helper. That is a Phase 1 seam cut, which grapevine did not have:

- Sort by **consumer set, not filename** (Phase 1 action 2). Two-sided symbols
  go to `plugins/spellbook/skills/bounty/shared/`; daemon-only stays in
  `scripts/`. A module can be two-sided by file and **disjoint by symbol** —
  glamour's `reduce.ts` had 25 exports, 21 backend / 4 surface, intersection
  zero. Split by symbol; do not ship the daemon's mutators to the board.
- The surface then imports
  `../../../../plugins/spellbook/skills/bounty/shared/…`. This is the
  established pattern and the import-boundary wards permit it —
  `src/glamour/surface/state/fileIntake.ts:1` imports a **value** across it, so
  you are not limited to types. It is the direct reach into `scripts/` that is
  forbidden.
- **Do the seam cut in its own commit, before the surface exists**, with the
  gate green and the tree shippable — that is the whole point of Phase 1 landing
  before Phase 2. `server.test.ts` must go on passing across the move unmodified
  except for its import path; if a test needs its _body_ changed, the split is
  wrong.

**Verified for you, so do not re-litigate it:** bounty's backend imports nothing
outside its own folder today (`node:*`, `bun`, `./cli.ts`, `./server.ts`, and
nothing else). `shared/` lives **inside** the tracked skill subtree precisely so
a source-shipped daemon can reach `../shared/x`, so **Contract 3 row 1 still
holds after the seam cut**: the backend keeps shipping Bun-native `.ts` source,
`scripts/` + a `dist/` that is surface only. **Re-check this with your own grep
after the cut** — if anything ends up reaching `src/kit/`, Contract 3 flips to a
built `dist/cli.js` and drags acc conformance in front of it, and that is a
different branch. Come back and say so rather than absorbing it.

### 3 · Phase S runs INSIDE Phase R — primitives come from the CLI

Grapevine vendored hand-copied primitives in its rewrite and **paid for it with
a whole second branch**. Do not repeat that. `surface/ui/` is owned by the
shadcn CLI from the first commit that creates it: `base-nova` style on
`@base-ui/react`, `src/bounty` registered as a Bun workspace member, dependency
cap of `cn` + `class-variance-authority`. Phase S's S0–S6 tell you the rest,
including the three stylesheet needs and the overwrite trap (**Gotcha 11:
`--yes` does not answer the CLI's overwrite prompt**).

No custom button, badge, dialog, tooltip, select or input where a registry
primitive exists. Where the recipe and the board's look disagree, add a
**variant**, not a stacked override.

### 4 · The board is a drag-and-drop surface

Grapevine's was a feed. Bounty's is a kanban with drag-drop card movement,
filters persisted to `localStorage` under `bounty:filters`, WIP limits, overdue
poking and an `ended` terminal state. Two consequences:

- **The inventory must capture drag as behaviour**, not as markup — what starts
  a drag, what a valid drop target is, what `isNoOpMove` suppresses, and what
  the board does with a frame that arrives mid-drag. `x-cloak` on `<body>` is a
  row too (first-paint behaviour).
- **R8's per-key typing rule extends to pointer sequences.** A verifier's
  `dragTo()` is one synthetic event; the real interaction is down → several
  moves → up, and a bug that only shows between them is exactly the class that
  ate grapevine's focus regression. Say so in the inventory rows so the verifier
  drives it properly.

## Everything else follows the playbook

Layout, the build delegator, `bunfig.toml`, `styles.css`'s three opening lines,
the dev/release resolution, the spawn cwd pin (Contract 5 — **grep `spawn(` in
`cli.ts`**, grapevine's passed no cwd), `git rm` the page before the wards read
the index, un-ignoring `dist/`. All of it is in Phases R5, 2 and 3. Do not
reinvent it from the exemplars; the playbook already compressed them.

**The four wards that will red, and must be re-declared by hand (R6):**
kit-styling's `KIT_CONSUMERS`, gate-honesty's pin, import-boundary's pin, then
gate-honesty again on departure. Your specific pin:
`grimoire/gate-honesty.test.ts:218` carries
`"plugins/spellbook/skills/bounty/scripts/template.html": 1003` — that row
leaves, and the arithmetic reconciles **from the object's own sum**, not from
the last paragraph's total. Then the prose that names bounty's surface tier
drifts: `PROJECT-SUMMARY.md`, house-style's queue table, the decay ledger.

## Conventions that bite

- `bunx biome check --write` on changed `.ts/.tsx` **before every commit**.
  Prettier is for `.md` only — it fights biome's import sort.
- **Run the gate UNPIPED**, exit read from a file:
  `bun run gate > /tmp/g.log 2>&1; echo $?`. `| tail` reports tail's exit and
  has produced a false green here more than once.
- Commit in **story chapters**, not a WIP diary: inventory → seam cut → surface
  - build → daemon → wards + prose. Fold fix-ups into the chapter they fix.
- Every daemon you start gets its own `BOUNTY_HOME` (or equivalent) under the
  session scratchpad, and gets torn down. **Do not kill pids 23127 or 66902** —
  they are not yours.
- **Never stage, stash, commit or edit `skills-lock.json` or
  `.claude/skills/shadcn/`.** They are Cole's in-progress files. `git status` is
  never empty; that is correct.
- **Do not push. Do not merge.** The orchestrator reviews, a separate no-stake
  verify agent drives, Cole finalizes.
- Commit trailers:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.

## Records — equal weight to the code

Keep these current **as you go**, not reconstructed at the end:

1. `behaviour-inventory.md` — the oracle. Per R1: every route and query param,
   every WebSocket frame and the state it mutates, every persisted key, every
   visibility predicate, every timer, and **every silent branch** (an empty
   `catch {}` is a behaviour: "this error is not shown"). Each row carries the
   line range in `template.html` and a "how to drive it" step. Grapevine got 68
   rows from 1,000 lines. **Write it for the verifier, not for yourself** — an
   under-specified row is where grapevine's regression walked through.
2. `decision-log.md` — every choice **with the options not taken**, live.
3. `rewrite-journal.md` — the falsification record described above.
4. `sessions/2026-09-06-the-board.md` at the end — what shipped by sha, what was
   driven, what was not and why, what you would tell digestify's agent.

## Done means

- `src/bounty/surface/` exists, builds, `dist/` committed and byte-reproducible.
- The daemon serves it; `template.html`, its Alpine CDN `<script>` and its SRI
  pin are gone from the index and from disk.
- **The Alpine mirror is gone** — the board's predicates come from `shared/`,
  imported, and `server.test.ts` still guards them unmodified.
- Every inventory row is marked _driven_, _test cell_, or _not driven + why_.
  **A `not: <why>` row is a claim the verifier will run**, and five of
  grapevine's seven fell.
- Gate green (unpiped), `bun scripts/dist-check.ts` exit 0 reporting **7
  buildable spells**, the four wards re-declared, the `ward` skill run.
- All four records written.
