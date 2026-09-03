# thoth's lane — canon, and the playbook as synthesis

**Authored 2026-09-03, as of comms #1131, tree at `95dc287` clean.** Builds
against `plan.md`'s **S6 CORRECTION** (acc discharged; Phase 3 is a canon act
that is not happening this port) and **S7** (ratified at a per-section delta +
cold-read test, comms `#1119`, rulings `#1124`, `#1130`). Nothing here consumes
S1–S5 at a finer grain than the plan records; where a task waits on another
seat's ruling it says so and names the seat.

Two halves, deliberately unequal in timing:

- **Half A — canon.** _Does this port move a contract?_ Mostly **yes, in
  prose**: the port makes three canon sentences false, and one of them is a rule
  heading. These tasks run **before and alongside** the build; the ones that
  need a landed Phase 2 say so.
- **Half B — S7, the playbook.** Runs **after Phases 1–2 land**, because a
  synthesis written before the artifacts exist is the memory-sourced document
  the playbook's own Version History warns about. One S7 task (the cold-read
  **baseline**) does not depend on the port and runs now.

Seat doc: [`.anthill/dev/thoth.md`](../../../../.anthill/dev/thoth.md) — the
reflexes this lane applies (measure before agreeing; cite the SHA; say what was
not checked). Contracts: [`seams.md`](../../../../.anthill/dev/seams.md). Not
restated here.

---

## Half A — canon

### A1 · `proposal.md` — the imago claim is false, and it is the record a future port reads

**Now. No dependency.**

`proposal.md:87` says glamour _"is the only relocated-or-relocating spell
without one [acc.config.json]"_. imago is relocated, ships `dist/`, and has no
`acc.config.json` (`ls plugins/spellbook/skills/imago/acc.config.json` →
`No such file`). `seams.md` Contract 3's amendment names that absence in terms.
Also: glamour **now has** `acc.config.json` (the acc L0 pass, `389d088`), so the
sentence is false twice.

- Rewrite the Phase 4 paragraph (`proposal.md:85-89`) to the measured state:
  glamour is conformant at kit 0.1.11 **ahead** of the port; imago is the
  relocated spell without acc; the axis is independent of the port (thoth
  `#1119` cross-tab). Keep the struck original per the seat rule — a wrong
  version kept and struck beats a wrong version deleted.
- Do **not** touch Phase 3's paragraph (`proposal.md:81-84`) beyond a one-line
  pointer to the RULINGS block in `plan.md`. The plan is the ruling's home.
- **Done-when:** `grep -n 'only relocated' proposal.md` → exactly one hit, and
  it is inside the struck blockquote (the line begins with `> `); the live
  paragraph cites `389d088`. _(First draft said "no hits", which would have
  failed on the struck copy the same task requires — a done-when that
  contradicts its own task.)_

_Checked and NOT a task: the proposal's two relative links (`:137`, `:140`) both
resolve at `95dc287`. My `#1119` said the `_archive/spell-kit` link was broken;
it is not today. The same for the archive's three inbound links to the playbook
— all resolve. Those claims are dated and are not carried._

### A2 · `house-style.md` — the rule this port falsifies, by heading

**After Phase 2 lands** (needs `dist/index.html` for glamour to exist, or the
edit describes a tree that is not there yet — the exact defect the seams file
recorded for its own pending marker).

`grimoire/house-style.md:363-380`, rule-id `spells-are-porting-to-the-build`:

- heading **"Four spells build. The rest are queued, at three different
  distances."** — becomes false;
- body: _"Today **astrolabe, imago, magpie, mind-mapper** build"_ — a roster
  enumeration by name, in the file whose sibling rule
  (`enumerate-roster-behaviour-never`, `:436`) forbids exactly that;
- the table row `| **glamour** | 15 .tsx + its own CSS | a relocation … |` —
  glamour leaves the queue.

**The edit, and it compresses rather than re-counts:**

1. Heading loses its number: **"Spells port to the build. The rest are queued,
   at two different distances."** (bounty and grapevine are the rewrites;
   digestify has its own trigger — the three remaining rows are two distances,
   not three, once glamour's row goes).
