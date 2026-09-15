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
measured the two halves disjoint — server imports 15 symbols, the surface 4,
**intersection zero**. _(Corrected 2026-09-03 from 16: daedalus re-derived it by
command at `c8730ec` — plan/daedalus.md T1.3. The ratify counted the server's
import list and called it the backend half.)_ circe preferred `shared/reduce.ts`
whole, calling the split a refactor "no surface rewrite" does not license.
**Ruled: split.** The scope objection is answered by daedalus's own argument —
shipping it wholesale hands the surface **21 backend exports it must never
call**, which is the misfiled-`.server` defect mirror-imaged. Not splitting
reproduces the exact bug this port exists to fix, so it is not gold-plating.

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

## 🔄 Reconciled 2026-09-03 @ `9964926` — against the landed acc L0 pass

`feat/glamour-acc-l0` merged to `develop` (`389d088`, 10 commits) and `develop`
is merged in here. The acc pass rewrote `scripts/cli.ts` (+712) and added
`tests/cli-contract.test.ts` (+363); it touched **no** file this plan relocates.
Claims re-checked below — the verdict is written even where nothing moved,
because an unchecked claim and a confirmed one are indistinguishable in silence.

- **"Phase 3 is ordered behind the `printJson` convergence trigger"** —
  **HELD.** The acc session's own deferred list records the trigger as _"still
  not pulled"_; the new command table is local to glamour and imports nothing
  from `src/kit/`. thoth's canon argument (Contract 3 enumerates astrolabe and
  magpie only) is untouched. Phase 3 stays dropped.
- **S1's three dual-consumer modules** (`types.ts`, `imageOptimize.ts`,
  `reduce.ts` SPLIT) — **HELD.** acc changed `scripts/cli.ts` only;
  `surface/state/` is byte-unchanged, so the symbol-grain measurement behind the
  split ruling still stands.
- **S4's "glamour keeps 7 tests in `tests/`"** — **STALE. It is 8.**
  `cli-contract.test.ts` landed with the acc pass.
- **⚠ S4's real deliverable — "glamour needs an 8th test, a
  `release-serve.test.ts` with the forced-dev cell"** (cassandra and circe,
  independently) — **STILL OPEN, and now easy to misread as closed.** An 8th
  test did arrive, and it is not that test. `cli-contract.test.ts` characterises
  the **CLI's wire**; the uncovered subject is the **surface-serving path**,
  which `daemon.integration.test.ts` still never fetches (`/` is never requested
  — cassandra deleted the board route outright and the file stayed 16 pass / 0
  fail). **Counting to eight satisfies nothing here.** glamour still has no
  `release-serve.test.ts`; astrolabe and imago have the cell, mind-mapper and
  magpie do not.
- **NEW OBLIGATION, and it lands on this branch.** The acc charter's second
  success criterion is explicitly the port's to close: re-run `acc check` after
  the relocation and it must **still pass, or the port must name what it
  changed**. That is the characterization payoff the whole ordering was for.
  Added to the verification gate below.
- **cassandra's line-number trap** — **HELD.**
  `import-boundary-wards.test.ts:1089` still pins `glamour/scripts/server.ts`
  **line 77** by number; acc did not touch `server.ts`. Expect the false red
  during Phase 1.
- **circe's Phase-3 specifier hazard** (`tests/cli.test.ts` imports ten named
  exports from `../scripts/cli`, which Phase 3 would turn into a launcher) —
  **MOOT.** Phase 3 is dropped, so `cli.ts` stays authored in place. Her related
  note that Phase 3 moves `exit-site-inventory.test.ts`'s hard-coded entries is
  moot for the same reason; acc has already revised those entries and the
  flag-invariant ward for its own change.
- **S6 — "acc is severable"** — **DISCHARGED, not pending.** It ran ahead of the
  port and passed at kit 0.1.11. What is still unruled is whether `acc` is wired
  into `bun run gate` at all; the acc session recommends it and names **Cole**
  as the owner, since it is a gate-cost decision.

## 🔄 Reconciled 2026-09-03 @ `cae26f8` — the port is COMPLETE

