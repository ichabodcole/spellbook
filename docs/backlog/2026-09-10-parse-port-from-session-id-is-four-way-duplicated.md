# `parsePortFromSessionId` is four-way duplicated, with the same type error in all four

**Added:** 2026-09-10 · **Found by:** type-debt Phase 2 (digestify) ·
**Decisions:** `docs/projects/type-debt/decision-log.md` **T22**

`parsePortFromSessionId` is **byte-identical** in four spells:

| file                              | line |
| --------------------------------- | ---- |
| `src/digestify/backend/review.ts` | 234  |
| `src/imago/backend/server.ts`     | 111  |
| `src/magpie/backend/server.ts`    | 117  |
| `src/bounty/backend/server.ts`    | 326  |

Same `PORT_SUFFIX_RE = /-p(\d{2,5})$/`, same body, and **the same
`noUncheckedIndexedAccess` error at `parseInt(m[1], 10)` in all four** — three
of which are still declared debt (imago 99, magpie 38, bounty 125). Digestify's
is fixed; the other three are waiting in Phases 3 and 4, and whoever fixes them
will write the same four lines a third and fourth time.

The natural home is `src/kit/wire/` beside `shouldIdleClose`: the function is
pure, clock-free, fs-free, and the session-id port suffix is a **house
convention** rather than a per-spell one — which is exactly the argument that
moved `serveFromDist` and `shouldIdleClose` into the kit.

## ⛔ Why it was NOT done inside the type commit

**Because that is the D64 move.** A de-duplication that hides an indexed read
behind a parameter lowers **four** area counts at once with nothing established
about any of them, and D64 is the register entry for a de-duplication that took
a ward's `pins` from 6 to 5 with nothing red anywhere. The ratchet's FELL
sentence names it by name, and type-debt Phase 2 added a second form of the same
hazard to that sentence (a value moved across a function boundary into a
non-optional parameter launders a genuinely-absent value exactly as well as it
launders a false narrowing).

So this is a **refactor with a behaviour question attached**, not a type fix,
and it wants its own branch:

- The four copies are byte-identical **today**. Whoever promotes it must
  establish that, not assume it — and must check the two callers that pass a
  possibly-`undefined` id (`sid?.match` in three of the four, `if (!sid)` in
  digestify's) actually agree on what an empty id means.
- Each spell's recovery path reads the result differently (digestify re-binds
  the port so a relaunched page inherits its `localStorage` draft). The kit
  function must not decide anything the caller decides.
- The one fixed copy carries the **named-branch idiom** for an impossible
  absence in shipped code (T22). Promote that, not a `!`.

## Suggested shape

One `parsePortFromSessionId(sid: string | undefined): number | null` in
`src/kit/wire/`, with the invariant comment from
`src/digestify/backend/review.ts` and a test per boundary (no marker, empty id,
out-of-range, non-trailing marker — digestify's five cells are already written
and can move with it). Then delete four copies in one commit, with a population
parity check that all four call sites resolve to the kit's.