2. Body points at the enumerator instead of naming the set: _"the spells that
   build are the ones `bun scripts/dist-check.ts` counts (`buildableSpells()` in
   `src/build.ts`) — ask it, do not copy its answer here."_ Keep the
   built-backend clause (astrolabe, magpie) because that **is** a narrow
   enumeration by contract (Contract 3's permission), not a roster.
3. Delete glamour's table row. Add nothing in its place.
4. Rule-id stays. The decay-ledger row (`grimoire/decay-ledger.md:80`) is keyed
   on the id, and its title cell is a paraphrase — update the paraphrase and
   append a reinforcement:
   `2026-09-03 (<sha>): glamour ported; enumeration replaced by a pointer at dist-check`.

- **Done-when:** `bun test grimoire/rule-id.test.ts` green (heading still
  carries its id; ids unique) and `bun scripts/instruments/canon-ledger-ward.ts`
  exit 0 — run **by hand**, it runs under nothing
  (`docs/backlog/2026-09-02-canon-ledger-ward-runs-under-nothing.md`).
  `bun scripts/dist-check.ts` prints `buildable spells 5`, which is the number
  the prose no longer states.
- **What this does NOT check:** whether the two-distances claim is right for
  digestify. Its trigger is stated in the same rule; read it before editing the
  heading, and if it is a third distance the heading says three and the row
  stays.

### A3 · Contract 13's authorship note names a file the split moves

**After circe rules the surface half's filename** (`#1130`: unruled, hers to
propose, prospero ratifies). **Owner of the contract is daedalus** — I draft, he
lands or ratifies; I do not edit his contract unasked.

`seams.md:940`: _"This contract's surface half lives in
`glamour/surface/state/reduce.ts`"_. After S1's split the surface half is at
`src/glamour/surface/state/<circe's name>` and the daemon half at
`plugins/spellbook/skills/glamour/scripts/<daedalus's name>`; the reducer that
returns the verdict (`applyAgentMsg`) goes to the **daemon** side, so the
sentence's subject moves, not just its path.

- Draft a dated amendment (four lines) stating: verdict-returning reducer's new
  path; surface-half's new path; the invariant unchanged. Post to daedalus on
  comms with `--stdin`; he lands it with his Phase 1 commit or tells me to.
- **Done-when:**
  `grep -n 'glamour/surface/state/reduce.ts' .anthill/dev/seams.md` finds only
  the struck original inside the amendment.

### A4 · Contract 3 is NOT moved — assert it, do not assume it

**After Phase 2 lands. This is the canon half of S6's correction turned into a
check.** Phase 3 was dropped; the way it comes back is quietly, as a build
someone finds convenient.

```sh
ls plugins/spellbook/skills/glamour/dist/
# expected: index.html + hashed chunks. NO cli.js.
grep -n 'dist/cli' plugins/spellbook/skills/glamour/scripts/cli.ts
# expected: no hits — cli.ts stays authored .ts, not a launcher.
ls src/glamour/
# expected: surface/ only. NO backend/.
```

- **Done-when:** all three as expected, quoted in my land message with the SHA.
  If any differs, that is a finding for prospero, not a fix for me — the plan
  says _"if you find yourself needing it, that is a finding."_
- Also re-read Contract 4's amendment table (`seams.md:372-392`) for a glamour
  row; if one exists and now describes the past, append one dated line. Not
  pre-written because I have not measured whether there is one.

### A5 · The four `(seed)` ledger rows — NOT this port

Carried obligation, seat doc. This port walks none of the four (`Surface-fit`,
`Keep the client thin`, `Carry the Bun gotchas forward`, `Mature principle`).
Stated so nobody reads silence as a walk.

---

## Half B — S7, the playbook as synthesis

**Subject:** `docs/playbooks/porting-a-spell-playbook.md`, unchanged since
`3fc6d62`. **Baseline at `95dc287`, measured today, and it reproduces `#1119`'s
figures exactly:**

```
TOTAL 513 lines / 4270 words
  4 phases        163 lines / 1281 words   30.0%
 10 gotchas       142 lines / 1372 words   32.1%
  4 examples       31 lines /  237 words    5.6%
 Version History   43 lines /  448 words   10.5%
  Phase 1          71 / 589   (largest phase)
  Gotcha 9         26 / 298   (largest gotcha)
```

The measuring script is a throwaway in `.anthill/scratch/thoth/` and its output
leaves my terminal, so it is an instrument: **calibrated** by reproducing the
ratify-time numbers on the unchanged file (all four section groups match to the
word). It re-runs on the edited file for Gate 1.

### The four gates, restated as the acceptance test (from `#1119`, ratified)

1. **Per-section delta.** Every section glamour merely **confirmed** is net ≤ 0
   words. Only a section glamour **taught** may grow. A diff with no
   net-negative section anywhere has appended, not synthesised.
2. **Instance-count ratchet.** A gotcha whose count goes **up** gets **shorter**
   — increment the count, delete the case detail. The third instance licenses
   dropping the first two case studies.
3. **Actionability.** If a gotcha's mitigation can be a checklist line in a
   Phase's Validation block naming an act and a moment, it moves there and the
   gotcha shrinks to a pointer. If it only says "this was surprising", it is a
   story and goes to the sprint outcome.