**Both phases landed.** `9f2cbd4` the seam · `cae26f8` the surface relocation
and build · `10aa386` the Contract 5 comments with their rebuilt bundles ·
`50932b8` the playbook and house-style synthesis. Gate 1587 pass / 0 fail / 123
files. `dist roster: 5 buildable spell(s)`.

**Claim by claim, verdicts written even where nothing moved:**

- **S1 — reduce.ts SPLITS, three dual-consumer modules** — **HELD, and measured
  true at the sha** by daedalus: 21 backend exports to `scripts/`, 4 selectors
  to `derive.ts`, `types.ts` and `imageOptimize.ts` to `shared/`.
- **S2 — exactly one `src/`-naming SPECIFIER on the shipped path** — **FALSIFIED
  AS WRITTEN at the ratify, HELD as corrected.** Measured at `cae26f8`: one, in
  `server.ts`'s dev ternary. ⚠ A naive `grep -rn "src/glamour" scripts/` now
  returns **six** — the other five are prose, including the preflight hint that
  names the path deliberately. **Count specifiers via the scanner, never text.**
- **S3 — the deployed folder is source-free** — **FALSIFIED AS WRITTEN, HELD as
  corrected.** `plugins/…/glamour/` is exactly
  `SKILL.md · acc.config.json · dist · scripts · shared · tests · tsconfig.json`.
  No `surface/`, no `bunfig.toml`.
- **S4 — the tests survive the move** — **HELD as corrected.** The real
  deliverable was the eighth test, and it exists: `release-serve.test.ts`, 7/7
  mutation arms, calibrated by its non-author.
- **S5 — glamour arrives conforming** — **HELD.** The css-scope ward is 9/0 with
  glamour in its population; the arrival case reproduces under the pre-fix ward
  and clears under the landed one. Shipped stylesheet 41,048 B, the figure
  predicted from a scan before glamour was in the roster.
- **S6 — acc is severable** — **DISCHARGED.**
- **S7 — the playbook compresses on confirmation** — **CONTRACT HELD, THESIS
  FALSIFIED, and they are separable.** Every confirmed section shrank; every
  increase named a lesson. And the file went **513 → 522 lines**, against a −120
  prediction its author scored rather than re-baselined. A playbook documenting
  a fifth spell's worth of distinct mechanisms is not compressible by being
  confident.

## ⛔ PHASE 3 RE-ANSWERED 2026-09-03 (Cole asked, post-acc) — VERDICT UNCHANGED

**The question:** does the acc work on glamour's _backend_ change the ruling,
given a build would enable cross-CLI sharing?

**Both original grounds re-measured at `cae26f8` and both HOLD.** Structural
benefit is still zero — glamour's shipped backend imports only `../shared/*`,
`./*.server`, `./reduce` and `node:` builtins; a build inlines what will not be
at the destination and there is nothing. Canon still excludes it: Contract 3's
repeal is enumerated (astrolabe, magpie) and neither clause fires.

**⚠ BUT ONE INPUT FLIPPED AND WAS NEVER RE-CHECKED UNTIL ASKED.** thoth's ratify
finding was that Phase 3 needed TWO gates and acc was the second — _"a spell
goes conformant before its backend goes opaque."_ At the ratify glamour had no
`acc.config.json`, the same fact that excludes imago. **It has one now, L0 at
kit 0.1.11. Gate 2 is satisfied.** glamour did not become permitted; it became
**eligible**.

**And the sharing pressure is measurably higher:** 6 spells now carry a command
table, 4 define a local `printJson` against the kit's one, 2 carry the CliError
taxonomy. Census:
`docs/backlog/2026-09-03-six-dies-the-cli-boilerplate-census.md`.

**Why it stays dropped — the causation runs the wrong way.** Building glamour
does not create sharing; sharing would REQUIRE a build. The live question is
whether those helpers converge into `src/kit`, and that is roster-wide: **bounty
and grapevine are not in `src/` at all.** Plus a hazard that stayed dead only
because Phase 3 dropped — glamour is the first spell where the file that becomes
the launcher is also a file a test imports names from (`tests/cli.test.ts` → 10
named exports from `../scripts/cli`).

