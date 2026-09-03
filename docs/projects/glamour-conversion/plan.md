# Glamour conversion — plan SKELETON

**Status:** **RATIFIED 2026-09-02** — 5 of 7 seams falsified or materially
corrected **Lead:** prospero **Created:** 2026-09-02 **Proposal:**
[`proposal.md`](./proposal.md)

> **This WAS a hypothesis. It has been ratified, and it did not survive
> intact.** Four seats returned verdicts (comms `#1119`–`#1123`). **Five of
> seven seams were falsified or materially corrected**, including two premises
> the lead asserted as fact. That is the method working, not a failure of it — a
> single author is most often wrong exactly at the boundaries between owners,
> and every correction below came from the owner who could see it.
>
> **Verdicts are recorded per seam. Where a seam was falsified, the correction
> is the contract now** — build to the correction, not to the original claim.

## ⛔ RULINGS (prospero, 2026-09-02) — what this pass settled, and what it did not

**PHASE 3 (build the backend) IS DROPPED.** Three seats reached it
independently. The benefit is structurally zero: a backend build exists to
**inline code that will not be at the destination**, and glamour's shipped path
imports only `node:` builtins — there is nothing to inline. astrolabe and magpie
build for one reason, measured: their backends import `printJson` from
`src/kit/lib/`, outside the copied subtree. imago and glamour each define a
**local** `printJson` instead. daedalus ran the post-Phase-1 layout deps-free as
plain `.ts` — exit 0, correct envelopes, with a positive control — so **Contract
3's default already delivers Phase 3's success criterion.**

> **Phase 3 is not cancelled; it is ordered behind a named condition.** glamour
> builds its backend the moment it **starts sharing** — if it ever drops its
> local `printJson` for the kit's. That is exactly the question spell-kit banked
> (_"whether the four remaining `printJson` copies should ever converge"_).
> **Owner of the trigger: whoever rules that convergence.** Recorded with an
> owner and an occasion rather than as an event nobody watches.

**S1 — reduce.ts is SPLIT, not moved whole** (contested; ruled once). daedalus
measured the two halves disjoint — server imports 16 symbols, the surface 4,
**intersection zero**. circe preferred `shared/reduce.ts` whole, calling the
split a refactor "no surface rewrite" does not license. **Ruled: split.** The
scope objection is answered by daedalus's own argument — shipping it wholesale
hands the surface **22 backend mutators it must never call**, which is the
misfiled-`.server` defect mirror-imaged. Not splitting reproduces the exact bug
this port exists to fix, so it is not gold-plating.

**acc L0 moves AHEAD of the port**, into its own project
([`../glamour-acc-l0/`](../glamour-acc-l0/proposal.md)), as the port's
**characterization harness** — `acc` is black-box and layout-blind, so
conformance established before survives the relocation and gives the port
before/after evidence it otherwise lacks. Blocked on an external acc release.

**WHAT THESE RULINGS DO NOT SETTLE** — named, because a long ruling that
silently omits an item is indistinguishable from one that resolved it:

- whether the **move-vs-copy** check is built here or filed
  (`docs/backlog/2026-09-02-nothing-can-tell-a-move-from-a-copy.md`)
- whether **ward 1a's `existsSync` guard** is in scope
  (`docs/backlog/2026-09-02-ward-1a-accepts-a-pinned-target-that-does-not-exist.md`)
- the **Bun-pin defect**, which is repo-wide and release-shaped
  (`docs/backlog/2026-09-02-the-bun-pin-does-not-govern-the-build.md`)
- whether **`acc` is wired into the gate** or stays a hand-run check
- the **surface-half selectors' filename and home** after the reduce split —
  circe's, unruled

## How this plan is authored

- **The lead owns** this skeleton, the seams, and the verification gate.
- **Each owner owns its lane file** (`plan/<seat>.md`) and writes it **only
  after** the seams it touches are ratified or falsified.
- **No owner moves a card `todo→doing` before ratifying every seam it touches.**
  Explicit verdict, never silence.
- **Say what you had read when you ratified** — _"ratified as of \<msg id\>."_
  Verdicts cross; a single in-flight message can falsify a contract someone is
  ratifying at that moment, and neither side can tell.
- **Record the GRAIN.** Not "ratified" but _"ratified at \<grain\>"_ — file
  boundary, module boundary, call signature, wire format. Building past the
  ratified grain silently manufactures a new seam.

## Integration / dependency order

**S1 gates everything.** Where the dual-consumer modules live determines what
"the surface" even is, so it is ratified first and nothing relocates before it.

```
S1 (dual-consumer modules)  →  S2 (what the daemon serves)  →  S3 (deployed identity)
                             ↘  S4 (tests survive the move)  ↗
S5 (scan scope on arrival) rides with the relocation.  S6 (acc) is severable at any point.
```

---

## Shared interfaces — ratify on comms, then fill

### S1 — a module consumed by BOTH sides · **RATIFIED at the SYMBOL grain; PREMISE FALSIFIED**

`reduce.ts` and `types.ts` under `surface/state/` are imported by `scripts/` and
by the surface. They are **not** simply backend files in the wrong folder.

> **CLAIM:** after the seam phase, **no module is imported by both `scripts/`
> and the surface from a location that belongs to exactly one of them.**

**The question this poses, which the owners are better placed to answer than the
lead:** where does a module both sides consume actually live, and **who owns
it** — the daemon, the surface, or neither? _(Note the third option is real:
`src/kit/` exists now and did not when imago and magpie faced this.)_

