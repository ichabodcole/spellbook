# Porting a Spell to the Built / Shared Layout — Playbook

**Created:** 2026-08-31 **Last Updated:** 2026-09-03 **Status:** Active — second
real run (glamour); **next real run after bounty or grapevine is rewritten**
(nothing else in the roster is a subject; see Applicability)

---

## Context

A spell starts life self-contained: hand-authored source under
`plugins/spellbook/skills/<spell>/`, run directly by Bun, shipped by copying the
subtree. **Porting** moves its buildable source out to `src/<spell>/`, commits a
built artifact back into the skill folder, and — once ported — lets it share
code with other spells.

The port is not one edit. It is a **sequence with a required order**, and the
repo's own gate (`bun run check && bun test`) is **structurally blind to the two
failure classes the port actually produces**. Every ported spell went through it
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
  nothing to relocate. **A spell with no `surface/` is not yet a subject — the
  rewrite comes first**; house-style's queue table says which spells that is.
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
- **A measured pre-move baseline**, captured as _error lines_, not counts, and
  **name the tsconfig** — the root `-p .` and a spell's own (only some spells
  carry one; glamour's is `plugins/spellbook/skills/glamour/tsconfig.json`) are
  different instruments (33 vs 7 lines under glamour, same tree) and the
  after-diff must use the same one. See Gotcha 5.
- **A resolve-sweep floor.** There is no shared sweep tool; write yours over
  [`grimoire/lib/import-graph.ts`](../../grimoire/lib/import-graph.ts)'s
  `scanSpecifiers(sourceText)` — it takes the file's **text**, not its path, and
  returns one ref per import with its specifier and line — calibrate it red on
  one planted break, then record its floor. See Gotcha 7.
- **acc conformance** if the backend will ship built — a spell goes conformant
  before its backend goes opaque.
- ⛔ **Answer this before anything else: does this spell ALREADY have a built
  backend?** `ls src/<spell>/backend/`. If it exists, the spell's backend lives
  in **two roots**, and every census, sweep and done-when below must run over
  both. A previously-ported spell is not a simpler starting point — it is a
  spell whose seam is already half somewhere else.

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

> **How well-tested this order is.** Phase 0 and Phase 3 have run on every port;
> Phase 1 has run on two (magpie, glamour), and glamour ran the whole sequence
> on the playbook alone. **Skip Phase 1 only after counting the daemon's reaches
> into build-input source and finding zero.**

## Steps / Phases

### Phase 0: Instruments, before the work that breaks them

**Goal:** every check that must observe the port exists and is green **at
HEAD**.

**Actions:**

1. Confirm the blind-set instrument
   ([`scripts/instruments/gate-blind-set.ts`](../../scripts/instruments/gate-blind-set.ts),
   run as `bun scripts/instruments/gate-blind-set.ts` from the repo root) counts
   **both** roots — the skills tree and `src/`. A prefix-scoped instrument
   reports relocation as _progress_; see
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

**Goal:** the backend stops reaching into build-input source, proven while the
tree is still shippable.

> ⛔ **THE SEAM HAS TWO ROOTS ONCE THE BACKEND SHIPS BUILT.** If
> `src/<spell>/backend/` exists, a census scoped to `<spell>/scripts/` is
> **structurally blind to the half that ships built** — and it goes green while
> the seam is open. Measured on magpie: **12 sites visible to the scoped grep,
> 15 actually present**, the missing three in `src/magpie/backend/cli.ts`,
> because an earlier sprint relocated that file and took a third of the seam
> with it. This is [Contract 19](../../.anthill/dev/seams.md) — a population
> that stopped following its subject — landing on a brief's own command, one
> sprint after the contract was written from three instances of it.

**Actions:**

