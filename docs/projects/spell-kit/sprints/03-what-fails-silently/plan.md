# Sprint 03 — What fails silently

**Status:** Planned (depends on Sprint 02's ruling) **Created:** 2026-08-30
**Project:** [spell-kit](../../proposal.md)

> **What this sprint delivers:** shared styling with per-app override — the
> third and last capability — and canon that finally describes the build that
> exists.
>
> **Its governing discipline, and its name:** the Tailwind `@source` hazard
> **fails silently.** A kit outside every current scan root emits **zero
> utilities, with no error**. So this sprint's proof cannot be tokens alone: it
> needs a **kit component using a kit token**, and an assertion that the utility
> reaches the built CSS. A tokens-only proof passes while leaving the mechanism
> untested.

## Read before you start — this is not a self-contained work order

**[R3](../../design-resolution.md#r3--theming-a-base-layer-with-per-app-override)
is the specification for Phase 4, and this plan carries only its consequences.**
The layer contract, the invariant that makes kit components safe, and the
condition under which the 95-site rename stays out of scope all live there. Two
of them are one-line traps: reference a single L1 alias and a 95-site rename
lands on the critical path; reference a token no other spell defines and the kit
fails **silently and visually** in every spell but one.

| Read this                                                                                 | Before  | Because                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [R3 — theming](../../design-resolution.md#r3--theming-a-base-layer-with-per-app-override) | Phase 4 | The L0/L1/L2/L3 layer contract, **"every token a kit component references must exist in L0"**, the three mechanical constraints the kit inherits, and the narrowed probe (its Open Question 2). |
| [The proposal's Slice 4 table](../../proposal.md)                                         | Phase 4 | It is the **needed / NOT needed** split — the full ~16-token L0, mind-mapper's renames and imago's light palette are all out. R3 rules the architecture; the proposal rules what gets built.    |
| [Sprint 02's emission ruling](../02-the-boring-module/plan.md)                            | Phase 5 | **Canon lands last because its wording depends on that ruling.** If option 3 won, Phase 5 also carries a narrow backend-build repeal.                                                           |
| [The ledger's vocabulary table](../../README.md)                                          | Phase 5 | **"Seam C"** just means _amend `house-style.md`_, and **`ward`** is both a check and the repo skill Phase 5 must run. Same word, two things, both in this sprint.                               |
| [The gap analysis's finding index](../../gap-analysis.md#finding-index)                   | Phase 5 | Phase 5's three mechanical dependents **are** finding I2, which is also the record that the `ward` skill was not invoked.                                                                       |

## The proof this sprint must produce

1. **One kit component renders correctly in both spells**, with imago overriding
   at least one L0 token.
2. A utility that **only** the kit component uses appears in the emitted
   `dist/index-*.css`.
3. `grimoire/house-style.md` describes the build that exists — Seam C, open
   since v2.2.0.

> **⛔ Both phases below end with what their gate CANNOT see, and in this sprint
> those blocks ARE the gate.** Phase 4's real check is the built-CSS assertion
> plus a human looking at two boards — `bun run check` reads no CSS, `bun test`
> builds nothing, and Tailwind reports success on zero output. Phase 5's ledger
> ward is **not** a `.test.ts`, so `bun test` never collects it. Read each
> phase's ⛔ block before you report it green; a green suite here means very
> little.

> ### Two constraints from the rulings, both load-bearing
>
> **The kit component must reference L0 tokens ONLY.** A single shadcn alias
> (`bg-accent`, `bg-popover`…) pulls the 95-site `accent`→`brand` rename onto
> the critical path. [R3](../../design-resolution.md) states this as a governing
> condition, not a preference.
>
> **imago's light palette is out of scope.** The base ships both palettes and
> mind-mapper exercises mode-override for free; imago proves _app_-override in
> dark only. A consequence worth stating: R3's preferred probe was a **theme
> switcher**, and a switcher cannot be proven in a one-palette spell — so the
> kit component is something smaller.

## Phases

### Phase 4 — Shared styling, with override (Slice 4)

**Goal:** one kit component renders with mind-mapper's value for an L0 token in
mind-mapper, and with imago's **overridden** value in imago, from one
implementation.

> ⚠ **The kit component is the load-bearing part and the reason this phase can
> fail silently.** Overriding a token in a spell's own markup proves nothing
> about the kit. `src/kit/` sits **outside every current `@source` scan root** —
> three spellings across the roster (`"./"` ×2 at `imago/surface/styles.css:6`
> and magpie, `"./**/*.tsx"` at glamour, `"./**/*.{ts,tsx}"` at astrolabe and
> `src/mind-mapper/surface/styles.css:4`) — and Tailwind's response to a
> component it cannot see is to emit **zero utilities with no error**. A
> tokens-only proof passes while leaving the real mechanism untested.

**Key changes:**

- `src/kit/theme/` — L0 base tokens, **a handful, not the full ~16**. Seeded
  from `src/mind-mapper/surface/styles.css:10-17` and its light override at
  `:54` — the only surface in the roster carrying **both** palettes. R3's
  four-layer mechanism is proven there; the kit's job is relocation plus a
  naming decision, not invention.
- The kit's own CSS **must carry its own `@source`**, resolved relative to the
  file that declares it, covering `src/kit/`'s components.
- **A built-CSS assertion.** After `build.ts` runs, assert a utility that
  **only** a kit component uses appears in the emitted `dist/index-*.css`. This
  is the only check that can catch the silent-zero-utilities failure;
  `bun run check` never reads CSS at all.
- mind-mapper's `styles.css` imports the kit base and keeps its own values.
- imago's `styles.css` imports the kit base and **overrides at least one L0
  token** — proving L2 works.
- **One kit component**, styled in **L0 tokens only**.

**Two constraints that keep this phase from swallowing the sprint:**

1. **The kit component must reference L0 tokens only — never an L1 shadcn
   alias.** R3 rules imago's brand slot renamed out of shadcn's namespace
   (`--color-accent` → `--color-brand`, **95 sites**), and the proposal's
   Slice-4 table puts that rename out of scope. **Both hold simultaneously if
   and only if the kit component touches no alias**, because L1 is imported only
   by spells consuming `kit/ui/`, and nothing here does. **The moment the
   component uses `bg-accent` or any alias, the 95-site rename lands on the
   critical path.** Hold the line here.
2. ~~The proposal and R3 disagree about imago's light mode~~ — **RULED, and this
   phase is not blocked.** _(An earlier draft called it unresolved and linked a
   section that no longer exists.)_ The reconciliation is in
   [R3's Open Question 2](../../design-resolution.md): **R3 rules the
   architecture** — the base ships both palettes and mind-mapper exercises
   mode-override for free — **the proposal rules what gets built** — imago
   proves _app_-override in dark only. Its 24-value light palette is **out of
   scope**, and the consequence is stated in this sprint's header: the kit
   component is something smaller than a theme switcher.

**This phase is done when:** the same component file renders with two different
computed colours in the two spells, screenshotted or asserted; and the built CSS
contains a kit-only utility. **Both halves are required** — the first alone
passes with a kit whose utilities were never emitted and whose component happens
to inherit.

#### ⛔ What Phase 4's gate cannot see

_Everything that matters. Everything above can be green while all of this is
true._

- `bun run check` reads **no CSS**; `bun test` **builds nothing**; Tailwind
  reports success on **zero output**.
- **This phase's real gate is the built-CSS assertion plus a human looking at
  two boards.**

---

### Phase 5 — Seam C: canon stops contradicting the tree

**Goal:** a fresh agent reading `grimoire/house-style.md` is not misled about
the build.

**Key changes:**

- `grimoire/house-style.md:361` — `## The build (there isn't one)` is false;
  v2.2.0 shipped one and this project ships three. Rewrite the section and the
  `self-contained-no-build` rule (`:363`, rule-id at `:365`).
- **Prefer `.anthill/dev/seams.md` Contract 3's wording**, which already says
  what the replacement is and explicitly warns: _"Shipping a duplicate rule
  beside the old one, or stacking two repeal phrasings, drifts the canon. Merge
  into one."_ Contract 4's "identity reframe" supplies the other half —
  self-contained now describes the **deployed** folder, not the dev layout.
- **Three mechanical dependents, all of which must move in the same change:**
  - `grimoire/rule-id.test.ts` — every rule heading carries a unique rule-id;
    clause ids are namespaced under their parent.
  - `grimoire/decay-ledger.md:80` — the `self-contained-no-build` row, under
    `scripts/instruments/canon-ledger-ward.ts`'s injective pairing check. **If
    the rule-id changes, the ledger row must change with it.**
  - `house-style.md:396-397` — `✅ 63` / `❌ 37`, stale at HEAD (**64** /
    **38**) and moved again by Phase 1c (**56** after the split). Correct the
    numbers _and_ the surrounding claim about which three spells keep tests in
    `tests/`.
- If Phase 2's ruling chose option 3, canon must also carry the **narrow**
  backend-build repeal — for one spell, per Contract 3's own criterion.
- **Run the `ward` skill.** Its trigger is literally _"changing a house-style
  convention"_ and the gap analysis ([I2](../../gap-analysis.md#finding-index) —
  _Seam C is canon with three mechanical dependents_) records that it was not
  invoked.
- **Update `.anthill/dev/seams.md`** — its own write-trigger is _"whoever moves
  a boundary updates this file and its proof — in the same change."_ This
  project moves Contract 4's boundary (three spells now), Contract 5's cwd pin
  (two more spells), and adds R1's `shared/` and R6's two wards.

**This phase is done when:** `bun scripts/instruments/canon-ledger-ward.ts`
exits 0, `bun test grimoire/rule-id.test.ts` is green, and the three counts in
`house-style.md:396-397` reproduce when run.

#### ⛔ What Phase 5's gate cannot see — and it is a real hole

_Everything above can be green while this is true._

- `canon-ledger-ward.ts` is **not** a `.test.ts`, so **`bun test` never collects
  it**. A `house-style.md` edit that breaks the ledger pairing passes the team
  gate (`check && test`) green. **It must be run by hand.** _(Already recorded
  at `.anthill/dev/thoth.md:459`, found the same way — by applying a
  discriminator to a grep that returned seven files of which five merely named
  the file.)_

---

## ⛔ What this sprint's gate cannot see

_The sprint can be reported green while every one of these is true._

- **`canon-ledger-ward.ts` is not a `.test.ts`, so `bun test` never collects
  it.** A `house-style.md` edit that breaks the decay-ledger pairing passes the
  team gate **green**. Phase 5 must run it by hand — verified: it exists, it
  passes today, and nothing would have told you if it didn't.
- **Nothing in `bun test` runs `build.ts`.** Proof 2 either shells out to a
  build or reads a committed `dist/` whose freshness nothing gates. **Say which,
  in the phase.**
- The `@source` assertion proves the utility _reached_ the CSS, not that the
  component _renders correctly_ — that is an eyeball, and this sprint should say
  so rather than imply the check covers it.

---

**Related:** [proposal](../../proposal.md) ·
[design-resolution](../../design-resolution.md) ·
[Sprint 02](../02-the-boring-module/plan.md) · [project ledger](../../README.md)

---

_Reconciled 2026-08-31 @ `9b6d8e5` — swept after sprint 01 landed. **⛔ STALE
PATH CITATION:** `imago/surface/styles.css:6` is now
`src/imago/surface/styles.css`. astrolabe's and imago's `@source` directives
both survived relocation intact (verified by drive: Tailwind utilities emitted
and applied in both spells' release builds). **NEW WORK THIS SPRINT HANDED TO
PHASE 5's CANON PASS**, none of it written yet — four instrument-design rulings
returned by seats and deliberately not landed in `house-style.md`, because Seam
C's wording waits on the emission ruling: (1) **an exemption must carry a cell
that FAILS when the exemption is removed — and the cell must evaluate it, not
describe it**; (2) **a "must not be served" cell is vacuous until the thing it
forbids would otherwise resolve** — plant the target, then assert the refusal;
(3) **a partition argument licenses a claim about CLASSIFICATION, never about
COVERAGE** — ask what the classifier never sees; (4) **a pinned site's identity
is (file, spec, resolved); the line is reported, never compared** — ruled and
shipped in the ward at `5253b72`, but not yet canon. **Also owed here:** this
plan's `house-style.md:396-397` arithmetic. Measured **65 / 39** at `3e00e73`,
not the 64 / 38 recorded; with **7** tests moving (not 8 — the straddler was
ruled to stay backend), the first figure lands at **58**, not 56._

---

_Reconciled 2026-08-31 @ `5d32bfa` — swept after sprint 02 landed. **INHERITED,
and larger than when this plan was written.** `src/kit/` now exists with two
inhabitants (`printJson`, `cn`), so Phase 4's kit component has a home and Ward
2 is **live rather than vacuous** — it has been made to fail. **⛔ NEW SCOPE,
ruled into this sprint by Cole 2026-08-31: magpie's SURFACE is still
unrelocated.** Slice 2 relocated magpie's *backend* and left its surface in the
spell folder — the only spell in a split state. 27 files, ~3,235 lines. It is
safe today because Contract 1 keys release mode on `dist/index.html`
specifically rather than on `dist/` existing, so magpie correctly stays in dev
mode. **A relocated surface is a precondition for magpie consuming
`src/kit/theme/`, which is this sprint's subject.** **STILL OWED to Phase 5's
canon pass** (unchanged, none written): the four instrument-design rulings, and
the `house-style.md:396-397` arithmetic — measured **65 / 39**, not the recorded
64 / 38, and with **7** tests having moved the first figure lands at **58**.
**NEW for Phase 5:**
`docs/backlog/2026-08-31-ward-routes-an-unbuilt-surface-edit-to-chore.md` now
has a **second surface** — a backend edit in `src/<spell>/backend/` also changes
nothing under `plugins/spellbook/` until built. The fix must be written over a
**derived** set of build-input→output pairs, never a hardcoded surface→dist
pair._