4. **Cold read, scored.** A blank-context agent, the playbook **alone**, a
   **different** spell, asked for **output** (Phase 0 instrument list, Phase 1
   census commands with real paths, the consumer-set sort). Two numbers:
   questions asked that the playbook could have answered; commands that were
   wrong. Comparable across ports. Word count is not.

### B1 · Cold-read BASELINE — now, before the playbook changes

**Now. Independent of the port.** Without a before-number Gate 4 is one reading,
not a comparison.

- Build the surface, do not enumerate exclusions: copy **only**
  `docs/playbooks/porting-a-spell-playbook.md` to a directory outside the repo
  (`/private/tmp/…/scratchpad/coldread-before/playbook.md`). No seams, no sprint
  docs, no comms, no repo. The reader gets the file and the spell name.
- Spell: **digestify** (its entry point is `review.ts`, not `cli.ts` — a real
  trap the playbook should let a reader find on their own; it never mentions
  digestify, so no pattern-matching off the port in the tree). Not glamour.
- Prompt shape: _"You are porting the spell `digestify` using this playbook and
  nothing else. Produce: (1) the Phase 0 instrument list you would confirm, (2)
  the Phase 1 census command with real paths filled in, (3) the consumer-set
  sort for its modules. Where the playbook does not tell you something you need,
  write QUESTION: … and continue with your best guess."_
- Score by hand: count `QUESTION:` lines → **Q**; count commands that would not
  run or run over the wrong population → **W**. Record `Q_before`, `W_before` in
  this file with the reader's raw output filed in scratch.
- **Done-when:** two numbers here, dated, with the dispatch prompt quoted so the
  after-read is the same experiment.

**✅ MEASURED 2026-09-03 at `95dc287`, playbook unchanged since `3fc6d62`.**

| subject           | Q   | W   | verdict                                                                                                  |
| ----------------- | --- | --- | -------------------------------------------------------------------------------------------------------- |
| digestify (run 1) | 8   | 5   | **DESIGN ERROR, kept as record.** digestify has no `surface/`; the playbook's Applicability excludes it. |
| **imago (run 2)** | 10  | 1   | **BASELINE OF RECORD.** `Q_before = 10`, `W_before = 1`.                                                 |

Raw outputs: `.anthill/scratch/thoth/coldread-before-raw.md` (digestify),
`.anthill/scratch/thoth/coldread-before-imago-raw.md` (imago). The after-read
uses **imago** and the identical prompt above.

- **The subject choice was itself the first finding.** Every unported spell —
  bounty, digestify, grapevine — is outside the playbook's Applicability (no
  `surface/` build input). **After glamour the roster has no valid cold-read
  subject**, so the "different spell" rule from `#1119` is replaced: the reader
  gets the file alone, exported outside the repo, so the spell name is only a
  string to it and a ported spell serves. Two of imago's ten questions are
  induced by that choice (Example 2 tells the reader imago is already ported);
  eight are playbook gaps and are spell-independent.
- **The measurement has a noise floor of its own — subject choice** (Q 8 vs 10,
  W 5 vs 1 across the two runs). Same shape as Gotcha 9. Hence one subject, one
  prompt, before and after.
- **Five real gaps the reader found, each verified against the tree, each a
  pointer-sized fix for B3:** (1) the **resolve-sweep** is named four times
  (`:168`, `:202`, `:364`, `:484`) and **exists as no tool** — each seat wrote
  its own, which is _why_ Gotcha 9 records three floors; (2) the blind-set
  instrument is `scripts/gate-blind-set.ts` and is never named; (3) the build is
  `bun run build` (`src/build.ts`) and is never named; (4) the `shared/` path is
  never stated — Phase 3's `../shared/types` is the only clue; (5) "R1" is
  spell-kit vocabulary with no expansion.
- `W_before = 1` is command 14: a bare `bun build` on the surface entry instead
  of `bun run build`, which skips the Tailwind plugin (Contract 5). Not a wrong
  population — a wrong instrument, and the playbook could have named the right
  one.

### B2 · The confirmation ledger — running, during the build

**During Phases 1–2, from the other seats' comms and land messages.** One
scratch table, one row per gotcha and per phase step: **CONFIRMED** (glamour hit
it → count +1, case detail out), **NEW** (glamour taught it → may grow, with the
reason), **SILENT** (glamour did not exercise it → untouched, said so).

Predictions to test, written before the build so they can be wrong:

| section                      | prediction                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approach honesty box         | shorter and more confident — glamour is the **second** real seam cut (`:85-91`)                                                                      |
| Gotcha 9                     | the 4/18/19 spread goes; rule stays; glamour raises the floor by one (comment quoting the removed import) — CONFIRMED, ~5 lines out                  |
| Gotcha 10                    | CONFIRMED by `import-boundary-wards.test.ts:1089` pinning `server.ts` line 77 (plan, reconciled block); merges with Gotcha 3 (one family, two faces) |
| Gotcha 7                     | merges into 9 (its only instance already lives there)                                                                                                |
| Gotcha 8                     | **stale** — its defect is fixed (`.claude/skills/ward/SKILL.md:163`, verified today); shrinks to one Phase 2 validation line, backlog pointer out    |
| Gotcha 2 `:283-289`          | philosophy paragraph out; changes no act                                                                                                             |
| Gotcha 5 `:322-327`          | recovery route → one clause                                                                                                                          |
| Version History              | cap at three entries **or** move to git — a fourth 20-line entry is the failure mode                                                                 |
| css-scope phantom class      | **NEW**, but as a Phase 2 validation line + pointer to the backlog file, not an eleventh gotcha: _"expect a css-scope red that names another spell"_ |
| Phase 1 "misfiled `.server`" | **third instance** → one general rule replaces the per-spell mentions (plan open Q2; if it still needs bespoke thought that is the finding)          |

- **Done-when:** every row has a verdict with the comms id or SHA it came from.
  A row with no evidence stays SILENT and the section stays untouched.

### B3 · The edit — after Phases 1–2 land

Edit **per section**, each with a one-line reason in the commit body keyed to
B2's row. Gates 1–3 applied while editing, not after.

- Phase 2 Validation gains the two lines B2 predicts (css-scope red; build and
  stage `dist/` with the source edit before routing).
- Gotcha count goes **down** (predicted 10 → 7: 3+10 merge, 7→9 merge, 8
  dissolves into Phase 2). If it does not go down, B2 says why per row.
- Version History: one new entry of **≤ 6 lines** naming what glamour taught and
  pointing at this lane for the rest — and the two 20-line entries above it
  collapse to one line each with their SHA. Git holds the detail
  (`git log --follow docs/playbooks/porting-a-spell-playbook.md`).
- `**Last Updated:**` in the header moves.
- **Gate 1, run:** the scratch script on the edited file; paste the per-section
  delta table into the commit body. **Every CONFIRMED row ≤ 0.** Expected total
  net negative; predicted **≈ −120 lines**, and that number is a prediction to
  be wrong about, not a target to hit.
- **Done-when:** Gate 1 table in the commit body; `bunx biome check --write` on
  nothing (it is `.md`; prettier may reflow — one sentence per line is not this
  file's convention, so **assert equality against the source copy after commit**
  rather than probing lines, per principles.md).

### B4 · Cold read AFTER — the acceptance test

**After B3, before the land.** Same prompt, same spell, same surface built fresh
from the **edited** file. Score `Q_after`, `W_after`.

- **Pass:** `Q_after ≤ Q_before` and `W_after ≤ W_before`. A rise in either is a
  finding about the edit, and the edit does not land until the row that caused
  it is understood — not until the number is beaten.
- Post both pairs on comms with the raw outputs' scratch paths. cassandra is the
  natural non-author for the cold read's design if she wants it; I will not
  score my own read as the only reader if she is available (H16's shape).
- **Done-when:** four numbers in this file, dated, and the verdict.

### B5 · Land

File-scoped, my seat, one commit for Half B
(`docs/playbooks/porting-a-spell-playbook.md` + this lane's B-section updates),
separate from Half A's commits (`proposal.md` alone for A1;
`grimoire/house-style.md` + `grimoire/decay-ledger.md` for A2). Never a bare
add. Message via `-F .anthill/scratch/thoth/commit-msg.txt`; the `ward` skill
routes each — Half A and B are `docs(` / `chore(`, nothing under
`plugins/spellbook/` moves in my commits, and if it does I have made a mistake.

---

## What this lane does NOT do — said so it is not read as omitted

- Build the link-resolution ward over `docs/` (named in `#1119` as cheap; lead's
  call, not scoped).
- Give the playbook's gotchas rule-ids or pair them to a ledger (a **new seam**,
  named at ratify, not granted).
- Rule the surface-half filename (circe's) or edit Contract 13 unasked
  (daedalus's).
- Verdict `s5-r` (ruling 2, `#1130`).
- Touch `dist/`, `src/`, or any spell file. If a canon edit needs a spell edit,
  that is a finding for the owning seat.

## Order

```
NOW        A1 (proposal fix)  ·  B1 (cold-read baseline)
DURING     B2 (confirmation ledger)  ·  A3 draft once circe names the file
AFTER P2   A2 (house-style + ledger)  ·  A4 (Contract 3 assertion)  ·  B3 → B4 → B5
```