1. **Census BOTH roots, and every backend file — not just `server.ts`.** The
   single-file form generalised from a spell where `server.ts` happened to hold
   every site; the next spell's seam spanned three files.

   ```sh
   grep -rn '\.\./surface/' \
     plugins/spellbook/skills/<spell>/scripts/ \
     src/<spell>/backend/ 2>/dev/null
   ```

   Write the total down, **split value vs type-only** — the two fail differently
   (Gotcha 1), and the split is what tells you which sites the gate will catch
   at all. **Take the split from `scanSpecifiers(sourceText)` in
   `grimoire/lib/import-graph.ts` (it keeps `import type`), not by eye:**
   magpie's was 8 value / 4 type-only, not the 9/3 its own brief asserted.

2. **Sort every module by its CONSUMER SET, never by its filename.** The
   three-way sort (spell-kit's "R1"): **two-sided** →
   `plugins/spellbook/skills/<spell>/shared/` (inside the tracked subtree, so a
   source-shipped daemon can reach `../shared/x`); **daemon-only** → `scripts/`
   or `src/<spell>/backend/`; **surface-only** → stays. There is rarely exactly
   one contract — magpie and glamour each had **three** two-sided modules and
   **three** daemon-only files moving the other way.

   **A file named `.server` under `surface/` is the daemon's** — its consumer
   set will say so. Three ports in a row (imago, magpie, glamour) found this
   shape; treat it as the expected first finding, not a surprise.

   **A module can be two-sided by FILE and disjoint by SYMBOL.** glamour's
   `reduce.ts` had 25 exports: 21 backend, 4 surface, intersection zero. Split
   it — one half per side — rather than ship 21 mutators to a surface that must
   call none; `git mv` the larger half so `git -M` keeps history on it, and
   derive the counts **by command**, not by reading the server's import list
   (that list was 15 of the 21; the other 6 were test-only and still backend).

   ⚠ **Names and headers lie in both directions.** `reduce.ts` reads as surface
   state and is daemon-only; `alpha.ts` reads as backend policy and is
   two-sided; a module can be two-sided **through the built CLI with zero
   `server.ts` imports**. **Resolve the consumers; never infer them from a name
   or a header.**

3. **Resolve-sweep now — the sweep belongs to whatever phase moved specifiers**,
   and this one does. Measure your noise floor first; see Gotcha 7.

4. **If the backend ships built, rebuild and stage `dist/` IN THIS COMMIT.** The
   seam edits `src/<spell>/backend/cli.ts`, so the committed bundle stops
   reproducing the instant you touch it. Contract 18 does not permit a commit
   that hands over an artifact disagreeing with its source, and "the relocation
   phase owns `dist/`" is not a licence to leave it stale for a commit.

5. Re-run the census over both roots.

**Validation:**

- [ ] Census re-run **over both roots**; the count dropped to its target.
- [ ] `dist/` rebuilt and staged, if the backend ships built.
- [ ] Gate green. The tree is still shippable at this commit.

> ⚠ **What Phase 1 deliberately does NOT do — and an earlier draft of this
> playbook got this wrong.** It does **not** make the surface import dev-only
> and dynamic. `resolveMode()` needs the `dist/` that Phase 2 produces, so every
> spell that has done this **deferred it**. The surviving entry import is the
> _expected end state_ of Phase 1, not a leftover — which is what the validation
> step above has always said, while the action list contradicted it.

### Phase 2: Relocate

**Goal:** build input lives at `src/<spell>/`; the skill folder carries backend
source plus a committed `dist/` and no build-input source.

**Actions:**

1. `git mv` the build input to `src/<spell>/`.
2. **Rewrite every importer by computing `relpath(target, dirname(file))`** — a
   short script whose _output_ is the depth-class table. Never a blanket `sed`.
3. **Resolve-sweep every specifier in the tree** afterwards; do not trust the
   rewrite's own list. Compare against the floor you measured in Phase 1 (Gotcha
   7).
