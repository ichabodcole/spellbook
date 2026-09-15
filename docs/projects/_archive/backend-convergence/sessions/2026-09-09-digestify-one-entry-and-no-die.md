# 2026-09-09 — digestify: one entry, no `die`, and a page nobody had submitted

**Agent:** Claude Opus 5, as the implementing agent · **Branch:**
`feat/digestify-backend-port` · **Mode:** brief-driven, single implementer;
orchestrator reviews, Cole finalizes.

**Phase 5 of the backend convergence.** digestify's whole backend — one entry,
`scripts/review.ts` (725 lines), plus its two test files — out of the deployed
skill folder, behind ONE launcher, with the kit modules that have a subject.

Three things make this port different, and each produced a finding. It is the
**first spell with one entry and no `cli.ts`**, so it is the first real consumer
of the Phase B rewrite that stopped keying its steps on the names `cli` and
`server` (D55). It is the **first SINGLE-SHOT spell** — one human, one review,
then exit — so half the wire kit has no subject in it at all, and "adopt the
kit" had to become a per-row ruling. And it is the spell with **no `die` and no
error class**, where a grep for the helper answers "nothing to change" about a
contract SKILL.md publishes in a table.

---

## What shipped, by sha

| chapter | sha        | what it is                                                                                                                                                                                                                              |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `110a3611` | **the relocation** — one entry and two test files into `src/digestify/backend/`, one launcher, one committed artifact. Three ward lists re-declared, two live prose references repaired. `import.meta.main` deleted for the arithmetic. |
| 2       | `67f74097` | **the adoption** — the four kit modules with a subject; the eight-site error contract converted; three exit codes moved; `/index.html` given a cell.                                                                                    |
| —       | (this)     | **the records** — D58–D60, `phase-5-journal.md`, this file, the caveats row, two register entries, and the Phase B amendment pass.                                                                                                      |

**No third chapter.** The MAYBE slot Phase B budgets for an instrument the port
itself breaks did not fire: all three instruments that judge this port had been
repaired in advance (D42, D49) and each named `review.js` or produced
digestify's row before it was asked to.

## The numbers

|                                                | before                          | after                                                    |
| ---------------------------------------------- | ------------------------------- | -------------------------------------------------------- |
| `bun run gate`, unpiped, exit read from a file | 0 · 1,978 pass / 0 fail         | **0** · **1,982 pass / 0 fail**                          |
| `bun scripts/dist-check.ts`, all arms          | 0                               | **0** · 36 tracked / 36 on disk                          |
| `launcher-pairing-ward`                        | 6 pass, no digestify entries    | **6 pass** · `derived=[review] review.ts→dist/review.js` |
| `spawn-path-ward`                              | 9 pass, digestify **not a row** | **9 pass** · `review.js  anchor-read=yes  pins=5` ⚠      |
| kit modules with a subject                     | —                               | **4 of 8** adopted; 4 with none, plus 2 partial exports  |
| acc                                            | **no config** (D37)             | **no config** — not acquired, by decision                |
| blast radius of chapter 2                      | —                               | **1 artifact** — no kit module was modified              |

⚠ **`pins=5`, not `pins=6` — this table said 6 and the ward printed 5.** The
number was true at `110a3611` and false from `67f74097`, because de-duplicating
`resolveMode` moved a literal `join(DIST_DIR, "index.html")` behind a function
parameter and into the ward's declared blind spot. **A de-duplication reduced
ward coverage**, silently, since a coverage count going down is not a failure.
Corrected at the repair chapter, driven at three commits — D64, C4.

---

## The three findings

### 1 · A boot is not a drive, for a spell whose product is one submission

Phase B's checklist says "driven on a booted daemon". Every previous subject was
a standing daemon, where booting it and asking it things IS the exercise.
digestify exists so a human can read a rendered page and **submit once**. A
booted daemon nobody submits to exercises neither the in-memory substitution nor
the exit path that carries the payload to the agent — which is the entire spell.

So every drive here ran a whole session: boot → `GET /` and read the injected
payload back out of the page → `POST /submit` → **the process exits 0 with the
answers on stdout**. Both modes, plus `/cancel` → 130 and the `--timeout 0`
pair. That is also what ruled out B2's third case (an exit load-bearing for
something other than exiting) in one invocation instead of by reading.

### 2 · `serveFromDist` had to be adopted with a hole cut in it — and then given a cell

The kit's file server guards empty / `..` / nested and nothing else. digestify's
local copy refuses `index.html` **by name**, because `/` here answers the built
HTML with the review injected in memory. Adopting the kit verbatim leaves a live
`GET /index.html` serving the **unsubstituted** page — a review with no
questions in it, at HTTP 200, with nothing red anywhere.

The refusal stayed. What the pre-work did not ask for, and what this port added,
is the **cell**: `/index.html` 404s, its body carries neither placeholder, and
the file it would have served is asserted to still hold them — otherwise the
cell passes because there was nothing to leak. **A drive finds this once; the
next kit change deletes the `if` again.**

### 3 · No `die`, and two populations of exit code

Eight raise sites, none of them findable by the token. All eight now emit the
house envelope. `usage` already agreed at 2; **`not_found` (5) and `conflict`
(6) are new**, and the `{"event":"bind_error"}` line was deleted rather than
kept above the envelope, because two JSON lines are two documents.

**124 and 130 did not move**, and the ruling is why rather than whether: they
are what happened to the review, not refusals of a command; they are returned
and never raised; they carry an observation on **stdout** where a failure
carries an envelope on **stderr**. The channel is the discriminator. D52 wrote
this ruling for `join.ts`; this is the spell it was written about.

And the ruling has a destination Phase B never names: **SKILL.md's exit table**,
which is what tells the caller. Three spells have now changed exit codes and
each found that step by itself.

---

## What I could not verify

- **The human half.** Every submission here was a `POST /submit` by `curl` or by
  a test, not a person clicking Send in a browser. The page renders (the payload
  island parses, the stylesheet carries the surface's own utilities in dev), and
  the surface itself was not touched by this port — but nobody drove the review
  through the UI.
- **`internal` (exit 1) has no deliberate raise**, so the envelope on that path
  was reasoned about and not driven: an unknown throw ends the process with its
  stack exactly as before, which is the behaviour `reportCliError` returning
  `null` is designed to preserve.
- **Register D9's hazard** (`--timeout 3` timing out a typing human against the
  page's 5 s beat gap) was derived from reading both halves and NOT driven —
  driving it needs a browser typing on a schedule.

## What contradicts what

- **The brief and the pre-work both say "fourteen sites".** Counted by following
  the returns, it is **eight** failures; the other stderr writes are the ready
  line, the heartbeat trace and `stale_cancel_ignored` — diagnostics, not
  raises. No ruling changes; recorded because a count is a claim.
- **Phase B B4 and B10 read as a contradiction** about staging a first-emit
  artifact. They are not — they ask different questions — but the reconciliation
  lived only in D42's prose. Amended.
