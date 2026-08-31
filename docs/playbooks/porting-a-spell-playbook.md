# Porting a Spell to the Built / Shared Layout — Playbook

**Created:** 2026-08-31 **Last Updated:** 2026-08-31 **Status:** Active

---

## Context

A spell starts life self-contained: hand-authored source under
`plugins/spellbook/skills/<spell>/`, run directly by Bun, shipped by copying the
subtree. **Porting** moves its buildable source out to `src/<spell>/`, commits a
built artifact back into the skill folder, and — once ported — lets it share
code with other spells.

The port is not one edit. It is a **sequence with a required order**, and the
repo's own gate (`bun run check && bun test`) is **structurally blind to the two
failure classes the port actually produces**. Four spells have been through it
and the same findings recurred with counts, which is why this exists as a
playbook rather than a plan.

**This playbook does not restate the contracts it depends on.** Every rule below
points at its authoritative home; two denominators for one fact drift apart and
then neither is wrong.

## Applicability

**Use this playbook when:**

- Moving a spell's `surface/` (or a future `backend/`) out to `src/<spell>/` and
  committing a built `dist/`.
- Cutting a spell's backend↔surface seam so its daemon stops reaching into
  surface source.
- Making two spells share one implementation, on either side of that line.
- Any change where **a green suite and a broken installed artifact can coexist**
  — that is the condition this playbook is really about.

**Don't use this playbook when:**

- The change stays inside one spell's already-ported tree. That is ordinary
  work.
- The spell has no build input (no `surface/`, no shared module). There is
  nothing to relocate.
- You are only editing `dist/` — you are not; `dist/` is generated. Edit the
  source and rebuild.

## Prerequisites

- **The wards exist and are green at HEAD, before anything moves.** They are the
  only instruments that observe the move; building them afterwards means
  calibrating them against a tree you already changed.