4. **Run the formatter BEFORE you re-pin and BEFORE you diff `tsc` by lines.**
   It is the one step that rewrites files _after_ your computed rewrite —
   including import order, and including splitting an import the move made too
   long — so anything you measure or re-declare ahead of it, you do twice. (Hit
   for real: a `tsc` run taken pre-format had to be re-run and re-diffed.)
5. Pin the daemon's spawned cwd to `src/<spell>/`, or the dev bundler cannot
   compile the stylesheet and **the whole page fails (500, no stylesheet link)**
   — measured on glamour; Contract 5 and four spells' comments said "silently
   skipped, unstyled board", and nobody had run it. Assert the invariant, not
   the status: _the utility never reaches the browser_ when the cwd is wrong,
   and does when it is pinned.
6. Build (`bun run build`, which is `src/build.ts`; never a bare `bun build` —
   it skips the Tailwind plugin, Contract 5), and **un-ignore and commit
   `dist/`** — a bare `dist` ignore rule with a hand-kept un-ignore list will
   otherwise skip a newly relocated spell's `dist/` at exit 0, and the spell
   ships with no surface (Contract 18).

**Validation:**

- [ ] **Run every population-derived ward against the arriving spell in a
      worktree BEFORE the relocation commit.** A ward whose population is `src/`
      gains the spell on arrival, and a defect it has been carrying reds on the
      wrong spell (glamour's leading-digit variant, `2xl:`, was written as a
      space-terminated CSS escape the css-scope ward misread as a phantom class
      — and the red named astrolabe). Fix the ward ahead of the port.
- [ ] `tsc` error **lines** diffed against the pre-move baseline, **same
      tsconfig** — TS2307 back to baseline is necessary, not sufficient.
- [ ] The blind set's declaration re-declared by hand, not regenerated.
- [ ] `dist/` built and staged **with** the source edit, then routed — an
      un-rebuilt port has nothing under `plugins/spellbook/` changed and the
      `ward` skill's discriminator correctly says "nothing ships".
- [ ] **The assembled file list matches every seat's disclosure list.** A patch
      cut from a worktree carries only tracked changes; the new test files a
      seat placed beside their subjects are not in it. glamour's assembly would
      have landed without its three calibrated cells and with a backlog doc
      still reading "not yet run" — two seats caught it independently, minutes
      before the commit. **And run the REPO's formatter (`bun run check`, the
      pinned biome) over the placed files before you stage them** — not
      `bunx biome` in a temp copy, which resolves its own biome and certifies a
      different tool; glamour's first assembly went red on exactly the three
      placed files, each green under the wrong biome.
- [ ] Gate green — as **one commit** if neither half is green alone. The
      dist-roster clause-1 cell makes this mechanical: a split relocation reds
      on its first commit.

### Phase 3: Prove what the gate cannot see

**Goal:** the installed artifact runs where nothing is installed.

**Actions:**

1. **Copy the spell's TRACKED SUBTREE** —
   `git ls-files plugins/spellbook/skills/<spell>` — to a path with **no up-tree
   `node_modules`**.

   ⛔ **Not a hand-written file list.** An earlier version of this step said
   `SKILL.md` + `scripts/` + `dist/` _"and nothing else"_, which **contradicted
   Phase 1 of this same document**: Phase 1 tells you to create `shared/`, and a
   daemon that imports `../shared/types` then cannot resolve it. Copy what the
   marketplace copies — the tracked subtree — and the list can never drift from
   the layout again.

2. Start the daemon there. Drive the board in a browser.
3. Exercise the CLI's contract surface: `--version`, `--help`, and a bogus verb
   returning the error envelope at exit 2.
4. Assert the daemon **emits** `mode === "release"` on **every** transport it
   has — ready event, discovery JSON, stdout handshake if it prints one — a cell
   that reads one certifies a third of the contract. A dev-mode daemon with root
   deps present renders an identical-looking board.