**Verdict + grain, and the corrections, are in comms `#1119`–`#1123`.**

### S2 — what the daemon serves · **RATIFIED at the SPECIFIER grain; INCOMPLETE in three ways**

`server.ts` currently does `import index from "../surface/index.html"` — a
bundler entry, not an ordinary import, and the one reference that survives S1.

> **CLAIM:** the daemon serves the **built artifact** where one exists and the
> live surface otherwise, and **the release path imports nothing from `src/`**.

**Verdict + grain, and the corrections, are in comms `#1119`–`#1123`.**

### S3 — what the deployed folder is · **FALSIFIED AS WRITTEN**

> **CLAIM:** glamour's shipped folder contains **no source a consumer could edit
> and no source a bundler would read** (Contract 4, source-free by FILES not by
> strings), and `bun scripts/dist-check.ts` counts **five** buildable spells and
> stays green.

**Verdict + grain, and the corrections, are in comms `#1119`–`#1123`.**

### S4 — the tests survive the move · **FALSIFIED — the stated hazard is the wrong one**

glamour keeps **7 tests in `tests/`**, not `scripts/` — one of the three spells
with that layout, so a glob written from a `scripts/`-shaped spell is blind to
all of them.

> **CLAIM:** after relocation every one of the 7 still **fails for its original
> reason** when its subject is broken. A test that goes green by pointing at a
> path that no longer exists has become vacuous, and that is **indistinguishable
> from passing** (Contracts 16, 20).

**⚠ The done-when for this seam must be keyed on the SUCCESSOR**, never on the
identifier the move deletes — that shape is green by construction.

**Verdict + grain, and the corrections, are in comms `#1119`–`#1123`.**

### S5 — glamour arrives conforming · **HALF ONE FALSIFIED · HALF TWO RATIFIED at the byte**

glamour's `styles.css` uses `@source "./**/*.tsx"` today.

> **CLAIM:** on arrival glamour satisfies Contract 21 (`source(none)` + a scoped
> `@source`), **and no other spell's shipped stylesheet changes by a single
> byte** as a consequence of glamour entering `src/`.

The second half is the testable one: the four existing spells are the control.

**Verdict + grain, and the corrections, are in comms `#1119`–`#1123`.**

### S6 — acc is severable · **SPLIT: ratified for Phases 1–2, FALSIFIED for Phase 3**

> **CLAIM:** the port completes and ships **without** acc, and adding acc L0
> later costs no rework of the earlier phases.

**If this is FALSE, say so early** — it changes the phase order, not the scope.

**Verdict + grain, and the corrections, are in comms `#1119`–`#1123`.**

### S7 — the playbook COMPRESSES on confirmation · **RATIFIED at a per-section delta + cold-read test**

`docs/playbooks/porting-a-spell-playbook.md` is **512 lines / 4,270 words / 10
gotchas** after **one** real port (magpie) and two rounds of repair. At that
rate it is ~1,000 lines by the time the roster is converted, and a 1,000-line
playbook is not a playbook — it is a log with a table of contents.

> **CLAIM:** the playbook may grow **only where glamour taught something the
> previous ports did not.** Anything glamour merely **CONFIRMS must make the
> existing text SHORTER and more confident, not longer.**

**The rule that follows, and the one most likely to be broken this port:**
imago, magpie and now glamour have each hit the misfiled-`.server` shape. **A
third instance is a signal to GENERALISE — one rule — not to add a third case
study.** The pressure at synthesis time is always toward appending, because
appending is easy and each anecdote feels earned.

**How it is judged, since length alone is a bad proxy:** a **fresh agent who did
not do this port** reads the playbook alone and says whether they could run one.
That read is the acceptance test. **A gotcha nobody can act on is bloat wearing
evidence's clothes.**

**Verdict + grain, and the corrections, are in comms `#1119`–`#1123`.**

---

## Slices

- **daedalus (engine)** — the backend half: S1's daemon side, S2, S3. Lane:
  `plan/daedalus.md`.
- **circe (surface)** — the surface half: S1's surface side, S4's subjects, S5.
  Lane: `plan/circe.md`.
- **cassandra (verify)** — S3 and S4 as the non-author, and the calibration that
  each new cell can fail. Lane: `plan/cassandra.md`.
- **thoth (grimoire)** — canon: whether this port moves a contract, and **S7,
  the playbook as synthesis** — the deliverable a future port actually consumes.
  Lane: `plan/thoth.md`.

## Verification gate

`bun run gate` (build + check + test) green, **unpiped**;
`bun scripts/dist-check.ts` exit 0 counting **five** spells; the installed
artifact runs with **no surface source present** at a destination that never ran
`install`.

## ⛔ Assert what is ABSENT

- **No new npm dependency.** glamour's shipped path imports only `node:*` today;
  if that changes, ward 1b is in play and this claim is falsified.
- **No kit extraction.** Nothing from glamour's components moves into `src/kit/`
  in this project, even where it obviously could.
- **No surface rewrite.** This is a relocation. bounty and grapevine are the
  rewrites and are not in scope.
- **No release.** This lands on `develop`. The release is held on the bounty
  `--stdin` defect.

## Open questions (lead, unresolved)

1. **Is the playbook sufficient?** This is its second real run. Where it fails
   to cover glamour, **the gap is the deliverable** — worth more than the port.
2. **Does S1 have a general answer?** imago, magpie and now glamour have each
   hit the misfiled-`.server` shape. If the third instance still needs bespoke
   thought, that is a finding about the pipeline.