- **The spell's daemon starts offline.** `bun --no-install scripts/server.ts`
  must not die on a missing package. If it does, that is a live defect and it
  blocks the port's only real proof — see
  [imago's case](../backlog/2026-08-30-imago-daemon-cannot-start-offline.md).
- **A measured pre-move baseline**, captured as _error lines_, not counts. See
  Gotcha 5.
- **acc conformance** if the backend will ship built — a spell goes conformant
  before its backend goes opaque.

## Approach Summary

**Key Principles:**

- **Instruments before the move.** A ward built after the relocation is
  calibrated against the damage.
- **Cut the seam before you relocate.** Prove the coupling is gone while
  everything is still where it was and still shippable; then move.
- **The gate is not the proof. The local-sim is.** `bun test` runs in-repo with
  `node_modules` present and never builds.
- **Rewrite by directory class, never by string.** Compute the new specifier; do
  not count `../`.
- **Land as one commit when neither half is green alone.** That is a property of
  the work, not a defect in it ([prospero.md](../../.anthill/dev/prospero.md) —
  the 1a/1c shape).

**Overall Strategy:** make the invisible failure classes visible first
(instruments), remove the coupling that the move would break (seam), move
(relocation), then prove the thing the gate cannot see (local-sim).

> ⚠ **How well-tested this order is, stated honestly.** Phase 0 and Phase 3 have
> been run on every port. **The full four-phase sequence has been exercised
> end-to-end on exactly one spell** — astrolabe was chosen _because_ it needed
> zero seam work, and the backend port took a different route. So Phase 1 is
> supported by one instance, not four. **Skip it only after counting the
> daemon's reaches into build-input source and finding zero** — that count is
> what Phase 1 exists to drive to its floor, and it is cheap to run.

## Steps / Phases

### Phase 0: Instruments, before the work that breaks them

**Goal:** every check that must observe the port exists and is green **at
HEAD**.

**Actions:**

1. Confirm the blind-set instrument counts **both** roots — the skills tree and
   `src/`. A prefix-scoped instrument reports relocation as _progress_; see
   [Contract 4's amendment](../../.anthill/dev/seams.md).
2. Confirm the import wards cover the artifact boundary, the shipped execution
   path, and cross-spell reaches
   ([`grimoire/import-boundary-wards.test.ts`](../../grimoire/import-boundary-wards.test.ts)).
3. **Have a non-author plant a violation in each cell and watch it go red.** An
   author's own demonstration samples the frame that authored the cell.
4. For any ward that is green because its subject does not exist yet, give it a
   **zero-guard that says so out loud on every run**. A vacuous pass now is a
   cell that gets trusted later.

**Validation:**

- [ ] Every new or changed cell has a mutation route a non-author ran.
- [ ] Any vacuous ward prints its own vacuity.
- [ ] Gate green at HEAD, unpiped, exit code read from a file — a piped `$?` is
      the pipe's, and this repo has burned actors on it.

### Phase 1: Cut the seam, before anything moves

**Goal:** the daemon stops reaching into build-input source, proven while the
tree is still shippable.

**Actions:**

1. Count the reaches first (`grep '\.\./surface/' <spell>/scripts/server.ts`)
   and write the target number down.
2. Move the two-sided contract into the spell's own `shared/` — two-sided within
   **one** spell, never across spells.
3. Make the daemon's surface import **dev-only and dynamic**, so a release
   daemon never pulls the surface build graph into its load path (Contract 1).
4. Re-run the count. It should be exactly the entry import.

**Validation:**

- [ ] The reach count dropped to its target **before** anything relocates.
- [ ] Gate green. The tree is still shippable at this commit.

### Phase 2: Relocate

**Goal:** build input lives at `src/<spell>/`; the skill folder carries backend
source plus a committed `dist/` and no build-input source.

**Actions:**

1. `git mv` the build input to `src/<spell>/`.
2. **Rewrite every importer by computing `relpath(target, dirname(file))`** — a
   short script whose _output_ is the depth-class table. Never a blanket `sed`.
3. **Resolve-sweep every specifier in the tree** afterwards; do not trust the
   rewrite's own list.
4. Pin the daemon's spawned cwd to `src/<spell>/`, or the Tailwind plugin is
   silently skipped (Contract 5).
5. Build, and **un-ignore and commit `dist/`** — a bare `dist` ignore rule with
   a hand-kept un-ignore list will otherwise skip a newly relocated spell's
   `dist/` at exit 0, and the spell ships with no surface (Contract 18).

**Validation:**

- [ ] `tsc` TS2307 count returns to the **measured** pre-move baseline.
- [ ] The blind set's declaration re-declared by hand, not regenerated.
- [ ] Gate green — as **one commit** if neither half is green alone.

### Phase 3: Prove what the gate cannot see

**Goal:** the installed artifact runs where nothing is installed.

**Actions:**

1. Copy `SKILL.md` + `scripts/` + `dist/` — **and nothing else** — to a path
   with **no up-tree `node_modules`**.
2. Start the daemon there. Drive the board in a browser.
3. Exercise the CLI's contract surface: `--version`, `--help`, and a bogus verb
   returning the error envelope at exit 2.
4. Assert the daemon **emits** `mode === "release"`; a dev-mode daemon with root
   deps present renders an identical-looking board.

**Validation:**

- [ ] The board renders and the daemon serves from `dist/`.
- [ ] ⚠ **This is manual and nothing automates it.** Write the result down in
      the commit message, or it will not be run twice.

## Risks & Gotchas

### Gotcha 1: The gate is blind to the port's own failure classes (4 instances)

- **Symptom:** green suite, broken artifact.
- **Root cause:** four distinct blind spots, each needing a different
  instrument: a value import **nothing loads** (only `Bun.build` on the surface
  entry sees it); a **type-only** import (`tsc --noEmit | grep -c TS2307` only);
  an import that **only resolves in-repo** (only the local-sim); and relocated
  **non-`.ts`** files that `bun run check` cannot read at all (only the
  blind-set's second root).
- **Mitigation:** run all four. See [Contract 16](../../.anthill/dev/seams.md)
  for the class table — it is the authority, and this list is a pointer to it,
  not a copy.

### Gotcha 2: Counting `../` by hand (3 instances)

- **Symptom:** a specifier that is wrong for some importers, or for all of them.
- **Root cause:** depth was treated as _input_ — read off the tree, or inherited
  from a brief — instead of computed.
- **Mitigation:** compute `relpath(target, dirname(file))` and print the class
  table as **output**. It cannot make the error, it is re-runnable as the check,
  and it **contradicts a wrong brief out loud** rather than accommodating it
  ([circe.md](../../.anthill/dev/circe.md)).

### Gotcha 3: A ward's population stops following its subject (3 instances)

- **Symptom:** a ward goes green while its title still claims to govern the
  thing it stopped scanning. **A shrunk population is not a red cell.**
- **Root cause:** the population was defined by a path or extension that the
  port then changed.
- **Mitigation:** ask of every check — _is the thing I am checking still in the
  set this examines, and will it be after the move?_ Prefer **membership over a
  structurally-invariant subset** to any magnitude, since a floor over a
  population the roadmap shrinks is a countdown, not a guard.

### Gotcha 4: `git ls-files` reports the INDEX, not the disk (2 instances)

- **Symptom:** a ward dies with `ENOENT` inside cells unrelated to your change,
  or a zero-guard reports 0 files under a directory that visibly holds them.
- **Root cause:** `ls-files`-driven enumerators read the index. A deletion that
  is not staged, or a new artifact that is not added, is invisible or stale.
- **Mitigation:** **stage the artifact before running the gate.** "Delete a
  file" and "add a build output" are not working-tree-local acts here
  ([daedalus.md](../../.anthill/dev/daedalus.md)).

### Gotcha 5: A returning error count is not proof of neutrality

- **Symptom:** the typecheck total comes back to its old number and everything
  looks fine.
- **Root cause:** an unresolved module degrades to `any`, which **suppresses**
  diagnostics beneath it — so errors leaving and arriving can cancel. One tree
  went 452 → 512 → 452, which was 78 leaving and 18 arriving.
- **Mitigation:** diff by error **lines** against a detached worktree at the
  pre-move commit with `node_modules` symlinked
  (`git worktree add --detach <path> <sha>`).

### Gotcha 6: The small fix can be the illegal one

- **Symptom:** a test breaks after the move; re-pointing its import in place is
  one line and obviously right.
- **Root cause:** that one line can be a **relative escape out of the artifact
  boundary** — precisely what the artifact ward forbids. The minimal edit and
  the legal edit are different edits.
- **Mitigation:** before taking the small fix, resolve the new specifier and ask
  which side of the boundary it lands on. Move the test instead.

### Gotcha 7: A file's comments are part of a text-scanning predicate's input

- **Symptom:** an instrument's population changes with **zero code change** —
  one case went 18 → 16 entry points on wording alone.
- **Root cause:** behavioural enumerators scan source text, and prose that names
  the token they match is indistinguishable from code that uses it.
- **Mitigation:** where a file's classification depends on a text scan, name the
  token only where the scan does not look, or describe it without spelling it.

### Gotcha 8: Routing the commit as `chore(`

- **Symptom:** a surface edit lands as `chore(`, no version bump, and never
  reaches a consumer.
- **Root cause:** the "nothing ships" discriminator is _did anything under
  `plugins/spellbook/` change_ — and for an **un-rebuilt** port that is
  literally true, because the source now lives outside it. Staleness makes the
  wrong answer correct.
- **Mitigation:** build and stage `dist/` **with** the source edit in one
  commit, then route. This is a
  [known defect in the `ward` skill](../backlog/2026-08-31-ward-routes-an-unbuilt-surface-edit-to-chore.md)
  — check it is fixed before trusting the checklist.

## Validation & Acceptance

**Acceptance Criteria:**

- [ ] Build input at `src/<spell>/`; skill folder has **no** build-input source.
- [ ] `dist/` committed, and reproducible — a rebuild is a
      `git status     --porcelain` no-op (Contract 18; the comparison is
      **never** `git diff`, because a content change renames a hashed chunk).
- [ ] Daemon emits `mode === "release"`.
- [ ] TS2307 back to the **measured** baseline, diffed by lines.
- [ ] Blind-set declaration re-declared by hand.
- [ ] All import wards green, each with a non-author mutation route on any cell
      that changed.
- [ ] **Local-sim passes**, by hand, recorded.
- [ ] Gate green, unpiped.

**Testing:** the suite proves none of the port's characteristic failures on its
own. Treat `bun test` as a regression check on everything _else_ you touched,
and the local-sim as the check on the port.

## Examples

### Example 1: astrolabe — the mechanical surface port

**Context:** the reference port, chosen because it needed **zero** seam work.
**Outcome:** ships a prebuilt surface and boots where nothing is installed.
**Lessons:** proved the pipeline generalises, so that when a harder seam was cut
it was proven alone. **Reference:** `d181c88`.

### Example 2: imago — the seam, cut before the move

**Context:** the daemon reached into `../surface/` five times, three at runtime.
**Outcome:** the seam was cut first (`3e00e73`), then the relocation
(`5d918e2`). **Lessons:** the phase that creates edges sets the next phase's
blast radius — one spell had 4 cross-tree edges, the other 33, and a card
written before those edges existed enumerated 5. **Reference:** Contract 16.

### Example 3: magpie — a backend, and the shared module

**Context:** first backend to ship built, alongside astrolabe. **Outcome:** two
spells' shipped CLIs resolve **one** `printJson`; the installed artifact still
runs with nothing installed. **Lessons:** the launcher pattern — a real `.ts` at
`scripts/cli.ts` importing the bundle — is what keeps the behavioural wards
seeing the CLI at all. **Reference:** `7bb0f4a`.

### Example 4: `cn()` — sharing on the surface side

**Context:** 10 lines, dependency-free, the most boring module available.
**Outcome:** one module in `src/kit/`, two surfaces consuming it, neither
artifact gaining a source file. **Lessons:** _prefer the most boring shared
module, never the most valuable one_ — the valuable extraction's copies are
usually different architectures. **Reference:** `475cb6a`.

## Related Patterns

- [`seams.md`](../../.anthill/dev/seams.md) — Contracts 1–5 (serve, `dist/`
  layout, backend-as-source, the `src/` split, cwd pinning), 16 (relocation
  fallout), 17 (the `src/<spell>/` ward gap), 18 (reproduction).
- [spell-kit project ledger](../projects/spell-kit/README.md) — vocabulary; note
  that `shared/`, `ward`, `pinned` and _the gate_ each mean something narrower
  there, and several numbering schemes reuse the same digits.
- [`grimoire/house-style.md`](../../grimoire/house-style.md) — the
  `self-contained-no-build` rule the port re-scopes.
- [the `ward` skill](../../.claude/skills/ward/SKILL.md) — commit-type routing.

---

## Version History

- **2026-08-31** — Initial version. Extracted from four ports (astrolabe
  surface, imago seam, imago surface, magpie backend) and two sharing operations
  (`printJson`, `cn()`) across spell-kit sprints 01–02.