5. Force dev mode at the surface-free destination and assert it **dies cleanly
   and names the right thing**: no discovery file, **no session directory left
   behind** (glamour's mode check first sat after its first filesystem write and
   every failed boot leaked a `-files/` dir), and an error that names the
   **missing surface**, not the binary — a spawn with a missing cwd reports
   `ENOENT` on the executable, so a dev-cwd that does not exist at the
   destination reads as "bun is missing".

   ⚠ **The discriminator is `dist/index.html`, never the presence of `dist/`.**
   A backend that ships built puts `cli.js` in `dist/` — so a spell can have a
   `dist/` and still correctly resolve to **dev** mode because its surface has
   not been ported. Contract 2's amendment already keys on the **unhashed**
   `index.html` for exactly this reason; "the artifact always has a `dist/`" is
   a claim that stopped being true the moment backends started shipping built.

**Validation:**

- [ ] The board renders and the daemon serves from `dist/`.
- [ ] ⚠ **The browser drive is manual unless you automate it, and the
      automatable form is a remove-it-and-diff:** headless Chromium loads the
      board, samples computed properties, removes the shipped stylesheet's
      `<link>`, samples again; a sheet that does real work changes a measurable
      share (glamour: 126 of 320) and a page with no inline `<style>` floors
      at 0. The script is cassandra's (seat doc, 1c), not yet a shared tool.
      Write the result down in the commit message either way. The serve/mode
      half is not manual: astrolabe, imago and glamour each carry a
      `release-serve.test.ts` whose forced-dev cell convicts a daemon that boots
      without its surface — copy that cell, and have a non-author calibrate it.

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

### Gotcha 2: Counting `../` by hand (4 instances)

- **Symptom:** a specifier that is wrong for some importers, or for all of them.
- **Root cause:** depth was treated as _input_ — read off the tree, or inherited
  from a brief — instead of computed.
- **Mitigation:** compute `relpath(target, dirname(file))` and print the class
  table as **output**. It cannot make the error, it is re-runnable as the check,
  and it **contradicts a wrong brief out loud** rather than accommodating it
  ([circe.md](../../.anthill/dev/circe.md)).
- ⛔ **The string trap has TWO forms.** One string meaning two modules (Contract
  16), and one string with **several** correct rewrites — glamour's `./types`
  needed three, by directory. A `sed` is wrong for one of them whichever way you
  run it; the computed rewrite never sees the collision.

### Gotcha 3: A ward's population or its pinned values stop following the subject (4 instances)

One family, two faces. **Quiet:** a ward goes green while its title still claims
to govern the thing it stopped scanning — the population was defined by a path
or extension the port changed. **Loud:** a ward you never opened goes red in
cells about import specifiers, because a pinned inventory records specifier
**values** and the move changed them.

- **Mitigation, quiet face:** ask of every check — _is the thing I am checking
  still in the set this examines, and will it be after the move?_ Prefer
  **membership over a structurally-invariant subset** to any magnitude; a floor
  over a population the roadmap shrinks is a countdown, not a guard.
- **Mitigation, loud face:** expect it, read the diff, and **re-declare by hand
  — never regenerate.** A regenerated pin agrees with the tree by construction
  and discards the human reading it exists to preserve. **A red pin after a move
  is the pin doing its job.** And a line-number pin is a coincidence guard in
  both directions — glamour's `server.ts` import block shrank and a formatter
  re-sorted it onto the same line, so the pin stayed green through a real
  change.

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
- **Mitigation:** capture the baseline **as error lines** before you move
  anything, with the tsconfig named, and diff against the file afterwards. (No
  baseline? A detached worktree at the pre-move commit with `node_modules`
  symlinked buys it back, expensively.)

### Gotcha 6: The small fix can be the illegal one (2 instances, 2 sprints)

- **Symptom:** a test breaks after the move; re-pointing its import in place is
  one line and obviously right.
