# Spell Kit — design resolution

**Status:** Draft — resolving the proposal's blocking questions one at a time\
**Created:** 2026-08-30\
**Related Proposal:** [proposal.md](./proposal.md)\
**Author:** Cole Reed + Claude Code

---

## Overview

The [gap analysis](./gap-analysis.md) returned **seven blocking findings**
against the proposal. This document resolves them as they are decided, so the
proposal records the _shape_ of the work and this records the _rulings_. It is
being filled incrementally; unresolved items stay in the proposal's status
banner.

| #   | Blocking question                                                                               | Raised as | State                             |
| --- | ----------------------------------------------------------------------------------------------- | --------- | --------------------------------- |
| 1   | Where do imago's `types.ts` / `imageOptimize.server.ts` live?                                   | **B1**    | ✅ **RESOLVED — see R1**          |
| 2   | `presence`/`activity`/`buildInfo` — unwired, or cross the gate?                                 | **B2**    | ⏸ **moot — kit breadth descoped** |
| 3   | **Theming — does one palette replace the other?**                                               | **B3**    | ✅ **RESOLVED — see R3**          |
| 4   | Is there a shared context type at all?                                                          | **B4**    | ⏸ **moot — K2 descoped**          |
| 5   | What happens to `DECLARED_BLIND`?                                                               | **B5**    | ✅ **RESOLVED — see R5**          |
| 6   | Restate the invariant over the right denominator                                                | **D3**    | ✅ **RESOLVED — see R6**          |
| 7   | Migrate or formally drop astrolabe                                                              | **D1**    | ✅ **RESOLVED — see R7**          |
| —   | **RB · what building the backend would cost** _(not one of the seven, but it governs the gate)_ | —         | ✅ **RESOLVED — see RB**          |

### Three id series run through these documents, and they are not the same series

