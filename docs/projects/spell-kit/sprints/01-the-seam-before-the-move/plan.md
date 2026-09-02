# Sprint 01 — The seam before the move

**Status:** Planned **Created:** 2026-08-30 **Project:**
[spell-kit](../../proposal.md) · **Rulings:**
[design-resolution](../../design-resolution.md)

> **What this sprint delivers:** a second and third spell that **build**, and
> the instruments that will tell the truth about them afterwards. Nothing is
> shared yet — that is Sprint 02. This sprint makes sharing _possible_ and makes
> the gates honest about what changed.
>
> **Its governing discipline, and its name:** imago's shipped `server.ts`
> reaches into `../surface/` **five times, three of them at runtime**. Relocate
> first and the daemon breaks at a destination that has no `src/`. **Cut the
> seam while everything is still where it was**, prove it with a grep, and only
> then move.

## Read before you start — this is not a self-contained work order

**The instructions live in [design-resolution.md](../../design-resolution.md).**
This plan _applies_ the rulings; it does not restate them, and the phases below
are unsafe to execute from alone. **This has already cost a defect:** Phase 0
was drafted against a version of Ward 1 that R6 had corrected, and produced a
ward that is red on arrival with **95 violations across 65 correct files**.
_(That figure read "88 correct files" until 2026-08-31 — wrong on the number and
on the unit; see R6.)_

