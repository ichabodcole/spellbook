# Sprint 02 — The boring module

**Status:** Planned (depends on Sprint 01) **Created:** 2026-08-30 **Project:**
[spell-kit](../../proposal.md)

> **What this sprint delivers:** code actually shared, on **both** sides of the
> surface/backend line — and the one irreversible decision this project
> contains.
>
> **Its governing discipline, and its name:** prefer the **most boring** module
> available, never the most valuable one. `printJson` is byte-identical across
> five spells; there is no abstraction to invent, so sharing it tests the
> platform and nothing else. The chat sidebar (1,281 lines, 4 spells) is the
> valuable extraction and exactly the wrong first one — its four copies are four
> architectures. **"Amount of code shared" is an explicit non-criterion.**

## Read before you start — this is not a self-contained work order

**The analysis behind this sprint's one irreversible decision is not in this
file.** The option table below is a compression of
[RB](../../design-resolution.md#rb--the-backend-emission-trade-legibility-belongs-to-the-interface);
making the emission ruling from the compression alone means re-deciding a
question that has already been half-answered, without the evidence.

| Read this                                                                                                                        | Before              | Because                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RB — the backend emission trade](../../design-resolution.md#rb--the-backend-emission-trade-legibility-belongs-to-the-interface) | the ruling          | It removes **one** reason (source-readability) and names the real cost, with the cold drive, the `--sourcemap=inline` measurement and the acc prerequisite behind it. **It explicitly does not open the gate** — do not read it as having chosen. |
| [R6 — the wards](../../design-resolution.md#r6--the-shared-import-wards-and-imagos-test-split)                                   | Phases 2 and 3      | Ward 1a **permits `plugins/spellbook/lib/` on purpose** and must not be read as endorsing option 1; Ward 1b is what catches a dependency reaching the shipped execution path; Ward 2 stops being vacuous the moment Phase 3 creates `src/kit/`.   |
| [Sprint 01's plan and its carry-forward](../01-the-seam-before-the-move/plan.md)                                                 | the ruling, Phase 3 | The ruling is meant to be made **knowing what Sprint 01 found** about what the artifact actually needs. Phase 3 also depends on Phase 1 having moved all three surfaces under `src/`.                                                             |
| [The ledger's vocabulary table](../../README.md)                                                                                 | anything            | **emission**, **the gate** (three senses — the CI check, the emission decision, and a filename), **local-sim** and **acc** all mean something narrower here.                                                                                      |
| [The gap analysis's finding index](../../gap-analysis.md#finding-index)                                                          | Phase 3             | Phase 3's staleness work **is** finding I5, and the index says what the other bare ids are.                                                                                                                                                       |

## The proof this sprint must produce

1. **Two spells' shipped `scripts/` import one implementation**, and the
   installed artifact still runs from a copy with no `node_modules` up-tree.
2. **Two surfaces import `cn()` from `src/kit/`**, both `dist/` build, and
   neither artifact gains a source file.
3. Ward 2 (`src/kit/` is a leaf) goes from vacuously green to **meaningfully**
   green — it now has something to guard.
4. **The emission ruling is made, recorded, and warded.**

> **⛔ Both phases below end with what their gate CANNOT see, and this sprint is
> the one where that matters most.** **Every one of the three emission options
> passes `bun test`** regardless of whether the installed artifact works — the
> suite runs in-repo, with the full tree and root `node_modules` on disk. The ⛔
> block is where the discriminating check is named. Read it before you report
> either phase green.

> ### The ruling is the deliverable, not a side effect
>
> [RB](../../design-resolution.md) removed the bad reason for one answer —
> source-readability does not survive testing, and `--sourcemap=inline` embeds
> the original TypeScript anyway. **What remains is the real cost: a build step
> in the backend's dev loop**, which is what the pipeline proposal's §5
> dependency-smell guardrail exists to resist.
>
> Make it **knowing what Sprint 01 learned**. One fact bears on it: imago has
> **no `acc.config.json`** (RB's conformance prerequisite).
>
> ⛔ **CORRECTED 2026-08-31 — the second fact is dead, and it was the
> load-bearing one.** This passage said imago's `sharp` dependency _"trips
> Contract 3's native-addon repeal trigger by itself — an argument for option 3
> that is independent of anything about sharing."_ **`sharp` is gone.**
> daedalus's `Bun.Image` swap removed it from every shipped path in Sprint 01;
> only a test fixture and one comment mention it (verified twice). **Contract
> 3's original native-addon trigger now has ZERO live instances**, so option 3
> has **no** argument independent of sharing — the whole case rests on the
> six-copy `printJson`, which is code organisation and does not fire that
> trigger at all. Contract 3 is therefore **amended**, not repealed; see
> [its amendment](../../../../../.anthill/dev/seams.md) (Contract 3,
> 2026-08-31).

## Phases

### Phase 2 — One backend module, two spells, and the emission ruling (Slice 2)

**Goal:** two spells' **shipped** `scripts/` resolve one `printJson`, and the
installed artifact still runs. This phase contains the project's only
irreversible decision.

#### The decision point — do not default into it

`scripts/*.ts` ships as **source** and executes where nobody ran `install`.
Anything it imports must physically resolve there. RB removed source-readability
as a reason and named the real costs:

| Option                           | Portable                   | Self-describing             | Real cost                                                          | Ward it would need                                                                  |
| -------------------------------- | -------------------------- | --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **1 · `plugins/spellbook/lib/`** | ❌ Claude-marketplace only | ✅ source                   | breaks the skill-directory unit the Agent Skills standard requires | a **tighter** Ward 1, scoped to the skill dir, with `lib/` carved out               |
| **2 · vendor per skill**         | ✅                         | ✅ source                   | N copies; a staleness ward is **mandatory, not optional**          | vendored copy is byte-identical to its kit source                                   |
| **3 · build the backend**        | ✅                         | ✅ via `--sourcemap=inline` | **a build step in the backend dev loop**                           | built artifact runs with no `node_modules` and no unbuilt source; a freshness stamp |

**Three inputs the source documents do not put side by side:**

1. **Option 3 has a prerequisite that imago fails today.** RB: _"a spell is
   conformant before its backend goes opaque."_ Three spells carry
   `acc.config.json` — astrolabe, magpie, mind-mapper. **imago does not.**
   Choosing imago as one of Slice 2's two spells therefore **forecloses option
   3** unless acc conformance for imago is brought into scope, which it is not.
2. **Option 3 also requires a narrow repeal of seams Contract 3** (_"Backend
   ships as source (no build)"_), whose own criterion says to repeal for one
   spell first and promote only on a second independent signal.
3. **Option 2 is the mirror this project's thesis calls the disease** — but a
   _warded_ mirror is a different object from an unwarded one. If option 2 wins,
   the ward is the deliverable, not the copies.

**Slice 2 does not depend on Phase 1.** `printJson` is backend-only, and no
candidate spell needs a relocated surface. The pair can be chosen on the
emission ruling's terms:

| Candidate pair      | Both have `printJson`?                                      | Keeps option 3 open?   | Note                                                                  |
| ------------------- | ----------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| imago + astrolabe   | ✅ (astrolabe's is an arrow const — a 1-line normalisation) | ❌ imago has no acc    | both already in Slice 1's blast radius                                |
| astrolabe + magpie  | ✅                                                          | ✅ both acc-conformant | magpie is otherwise untouched by this project                         |
| imago + mind-mapper | ❌ **mind-mapper has none**                                 | ❌                     | requires introducing `printJson` at `cli.ts:578/:608/:626/:740` first |

**Recommendation, offered as input and not as the ruling:** make the emission
ruling first, then pick the pair it allows. If options 1 or 2 win, **imago +
astrolabe** is the cheapest pair and rides on Phase 1's work. If option 3 is
live, the pair must be **astrolabe + magpie**.

#### Key changes

- One implementation of `printJson`, placed per the ruling. **The six copies, by
  path:** `bounty/scripts/cli.ts:82-84` · `glamour/…:51-53` · `imago/…:68-70` ·
  `magpie/…:142-144` · `grapevine/…:354-356` — all five byte-identical (md5
  `d71e4b2d…` over the three-line span) — and `astrolabe/scripts/cli.ts:53`, an
  arrow const that normalises to the function form with no behaviour change.
  **None is exported today**; each is file-local, so every consumer gains an
  import it did not have.
- Delete the two now-dead local copies; leave the other four alone. **Deleting
  all six is out of scope** — this phase proves a mechanism, not a cleanup.
- The ward the ruling produces (right-hand column above), as a real
  `grimoire/*.test.ts` cell that fails when handed a violation.
- **Record the ruling in this project's docs**, with the three options and why
  the loser lost. RB is the analysis; this is the decision.

**This phase is done when:** both spells' CLIs emit **byte-identical** stdout
for the same input, sourced from one file; a `diff` of the two outputs is empty
and is asserted in a test; **and the local-sim runs both CLIs from a copied
skill folder with no up-tree `node_modules`** — which is the whole question.

#### ⛔ What Phase 2's gate cannot see

_Everything above can be green while this is true._

- `bun test` runs in-repo with root `node_modules` on disk and the full tree
  present. **Every one of the three options passes `bun test` regardless of
  whether the installed artifact works.** The local-sim is not optional here and
  it is not automated — write it down as a procedure or it will not be run
  twice.

---

### Phase 3 — One surface module, two surfaces (Slice 3)

**Goal:** two surfaces import one module from `src/kit/`, and neither `dist/`
grows a source file. Cheap by construction — the bundler erases the import —
**but "free" is a prediction until something runs.**

> ⚠ **MEASURED — and then CORRECTED on review. The scan is right; the conclusion
> was too strong.** A whole-repo scan for identical non-trivial lines between
> any two of the three porting surface trees returns single digits, and the
> three surfaces are genuinely disjoint by that measure. _(For scale, the
> out-of-scope pairs are not: imago↔magpie is **114** identical substantive
> lines, imago↔glamour **51**.)_
>
> **But Slice 3 does not require duplication. It requires a module two surfaces
> import.** The scan looked for the former and so could not see the latter — and
> there is a clean candidate it structurally could not find, added as the first
> row below.

| Candidate                                                                                                                                                          | What it is                                                                                                                                                                                              | Why it costs something                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`cn()` from `src/mind-mapper/surface/lib/utils.ts`** ⭐⭐                                                                                                        | 10 lines, **dependency-free by design**, `ClassValue` + a filter-join. **7 call sites in mind-mapper; imago has none.** Moves to `kit/lib/cn.ts`; mind-mapper re-points, imago adopts at one call site  | Nothing that matters. It is a **value** export (not type-only, so the bundler is genuinely exercised), it is boring by construction, and it is a **prerequisite for `kit/ui/` later** rather than throwaway proof scaffolding      |
| **Fold into Phase 4**                                                                                                                                              | Phase 4's kit component **is** a shared surface module, imported by two surfaces                                                                                                                        | Slice 3 stops being a separate proof, and the two capabilities land tangled rather than separately — **now unnecessary, given the row above**                                                                                      |
| `useEscape(onClose, enabled?)`                                                                                                                                     | 3 clean sites — `imago/surface/components/Lightbox.tsx:7-13`, `ContentModal.tsx:31-37`, `astrolabe/surface/components/AddProjectModal.tsx:37-44` — plus 3 imago near-sites that add pointerdown-outside | A **hook, not a pure function**; and the consumers are imago + astrolabe, **not mind-mapper**                                                                                                                                      |
| `ConnStatus` + the `wss:`/`ws:` derivation                                                                                                                         | byte-identical in `mind-mapper/…/useProjectState.ts:24,:100-101` and `imago/…/useSession.ts:4,:13-14` (magpie too)                                                                                      | **2 lines.** A 2-line module is worse than the duplication — and the type half erases entirely, so it proves nothing about the bundler                                                                                             |
| ~~`relTime` / `formatAge`~~ **moot 2026-08-31** — `buildInfo.ts` was deleted at `fae8830`, so the pair no longer exists. Retained as the record of why `cn()` won. | the only genuinely **pure** pair — `astrolabe/…/board.ts:33-43` vs `mind-mapper/…/buildInfo.ts:15-24`                                                                                                   | Five substantive differences (`round` vs `floor`, seconds tier, `""` vs `null`, epoch vs ISO). Converging **changes rendered strings in both spells** and breaks `buildInfo.test.ts:10-12,22`. A rewrite wearing a share's clothes |

**RULED (Cole, 2026-08-30): take `cn()`.** Slice 3 does **not** fold into Phase
4 and does **not** take `useEscape`. **Do not take `relTime`** — it is exactly
the abstraction-design trap the project's own rule warns about, and the standing
instruction applies: bank the ruling, narrow the proof.

> **This spends a criterion this plan invented, and that is deliberate.** The
> "already duplicated" test below is **stricter than the proposal**, which asks
> only for _"one boring module, imported by both surfaces."_ Slice 3 proves that
> **sharing works** — a module one spell has and another adopts proves that
> exactly as well as a deduplication does, and `cn()` is boring by every other
> measure: 10 lines, dependency-free, a pure function, no React state, no domain
> model, no wire type.
>
> **The criterion is struck, not bent.** _(And note what does NOT justify it: an
> earlier draft argued `cn()` is "a prerequisite for `kit/ui/` later." That is
> value-of-the-abstraction reasoning, `kit/ui/` is out of scope, and the
> project's own rule forbids it. `cn()` is taken for being boring, not for being
> useful.)_

**Key changes:**

- Create `src/kit/` with its first module. Ward 2 (Phase 0) becomes non-vacuous
  the moment this lands; confirm its zero-guard now reports a non-zero
  population.
- **Selection criterion, as ruled:** pure function, no React state, no domain
  model, no wire type; under ~40 lines. ~~already duplicated in two surfaces~~ —
  **struck; see the ruling above.** `cn()`
  (`src/mind-mapper/surface/lib/utils.ts:6-10`) satisfies every surviving
  clause: **10 lines, dependency-free by design, 7 mind-mapper call sites, and
  imago has no equivalent** — so imago gains one call site, which is the
  adoption, and it is a one-line change rather than a rewrite.
- **After Phase 1, all three surfaces live under `src/`,** so `src/kit/` is
  reachable by all of them and Ward 2 governs the direction. Before Phase 1 it
  is not — imago's and astrolabe's surfaces still ship inside the plugin
  subtree, where importing `src/kit/` would violate Ward 1. **Slice 3 therefore
  does depend on Phase 1**, unlike Slice 2.
  > ### ⚠ Two bullets stood here and BOTH have lost their subject — reconciled 2026-08-31
  >
  > They said: _extend the staleness walk to `src/kit/`_ (a real work item
  > pointing at `mind-mapper/scripts/server.ts:112-114`), and _mind-mapper's
  > `dist/` is stale at HEAD, rebuild it before building on a false baseline_.
  > **A seat could have picked up either.**
  >
  > **The detector is deleted, not extended** (`fae8830`, Cole's ruling). And
  > mind-mapper's `dist/` was never stale — the detector was **inverted**: it
  > compared mtimes across a git boundary, which preserves neither, so every
  > correct dist reported STALE and the merge that landed two freshly-built ones
  > is what made them look worst.
  >
  > **I5 survives and its remedy space collapsed in our favour.** _Nothing keeps
  > a committed `dist/` honest_ is still true — but with the stamp gone, `dist/`
  > is **byte-reproducible with no exclusion list** (proved at git level: two
  > consecutive rebuilds write the same tree sha). So the honest check is
  > **rebuild and diff** — no basis to rule on, no retention story, and it
  > cannot be inverted by a checkout. **`src/kit/` needs no special handling**:
  > a rebuild consumes whatever the build consumes, so a kit change is caught
  > for free by the same check that catches a surface change.
  >
  > **Not built here.** It is the release-pipeline sprint's, whose plan is
  > [the 2026-08-31 spike](../../../../investigations/2026-08-31-releasing-a-non-stale-build.md).

**This phase is done when:**
`grep -rl "surface/lib/utils" plugins/spellbook/skills/*/dist/` returns
**nothing** — no _source path_ leaked into a bundle. ⚠ **Do not grep the export
name**: the build sets no `minify`, so `cn` survives as an identifier and
matches in every bundle regardless. The path grep is the discriminating one
while both surfaces import it and both boards render. ⚠ _A third clause stood
here — "touching a file in `src/kit/` makes both daemons print `STALE DIST` on
next boot" — and is now simply **false**: that warning was deleted at `fae8830`.
Its replacement, if this phase wants one, is that a rebuild after a `src/kit/`
edit leaves `git status` **dirty**, which is the same signal without a daemon in
it._ _(If Slice 3 folds into Phase 4, the same two checks run there against the
kit component — the proof does not disappear, it changes address.)_

> ⚠ **A type-only shared module cannot satisfy this phase.** `import type` is
> erased by the compiler before the bundler ever sees it, so the `dist/` check
> passes trivially and proves nothing about the mechanism. **The shared module
> must export at least one runtime value.**

#### ⛔ What Phase 3's gate cannot see

_Everything above can be green while both of these are true._

- Nothing in `bun test` builds, so **"the bundler erased it" is unverifiable
  from the suite** — it requires **inspecting `dist/`**.
- A stale committed `dist/` produces a _working_ board — and **nothing in the
  gate distinguishes fresh from stale.** ⚠ _This bullet said "only the stamp
  comparison distinguishes" until 2026-08-31; the stamp is gone, and it was
  inverted anyway. What distinguishes them now is **rebuilding and diffing**,
  which no cell does yet._

---

## ⛔ What this sprint's gate cannot see

_The sprint can be reported green while both of these are true._

- **Every emission option passes `bun test` regardless of whether the installed
  artifact works.** Only a copy-and-run discriminates. The suite cannot tell you
  the ruling was right.
- Ward 1a is blind to bare specifiers; **ward 1b is the one that catches a
  dependency escaping into the shipped execution path**, and it only fires on
  `scripts/` and `shared/`.

## Carry-forward into Sprint 03

- **The emission ruling decides what Sprint 03's canon says.** This is why canon
  lands last: writing it before the ruling means amending `house-style.md`
  twice, and each amendment drags `rule-id.test.ts`, the `decay-ledger.md:80`
  pairing, and a `ward` run with it.
- Whether `src/kit/` needed a shape nobody predicted — Sprint 03 puts a
  _component_ in it, which is a heavier tenant than a pure function.

---

**Related:** [proposal](../../proposal.md) ·
[design-resolution](../../design-resolution.md) ·
[Sprint 01](../01-the-seam-before-the-move/plan.md) ·
[project ledger](../../README.md)

---

_Reconciled 2026-08-31 @ `9b6d8e5` — swept after sprint 01 landed. **"After
Phase 1, all three surfaces live under `src/`" — HELD, and the PRECONDITION IS
NOW MET.** astrolabe and imago both relocated;
`plugins/spellbook/skills/{astrolabe,imago}/surface/` no longer exist. **Slice
3's stated dependency on Phase 1 is discharged** — `src/kit/` is now reachable
by all three surfaces and Ward 2 governs the direction. **"imago does not have
an `acc.config.json`" — UNCHECKED**, nobody owned it this sprint. **⛔ STALE
PATH CITATIONS — every `<spell>/surface/...` reference in this plan now needs a
`src/` prefix**, and the line numbers are unverified:
`imago/surface/components/Lightbox.tsx:7-13`,
`astrolabe/surface/components/AddProjectModal.tsx:37-44`,
`imago/.../useSession.ts`, `astrolabe/.../board.ts:33-43`. **Not silently
rewritten** — re-derive them when the phase runs rather than trusting a line
number nobody re-measured. **NEW INPUT this sprint owes its emission ruling:**
Contract 1's release/dev split is now duplicated verbatim across two spells —
**42 lines of engine byte-identical modulo the spell name** (`resolveMode` 5,
`serveDist` 10, `daemonCwd` 5, `STATIC_CONTENT_TYPES` 8) plus a release-serve
gate that is a 46% copy. That number is this sprint's argument; quote it rather
than re-deriving it._