- **Root cause:** that one line is a **relative escape out of the artifact
  boundary** — what the artifact ward forbids. The minimal edit and the legal
  edit are different edits.
- **Mitigation:** before taking the small fix, resolve the new specifier and ask
  which side of the boundary it lands on. **Move the test instead** — a test
  whose subject relocated relocates with it. Better: **place a new test beside
  its subject from the start** (glamour's `derive.test.ts` sat in
  `surface/state/` from Phase 1, so no `plugins/ → src/` edge ever existed).

### Gotcha 7: The resolve-sweep has a noise floor, and it is a property of YOUR instrument (5 instances)

- **Symptom:** the sweep reports N unresolved specifiers and you cannot tell
  which are yours. A first-timer sees the total and reads all of it as damage.
- **Root cause:** synthetic fixture strings inside ward files, already-relocated
  paths, and anything your resolver's extension list does not cover read as
  unresolved on a clean tree — **and so does prose**: if a ported `server.ts`
  keeps a comment quoting its removed static import, a text-scanning sweep reads
  it, and the floor rises by one on a paragraph you just wrote (three ports did
  this; glamour deleted the import instead and its floor stayed 0).
- **Mitigation:** there is no shared sweep
  ([filed](../backlog/2026-09-03-five-seats-each-wrote-their-own-resolve-sweep.md));
  **write yours, calibrate it red on one planted break, measure its floor before
  you move anything, and re-measure after each phase.** Never inherit a floor
  from a document or a peer — five seats measured five floors on one tree, and
  every difference was the instrument.

## Validation & Acceptance

**Acceptance Criteria:**

- [ ] Seam census re-run **over both roots** (`scripts/` AND
      `src/<spell>/backend/`) — not the scoped form.
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
- [ ] If the spell is acc-conformant, `acc check` still passes **and the port
      names what it changed** — an empty rule-by-rule diff means the _rules_ saw
      no change; an additive field (glamour's `mode` on `open`/`info`) is
      invisible to them, so name it yourself.
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
- [spell-kit project ledger](../projects/_archive/spell-kit/README.md) —
  vocabulary; note that `shared/`, `ward`, `pinned` and _the gate_ each mean
  something narrower there, and several numbering schemes reuse the same digits.
- [`grimoire/house-style.md`](../../grimoire/house-style.md) — the
  `self-contained-no-build` rule the port re-scopes.
- [the `ward` skill](../../.claude/skills/ward/SKILL.md) — commit-type routing.

---

## Version History

Git holds the detail (`git log --follow` this file); each entry names what a
port **taught**, not what it confirmed.

- **2026-08-31** — Initial, from four ports and two sharing operations
  (spell-kit sprints 01–02).
- **2026-08-31** — Repaired after first non-author use (magpie's seam): the
  second root, the consumer-set sort, the noise floor.
- **2026-08-31** — Round 2 (magpie's surface): the tracked-subtree copy, the
  `dist/index.html` discriminator, the mirror string trap.
- **2026-09-03** — **glamour, the second real run, and the first on the playbook
  alone.** Taught: a module can be two-sided by file and disjoint by symbol
  (split it); a `.server` file under `surface/` is the expected first finding,
  not a surprise; run the population-derived wards against the arriving spell
  before the relocation commit; name the tsconfig; there is no shared
  resolve-sweep and there never was. Confirmed, and therefore shorter: the
  honesty box, Gotchas 2, 5, 6, 9. Gotchas 3+10 and 7+9 merged (old numbering);
  Gotcha 8 dissolved into Phase 2's checklist because its defect is fixed. **The
  population is closed** — every remaining spell is outside Applicability until
  a rewrite gives it a `surface/`. **Net: 75 words longer** — every confirmed
  section shrank and Phases 2–3 grew by more than that, because this port taught
  more than it confirmed. Scored by a cold read before and after
  (`docs/projects/glamour-conversion/plan/thoth.md`, B1/B4).
