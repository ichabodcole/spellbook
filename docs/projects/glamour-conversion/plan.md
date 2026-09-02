# Glamour conversion — plan SKELETON

**Status:** skeleton · seams **awaiting ratification** **Lead:** prospero
**Created:** 2026-09-02 **Proposal:** [`proposal.md`](./proposal.md)

> **This is a hypothesis, not an instruction.** Every seam below is a **CLAIM**
> written by someone who does not own it. **Falsifying one is the point of the
> exercise, not a setback** — a single author is most often wrong exactly at the
> boundaries between owners.

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

### S1 — a module consumed by BOTH sides `(CLAIM — awaiting daedalus × circe)`

`reduce.ts` and `types.ts` under `surface/state/` are imported by `scripts/` and
by the surface. They are **not** simply backend files in the wrong folder.

> **CLAIM:** after the seam phase, **no module is imported by both `scripts/`
> and the surface from a location that belongs to exactly one of them.**

**The question this poses, which the owners are better placed to answer than the
lead:** where does a module both sides consume actually live, and **who owns
it** — the daemon, the surface, or neither? _(Note the third option is real:
`src/kit/` exists now and did not when imago and magpie faced this.)_

**Ratified at:** ⟨grain — awaiting⟩

### S2 — what the daemon serves, and in which mode `(CLAIM — awaiting daedalus)`

`server.ts` currently does `import index from "../surface/index.html"` — a
bundler entry, not an ordinary import, and the one reference that survives S1.

> **CLAIM:** the daemon serves the **built artifact** where one exists and the
> live surface otherwise, and **the release path imports nothing from `src/`**.

**Ratified at:** ⟨grain — awaiting⟩

### S3 — what the deployed folder is `(CLAIM — awaiting daedalus × cassandra)`

> **CLAIM:** glamour's shipped folder contains **no source a consumer could edit
> and no source a bundler would read** (Contract 4, source-free by FILES not by
> strings), and `bun scripts/dist-check.ts` counts **five** buildable spells and
> stays green.

**Ratified at:** ⟨grain — awaiting⟩

### S4 — the tests survive the move MEANING what they meant `(CLAIM — awaiting cassandra × circe)`

glamour keeps **7 tests in `tests/`**, not `scripts/` — one of the three spells
with that layout, so a glob written from a `scripts/`-shaped spell is blind to
all of them.

> **CLAIM:** after relocation every one of the 7 still **fails for its original
> reason** when its subject is broken. A test that goes green by pointing at a
> path that no longer exists has become vacuous, and that is **indistinguishable
> from passing** (Contracts 16, 20).

**⚠ The done-when for this seam must be keyed on the SUCCESSOR**, never on the
identifier the move deletes — that shape is green by construction.

**Ratified at:** ⟨grain — awaiting⟩

### S5 — glamour arrives conforming `(CLAIM — awaiting circe)`

glamour's `styles.css` uses `@source "./**/*.tsx"` today.

> **CLAIM:** on arrival glamour satisfies Contract 21 (`source(none)` + a scoped
> `@source`), **and no other spell's shipped stylesheet changes by a single
> byte** as a consequence of glamour entering `src/`.

The second half is the testable one: the four existing spells are the control.

**Ratified at:** ⟨grain — awaiting⟩

### S6 — acc is severable `(CLAIM — awaiting cassandra × thoth)`

> **CLAIM:** the port completes and ships **without** acc, and adding acc L0
> later costs no rework of the earlier phases.

**If this is FALSE, say so early** — it changes the phase order, not the scope.

**Ratified at:** ⟨grain — awaiting⟩

### S7 — the playbook is a SYNTHESIS, and confirmation must COMPRESS it `(CLAIM — awaiting thoth)`

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

**Ratified at:** ⟨grain — awaiting⟩

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
