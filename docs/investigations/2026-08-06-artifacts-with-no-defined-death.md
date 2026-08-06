# Artifacts with no defined death — where the loop doesn't close

**Created:** 2026-08-06 **Status:** Open — evidence gathered, mechanism not yet
chosen **Author:** Claude Code (prospero), with Cole Reed

---

## The question

Five separate gaps surfaced in a single working session. Each looked like its
own problem and got its own fix. **They are one problem**, and this document
exists to establish whether that claim survives scrutiny, and — if it does —
where the mechanism that closes them should live.

The claim: **every artifact this house creates has a defined birth and no
defined death.** Conventions say precisely when to create a plan, a handoff, a
scratch file, a backlog item, a temp dir. **Not one of them says when it ends,
who says so, or what happens if nobody does.**

## Why now

Nothing here was found by looking for it. All five were found by tripping over
them while doing unrelated work on 2026-08-06 — which is itself evidence about
the failure mode: **an artifact that never closes produces no error, no alert,
and no failing test.** It produces a document that is quietly wrong, and it is
discovered by someone who happened to check.

---

## Evidence

Five instances, measured, with the specific harm each produced.

### 1. `plan.md` — 1,951 lines, no close

`docs/projects/spell-hardening/plan.md` reached **1,951 lines / 122KB** across
**nine rounds of in-place amendment**.

The convention (`docs/projects/README.md`) said a project gets one `plan.md`,
"created when implementation begins", and listed "spans multiple sessions" as a
reason to create a project at all. **There was no shape for a second plan**, so
the only way to plan more work was to rewrite the plan already executed against
— destroying the record of what was believed at the time.

`docs/projects/mind-mapper/` hit the same wall and improvised the other way:
`plan-round3.md` through `plan-round12.md` as loose siblings, with no ledger
saying which was live. **Same missing shape, opposite workaround.**

**Fixed 2026-08-06** (`8485ac9`, `b884990`): sprints, frozen plans, and
`outcome.md` as the close.

### 2. The handoff — outlived its purpose by a day, invisibly

`spell-hardening`'s `HANDOFF.md` said "read this before ratifying the plan." The
ratify round happened on 2026-08-06. **The document's claims were audited twice,
individually, across a full day — after its reason to exist had already
expired.**

Its own banner, written by the session that eventually noticed:

> _a document whose job is to say "the other document is stale" needs its own
> staleness rule — and needs it for its PURPOSE, not just its claims. The claims
> were audited twice. **Nobody asked whether the document still had a reason to
> exist.**_

**This is the sharpest instance and the one that names the mechanism.**
Fact-checking cannot catch purpose-rot. Every individual sentence stayed true
while the document as a whole became garbage.

**Fixed 2026-08-06:** no continuity handoff as a convention; `handoff.md` scoped
explicitly to deployment so the name stops being borrowed.

### 3. `.anthill/scratch/` — a stated lifecycle with no mechanism

`anthill:finalize-session` step 2 states the contract exactly:

> _"Your scratch is disposable after synthesis — the durable form is the seat
> doc."_

Every seat reads it, agrees, synthesizes, and leaves the directory where it was.
Measured: **8.0M across 8 entries**, oldest material ~3 weeks old and carried
across roughly a dozen sessions.

Verified that the mechanism is genuinely absent rather than merely unused:
`scripts/anthill/commands/` ships **17 commands** and none touches scratch.
Grepping all of `scripts/` for `scratch` returns only a `.gitignore` line and a
one-off migration discard. **The only thing that has ever cleaned scratch is a
layout migration's side effect.**

**Filed upstream** as `ichabodcole/anthill#93`.

### 4. Temp directories — cleanup that only runs on graceful exit

`$TMPDIR` held **22,882 entries**; **11,889** matched known test-fixture
prefixes and were older than two hours. Oldest: **2026-07-16**.

```
anthill-lock               5165
anthill-d3 (+ variants)    2934
media-buffet-test-storage  1566
mind-mapper-*-test          971
glamour-home/styles/files   354
```

`glamour` mints `glamour-home-*`, `glamour-styles-*` and `glamour-files-*` per
invocation; mind-mapper mints one per test. Cleanup exists — and is
**graceful-exit-only**, so a killed process never sweeps.

**This is the same root cause as the `spell-hardening` discovery-pointer
defect** (candidate 6: a machine-global pointer at
`join(tmpdir(), "<spell>-latest.json")`, cleanup graceful-exit-only, killed
daemons never unlink). One defect, two surfaces.

