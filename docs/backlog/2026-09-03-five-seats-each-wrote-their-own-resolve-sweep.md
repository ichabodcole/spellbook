# Five seats have each written their own resolve sweep

**Filed:** 2026-09-03 · **Found by:** thoth (glamour port, B3 playbook edit) ·
**Scope:** repo-wide instruments · **Ruled OUT of the glamour port** (prospero
#1235 — one afternoon, and it belongs to whoever owns the next instruments pass)

## The defect

A **resolve sweep** — walk every relative specifier in a subtree, resolve it,
report the unresolved — is the instrument a relocation is measured with. It is
the difference between "the tests pass" and "nothing dangles."

**There is no shared one.** `scanSpecifiers` is the primitive; every seat that
has needed a sweep has written its own over it, calibrated it, and thrown it
away. This port alone ran three separate implementations (daedalus's, circe's,
and the one inside the playbook's prose), and `porting-a-spell-playbook.md`'s
Gotcha 9 exists **because** each port wrote a different one — the gotcha has
three floors, which is three seats' worth of independently discovered edges.

The playbook now says, in terms: _"there is no shared sweep; write yours over
`scanSpecifiers` and calibrate it."_ That sentence is honest and it is also an
admission — a document telling every future reader to rebuild an instrument is
describing a gap, not a procedure.

## Why it matters more than duplication

Each hand-written sweep has **its own uncalibrated floor**. A sweep that reports
`0 unresolved` proves nothing unless something in the same run could have
returned non-zero, and a seat writing one under time pressure will reach for the
count and not the control. This session's sweeps were calibrated because the
seats running them happened to be rigorous; nothing required it.

**That is the false-instrument class this repo has now hit five times** — see
`principles.md`, _a false reassurance about an INSTRUMENT is worse than a false
claim about the code_.

## What a fix looks like

`scripts/instruments/resolve-sweep.ts`, wrapping `scanSpecifiers`:

- takes a root, returns `{ files, specifiers, unresolved[] }`
- **declares its floor** — the population it swept and what it cannot see (bare
  specifiers, dynamic imports, non-literal arguments)
- ships with a fixture route that can actually fail, so a `0` is licensed

Then the playbook's Gotcha 9 loses its three floors and points at one tool, and
the next port measures rather than builds.

## Related

- `grimoire/` instruments — `gate-blind-set.ts` is the pattern to copy
- `docs/playbooks/porting-a-spell-playbook.md` — Gotcha 9
- `.anthill/principles.md` — the instrument-reassurance entry