- **`B…` / `D…` / `I…`** — [gap analysis](./gap-analysis.md) findings, cited
  elsewhere by bare id. The **Raised as** column above is the crosswalk for the
  seven blocking ones; the [finding index](./gap-analysis.md#finding-index) is
  the legend for all of them. _(The letters are not section labels: `D1` and
  `D3` are Blocking findings.)_
- **`Q<n>`** — a blocking question **by number**, i.e. a row in the table above.
  Each is closed by the like-numbered ruling: `Q1`→R1, `Q5`→R5. Where this
  document says `Q1` it means the question; `R1` means the ruling that closed
  it.
- **`OQ<n>`** — an **open** question, a third series. In the gap analysis these
  are the **superseded first draft's** open questions; the rewritten proposal
  has none. R3 keeps its own [Open Questions](#open-questions-r3).

**Reading order, and where corrections live.** Each ruling below is
self-contained and can be read alone. **A correction made after a ruling was
first written is folded into the section it corrects, marked ⚠, and placed ahead
of the text it changes** — never appended below it. Where a later ruling
_narrowed_ an earlier one, the ⚠ pointer sits at the claim as well as in the
ledger it was recorded in. The rule exists because the old arrangement cost a
defect: a reader who stopped at R6's confident ward statement got the retracted
version and built it (Sprint 01 Phase 0, once).

---

## R5 — `gate-blind-set` gains a second root

**Resolved 2026-08-30 (Cole):** _"extend to a second root."_

### The problem

`gate-honesty.test.ts` pins the blind set — the shipped, hand-authored files
`bun run check` structurally cannot read — by **exact path and line count**, and
fails until a change is re-declared. Slice 1 relocates six of those files
(imago's `styles.css` 151 · `index.html` 13 · `bunfig.toml` 2 = **166**;
astrolabe's 93 · 35 · 2 = **130**). The suite goes red deterministically.

**Shrinking the declaration is defensible and still wrong.** The instrument asks
_"of the **shipped, hand-authored** files under `plugins/spellbook/skills/`,
which can `check` not read?"_ — and after relocation those files genuinely are
no longer shipped-and-hand-authored; what ships is a generated `dist/`. So the
answer legitimately gets smaller.

**But the blindness does not shrink — it relocates.** The files are still
hand-authored and still unread; they moved to `src/`, where the instrument does
not look. **An instrument that loses sight of files when they move is the silent
filter this repo keeps scarring on** — and this ward is the one that exists
specifically to stop blindness going unnoticed.

### Ruling

`gate-blind-set.ts` enumerates **two roots** — `plugins/spellbook/skills/` and
`src/` — so relocated files stay counted. `gate-honesty`'s pin covers the union.

### Both roots are the steady state, not a bridge

Measured over the current 16 files / 4,166 lines:

| Fate under a **full** build migration                                             | Files |     Lines |
| --------------------------------------------------------------------------------- | ----: | --------: |
| **Moves to `src/`** — the 4 React spells' `styles.css`/`index.html`/`bunfig.toml` |    12 |   **513** |
| **Needs a surface rewrite** — digestify + bounty + grapevine HTML                 |     3 | **3,508** |
| **Never moves, never gateable** — `magpie/scripts/remove.py`                      |     1 |   **145** |

**Root 1 can never empty.** `remove.py` is a permanent resident — backend
Python, in the shipped tree, which no surface migration relocates. House style
explicitly allows it: _"Bun-first, may orchestrate other runtimes behind one
interface."_ **Root 2 acquires 513 lines permanently**, since CSS and HTML are
outside biome's default reach wherever they live.

**Convenient consequence:** the ward's zero-guard
(`expect(Object.keys(DECLARED_BLIND).length).toBeGreaterThan(0)`, which stops
the pin passing vacuously) survives unchanged — root 1 cannot empty, so it never
needs to become per-root.

### Follow-on, filed separately

Cole, ruling this: _"maybe an area to look into additional types of checkers
other than biome at some point."_ **Measured immediately, and the answer is
better than expected: biome 2.4.16 already parses and lints CSS and HTML,
including JS inside inline `<script>`.** The exact failure `gate-honesty`
documents — an injected syntax error passing green — is closable by a
`biome.json` change. **96% of the blind set is self-inflicted by our own
`includes` list.**

Filed as
[`biome-already-reads-css-and-html`](../../backlog/2026-08-30-biome-already-reads-css-and-html.md),
with the warning that a clean `template.html` already yields 7 errors — so it is
a project, not a flag, in the same shape as the typecheck gate.

> **R5 does not wait on it.** R5 is a few lines and unblocks Slice 1. If the
> checker item later lands, R5's population drops to ~153 lines (Python + TOML)
> and the second root's job becomes guarding that it stays there.

---

## R1 — A per-app `shared/` folder, and a three-way rule

**Resolved 2026-08-30 (Cole):** _"extract into a shared folder that the server
and surface can import from — shared **within** the app, not across apps."_

**This is a better answer than the one recommended.** The earlier proposal put
the contract in `scripts/`, following astrolabe. That works, but `scripts/`
means _"the backend"_, and filing a two-sided contract there says it is
backend-owned when it is a **peer of both**. A named `shared/` says what is
true. astrolabe stays as it is — it is a precedent for the _direction_, not the
folder name.

### Where it goes

```
plugins/spellbook/skills/imago/       ← the shipped artifact
├── shared/     both sides legitimately need it   → server imports as a sibling ✅
├── scripts/    only the daemon executes it
└── dist/       built surface
src/imago/surface/                    ← authored here, bundled, never shipped
```

`shared/` **must** live in the shipped tree: the daemon runs from source at a
destination that never ran `install`, so anything it imports has to be there.
The surface reaching `src/ → plugins/` is a **build-time edge only** — bundled
and erased — and it is unavoidable for the same reason, whichever folder name
wins. Satisfies [R6](#r6--the-shared-import-wards-and-imagos-test-split):
nothing under `plugins/spellbook/` imports outside it.

### The three-way rule

`server.ts` reaches into `surface/` for **three** things, and each has a
different correct destination:

| Import                               | What it really is              | Goes to                                |
| ------------------------------------ | ------------------------------ | -------------------------------------- |
| `surface/index.html`                 | the surface itself             | **stays** — handled by `resolveMode()` |
| `surface/state/imageOptimize.server` | **daemon-only code, misfiled** | `scripts/`                             |
| `surface/state/types`                | the two-sided wire contract    | **`shared/`**                          |

> **`shared/` — what both sides legitimately need · `scripts/` — what only the
> daemon executes · `surface/` — what only the browser needs.**

#### Applied to imago: three files move, not two

⚠ **Corrected on review 2026-08-30, and this is the corrected version.** The
three-way table above sorts **import sites**, and read at that granularity it
looks like two files move. It is three. The correction is folded in here rather
than appended below the ruling, because the two-file reading is itself
actionable and wrong: build from it and you re-open the seam in the other
direction.

| File                              | Used by                | Goes to             |
| --------------------------------- | ---------------------- | ------------------- |
| `state/types.ts` (the contract)   | daemon **and** browser | **`shared/`**       |
| `state/imageOptimize.ts` (policy) | daemon **and** browser | **`shared/`**       |
| `state/imageOptimize.server.ts`   | daemon only            | `scripts/`          |
| `state/fileIntake.ts`             | browser only           | stays in `surface/` |

**What the earlier reading missed.** Found by the dev-plan agent:
`surface/state/imageOptimize.server.ts:6` imports
`{ OPTIMIZE } from "./imageOptimize"` — a 5-line browser-safe policy module that
`surface/state/fileIntake.ts:2` also uses. Move only the `.server` half to
`scripts/` and you have created a **new** `scripts/` → `surface/` value import:
exactly what R1 exists to remove, re-opened in the other direction.

**The rule was not wrong — it was applied to too coarse a unit.** `OPTIMIZE` is
used by the daemon path _and_ the browser path, so by R1's own test it is
**two-sided** and sorts to `shared/`.

**The general lesson, worth carrying into glamour and magpie:** sort at the
level of the _module_, and check what each candidate itself imports. A
daemon-only module that depends on a browser-safe one drags the boundary with
it. glamour's `persist.server`/`styles.server` and magpie's
`persist.server`/`source.server` must each be checked the same way before they
move.

### The `.server.ts` family: the convention already marks them

The misfiling is not imago's and it is not one file. **Six `*.server.ts` modules
sit inside `surface/` across three spells** — imago 1, glamour 3 (`styles`,
`imageOptimize`, `persist`), magpie 2 (`source`, `persist`) — and **every one is
imported by ZERO surface `.tsx` files.** They are backend code wearing a suffix
that already says so, filed on the wrong side of the line.

_(Measured carefully: an earlier grep appeared to show the surface importing
`imageOptimize.server`. It was matching a **comment** —
`"The sharp-based implementation lives in imageOptimize.server.ts"` — and the
file itself. No surface module imports it.)_

### It generalizes to the other two spells

The rule resolves all three React spells' coupling, and shows a category the
import-site view hides — **genuinely shared _logic_**, not just types:

| Spell   | → `scripts/` (daemon-only)        | → `shared/` (two-sided)                        |
| ------- | --------------------------------- | ---------------------------------------------- |
| imago   | `imageOptimize.server`            | `types`, **`imageOptimize`** (the policy half) |
| glamour | `persist.server`, `styles.server` | `types`, **`reduce`**                          |
| magpie  | `persist.server`, `source.server` | `types`, **`reduce`**, `alpha`, `versions`     |

So `shared/` holds the contract **and** shared logic — exactly as scoped: within
an app, never across.

⚠ **imago's second `shared/` entry is the correction above, carried into this
table** — a 5-line policy module, and the smallest possible instance of the same
category as glamour's and magpie's `reduce`. **glamour's and magpie's rows have
not had the module-level check run against them**; per the lesson above, each
`.server` file must be checked for a browser-safe sibling before it moves.

### Scope note

`types.ts` is **not** split. 12 of its 25 exports are two-sided (3 values —
`defaultState`, `MARK_TOOLS`, `styleId` — and 9 types), which is enough that
carving out a subset is surgery for a modest payoff, and it is the kind of
design work the reshaped scope defers. **The file moves whole.**

---

## R6 — The shared-import wards, and imago's test split

**Resolved 2026-08-30 (Cole):** _"mind-mapper style, and ward over
`plugins/spellbook`"_ — extended the same day, on the Nx precedent, to a second
direction: _"it's a one-way street."_ Replaces the first draft's invariant,
which the [gap analysis](./gap-analysis.md) correctly showed was scoped to the
wrong denominator.

**There are two wards, guarding two different directions.** The first keeps the
**artifact** self-contained; the second keeps the **kit** app-agnostic. Neither
implies the other, and only the first was in the original ruling.

### Ward 1 is TWO checks — read this before building either

⚠ **Corrected on review 2026-08-30. A single-predicate Ward 1 is retracted, and
this is the correction, placed ahead of the ward statements rather than after
them.** Sprint 01 Phase 0 was drafted against the retracted version while it
still sat further down the page — this ruling's own cautionary example, and the
reason corrections in this document now live inside the section they correct.

|                     | Predicate                                                                                                                                         | Why                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **1a · structural** | no **relative** specifier under `plugins/spellbook/` resolves outside it                                                                          | the subtree is path-self-contained. Green today.                                                                                      |
| **1b · dependency** | no file on the **shipped execution path** (`scripts/`, `shared/` — **not** `surface/`) statically imports a bare specifier outside `node:`/`bun:` | `surface/` bare imports are erased by the bundler and are fine; a `scripts/` one must resolve at a destination with no `node_modules` |

#### Why one check could not do both jobs — the correction, recorded

The retracted phrasing was _"may not **statically import** outside
`plugins/spellbook/`."_ The measurement behind it counted **relative specifiers
only** — and the two are not the same ward. Read literally, the English also
covers **bare** specifiers, of which there are **95** today, across **65
files**:

| specifier             |   count | where                                                    |
| --------------------- | ------: | -------------------------------------------------------- |
| `react` / `react-dom` |      49 | the four React spells' `surface/`                        |
| `lucide-react`        |      42 | ditto                                                    |
| `bun` (types)         |       4 | the exemption R6 measures below                          |
| ~~`sharp`~~           | ~~1~~ 0 | retired 2026-08-31 — swapped for `Bun.Image` in Phase 1b |

> ### ⚠ This table said 88 / 34 lucide-react, and it was undercounted by a LINE-BOUND SCAN
>
> **Corrected 2026-08-31.** thoth re-measured while authoring the ward and got
> 95; the lead re-measured to check him, got 34 lucide-react again, and **was
> reproducing the original defect** — a regex requiring `import` and `from` on
> one line cannot see a statement that spans lines. **Exactly 8 `lucide-react`
> imports span lines**, and lucide imports span lines because their symbol lists
> are long. A multi-line-aware scan returns 42, matching thoth's independent
> count on every specifier.
>
> **Two methods converging is not the check — the unit is.** Both counts are of
> **import _sites_**, not files. The sprint plan said _"88 correct **files**"_;
> that was wrong on the number and on the unit, and is corrected there too.
>
> **The mechanism is now a ward cell**, not a note: making `STATIC_RE`
> line-bound turns thoth's cross-check red with 30+ missing.

**Neither reading is the ward the project needs.** As measured it is green on
arrival and **structurally blind to the one escape that actually breaks a
deps-free destination** — `sharp`, which stops the shipped imago daemon booting
at all ([filed](../../backlog/2026-08-30-imago-daemon-cannot-start-offline.md)).
As stated it is red on arrival with **95** violations, against correct code —
the exact failure this ruling already anticipated on the dynamic axis and then
reproduced on the static one.

### Ruled during Phase 0, 2026-08-31 — two population questions R6 did not answer

thoth hit both while authoring the wards and correctly refused to settle them
in-lane.

**`*.test.ts` under `scripts/` is OUT of ward 1b's population.** 38 of the 78
files there are tests. Ward 1b's subject is the **shipped execution path** —
what a daemon or CLI actually loads at a destination that never ran `install`. A
test file ships but is never executed by a consumer; it is inert cargo, not an
execution path. Measured both ways at ruling time: **0 violations either way**,
so the ruling costs nothing today and can be revisited the moment it does not.

> **⚠ The hole this leaves is real and is NOT a ward gap.** A `*.test.ts` under
> `scripts/` still **ships** to a consumer who cannot resolve its imports. That
> is a **packaging** question — the same family as _"what does a consumer
> receive, per spell"_ already carried to Cole (see
> [RC](#rc--mind-mappers-standing-as-the-kits-source-d2)). It routes there, not
> into ward 1b, and widening 1b to cover it would answer a packaging question
> with a dependency instrument.

**Inline type queries are RECLASSIFIED, not exempted — and this overrides the
lead's first ruling on it.** `export type X = import("../../outside").Y` emits
nothing at runtime, and cassandra measured it failing ward 1a's **dynamic**
pinned inventory against correct code. The lead ruled: _"exempt it, on exactly
the reasoning that exempts `import type`."_

> **⛔ That ruling carried a false premise about the ward it was ruling on.**
> **`import type` is not exempt in this ward** — including it is the entire
> reason the scanner is a text scan rather than `Bun.Transpiler`, which
> unconditionally erases it. Applied literally the ruling would have exempted
> `import type` too and collapsed the scanner into the parser it exists to
> avoid, opening a **one-line bypass**: a type query invisible while the
> identical dependency written as `import type { X } from "../../out"` stays a
> violation. Same dependency, same `tsc` breakage, same nothing-at-runtime.
>
> **thoth fixed the finding and escalated the reason rather than obeying it** —
> the correct move, and the one this team's SOP asks for. Type queries get their
> own `kind: "type"`, which **rides with `static`** for ward 1a's escape check
> and is **excluded from the dynamic pin**, whose subject is imports deferred to
> a call — which a type query never is.
>
> **What makes the heuristic safe is a partition, not a judgement:** ward 1a
> checks `static` + `type` for escapes and `dynamic` against the pin, and the
> three are exhaustive. **A misclassification moves a finding between cells; it
> can never remove one.**
>
> _The general lesson, recorded because it will recur: **a ruling can carry a
> false premise about the code it rules on**, and obeying its reason rather than
> fixing its finding is how a correct instruction installs an incorrect
> invariant. The finding was real; the reason attached to it was not._

**Non-`.ts` surfaces are OUT of ward 1a's scope for this project.** A
`<script src="../../x.js">` in a hand-authored `.html` is an escape by any
reasonable reading and is invisible to all three wards. **thoth's observation is
the right one: that population IS the blind set, so the two holes are one hole
seen from two sides.** It already has a declared instrument — `DECLARED_BLIND`,
which R5 just extended to a second root — and teaching ward 1a to parse HTML
would build a second, weaker instrument over a population that already has one.

> **⚠ But the blind set DECLARES those files; it does not INSPECT them.** A
> declared-blind `.html` carrying a relative escape is counted and unread. The
> remedy is
> [the biome backlog item](../../backlog/2026-08-30-biome-already-reads-css-and-html.md)
> — biome 2.4.16 already parses CSS and HTML including inline `<script>`, which
> would shrink the blind set to ~153 lines — **not** a ward. Recorded in Phase
> 0's "what its gate cannot see" block.

---

### Ward 1a — outward: the artifact is self-contained

> **No tracked file under `plugins/spellbook/` may STATICALLY resolve a RELATIVE
> specifier outside `plugins/spellbook/`.**

**Measured at HEAD before adopting it — 206 tracked `.ts`/`.tsx` files**
(relative specifiers, which is what 1a governs; the bare-specifier population is
1b's, and is counted in the correction above):

|                                              | count |
| -------------------------------------------- | ----: |
| static imports escaping `plugins/spellbook/` | **0** |
| dynamic `import()` escaping                  | **1** |

The single dynamic escape is `mind-mapper/scripts/server.ts:552` →
`src/mind-mapper/surface/index.html`: Contract 1's **dev-only** mode resolution,
dynamic **on purpose** so a release daemon never pulls the surface build graph
into its load path. **A ward phrased over all imports would be red on arrival,
against correct code.**

**So dynamic escapes are exempt but PINNED, not allowlisted** — the
`exit-site-inventory` pattern: the inventory is declared, and a new escape fails
the suite until someone re-declares it. An exemption nobody has to look at again
is how the next one arrives unnoticed.

### Why static-vs-dynamic is the right proxy

The invariant that actually matters is **"nothing that executes in the shipped
artifact resolves outside it."** The dev-only import escapes but never runs at
the destination — release mode is chosen by `dist/` presence, and the artifact
always has a `dist/`. Static-vs-dynamic is the mechanical stand-in for
runs-at-the-destination, and the pin is what keeps the stand-in honest.

### Why `plugins/spellbook/` and not the skill folder

Deliberate, and worth stating because it is the looser of the two boundaries:

- **What it guarantees:** the **published artifact is self-contained**. That is
  the boundary the Claude marketplace actually copies, so it is the one that can
  actually break an install.
- **What it does NOT guarantee:** that each **skill directory** is
  self-contained — the unit the Agent Skills standard requires. A tighter ward
  follows _if_ the emission ruling later chooses portability. It also says
  nothing about the kit's own dependencies — that is Ward 2's job.
- **What it deliberately permits:** `plugins/spellbook/lib/` (emission option
  1). **The ward does not prejudge the gate** — it enforces "the artifact
  works," not "which sharing mechanism won."

### Ward 1b — outward: the shipped execution path carries no dependencies

> **No file on the shipped execution path (`scripts/`, `shared/` — never
> `surface/`) may statically import a bare specifier outside `node:`, `bun:`, or
> the bare `bun` types package.**

> **⚠ `bun` must be in the exemption, and it was missing here.** Written as
> `node:`/`bun:` alone, this predicate is **red today on four files** —
> `astrolabe`, `bounty`, `imago` and `magpie` each carry
> `import type { ServerWebSocket } from "bun"`, which is type-only and erased.
> Measured: **4 violations without the exemption, 0 with it.** Sprint 01's Phase
> 0 bullet already had it right; this section did not. _(Found by the on-ramp
> pass, which flagged the drift rather than reconciling it — correctly, since
> only running it says which side was wrong.)_
>
> ### ⚠ The population is FIVE files, not four — and the 4 was not wrong, it was narrower
>
> **Amended 2026-08-31.** The ward as built asserts **five**. The fifth is
> `glamour/scripts/server.ts:77`, which writes the same dependency as a **type
> query** rather than a statement:
> `new Set<import("bun").ServerWebSocket<unknown>>()`. A statement-shaped count
> — which is what produced the 4, twice, by two people — cannot see it.
>
> **Both numbers are correct in their own frame and the frames are stated so
> neither reads as a mistake:** 4 is the count of `import … from "bun"`
> statements; **5 is the count of files depending on `bun` by any construct**,
> which is the population the ward actually governs. **Prefer 5** — the ward is
> the thing that will be run.
>
> _Found by thoth while implementing the type-query reclassification below. It
> is the third line-shaped miss in this document set: the 88/34 census, the
> lead's re-check of it, and a re-export count of 6 that was 7. **The mechanism
> is now a cell rather than a warning** — the scanner compares counts, not sets,
> and dedupes on byte offset rather than line._

`surface/` is excluded on purpose: its bare imports are erased by the bundler
and never reach a destination. A `scripts/` one must resolve where nobody ran
`install`.

**1b is green today and R1 turns it red** — R1 moves the `sharp` importer into
`scripts/`. That is the correct behaviour: the ward should fire on exactly the
change that makes the dependency load-bearing, and it forces the
`sharp`→`Bun.Image` decision the proposal already scheduled.

### Ward 2 — downward: the kit is a leaf (the one-way street)

> **No file under `src/kit/` may make a relative import outside `src/kit/`.**

Bare specifiers (`react`, `lucide-react`) are unaffected — this governs relative
imports only. Kit modules importing each other (`kit/ui` → `kit/lib/cn`) is the
point.

**Prior art, and where the shape comes from.** Nx tags every library on two
dimensions — `scope:` (which app or domain) and `type:` (architectural layer) —
and enforces via `@nx/enforce-module-boundaries` that `scope:payments` may
depend on `scope:payments` and `scope:shared`, while **shared libraries may not
depend on app-specific ones.** Our structure maps almost one-to-one:

| Nx                                | Spellbook                                         |
| --------------------------------- | ------------------------------------------------- |
| `scope:<app>` library             | `plugins/…/<spell>/shared/` (R1)                  |
| `scope:shared` library            | `src/kit/`                                        |
| the app                           | `src/<spell>/surface/` + `…/<spell>/scripts/`     |
| `@nx/enforce-module-boundaries`   | these two wards                                   |
| `type:` (ui / util / data-access) | `kit/ui`, `kit/theme`, `kit/state` — half-present |

**Ward 1a does not catch this.** It guards `plugins/spellbook/` looking
_outward_; nothing in it would stop `src/kit/theme/` importing
`src/imago/surface/state/types`. **That single import is how the kit quietly
becomes imago-shaped**, and it is the mechanical enforcement of what
[R3](#r3--theming-a-base-layer-with-per-app-override) recorded only as a
discipline to hold — _"a kit that may become its own distributable must keep a
hard boundary."_

**Green on arrival, which is the cheapest moment to add it.** `src/kit/` does
not exist yet, and `src/` currently reaches into `plugins/` **zero** times — so
the ward starts green and stays green at no cost, versus finding the violation
once three modules depend on it.

### imago's test split — mind-mapper style

mind-mapper's precedent: **38 surface tests** under `src/mind-mapper/surface/`,
**32 backend tests** under `plugins/.../scripts/`. imago's 11 sit in one
`tests/` dir; classified by what they import, the split is clean — **and R1 is
what makes it clean**, because the two backend tests that look like surface
tests only touch the misfiled contract:

| Stays backend (`plugins/…/imago/`) | Why                                                    |
| ---------------------------------- | ------------------------------------------------------ |
| `cli.test.ts`                      | `scripts/` only                                        |
| `server.integration.test.ts`       | imports **only the contract** → **`shared/`** after R1 |
| `state.test.ts`                    | contract + `scripts/`                                  |

| Moves to `src/imago/surface/`                                                             |
| ----------------------------------------------------------------------------------------- |
| `contextLibrary` · `fileIntake` · `coords` · `erase` · `flatten` · `layers` · `transform` |

**3 backend / 8 surface.** One straddler to decide during implementation:
`imageOptimize.test.ts` covers both the browser-safe policy (`imageOptimize.ts`,
which the corrected sort moves to **`shared/`**) and the sharp-based
implementation (`imageOptimize.server.ts`, which R1 moves to `scripts/`). It
splits, or it picks a side and imports across. Not a design question — an
implementer's call.

> **Note the coupling:** R1 moves **three** files — `surface/state/types.ts`,
> `surface/state/imageOptimize.server.ts` and `surface/state/imageOptimize.ts`
> _(the third was added when R1's unit was corrected on review; see
> [R1's file-level sort](#applied-to-imago-three-files-move-not-two))_. The
> first two are why three of imago's tests currently look like surface tests and
> are not.

---

## R7 — astrolabe is dropped as the reference spell

**Resolved 2026-08-30 (Cole).** Closes the last outstanding item in
[`spell-surface-pipeline`'s plan](../spell-surface-pipeline/plan.md), which had
stood since v2.2.0. **imago is the reference spell.** The ruling is recorded in
the pipeline plan itself, where the question was asked — that plan's remaining
work is now zero, since spell-kit carries both Seam C and the second-spell
validation.

### Optional, and recommended: port astrolabe anyway — first

Cole: _"open to migrating it as well if it feels like an easy move, plus it
gives us a quick third point of reference."_ **Measured: it is the easiest port
in the roster, by a wide margin.**

| Cost                     | astrolabe                                | imago                           |
| ------------------------ | ---------------------------------------- | ------------------------------- |
| surface LOC to relocate  | **941** (smallest React surface)         | 6,591                           |
| `server.ts` → `surface/` | **1** (just `index.html`)                | **5** (3 runtime value imports) |
| `surface/` → `scripts/`  | 2 files, **both `import type`** (erased) | none                            |
| test files touched       | **0**                                    | 10 of 11                        |
| the wire contract        | **already in `scripts/state.ts`**        | misfiled in `surface/` (R1)     |

**astrolabe is already in the target state R1 moves imago toward** — contract in
`scripts/`, surface consuming it type-only. That is the exact arrangement R1
prescribes.

**So the sequencing argument is stronger than the third-data-point one:** port
astrolabe **first** and the pipeline generalization is proven with **zero seam
work**; port imago second and the seam is proven on its own. Two capabilities
validated separately rather than tangled in one change — the discipline the
reshaped scope is built on.

**Cost of adding it:** one more relocation, one more committed `dist/`. It
introduces **no new decisions** — its three `gate-honesty` entries
(`surface/styles.css` 93, `surface/index.html` 35, `bunfig.toml` 2) are the same
kinds as imago's, so R5's ruling covers both. Its 39 backend typecheck errors
sit under the same Tier 3 carve-out as imago's 137.

> **Not a fourth slice.** astrolabe rides inside Slice 1 as its first,
> mechanical half. If it turns out not to be free, drop it — Slice 1 is proven
> by imago either way.

---

## RB — The backend emission trade: legibility belongs to the interface

**Resolved 2026-08-30 (Cole).** Does not open the gate — it removes a bad reason
for one answer, so the eventual ruling is made on the real cost.

### The ruling

> **A tool that communicates well is a better solution than an agent reading
> source to work out how it behaves — or to find what is missing.** The
> `agent-cli-conformance` investment is what delivers that, and where it lands,
> the need to read source is already discharged. _(Cole, 2026-08-30.)_

**Source-readability is therefore not a reason to keep the backend unbuilt.** It
was the argument being made; it does not hold.

### The claim was tested, not assumed

Driving the **installed v2.2.0 artifact** cold, trying to create a mind-mapper
project knowing only the interface:

| Step              | Result                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `help`            | one-line verb list (v2.2.0; **fixed at HEAD**, 37 lines — release lag) |
| `propose-node`    | **excellent** — exact stdin shape _and_ title-ref semantics            |
| `projects add`    | _"Unexpected argument 'add'"_ — correct, no route forward              |
| `projects --help` | _"Unknown option '--help'"_                                            |
| `projects --xyz`  | _"Unknown option '--xyz'"_ — **no `choices`**                          |

**The drive stopped there** — and the decisive detail is that **what it needed
was never in the source logic. It was in a string.** `projects [--create

<title>]` lives in the `HELP` constant; `choices:["--create"]` lives in a
rejection path it did not happen to trigger. Both are **string literals and
data, which survive a build.** The source _comment_ explaining it does not.

Every point where the drive succeeded, the interface carried it. Every point
where it failed, the interface was thin and source would have been a **crutch
for a gap that should be closed anyway** — the `spell-hardening` / acc thesis,
reached from the opposite direction. Filed from this drive:
[`mind-mapper-unknown-flag-rejection-loses-choices`](../../backlog/2026-08-30-mind-mapper-unknown-flag-rejection-loses-choices.md).

### What survives `bun build --target=bun`

| What an agent consumes             | Survives?                   |
| ---------------------------------- | --------------------------- |
| `SKILL.md`                         | ✅ ships alongside          |
| `--help` / `HELP` strings          | ✅ string literal           |
| Error envelopes, `hint`, `choices` | ✅ string literals + data   |
| Verb and flag registries           | ✅ data                     |
| **Explanatory comments**           | ❌ stripped                 |
| Stack-trace line numbers           | ❌ unless a sourcemap ships |

Two measurements shrink even that column:

1. **Nothing is minified, and nothing needs to be.** `bun build` does not minify
   by default; output keeps function names, per-file boundary comments
   (`// plugins/.../cli.ts`) and readable structure — `printJson`,
   `sessionFilePath`, `cmdOpen` all greppable. **Bundled, not obfuscated.**
2. **`--sourcemap=inline` embeds the complete original TypeScript.** Verified:
   `sourcesContent` carries every source file verbatim, comments included. Cost
   on glamour's `cli.ts`: **18,269 → 76,926 bytes** (source is 26,958). A built
   backend can **literally contain its own source.**

### What is genuinely lost — two things, both smaller than claimed

1. **Editing in place.** Pipeline §4 already defines fork-to-hack as _"go to the
   **origin repo**"_ — the surface lost this first and the ruling was the repo,
   not the artifact. The backend would follow a path already taken.
2. **Line numbers in traces** — restored by the sourcemap.

### One argument that runs the other way

While debugging the drive, repo-HEAD source (**1,730** lines) was read against
the installed artifact (**1,576** lines). **Version skew.** Shipping source does
not prevent this — it _invites_ it, because source that disagrees with the
running binary is worse than none: it is confidently wrong. **A sourcemap is
welded to its build and cannot drift.**

### What actually decides it

| Option                              | Portable?                  | Self-describing?          | Real cost                                |
| ----------------------------------- | -------------------------- | ------------------------- | ---------------------------------------- |
| 1 · shared `plugins/spellbook/lib/` | ❌ Claude-marketplace only | ✅ source                 | breaks the skill-directory unit          |
| 2 · vendor the kit per skill        | ✅                         | ✅ source                 | N copies; needs a staleness ward         |
| 3 · **build the backend**           | ✅                         | ✅ **with `--sourcemap`** | **a build step in the backend dev loop** |

**Option 3's cost is not legibility. It is putting a build into the backend's
dev loop** — precisely what §5's dependency-smell guardrail exists to resist,
and the argument that was never actually made. It is also the only option under
which _"zip one folder and it runs"_ becomes **literally** true rather than
aspirational.

### The prerequisite this creates

If legibility lives in the interface, **interface conformance becomes the
enabling condition for building the backend** — checkable, not a vibe. **3 of 8
spells carry an `acc.config.json` today** (astrolabe, magpie, mind-mapper). A
sensible gate condition: a spell is conformant _before_ its backend goes opaque.
That sequences acc coverage **ahead of** the emission decision rather than
beside it.

> ⚠ **This does not open the gate.** It removes a bad reason for one answer and
> names the real one. Decide at the end of Phase 2, on the kit's actual shape.

### Honest limit

The drive was run by an agent **with the repo open**. A genuinely foreign agent
— artifact only, no source anywhere — is the real case, and this approximated it
rather than reproduced it.

---

## R3 — Theming: a base layer with per-app override

**Resolved 2026-08-30.** Supersedes the proposal's Open Question 1 and blocking
question 3.

### The ruling

**Neither palette replaces the other, and it never had to.** The kit ships a
**base theme** — house semantic tokens plus light and dark — that a spell gets
for free and may **override or extend at the app level**. imago keeps its
violet; mind-mapper keeps its night-table greys; a new spell that expresses no
preference still looks like a spell.

### Why this is cheaper than it looked: the mechanism already exists

`src/mind-mapper/surface/styles.css` is already four layers, and its own
comments state the property this resolution wants:

```css
@theme {
  --color-bg / --color-surface / --color-ink / --color-edge …   /* 1 · house semantic tokens   */
  --color-canon / --color-thread-tier / --color-story-local …   /* 2 · SPELL domain vocabulary */
  --color-popover:  var(--color-surface-raised);                /* 3 · shadcn aliases,         */
  --color-accent:   var(--color-edge);                          /*     var() refs — never values */
}
[data-theme="light"] { --color-bg: …; --color-ink: …; }          /* 4 · overrides layer 1 ONLY  */
```

> _"the light palette below overrides only the house tokens and the aliases
> follow for free"_ — `styles.css:32-33`

Layer 4 proves layer 3's discipline works: because the shadcn aliases are
`var()` references rather than copied values, **re-theming touches one layer and
everything downstream follows.** That is exactly the base/override contract.
**The mechanism is proven; it is simply in the wrong place.** The kit's job is
relocation plus a naming decision — not invention.

### The `--color-accent` collision is a namespace bug, not a palette conflict

The gap analysis ([B3](./gap-analysis.md#finding-index) — _`kit/ui/` cannot
render in imago; the Phase-2 order is backwards_) correctly measured that
`--color-accent` is `#7c3aed` (brand violet) in imago and `var(--color-edge)` (a
border grey) in mind-mapper, and concluded the palettes conflict. **The
measurement is right; the diagnosis was wrong.**

The two surfaces share **six token names** — `bg`, `surface`, `ink`, `edge`,
`attention`, `accent` — and **five agree in meaning.** Only `accent` diverges,
because the two are not the same kind of token:

| Spell       | `--color-accent` is…                                                |
| ----------- | ------------------------------------------------------------------- |
| imago       | a **brand** slot in the house taxonomy, with `-hover`/`-ink`/`-fg`  |
| mind-mapper | a **shadcn alias** — shadcn's `accent` means _subtle hover surface_ |

mind-mapper mapped shadcn's name correctly. imago squats the same identifier for
brand because it has no alias layer to collide with. So this is a **collision
between the house taxonomy and shadcn's reserved vocabulary**, and it is fixed
by renaming, not by choosing a palette.

**Ruling:** imago's brand slot is renamed out of shadcn's namespace —
`--color-brand{,-hover,-ink,-fg}` — leaving `accent` free for the alias layer.
The same applies to the `--color-accent-fg` (imago) /
`--color-accent-foreground` (mind-mapper) pair: one concept, two abbreviations;
the alias layer's spelling wins because shadcn fixes it.

**Priced:** **95 sites in imago** — 36 `bg-accent`, 27 `text-accent-ink`, 24
`border-accent`, 6 `ring-accent`, 1 `text-accent`, 1 `ring-accent-fg`. Purely
mechanical and greppable; one commit, independent of everything else in this
project.

### The layer contract

| Layer                  | Owner        | Contents                                                              | Overridable |
| ---------------------- | ------------ | --------------------------------------------------------------------- | ----------- |
| **L0 base tokens**     | `kit/theme/` | house semantic taxonomy + dark (default) and light                    | ✅ by L2    |
| **L1 shadcn aliases**  | `kit/theme/` | shadcn names → L0, **`var()` refs only, never values**                | rarely      |
| **L2 spell overrides** | the spell    | redefines any L0 token; L1 follows for free                           | —           |
| **L3 spell domain**    | the spell    | `--color-canon`, `--color-capture`, `--color-like` — never in the kit | —           |

**L1 is imported only by spells that consume `kit/ui/`.** A spell with no
primitives pays nothing for it.

### The invariant that makes kit components safe

> **Every token a kit component references must exist in L0.**

This is the load-bearing rule. A kit component reaching for a token only one
spell defines fails **silently and visually** in every other spell — the exact
class of defect this project exists to end, re-created inside the fix.

### Granularity: L0 starts small and grows

The two taxonomies describe the same concepts at different depth _and_ under
different names:

| Concept  | imago                                                | mind-mapper                       |
| -------- | ---------------------------------------------------- | --------------------------------- |
| surfaces | 5 — `bg, bg-elev, surface, surface-2, surface-3`     | 3 — `bg, surface, surface-raised` |
| text     | 4 — `ink, ink-strong, muted, faint`                  | 3 — `ink, ink-dim, ink-faint`     |
| edges    | 5 — `divider, edge, edge-2, edge-strong, edge-hover` | 1 — `edge`                        |

**RULED (Cole, 2026-08-30): L0 starts small and grows.** A token joins L0 when a
**second** spell independently wants it. Rationale: it satisfies the invariant
above with the least surface area, matches the house rule _"start minimal;
subtract before you test,"_ leaves mind-mapper's values untouched, and adding a
token later is cheap while removing one is not. _(Rejected: L0 as imago's
superset — a richer vocabulary immediately, at the cost of renaming tokens in
the one spell that is currently green and typecheck-clean.)_

### The scan — what the roster already agrees on

Measured across all five token-defining surfaces (invocation in the appendix;
**two scanner bugs were found and fixed before these numbers were trusted** — a
regex that ran past the `@theme` block into the `[data-theme="light"]`
overrides, and a `@theme` match that landed **inside a CSS comment**, which made
astrolabe report the comment's worked example as its palette).

| Spell           | literal tokens | `var()` aliases | light mode |
| --------------- | -------------: | --------------: | ---------- |
| astrolabe       |             33 |               0 | no         |
| imago           |             24 |               0 | no         |
| magpie          |             22 |               0 | no         |
| **mind-mapper** |             13 |          **10** | **YES**    |
| glamour         |          **0** |               0 | no         |

Two things fall straight out. **mind-mapper is the only spell with a light
palette**, so it seeds L0's light values. And **glamour defines no tokens at
all** — 135 raw-palette utility uses (`text-slate-500`, `bg-slate-900`) in
markup, in open violation of the house _"no raw palette in markup"_ convention.
glamour is out of scope here, but it is now known to be the **most expensive**
future adopter, not the cheapest.

**The concept overlap is 4-of-4; the naming overlap is 3-of-4.** mind-mapper
renamed the text and elevation scales; imago, magpie and astrolabe agree with
each other.

### L0 v1 — the initial list

Every concept below is independently defined by **3 or more** of the four
token-defining spells. Names follow the majority (imago/magpie/astrolabe).

| Concept             | L0 token                         | Spells | mind-mapper today                                            |
| ------------------- | -------------------------------- | -----: | ------------------------------------------------------------ |
| app background      | `bg`                             |      4 | `bg` ✅                                                      |
| card / panel        | `surface`                        |      4 | `surface` ✅                                                 |
| inset / raised      | `surface-2`, `surface-3`         |      3 | `surface-raised` ⚠ 1 step, not 2                             |
| default border      | `edge`                           |      4 | `edge` ✅                                                    |
| quiet divider       | `divider`                        |      3 | —                                                            |
| strong border       | `edge-strong`                    |      3 | —                                                            |
| primary text        | `ink`                            |      4 | `ink` ✅                                                     |
| heading text        | `ink-strong`                     |      3 | —                                                            |
| secondary text      | `muted`                          |      3 | `ink-dim` ⚠ rename                                           |
| tertiary text       | `faint`                          |      3 | `ink-faint` ⚠ rename                                         |
| brand               | `brand`, `-hover`, `-ink`, `-fg` |      3 | — _(renamed out of shadcn's `accent`, per the ruling above)_ |
| the agent needs you | `attention`, `attention-ink`     |    4/3 | `attention` ✅                                               |
| good / connected    | `positive`                       |      3 | —                                                            |

**~16 tokens.** The genuinely universal spine is only five — `bg`, `surface`,
`edge`, `ink`, `attention`, all four spells — but five is too thin to build a
chat sidebar against, and the remaining eleven each clear the 3-spell bar.

**mind-mapper pays three renames** (`ink-dim`→`muted`, `ink-faint`→`faint`,
`surface-raised`→`surface-2`/`-3`) and imago pays the 95-site `accent`→`brand`
rename. Nothing else moves.

**Explicitly NOT in L0** — 27 single-spell tokens stay L3, including
mind-mapper's `canon`/`thread-tier`/`story-local`/`pending`, imago's
`capture`/`like`, and astrolabe's `idle`/`danger-*`/`attention-surface-*`
family.

### Light and dark are a baseline, not an option

**RULED (Cole, 2026-08-30): every app ships at minimum a light and a dark mode,
for consistency — and the switcher is itself a shared kit component.**

This upgrades `kit/theme/` from a stylesheet to a **vertical slice**, and
absorbs the pre-paint mirror constraint rather than working around it. The kit
owns all four pieces:

| Piece                 | What                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| L0 tokens             | **both** palettes — every L0 token carries a light and a dark value                                                    |
| `resolveInitialTheme` | the resolution logic, today duplicated in mind-mapper                                                                  |
| the pre-paint script  | inline `<head>` snippet, **parameterised by spell name** (storage key, `data-theme` value) — kills the lockstep mirror |
| the switcher          | one component, one behaviour, every spell                                                                              |

**Consequences:**

- **Four of five spells are dark-only today.** In this project that is imago's
  problem only; magpie/astrolabe/glamour inherit it when they adopt.
- mind-mapper's existing light palette is the **seed** for L0's light values —
  it is the only one that exists, and it was designed against this token
  taxonomy.
- **imago's light mode is real design work, not a mechanical fill.** Its 24
  tokens are tuned for violet-on-near-black; mind-mapper's light ground is warm
  paper (`#f7f6f3`). What imago's brand violet becomes on warm paper is a
  decision someone has to make. **⚠ It is deferred, not cancelled** — the
  rewritten proposal puts it out of scope; the reconciliation is
  [Open Question 2](#open-questions-r3), and it narrows the probe below.

> ### This replaces the paper probe — and it is a better test
>
> ⚠ **Narrowed on review 2026-08-30, and the narrowing is not optional: the
> switcher is NOT what this project builds.** With imago's light palette out of
> scope, a switcher cannot be proven in a one-palette spell, so Slice 4's kit
> component is **something smaller that still uses a kit token** — the part that
> exercises the `@source` hazard. **R3's architecture ruling is unchanged; only
> the probe is.** Recorded in full at [Open Question 2](#open-questions-r3). The
> paragraph below is why the theme slice was the right _kind_ of probe, and that
> reasoning still holds.
>
> The [gap analysis](./gap-analysis.md) called the proposal's paper probe
> theatre ([D4](./gap-analysis.md#finding-index)) and countered with "build one
> real shared component." **The theme slice is a better candidate than its
> suggested `MessageBubble`**: it is small, it is real, and it exercises
> **every** mechanical constraint in one pass — L0 tokens, a kit hook, a kit
> component, the `@source` scan hazard, and the pre-paint script. Critically, it
> carries **no domain model**, which is exactly what makes `MessageBubble` hard
> (the four chat implementations are four architectures, not four copies). **A
> switcher that renders correctly in both spells, in both modes, proves the
> structure end to end.**

## Boundaries (R3)

**In scope:** `kit/theme/` with L0 + L1; imago's 95-site brand rename;
reconciling the L0 names; a light palette for imago, which has none today.

⚠ **These are R3's boundaries, and the rewritten proposal narrows what gets
BUILT inside them.** Slice 4 ships **a handful of L0 tokens, not the full
~16-token reconciliation**, and puts **imago's light palette** and the **95-site
rename** outside the work — the rename conditionally, on the kit component
touching no L1 alias. Both narrowings are recorded at
[Open Questions 2 and 3](#open-questions-r3). **R3 rules the architecture; the
proposal rules what gets built.** Read both before treating this list as a work
order.

**Out of scope:** re-skinning either spell; L3 domain tokens; any component
work. Theming lands _before_ `kit/ui/` (see below) and is independent of it.

**Postponed:** whether glamour/magpie/astrolabe adopt L0 — a follow-on, and
their adoption is the real test of the "grows on demand" rule.

## Architectural Positioning (R3)

`kit/theme/` sits **below** `kit/ui/` and everything else in the kit. This
**reverses the proposal's Phase-2 table**, which listed `kit/ui/` first and
theme third: the primitives are styled entirely in L1 alias tokens, so they
cannot render correctly in a spell until L0+L1 exist. **Theme is the kit's
foundation, not one of its modules.**

### Three mechanical constraints the kit inherits

1. **`@source` is a silent-failure hazard.** The roster has four spellings
   (`"./"` ×2, `"./**/*.tsx"`, `"./**/*.{ts,tsx}"` ×2). Moving `ui/` into
   `src/kit/` puts it **outside every current scan root**, and Tailwind's
   response is to emit **zero utilities for kit components** with no error. The
   kit's CSS must carry its own `@source`, and a smoke check must prove a
   kit-only utility actually reaches the built CSS.
2. **`@apply` is build-only.** imago uses it 23× in `@layer components`. Fine
   now that both consumers build — but the kit must not ship `@apply` component
   classes if any future consumer might be non-build. _(The Play-CDN scar:
   `@apply` is silently inert there.)_
3. **The pre-paint theme script is a lockstep mirror.** mind-mapper's
   `index.html:7-21` hand-copies `resolveInitialTheme` from `state/theme.ts`,
   commented _"keep the two in sync,"_ with spell-namespaced storage
   (`mind-mapper:theme`, `data-theme="mind-mapper"` on `<body>`). **`kit/theme/`
   must own this**, parameterised by spell name, or every consumer re-grows the
   mirror — a new instance of the defect the census filed against bounty.

## Irreversible Decisions (R3)

- **L1 aliases are `var()` references, never copied values.** Copying breaks the
  single-override property that makes L2 and light mode work at all. mind-mapper
  already learned this and wrote it down; the kit inherits the rule, not the
  rediscovery.
- **Kit components may reference L0 and L1 only.** Reaching into L3 couples the
  kit to one spell's domain and is the failure this project exists to prevent.

## Open Questions (R3)

1. ~~L0 granularity~~ ✅ **RULED — small and growing;** L0 v1 listed above.
2. ~~Does imago gain a light mode in this project, or later?~~ **⚠ NARROWED
   2026-08-30 — the proposal supersedes this.** R3 was written **before** the
   scope correction; the rewritten proposal's Slice-4 table puts imago's light
   palette **out of scope**, and it is later and reflects the standing rule
   (_spend effort only where it proves a capability_). **The reconciliation: R3
   rules the ARCHITECTURE — the base ships both palettes and mind-mapper
   exercises mode-override for free. The proposal rules WHAT GETS BUILT — imago
   proves app-override in dark only.** Light+dark remains the house baseline for
   every app; imago's own light palette is deferred, not cancelled.

   _Consequence, named by the dev-plan agent:_ R3's preferred probe was the
   **theme switcher**, and a switcher cannot be proven in a one-palette spell.
   **Slice 4's kit component becomes something smaller** — it still must use a
   kit token, which is the part that exercises the `@source` hazard.

3. **The 95-site `accent`→`brand` rename is out of scope, and stays out on one
   condition.** R3 rules the rename; the proposal excludes it. Both hold **iff
   the Slice-4 kit component references L0 tokens ONLY.** A single shadcn alias
   (`bg-accent`, `bg-popover`…) pulls all 95 sites onto the critical path.
   **This is a governing constraint on the component's design, not a
   preference.**
4. **Where does `styles.css` live once the surface relocates?** Entangled with
   blocking question 1 (the backend↔surface seam) and with `DECLARED_BLIND`
   (blocking question 5), which pins `imago/surface/styles.css` by path.

---

## Appendix — invocation

The L0 scan re-derives itself. **Strip CSS comments first and brace-count the
`@theme` block** — the two bugs that made the first two runs of this wrong:

```bash
python3 - <<'EOF'
import re
from collections import defaultdict
SHEETS={"imago":"plugins/spellbook/skills/imago/surface/styles.css",
        "magpie":"plugins/spellbook/skills/magpie/surface/styles.css",
        "astrolabe":"plugins/spellbook/skills/astrolabe/surface/styles.css",
        "glamour":"plugins/spellbook/skills/glamour/surface/styles.css",
        "mind-mapper":"src/mind-mapper/surface/styles.css"}
strip=lambda t: re.sub(r'/\*.*?\*/','',t,flags=re.S)   # @theme also appears in COMMENTS
def block(txt,head):
    i=txt.find(head)
    if i<0: return ""
    j=txt.index("{",i); d=0
    for k in range(j,len(txt)):
        if txt[k]=="{": d+=1
        elif txt[k]=="}":
            d-=1
            if d==0: return txt[j+1:k]            # do NOT run past into [data-theme=...]
    return ""
owners=defaultdict(list)
for n,p in SHEETS.items():
    toks=dict(re.findall(r'--color-([a-z0-9-]+):\s*([^;]+);',block(strip(open(p).read()),"@theme")))
    for k,v in toks.items():
        if not v.strip().startswith("var("): owners[k].append(n)
for k in sorted(owners, key=lambda k:(-len(owners[k]),k)):
    if len(owners[k])>1: print(f"{len(owners[k])}x --color-{k:<20} {owners[k]}")
EOF

# glamour's raw-palette debt (135 uses, 0 tokens)
grep -rohE "\b(bg|text|border|ring)-(slate|zinc|violet|amber|emerald|rose)-[0-9]{2,3}" \
  plugins/spellbook/skills/glamour/surface --include='*.tsx' | wc -l
```

---

## RC — mind-mapper's standing as the kit's source (D2)

**Ruled: D2's facts are correct, its inference was already overturned before it
was written, and one word of the proposal needs narrowing.** D2 does not block.

**What D2 claimed.** mind-mapper is pinned by `roster-drift.test.ts`, has no
`SKILL.md`, and appears in none of the four listings — so it is an undeclared
WIP spell, and it is the entire source of the pipeline this project borrows.
What shipped in v2.2.0 was that spell's `dist/` riding along in the subtree, and
nobody consumed it. D2 closes: _"it is the thing that makes the donor not a
spell."_

**Every fact is verified** (2026-08-31): no `SKILL.md` (7 of 8 spell folders
have one), the pin is present, no listing carries it.

### ⛔ The closing inference is already ruled, and the other way

**Cole ruled the undeclared state intentional and correct on 2026-08-10**
(`47238d7`), and the ruling is quoted in two live artifacts —
`grimoire/roster-drift.test.ts:32-38` and
[`docs/backlog/2026-08-10-mind-mapper-is-undeclared-and-shipped.md`](../../backlog/2026-08-10-mind-mapper-is-undeclared-and-shipped.md):

> **mind-mapper is undeclared BECAUSE it is not finished** — not through
> oversight, and not through drift. **There is nothing to repair** in the four
> synced listings, the trigger registry, or the missing `SKILL.md`. A spell that
> has not coalesced should not be claiming a roster slot.

So _undeclared_ is not a defect here and is not evidence of neglect — **it is
the correct state for a spell in mind-mapper's condition**, and the ward pins it
with that reason printed on every run. D2 read a deliberate state as a broken
one.

> **⚠ This nearly cost a duplicate.** The first draft of this ruling filed
> mind-mapper's missing `SKILL.md` to the backlog as "a real defect, and it is
> mind-mapper's." **It is neither** — a file recording that exact question has
> been open since 2026-08-10 with a human ruling already at the top of it. The
> ward comment names that file by path, which is how it surfaced. **Before
> filing a finding, grep the backlog for its subject** — this set has now
> produced one near-duplicate and one finding aimed at deleted text (below).

### ⚠ Two of D2's three complaints target the pre-rewrite proposal

D2 quotes the proposal saying _"validated through a real distribution channel"_
and objects to the missing `SKILL.md` sitting under _"Future Considerations,"_
as if cosmetic. **Neither string exists in `proposal.md` any more** (`grep`,
2026-08-31); both went when the proposal was rewritten around the four
capability slices.

> **Check a finding's target before acting on it.** This document set was
> rewritten _under_ its own gap analysis, so a finding can outlive the sentence
> it quotes. The ids stay stable; the text does not.

### What survives is one word, and it is worth fixing

The proposal used to port imago onto _"the pipeline mind-mapper already
proved."_ **Narrowed in `proposal.md` on 2026-08-31** to what the evidence
supports — the edit is made, not pending:

| mind-mapper DID establish                                     | mind-mapper did NOT establish                |
| ------------------------------------------------------------- | -------------------------------------------- |
| the relocate → `bun build` → committed `dist/` mechanism runs | that any consumer ever invoked it            |
| a built bundle survives the subtree and the plugin cache      | that the pipeline serves a spell anyone uses |

A bundle that shipped unconsumed proves the **packaging**, not the **product**.

> **⚠ Scope of this narrowing: the DISTRIBUTION claim only.** It does not reach
> [R3](#r3--theming-a-base-layer-with-per-app-override)'s _"proven four-layer
> mechanism,"_ which is a claim about CSS layering rendering in a browser and is
> established by mind-mapper's own dev runs. Different claim, different evidence
> — do not re-litigate R3 with this ruling.

### Why the donor question does not block Sprint 01

What Sprint 01 borrows is a **mechanism** — `resolveMode()`, the dev-only
dynamic import, the committed `dist/`. Whether the spell that first exercised it
holds a roster slot is a fact about **that spell's declaration**, not about
whether `bun build --target=bun` emits a bundle imago can serve.

**And the mechanism is not being taken on the donor's word.** Sprint 01's proof
is that **imago itself builds and serves** — so the donor's credibility is not
load-bearing; the sprint re-derives the result on the spell we care about. The
precedent was already explicitly limited: mind-mapper's `server.ts` makes
**zero** `../surface/` imports and imago's makes **five**, so the hard half of
Slice 1 was never covered by it.

**"imago would be the first declared, in-use spell whose surface leaves the
shipped tree" is the thesis, not an exposure.** D2 states it as a risk. It is
what the project is _for_.

### ⚑ What this DID surface — for Cole, not for a seat

The 2026-08-10 ruling **deliberately left one thing open**, and it names it as
out of scope for the ward that pins it:

> **What this ruling does NOT cover, left open deliberately:** whether the built
> artifact should be **in the published package** while the spell is WIP.
> `spellbook-v2.2.0` ships `mind-mapper/dist/` (~54k lines of JS + CSS) and
> `scripts/`. A consumer receives a daemon and a surface they have no contract
> for. **That is a packaging question, not a documentation one.**

**Spell-kit generalizes exactly that question.** Slice 1 commits imago's `dist/`
and `build.ts` learns to serve both spells; the endpoint of the project is every
spell shipping a built bundle. The open question stops being "should one WIP
spell's dist ride along" and becomes **"what does a consumer receive, per spell,
once built surfaces are the norm"** — and a consumer feels that as download size
and as a daemon they did not ask for.

**This is Cole's call, not a seat's** — it is product and cost, and it is
carried over here rather than resolved, because it was open before this project
started and nothing in these three sprints forces it. **Sprints 01–03 proceed
without it**; committing imago's `dist/` matches what the tree already does.

**Repeal criterion:** if Sprint 01 finds the pipeline depends on something only
an _undeclared_ spell can do — a build step a rostered spell's checks would
reject — this ruling is wrong and the donor question reopens.

---

**Related Documents:**

- [Proposal](./proposal.md) · [Gap analysis](./gap-analysis.md)
- `src/mind-mapper/surface/styles.css` — the proven four-layer mechanism
- `plugins/spellbook/skills/imago/surface/styles.css` — the taxonomy L0 is named
  after
- Memory: `spell-theming-convention` — _"house spells theme via a semantic-token
  layer (imago/glamour); no raw palette in markup; bake into scaffold later."_
  **This resolution is that bake.**