**Not fixed.** The sweep was scoped and offered; it is the one item here that
needs code rather than a ritual.

### 5. `docs/backlog/` — drift in both directions, same pass

**Nothing sweeps the backlog.** There is no mechanism by which a completed item
would ever be closed.

**Over-count:** `2026-06-22-bounty-heartbeat-skip-blocked` shipped in `e25a28d`
**on the day it was filed**, and GitHub **#40 closed the same day**. Six weeks
later the `spell-hardening` proposal still carried it as live work **in three
places**, one describing it as "already fully designed and approved." P3 was
over-counted by a whole item — **in the document an archive decision was resting
on, in a project whose entire subject is overstated completeness.** Corrected in
`b67520b`.

Note the shape: the fix was deliberate, shipped fast, and closed upstream.
**Only the local record stayed open.** Nothing anywhere would ever have
contradicted that paragraph.

**Under-count, the same day:** `#11` (the board wordmark still reads
"Tuskboard") **looks fixed to every text-based check** — a grep finds nothing,
because the alt text says "Bounty Board" and **the defect is inside
`assets/wordmark.webp`**. An automated sweep would have wrongly closed it.

---

## The shared shape

**Birth is motivated; death is not.** You create an artifact at the moment you
want it, so creation is self-triggering. You stop needing it at a moment defined
by something _else_ finishing — and at that moment your attention is already on
the next thing.

Three consequences follow, and all five instances exhibit them:

1. **A close cannot be triggered by the artifact's owner remembering.** It has
   to hang off the completion of whatever made the artifact obsolete.
2. **Purpose-rot is invisible to fact-checking.** A document can be entirely
   true and entirely obsolete. Every check we run tests claims; nothing tests
   whether the document still has a reason to exist.
3. **The failure is silent by construction.** No error, no alert, no failing
   test — only a document that is confidently wrong, discovered by accident.

### The counter-example, which is the encouraging part

**The one artifact class that has a close ritual works.**
`anthill:finalize-session` step 2.5 forces a re-read of every doc you own, with
the instruction to **assume it has drifted**. On its last run that beat found
drift in **all four** seat docs — including two outright false statements, in
docs written by careful agents.

And the framing was load-bearing, not the re-read: one seat reported she would
have **skimmed and passed** under a plain "re-read and update" instruction. She
found her drift only because she was told to assume it existed.

**So closes are not hard to make effective.** They are rare because each one had
to be invented separately, by whoever got bitten.

### One distinction that must not be collapsed

The five split cleanly into two kinds of fix, and conflating them would produce
a checklist where a `finally` block belongs:

| kind           | instances                             | fix                                                 |
| -------------- | ------------------------------------- | --------------------------------------------------- |
| **Ritual**     | plan, handoff, scratch, backlog       | a beat in a process, performed by an agent or human |
| **Mechanical** | temp dirs (and the discovery pointer) | code — signal handlers, `finally`, harness teardown |

Temp-dir accumulation will not be fixed by anyone remembering anything. Backlog
drift will not be fixed by a signal handler.

---

## Where the touchpoints are

Candidate hooks that already exist and already fire:

| touchpoint                  | exists today                                   | could close                                           |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| **Session end**             | `anthill:finalize-session` — yes, and it works | scratch (proposed upstream, #93); seat docs (already) |
| **Sprint close**            | `outcome.md` — invented 2026-08-06             | a sprint's plan (freeze), carry-forward               |
| **Branch finalize / merge** | nothing                                        | backlog items, deployment handoffs                    |
| **Sprint / project open**   | `anthill:convene` reads the retro              | re-check the backlog against code before scoping      |
| **Process exit**            | graceful-exit-only today                       | temp dirs, discovery pointers — **needs code**        |
| **Test-suite teardown**     | partial (`mkdtempSync` fixtures)               | test temp dirs                                        |

**The gap with the most leverage is `branch finalize / merge`** — it is the only
one with no ritual at all, and it is where a backlog item's death actually
happens. #40's fix merged; nothing on that path asked "does this close
anything?"

---

## Options

1. **Per-artifact closes, invented as needed.** Status quo. Cost: five
   inventions so far, each paid for by a failure, each covering one artifact.
2. **A generic close beat attached to existing touchpoints.** One rule —
   _whatever this act completes, name what it makes obsolete_ — hooked into
   finalize-session, sprint close, and merge. Cheaper than five rituals; risks
   being too abstract to act on.
3. **Mechanical closes where mechanical is possible, rituals only for the
   rest.** Temp dirs and pointers get code (a `finally`/signal-handler sweep, a
   harness teardown). Plans, backlog and scratch get ritual beats. **Most likely
   correct, and it is not exclusive with option 2.**
4. **A periodic sweep** (a grooming ritual, cf. the planned grimoire spell
   roster sweep). Catches drift regardless of which touchpoint was missed — but
   it is a net, not a fix, and it will find things late by design.

## Where it would live

Three homes, and the split is not optional — no single home covers all five:

- **project-docs** — plan/sprint closes (done), backlog closing ritual, the
  merge-time beat.
- **anthill** — scratch lifecycle (#93 filed), and the `finalize-session`
  framing that already works.
- **the spells themselves** — temp dirs and discovery pointers. Code, not
  convention.

---

## Open questions

- ~~**Who declares a death?** For a sprint it is the closer. For a backlog item,
  the person merging the fix may not know an item exists. That asymmetry is
  probably the real difficulty.~~

  > **PROPOSED ANSWER, Cole, 2026-08-06 — a sweep at finalize, not at merge.**
  >
  > **Invert it.** Don't ask the merger "does this close a backlog item?" — they
  > don't know the item exists, which is the asymmetry. Ask at the **end of a
  > sprint or project**, as a finalize beat: _here is what we accomplished;
  > which backlog items does it close?_ **Dispatch a subagent to sweep**,
  > because the question is a read across many files and the answer is a short
  > list.
  >
  > **Why this resolves it:** the closer holds the one thing the merger lacks —
  > **a complete account of what the session did.** The backlog reader and the
  > work-knower become the same agent. It will miss some, and that is accepted;
  > it catches the majority and it hangs off a ritual that already exists.
  >
  > **Precondition, from `#11`:** the sweep must report **verified fixed** (code
  > checked, fix cited) separately from **probably fixed**. When this sweep was
  > run manually on 2026-08-06 it produced exactly one verified close out of 31
  > items — and it was only right about `#11` because it looked past the text
  > into a binary asset. A sweep that collapses those two buckets will close
  > things that aren't done.
  >
  > **Where it hooks:** `anthill:finalize-session`, alongside the seat-doc
  > synthesis — and the same beat covers the scratch sweep (`anthill#93`), so
  > one ritual closes two of the five artifacts here.

- **Can an automated sweep be trusted?** `#11` says not alone: it looks fixed to
  every text-based check and is not, because the defect is in a binary asset.
  Any mechanical closer needs a "verified fixed" vs "probably fixed" split — a
  distinction this repo has been bitten by **four times in one day** in a
  different form (counts quoted without their denominators).
- **Does the close belong to the artifact or to the act?** Option 2 assumes the
  act. Unproven.
- **Is `_history/` a close or a deferral?** It preserves provenance, but a
  document moved there is still a document nobody re-reads.

## The ownership question underneath all of this

Noted 2026-08-06, because it shapes where any fix lands and it is currently
unresolved.

**There are two systems here — `project-docs` and `anthill` — and it is not
settled which owns a ritual.** `finalize-session` is anthill's; the project
folder conventions are project-docs'; a "finalize branch" beat belongs to
neither cleanly. Every close proposed above had to pick a home, and the picking
was ad hoc.

**The direction Cole is moving (his framing, recorded not ratified):** toward
anthill, but with the rituals **not pre-baked into anthill releases**. Instead a
team defines its own checklist — its methodology docs — and the skills **point
at** them. anthill ships the field notes: what has been found to work, so a team
doesn't reinvent everything, while still being able to bring in what fits and
modify it.

**Why that matters to this investigation specifically:** it changes the unit of
the fix. If rituals are team-defined and skill-referenced, then the answer is
not "add a backlog-sweep step to `finalize-session`" — it is **"make
`finalize-session` able to run a team's own close-list, and put the backlog
sweep in this repo's list."** The five gaps above would then be closed by
config, not by five upstream patches, and every other team gets the pattern
rather than the specific step.

This is the strongest argument found so far for that direction, so it is
recorded here as evidence rather than left in conversation.

## Related

- `docs/projects/README.md` § Multi-Sprint Projects — the two closes already
  built (`outcome.md`, frozen plans), including the erratum escape hatch.
- `ichabodcole/anthill#93` — the scratch lifecycle, filed upstream.
- `docs/projects/spell-hardening/sprints/01-drained-exit/plan.md` candidate 6 —
  the discovery pointer, same graceful-exit-only root cause as the temp dirs.
- `.anthill/retro.md` — the finalize ritual's own findings, including the
  assume-it-has-drifted result.