| Read this                                                                                                                  | Before      | Because                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [R6 — the two wards, and imago's test split](../../design-resolution.md#r6--the-shared-import-wards-and-imagos-test-split) | Phase 0, 1c | Phase 0 builds all three wards from it. R6 is where **1a and 1b are separated** and where the retracted single-predicate version is recorded. Phase 1c's test classification is R6's, not this plan's. |
| [R5 — a second root](../../design-resolution.md#r5--gate-blind-set-gains-a-second-root)                                    | Phase 0     | Phase 0's instrument change is R5's ruling plus its zero-guard reasoning. The bullets below say _what to edit_; R5 says **why the declaration must not shrink** — the judgement call you will face.    |
| [R1 — the three-way rule](../../design-resolution.md#r1--a-per-app-shared-folder-and-a-three-way-rule)                     | Phase 1b    | 1b's table is R1 applied to five import sites. R1 is where **three files move, not two** is ruled, and where the reason lives — the module-level sort that generalises to glamour and magpie.          |
| [R7 — astrolabe first](../../design-resolution.md#r7--astrolabe-is-dropped-as-the-reference-spell)                         | Phase 1a    | Phase 1a exists only because R7 ruled astrolabe worth porting first, and R7 carries **1a's escape hatch**: if it is not free, drop it.                                                                 |
| [The ledger's vocabulary and numbering tables](../../README.md)                                                            | anything    | `shared/`, `ward`, `pinned` and **the gate** each mean something narrower here, and **Phase 1b · Ward 1b · Contract 1 · L1 · Slice 1** are five schemes wearing the same digits.                       |
| [The gap analysis's finding index](../../gap-analysis.md#finding-index)                                                    | on sight    | Bare ids (`B1`, `D3`, `I1`…) appear in the rulings this sprint executes. The index says what each one is.                                                                                              |

## The proof this sprint must produce

1. `bun scripts/instruments/gate-blind-set.ts` reports **19 files / 4,442
   lines** across two named roots, and the calibration arm fails when a blind
   file is planted in **either** root.
2. **All three new wards** — 1a, 1b, and 2 — behave correctly: 1a and 1b fail
   when handed a synthetic violation; **ward 2 cannot yet fail meaningfully**
   (`src/kit/` does not exist), so what is proven for it is that its
   **zero-guard** distinguishes "no violations" from "no files examined".
3. astrolabe and imago each serve their board from `dist/` in release mode, from
   a copy of the skill folder with **no `node_modules` up-tree**.
4. `grep '\.\./surface/' imago/scripts/server.ts` returns **exactly one line**
   (the `index.html` entry). **It returns five at HEAD** — that is this sprint's
   premise. It drops to one **after 1b's seam cut and before 1c relocates
   anything**, so the seam is proven while the tree is still shippable.
5. mind-mapper's suite and typecheck stay green: **0 errors, 0 new failures.**

> **⛔ Every phase below ends with what its gate CANNOT see, and those blocks
> are not footers.** Proof 3 — the local-sim — **cannot be run by `bun test` at
> all**: the suite runs in-repo with `node_modules` present, so an import that
> only resolves in-repo passes green. Each phase's ⛔ block names its own
> version of that hole. Read it before you report the phase green.

## Carried baseline

**▸ = measured at `54fb203` today. ◦ = a forecast for an instrument Phase 0 has
not built yet** — those rows cannot be reproduced before this sprint starts, and
an earlier draft's header claimed they could.

|                                                           |                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ▸ `bun test`                                              | **1481 pass / 0 fail / 110 files**                                                            |
| ▸ `bunx tsc --noEmit`                                     | **434 errors** — imago 137 · astrolabe 40 · **mind-mapper 0** · **`src/` 0**                  |
| ▸ blind set (one root)                                    | 16 files / 4,166 lines                                                                        |
| ◦ blind set (two roots)                                   | **19 files / 4,442 lines** — root 2 recovers what mind-mapper's own relocation made invisible |
| ◦ ward 1a (relative escapes)                              | 0                                                                                             |
| ◦ ward 1b (bare specifiers on the shipped execution path) | **0, and it now stays 0** — see the ⚠ below                                                   |
| ◦ ward 2 (`src/kit/` is a leaf)                           | green by construction — `src/kit/` does not exist                                             |

> ⚠ **`sharp` is a live defect, not a risk this sprint discovers.** imago's
> shipped daemon **cannot start offline** — `bun --no-install server.ts` →
> `Cannot find package 'sharp'`, and there is no `node_modules` anywhere up-tree
> from the installed plugin. Proof 3 above **cannot pass** until it is fixed.
> Measured and scoped in
> [the backlog item](../../../../backlog/2026-08-30-imago-daemon-cannot-start-offline.md):
> `Bun.Image` is a **behaviourally equivalent** drop-in, one function, 12 lines,
> one call site. ⚠ **Not byte-identical** — that claim was falsified 2026-08-31
> on a 10-input sha256 corpus; identity holds only where nothing resamples. **Do
> it inside Phase 1b**, with the seam work, not as a follow-up.

## Phases

### Phase 0 — The instruments, before the work that breaks them

**Goal:** the wards that must observe Slices 1–4 exist and are green **at
HEAD**, before any file moves.

**Key changes:**

- **R5 · `scripts/instruments/gate-blind-set.ts` gains a second root.** Today it
  enumerates one root: `SKILLS_DIR` is read at `:132`, walked with
  `git -C <root> ls-files` at `:157-161`, and named in the envelope at `:183`.
  Make the roots a list — `plugins/spellbook/skills/` and `src/` — and merge the
  results into the one flat `files[]` the report already emits. **Do not** make
  the report per-root: `gate-honesty.test.ts:146` pins the **union**, and R5's
  zero-guard survives only because root 1 can never empty
  (`magpie/scripts/remove.py`, 145 lines, is a permanent resident).
  - The envelope's `skillsDir` field becomes `roots: string[]`. **`BlindReport`
    (`gate-honesty.test.ts:86-94`) does NOT need to follow** — it has no
    `skillsDir` field, and the instrument itself (`:183`) is that field's only
    consumer. _(An earlier draft asserted otherwise; corrected on review.)_
    **The real wire change is the scalars** — `tracked` / `handAuthored` /
    `gated` / `docs` become sums across roots, and
    `gate-honesty.test.ts:137-138` reads two of them.
  - **The fixture mints TWO roots, and the calibration arms double.** ⚠ **This
    is larger than a knob, and it is mandatory — not hygiene.** `deriveIn()`
    (`gate-honesty.test.ts:197-211`) spawns the instrument with `cwd` = a
    throwaway repo and `SKILLS_DIR: "skills"`. A second root that does not exist
    in that fixture makes `git ls-files` fail → non-zero exit →
    `fixture derive failed` → **both calibration tests go red and `bun test` is
    not green, so this phase cannot close.**

    **Ruled:** mint a real second root in the fixture and add a second mutation
    arm. The alternative — suppressing root 2 under the test hook — ships root 2
    **uncalibrated**, which is precisely the _"check that cannot fail in the
    failing case"_ this instrument's own header records having shipped once.
    Building a guard and exempting it from calibration is self-defeating.

    **Budget six sites, not one:** the instrument (`:132`, `:157-161`, `:183`),
    `mintFixture` (`:182-187`), `deriveIn`'s env object (`:200`), and a new
    mutation arm.

  - **Delete the now-false bullet** in the instrument's "WHAT THIS INSTRUMENT
    CANNOT SEE" header — it currently reads _"`src/<spell>/` … A further 3 files
    / 276 lines … not counted here."_ Leaving it is worse than never having
    written it.

- **Re-declare `DECLARED_BLIND`.** Three entries join, by hand, not by
  regeneration: `src/mind-mapper/surface/styles.css` **220**,
  `src/mind-mapper/surface/index.html` **52**, `src/mind-mapper/bunfig.toml`
  **4**. Set moves **16 → 19 files, 4,166 → 4,442 lines**.
  - **This is the phase's real finding, and it is retroactive:** those 276 lines
    went blind-and-uncounted when mind-mapper relocated, and nothing said so. R5
    is not a bridge for Slice 1 — it recovers a loss that already happened.
- **R6 Ward 1 — outward. TWO checks, not one**
  ([R6 states why](../../design-resolution.md#ward-1-is-two-checks--read-this-before-building-either)
  — an earlier draft of this bullet specified the retracted single-predicate
  version, which is **red on arrival with 95 violations across 65 correct
  files**; that is this project's cautionary example):
  - **1a · structural** — no tracked file under `plugins/spellbook/` resolves a
    **relative** specifier outside it. **0 today.**
  - **1b · dependency** — no file on the **shipped execution path** (`scripts/`,
    `shared/` — **not** `surface/`) statically imports a bare specifier outside
    `node:` / `bun:` / `bun`. **0 today, and it now stays 0.**
    - ⚠ **This changed on 2026-08-31 and it costs you a proof.** An earlier
      draft said Phase 1b would turn this ward red on `sharp` and that the red
      was correct. **`sharp` is gone** — daedalus swapped it for `Bun.Image`
      before the file moves, precisely so the ward never goes red rather than
      going red and being waited out. **So ward 1b will never fire on a real
      violation during this sprint.** Its only evidence is a planted one. **That
      makes the non-author's synthetic mutation the whole proof of this cell,
      not a formality** — treat a green 1b as unearned until it has been made to
      fail.

  In both, dynamic escapes are **exempt but pinned**, on the
  `grimoire/exit-site-inventory.test.ts` model — one declared inventory, one
  entry today (`mind-mapper/scripts/server.ts:552`), and a new escape fails the
  suite until someone re-declares it. **Not an allowlist.**

- **R6 Ward 2 — downward.** No file under `src/kit/` may make a **relative**
  import outside `src/kit/`. Bare specifiers (`react`, `lucide-react`) are
  unaffected. `src/kit/` does not exist yet, so the ward needs a zero-guard that
  distinguishes "no violations" from "no files examined" — otherwise it passes
  vacuously for the whole of Phases 0–3 and then is trusted in Phase 4.

**This phase is done when:** `bun scripts/instruments/gate-blind-set.ts` prints
**19 files / 4,442 lines** over two named roots; `bun test` is green at ≥ 1481;
the calibration arm demonstrably fails when a blind file is planted in
**either** root; wards **1a and 1b** fail when handed a synthetic violation; and
**ward 2's zero-guard** fails when handed an empty population (it cannot yet be
violated — see proof 2).

#### ⛔ What Phase 0's gate cannot see

_Everything above can be green while every one of these is true._

- Whether the 19 declared line counts are **correct** — only that they have not
  moved. Nothing here reads a line of those files; that is the point.
- **Ward 1a** permits `plugins/spellbook/lib/` **on purpose** (R6). It does not
  prejudge Phase 2's emission ruling and must not be read as endorsing it.
- **Ward 1a is blind to bare specifiers** — that is 1b's job, and 1b sees only
  `scripts/` and `shared/`. A dependency escaping through `surface/` is
  invisible to both, correctly: the bundler erases it.
- Ward 2 cannot see a kit that becomes imago-shaped by having a spell's types
  **copied into** it rather than imported. Only review catches that.
- **None of the three wards sees `bunx tsc`.** The gate is `check && test`.
- **No ward sees a relative escape inside a non-`.ts` file** — a
  `<script src="../../x.js">` in hand-authored HTML is an escape and is
  invisible to all three. That population **is** the blind set, so this hole and
  the blind set's are one hole seen from two sides: the set **declares** those
  files, it does not **inspect** them. Ruled out of scope 2026-08-31 (see R6);
  the remedy rides on the biome backlog item, not on a ward.
- **Ward 1b's population is half-empty and will stay that way this sprint** —
  `shared/` does not exist until Phase 1b creates it, and `sharp` was retired
  before its file moved. `scripts/` alone, 40 non-test files, 113 bare
  specifiers, **all builtins**. `*.test.ts` under `scripts/` is ruled out of the
  population (R6); those files still ship, which is a packaging question, not
  this ward's.

**Dependencies:** none. Start here.

---

### Phase 1 — Both spells build (Slice 1)

Split into three sequential parts. **1a is mechanical, 1b is the whole
difficulty of this project, and 1c is bookkeeping that touches 8 files.**

#### 1a — astrolabe, the mechanical port (R7)

**Goal:** prove the pipeline generalises with **zero seam work**, so that when
imago's seam is proven it is proven alone.

**Key changes:**

- `git mv plugins/spellbook/skills/astrolabe/{surface,bunfig.toml}` →
  `src/astrolabe/`.
- `astrolabe/scripts/server.ts:63` — the **static**
  `import index from "../surface/index.html"` becomes `resolveMode()` plus a
  dev-only dynamic import, copying `mind-mapper/scripts/server.ts:92-96` and
  `:550-553`. This is the Contract 1 deps-free crash, live in astrolabe today.
- `astrolabe/scripts/cli.ts` — pin the spawned daemon's cwd to `src/astrolabe/`
  (Contract 5). **The failure is silent** — bunfig's Tailwind plugin is skipped
  and the surface renders unstyled.
- Un-ignore `plugins/spellbook/skills/astrolabe/dist` in `.gitignore` (mirroring
  `:12-13`), build, commit the `dist/`.
- **Generalise `src/mind-mapper/build.ts`.** It is hard-coded: `ENTRY` at `:27`
  and `OUTDIR` at `:28-37` both name mind-mapper. Two spells make three copies
  by the end of this phase — **copying it here is the disease this project
  exists to treat.** Move it to one spell-parameterised script (a `src/build.ts`
  taking a spell name, or one script per spell delegating to a shared one) and
  add a root `package.json` script, which does not exist today.
- `astrolabe/surface/state/board.ts:1`, `useSession.ts:2`,
  `components/ProjectCard.tsx:1`, `QuietRow.tsx:1` — four `import type` edges
  into `../../scripts/state`, all erased at build. Their **depth** changes with
  the relocation; nothing else does.
- `astrolabe/tsconfig.json` stays at the skill root and afterwards covers only
  `scripts/`. Measured: exactly **1** of astrolabe's 40 root-program errors is
  in `surface/`, so the relocation moves 1 error from the skills tree into
  `src/` and adds none.
- Re-declare `DECLARED_BLIND`: astrolabe's three entries (`:74`, `:75`, `:80`)
  change path, not count — `surface/styles.css` 93 and `surface/index.html` 35
  move under `src/astrolabe/`, `bunfig.toml` 2 with them. **Set stays at 19
  files / 4,442 lines.** If the total changes, something else moved too.

**This phase is done when:**
`plugins/spellbook/skills/astrolabe/dist/index.html` is committed; the daemon
emits `mode==="release"`; and the **local-sim** passes — copy `SKILL.md` +
`scripts/` + `dist/` (and nothing else) to a path with no up-tree
`node_modules`, run the daemon, and drive the board in a browser.

##### ⛔ What 1a's gate cannot see

_Everything above can be green while both of these are true._

- `bun test` runs with root `node_modules` present and never builds, so **an
  import that only resolves in-repo passes green**. Only the local-sim
  discriminates.
- `bun run check` reads none of the four relocated non-`.ts` files — Phase 0's
  second root is what keeps them counted.

#### 1b — imago's seam, cut BEFORE anything moves

> ### ⚠ 1b also carries the `sharp` swap. Not optional, not a follow-up.
>
> **imago's shipped daemon cannot start offline today** —
> `bun --no-install scripts/server.ts` → `Cannot find package 'sharp'`, and
> there is no `node_modules` up-tree from an installed plugin. **This sprint's
> proof 3 cannot pass until it is fixed**, and no other phase owns it.
>
> **Do it FIRST within 1b, before moving `imageOptimize.server.ts`.** Ward 1b
> fires on a bare specifier in `scripts/`; swapping to `Bun.Image` _before_ the
> move means the ward never goes red, rather than going red and being waited
> out.
>
> **Measured drop-in, behaviourally equivalent output — NOT byte-identical**
> (the original claim, falsified 2026-08-31 on a 10-input sha256 corpus; the
> first corpus had nothing in it that resampled real content). One function, 12
> lines, one call site (`server.ts:194`), plus the test's own fixture. Proof in
> [the backlog item](../../../../backlog/2026-08-30-imago-daemon-cannot-start-offline.md).

**Goal:** `plugins/spellbook/skills/imago/scripts/server.ts` has **zero** value
imports from `../surface/`, while every file is still where it is today.

R1's three-way sort, applied to the five sites:

| Site              | Import                    | Destination                                                 |
| ----------------- | ------------------------- | ----------------------------------------------------------- |
| `server.ts:35`    | `../surface/index.html`   | **stays** — becomes `resolveMode()` in 1c ⚠ now `:49`       |
| `server.ts:36`    | `optimizeImageBuffer`     | → `scripts/imageOptimize.server.ts` (daemon-only, misfiled) |
| `server.ts:37-50` | `../surface/state/types`  | → `shared/types.ts` (the two-sided contract)                |
| `server.ts:1647`  | type-only re-export       | → `shared/types.ts`                                         |
| `server.ts:1648`  | `export { defaultState }` | → `shared/types.ts`                                         |

> **⚠ That table sorts import _sites_, and THREE files move, not two.** The
> third — `surface/state/imageOptimize.ts`, the browser-safe policy sibling —
> has no `server.ts` import site of its own, which is exactly how an earlier
> reading of R1 missed it. It goes to `shared/` too; see
> [R1's file-level sort](../../design-resolution.md#applied-to-imago-three-files-move-not-two)
> and "Watch the sibling" below.

**Key changes:**

- **FIRST: `sharp` → `Bun.Image` in `surface/state/imageOptimize.server.ts`**,
  before that file moves. **Delete the `sharp` references in its header comment
  and in `imageOptimize.ts:4` — do not correct them in place.** A comment
  describing a library the file no longer uses is exactly the defect filed
  against
  [magpie](../../../../backlog/2026-08-30-magpie-hand-rolls-scale-math-it-does-not-need.md);
  do not create a second instance while closing the first. See the box above —
  it is what makes proof 3 reachable, and doing it first means ward 1b never
  goes red rather than going red and being waited out.
- Create `plugins/spellbook/skills/imago/shared/` **in the shipped tree** — the
  daemon runs from source at a destination that never ran `install`, so anything
  it imports must physically be there.
- `git mv surface/state/types.ts shared/types.ts`. **The file moves whole** —
  R1's scope note rules out splitting it (12 of 25 exports are two-sided; the
  carve-out is surgery for a modest payoff).
- `git mv surface/state/imageOptimize.server.ts scripts/`. It has exactly
  **two** importers repo-wide (`server.ts:36`, `tests/imageOptimize.test.ts:3`)
  and **zero** surface `.tsx` importers — the `*.server.ts` suffix already said
  so.
  - **Watch the sibling.** `imageOptimize.server.ts:6` imports `./imageOptimize`
    (5 lines, one const `OPTIMIZE`), which **stays** in `surface/` and is also
    imported by `surface/state/fileIntake.ts:2`. After the move that becomes a
    `scripts/` → `surface/` value import — **the seam re-opened in the other
    direction.** ~~Decide this explicitly~~ — **R1 already rules it:**
    `OPTIMIZE` is used by the daemon path _and_ the browser path, so by R1's own
    test it is two-sided and moves to `shared/` as well. That makes **three**
    files R1 moves, not two — see
    [R1's file-level sort](../../design-resolution.md#applied-to-imago-three-files-move-not-two),
    which is the corrected one. Do not re-litigate it here.
- Rewrite every consumer's specifier: `surface/` files that imported `./types`
  now reach `../../shared/types`.

**This phase is done when:** `grep -n '\.\./surface/' imago/scripts/server.ts`
returns exactly **one** line — the HTML entry — **`grep -rn sharp` across
`scripts/` and `shared/` returns nothing**, `bun --no-install scripts/server.ts`
starts from a `node_modules`-free copy, and `bun test` is green with **no file
having moved out of `plugins/spellbook/`**.

> **Scoped to the shipped execution path on purpose.**
> `tests/imageOptimize.test.ts` uses `sharp` to build its own fixture (`:11-19`)
> and may keep doing so — tests are not on the daemon's execution path, and ward
> 1b does not cover `tests/`. Requiring zero `sharp` repo-wide would force an
> unrelated test rewrite. _(An earlier draft of this clause said "across the
> spell" and did overreach.)_ The tree is still shippable at this point; that is
> what makes 1b a real checkpoint rather than a staging area.

##### ⛔ What 1b's gate cannot see

_Assembled from facts stated above; nothing new is claimed here._

- **`bun test` never boots the daemon deps-free.** The suite runs with root
  `node_modules` present, so the `sharp`→`Bun.Image` swap is not proven by a
  green suite — only by `bun --no-install scripts/server.ts` from a copy, run by
  hand, as the done-when says.
- **Ward 1b does not cover `tests/`** (see the box above), so `sharp` surviving
  in a test fixture is invisible to it — correctly, but it means "the ward is
  green" is not "the spell is `sharp`-free."

#### 1c — imago's relocation and test split (R6)

**Key changes:**

- `git mv plugins/spellbook/skills/imago/{surface,bunfig.toml}` → `src/imago/`;
  `resolveMode()` + dev-only dynamic import + Contract 5 cwd pin + un-ignore and
  commit `dist/` — all exactly as 1a.
- **Test split, R6's classification.** 8 files move to `src/imago/surface/`:
  `contextLibrary` (22) · `coords` (76) · `erase` (63) · `fileIntake` (85) ·
  `flatten` (27) · `layers` (100) · `transform` (121) — and
  `imageOptimize.test.ts` (22), the straddler.
- **3 stay backend:** `cli.test.ts` (105, `scripts/` only) ·
  `server.integration.test.ts` (1316, imports `types` **type-only** at `:33`) ·
  `state.test.ts` (246, `types` + `scripts/server.ts`).
- **The straddler is an implementer's call (R6 says so), and 1b changes its
  inputs.** `imageOptimize.test.ts` imports `../surface/state/imageOptimize`
  (`:2`) and `…imageOptimize.server` (`:3`). After 1b the second is in
  `scripts/` **and — per R1's corrected three-file sort — the first is in
  `shared/`**, so **neither** file it imports is still in `surface/`. It is 22
  lines. **Splitting it into a 2-line backend test and a surface test is cheaper
  than reasoning about which side it belongs to** — recommended, but record
  whichever you choose, and note that R6 listed this file among the 8 that move
  to `src/imago/surface/` before the sort was corrected.
- **Where do the 3 backend tests live — `tests/` or `scripts/`?** R6 says "stays
  backend (`plugins/…/imago/`)" without ruling the directory, and the answer
  changes canon: `house-style.md:396-397`'s `enumerate-roster-behaviour-never`
  example names **three** spells that keep tests in `tests/` (glamour, imago,
  magpie). Keeping `tests/` leaves the example true; moving to `scripts/` makes
  it two spells and the example must be rewritten in Phase 5. **Recommend
  keeping `tests/`** — the example is a live scar and this project has no reason
  to spend it.
- **Both numbers in that example are already wrong at HEAD** — `find` returns
  **64** not 63, and the narrow glob **38** not 37. Moving 8 files takes the
  first to **56**. Phase 5 owns the correction; note it here so it is not
  discovered as a surprise.
- Re-declare `DECLARED_BLIND`: imago's three entries (`:72`, `:77`, `:82`) move
  under `src/imago/`. **Total stays 19 files / 4,442 lines.**
- imago has **no `tsconfig.json`** and does not get one here (Tier 3 carve-out).
  Its whole tree is already in the root program, so relocation does not change
  which config sees it — measured: imago contributes 137 before, and must
  contribute 137 after.

**This phase is done when:** both `dist/` are committed and serving; the
local-sim passes for imago as well as astrolabe; `bun test` is ≥ 1481 / 0 fail;
root typecheck is ≤ 434 with imago still at 137 and **mind-mapper still at 0**.

**Key risk:** this is the phase most likely to overrun, and the proposal says
so. The escape hatch is R7's: **if astrolabe turns out not to be free, drop it**
— Slice 1 is proven by imago either way. There is no equivalent hatch for imago.

##### ⛔ What 1c's gate cannot see

_Assembled from facts stated above; nothing new is claimed here._

- **The same blindness as 1a:** `bun test` runs with root `node_modules` present
  and never builds, so an import that only resolves in-repo passes green. Only
  the local-sim discriminates — and this phase's done-when needs it twice, for
  imago as well as astrolabe.
- **The gate is `check && test`, which never runs `bunx tsc`.** The "137 before,
  137 after · mind-mapper still 0" half of the done-when is a **manual** run;
  nothing fails if it is skipped.

---

## ⛔ What this sprint's gate cannot see

_The sprint can be reported green while every one of these is true._

- **`bun run check` is biome alone** and reads four extensions. It says nothing
  about the 4,442 blind lines; only `bun test` prints them.
- **Nothing here runs `bunx tsc`.** The team gate is `check && test`.
- **Nothing runs `build.ts`.** A `dist/` can be stale or absent and the suite
  stays green — the hole that
  [`stale-dist-fires-unconditionally`](../../../../backlog/2026-08-10-stale-dist-fires-unconditionally.md)
  documents from the other side.

## Carry-forward into Sprint 02

- **The emission ruling is untouched here on purpose.** Sprint 02 makes it, and
  it should be made knowing what this sprint learned about what the artifact
  actually needs.
- Whether the two-root blind set stayed honest through two relocations — if it
  did not, Sprint 02 inherits a broken instrument.
- Whether `shared/` proved to be the right third bucket, or whether glamour's
  and magpie's `.server.ts` files will need a different sort.

### ⚠ `src/<spell>/` is governed by NO import ward, and this sprint moves code into it

**Measured 2026-08-31, at `63a9960`:** ward 1a's root is
`PLUGIN_ROOT = "plugins/spellbook"` (`import-boundary-wards.test.ts:161`); ward
2's is `KIT_DIR = "src/kit"` (`:380`). **Nothing covers `src/<spell>/`.**

**Sprint 01 is what fills that gap with code.** 1a moves astrolabe's surface
there and 1c moves imago's, so the ungoverned region grows by two spells in this
sprint alone, and by every spell thereafter.

**Why it is a carry-forward and not a Phase 0 defect:** a surface is bundled, so
a relative escape out of `src/<spell>/surface/` is absorbed into the bundle
rather than breaking a deps-free destination — it is not ward 1a's hazard. **The
hazard it IS: a cross-spell import** (`src/astrolabe/surface/` reaching into
`src/mind-mapper/surface/`) **is invisible to every check we have, and that is
precisely the coupling this project exists to control.** `src/kit/` gets a ward
because it is the sanctioned sharing point; the unsanctioned one has none.

> Returned as a `seams.md` candidate by cassandra and **not yet written** —
> _"the wards and the blind set enumerate two different 'plugins'
> (`plugins/spellbook` vs `plugins/spellbook/skills`), and `src/<spell>/` is
> inside the blind set's denominator but outside every import ward's. **Contract
> 4 moves surfaces into exactly that ungoverned gap.**"_ The blind set counts
> those files; no ward reads their imports.

**Candidate remedy for Sprint 03's Seam C pass, not for this sprint:** a ward 3
— no file under `src/<spell>/` may make a relative import into a different
`src/<other-spell>/`. It would be **green by construction today** (two spells,
no cross-imports), which means it needs the same zero-guard discipline ward 2
carries, for the same reason: a vacuous pass now that gets trusted later.

---

**Related:** [proposal](../../proposal.md) ·
[design-resolution](../../design-resolution.md) ·
[gap-analysis](../../gap-analysis.md) · [project ledger](../../README.md)

---

_Reconciled 2026-08-31 @ `9b6d8e5` — **SPRINT COMPLETE, all five proofs HELD.**
"blind set 19 files / 4,442 lines over two roots, calibration fails in either":
**HELD** (instrument run directly; held through \_two_ relocations). "all three
wards fail when handed a synthetic violation; ward 2's zero-guard fails on an
empty population": **HELD**, 13 cells / 0 fail — and ward 2's floor was
**replaced with membership** after firing on schedule (`5253b72`). "astrolabe
and imago each serve from `dist/` in release mode from a copy with no
`node_modules` up-tree": **HELD**, both driven in a browser.
"`grep '../surface/' imago/scripts/server.ts` returns exactly one line":
**HELD** — it is `:49`, not the `:35` this plan cited; biome's import sort moved
it. "mind-mapper's suite and typecheck stay green, 0 errors": **HELD** (0).
**FALSIFIED and corrected in place:** the carried baseline's
`ward 1b -> 1 after R1 moves sharp's importer` (the swap landed first, so it
stays 0); R6's `88 bare specifiers / 34 lucide-react` (**95 / 42**, a line-bound
scan missing 8 multi-line imports); `Bun.Image is byte-identical` (behaviourally
equivalent, **not** byte-identical). **UNRECONCILED, deliberately:** this plan's
`imago contributes 137 tsc errors before and after` — the **invariant held** and
the constant is one high; measured 137 at `431fb53` and 136 at HEAD, the
difference attributable to the `sharp` swap removing a call-overload error.
`root typecheck <= 434` is a pre-Phase-0 figure; the tree is **433**, and the
full ledger is 434 + 17 (new ward files) - 1 = 450, then -17 when those were
fixed.\_