**⛔ THE TRIGGER'S WORDING WAS WRONG AND IS HEREBY CORRECTED.** It read
_"glamour builds if it ever drops its local printJson for the kit's"_, which
implies glamour decides. It now reads: **glamour builds when the ROSTER rules on
convergence; it is PRE-QUALIFIED, having cleared the acc gate.** Owner: whoever
takes the boilerplate-census project, which Cole has agreed to run next.

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

**CORRECTION — RATIFIED CONTRACT (daedalus #1120, circe #1123; ruled #1124).
Build to this, not to the claim above.**

- **The set is THREE modules, not two.** `surface/state/imageOptimize.ts` is the
  third — surface via `fileIntake.ts`, backend transitively via
  `imageOptimize.server.ts`. **Phase 1's stated grep proof cannot see it**:
  after Phase 1 the edge originates in the relocated backend file, not in
  `scripts/`.
- **Destination: `plugins/spellbook/skills/glamour/shared/`**, owned by neither
  seat — a peer of both, and imago's and magpie's built-twice answer.
  `import-boundary-wards.test.ts:496` already defines the shipped execution path
  as `/\/(scripts|shared)\//`.
- **`reduce.ts` SPLITS** — backend half (**21 exports: 15 imported by
  `server.ts`, 6 consumed only by `tests/reduce.test.ts`**) →
  `scripts/reduce.ts`; surface half (4 pure selectors: `itemsByKind`,
  `MarkFilter`, `matchesMarks`, `agentRepliedSince`) stays in the surface.
  **Filename and home are circe's and are NOT ruled.** `types.ts` goes to
  `shared/` **whole** — the split criterion is **runtime reach**, and types
  erase at runtime.
- **`src/kit/` is REJECTED on measurement**: a source-shipped backend cannot
  import from `src/` (outside the copied subtree — the specifier dangles at a
  consumer install), and `src/kit/` is a Tailwind content source for every
  adopting spell.

**Grain:** the **symbol** boundary for `reduce.ts`, the **module** boundary for
`types.ts` / `imageOptimize.ts`. Nothing finer.

_Full verdicts: comms `#1119`–`#1123`; rulings `#1124`._

### S2 — what the daemon serves · **RATIFIED at the SPECIFIER grain; INCOMPLETE in three ways**

`server.ts` currently does `import index from "../surface/index.html"` — a
bundler entry, not an ordinary import, and the one reference that survives S1.

> **CLAIM:** the daemon serves the **built artifact** where one exists and the
> live surface otherwise, and **the release path imports nothing from `src/`**.

**CORRECTION — RATIFIED CONTRACT (daedalus #1120), with a measured repro.**

The invariant, at the grain it will be built to: **exactly one `src/`-naming
specifier per deployed spell**, in `scripts/server.ts`, inside the
`mode === "dev"` ternary. Measured across four arms with positive controls — a
top-level static import dies at **load**, a branch-guarded dynamic one dies at
the **await**; that distinction is the whole mechanism.

**Three things the claim omits and a builder needs:**

1. **glamour has no `resolveMode()`, no `DIST_DIR`, no mode at all.** Contract 1
   requires the daemon to **emit its resolved mode**, on both transports (ready
   event _and_ discovery JSON, as imago does) — or the verification gate has
   nothing to assert and a dev daemon renders an identical-looking board.
2. **The dev half of this seam is not in `server.ts`.** `scripts/cli.ts:372`
   spawns the daemon with `cwd: SKILL_ROOT`; under Contract 5 that pin must
   become `src/glamour/` when the surface moves, and `bunfig.toml` must move
   with it. **This seam spans `server.ts` AND `cli.ts`.** ⛔ _FALSIFIED
   2026-09-03 (circe's measurement, `#1263`; ruled `#1264`): this clause read
   "**Tailwind is silently skipped** and the board renders unstyled". It is not
   silent. Without the pin the dev bundler cannot compile the stylesheet and the
   **PAGE fails — 500, no stylesheet link**. The requirement stands; its REASON
   is corrected. The sentence had propagated unmeasured through five spells'
   comments, the playbook, a lane and three of this session's rulings — see
   `.anthill/dev/seams.md`, the Contract 5 amendment. Found by thoth's 3.75
   sweep of a doc no seat owns._
3. **`bunfig.toml` must leave the deployed folder** — 0 of 4 landed spells have
   one; glamour does.

_Full verdicts: comms `#1119`–`#1123`; rulings `#1124`._

### S3 — what the deployed folder is · **FALSIFIED AS WRITTEN**

> **CLAIM:** glamour's shipped folder contains **no source a consumer could edit
> and no source a bundler would read** (Contract 4, source-free by FILES not by
> strings), and `bun scripts/dist-check.ts` counts **five** buildable spells and
> stays green.

**CORRECTION — RATIFIED CONTRACT (daedalus #1120, cassandra #1122).**

The face-value claim is **false of all four already-landed spells** — every one
ships hand-authored `.ts`. The operable invariant is Contract 4's own proof:
**the deployed folder contains no `surface/` and no `bunfig.toml`, and nothing
in it resolves anything under `src/` on the release path.** Source-free by the
**file list**, not the file class.

**⚠ A THIRD CLAUSE THE PLAN DID NOT HAVE — successor present is HALF a check.**
`git ls-files plugins/spellbook/skills/glamour` must contain **no path under
`surface/`**, asserted over the tracked subtree. cassandra planted a 34-byte
`src/glamour/surface/index.html` with the predecessor **fully intact** and
`dist-check` reported `buildable spells 5`. **A copy-not-move passes both
halves, and it was literally true of this tree while she measured it.**

**⚠ Prerequisite, not consequence:** `.gitignore` is a bare `dist` rule plus a
hand-kept un-ignore list. Without the two `!plugins/.../glamour/dist` lines,
`git add` stages nothing **at exit 0**, glamour ships with no `dist/`, falls to
dev mode, and dies importing a `src/` tree the marketplace never copied.

Post-port deployed folder, stated so it can be checked rather than inferred:
`SKILL.md` ·
`scripts/{cli,server,persist.server,styles.server,imageOptimize.server,reduce}.ts`
· `shared/{types,imageOptimize}.ts` · `tests/` (backend half) · `dist/`. **GONE:
`surface/`, `bunfig.toml`.**

_Full verdicts: comms `#1119`–`#1123`; rulings `#1124`._

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

**CORRECTION — RATIFIED CONTRACT (cassandra #1122, circe #1123).**

**The stated hazard cannot happen to 6 of the 7.** All reach their subjects by
static ESM **value** import; a vanished path is a hard load error, measured
(`mv reduce.ts` away → 31 pass / 3 fail / 3 errors). **S4 as written sails
through, and that is the suspicious outcome.**

**The real gap is a live, already-green test that never covered the subject.**
`daemon.integration.test.ts` fetches only `/state`, `/cmd`, `/events` across all
16 cells — **never `/`**. cassandra deleted the board route outright and it
stayed **16 pass / 0 fail**. The relocation then converts `server.ts`'s
load-time `import index from "../surface/index.html"` into an unreachable dev
branch: pointed at a file that does not exist, the full suite still reports the
**exact baseline, 1539 pass / 0 fail**. No wording detects absence.

**THE DELIVERABLE:** glamour gains a **`release-serve.test.ts` with the
`SPELLBOOK_SURFACE_MODE=dev` forced-dev cell** — force dev, assert the daemon
dies naming `src/glamour/surface/index.html`. astrolabe and imago have this
cell; mind-mapper and magpie do not.

**⚠ Operational, for Phase 1:** `import-boundary-wards.test.ts:1089` pins
`glamour/scripts/server.ts` **line 77 by line number**. Any insert above it
false-reds. It cost cassandra one red already.

**⚠ THE POPULATION IS NOW 8, AND THE 8TH IS NOT THIS TEST** (2026-09-03).
`tests/cli-contract.test.ts` arrived with the acc pass. It characterises the
**CLI's wire**; the subject named above — the **surface-serving path** — is
still uncovered, and `release-serve.test.ts` still does not exist. **Counting to
eight satisfies nothing here.**

_Full verdicts: comms `#1119`–`#1123`; rulings `#1124`._

### S5 — glamour arrives conforming · **HALF ONE FALSIFIED · HALF TWO RATIFIED at the byte**

glamour's `styles.css` uses `@source "./**/*.tsx"` today.

> **CLAIM:** on arrival glamour satisfies Contract 21 (`source(none)` + a scoped
> `@source`), **and no other spell's shipped stylesheet changes by a single
> byte** as a consequence of glamour entering `src/`.

The second half is the testable one: the four existing spells are the control.

**CORRECTION — RATIFIED CONTRACT (circe #1123).**

**Half one is FALSIFIED: `source(none)` + `@source "./"` is necessary and NOT
sufficient.** With glamour arriving **fully conforming**,
`grimoire/spell-css-scope-ward.test.ts` **reds** —
`"glamour carries 1 class(es) only astrolabe uses: 32"`. glamour is the roster's
first spell using a leading-digit variant (`2xl:`), CSS escapes it as `\32 `
(space-terminated), and the ward's `harvest()` regex stops at the space and
invents a phantom class `32`. **The correction is in the ward, not in glamour**
— and it will name the WRONG SPELL. Filed:
`docs/backlog/2026-09-02-css-scope-ward-invents-a-phantom-class-from-escapes.md`.

**⚠ Half two is RATIFIED at the byte but is NOT a test of half one.** All four
control stylesheets stay byte-identical **even when glamour arrives
non-conforming** — reading "controls unchanged" as evidence glamour conformed is
a false green.

Also measured: `@source "./**/*.tsx"` vs `@source "./"` differ by exactly one
rule — the `<body>` background from `index.html`. **The glob silently drops the
page background.** Cost of not conforming: **124,639 B → 41,048 B, 3.04x.**

_Full verdicts: comms `#1119`–`#1123`; rulings `#1124`._

### S6 — acc is severable · **SPLIT: ratified for Phases 1–2, FALSIFIED for Phase 3**

> **CLAIM:** the port completes and ships **without** acc, and adding acc L0
> later costs no rework of the earlier phases.

**If this is FALSE, say so early** — it changes the phase order, not the scope.

**CORRECTION — DISCHARGED, and the canon half is a RULING, not a phase (thoth
#1119, cassandra #1122).**

acc L0 ran **ahead** of the port and passed at kit **0.1.11**
([`../glamour-acc-l0/`](../glamour-acc-l0/proposal.md)), so the severability
question is settled by event rather than by argument.

**The canon half outweighs the seam.** thoth's cross-tab: `ported ⇒ acc` is
**3/4 and FALSE** (imago falsifies it); `built backend ⇒ acc` is 2/2 with no
counterexample. **acc travels the agent-legibility axis independently of the
port axis.** And Contract 3's repeal is **narrow and enumerated — astrolabe and
magpie only**; glamour is named in canon as the spell that would _earn_
promotion, which is precisely the statement that it does not have it. Neither
repeal clause fires. **So Phase 3 was never an implementation phase: it is a
canon act — an amendment or a promotion — that must be WRITTEN BEFORE a build
lands.** That is a further reason it is dropped, independent of the
measured-zero-benefit one.

_Full verdicts: comms `#1119`–`#1123`; rulings `#1124`._

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

**And the characterization arm, which is this port's alone** (added 2026-09-03 —
the acc charter's criterion 2, left open for the port to close):

```
bunx acc check plugins/spellbook/skills/glamour/scripts/cli.ts \
  --config-dir plugins/spellbook/skills/glamour
```

must still pass at kit **0.1.11**, run from the spell directory. **Exit 9 is the
only "not conformant" code — anything else is the kit failing**, and a kit
failure read as a pass is the one outcome that makes the whole
harness-before-the-port ordering worthless. If the port does move conformance,
that is a legitimate result and the port **names what it changed**; a silent
delta is not.

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
