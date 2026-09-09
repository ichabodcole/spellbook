# The conformance register — what the convergence defers, and why

**Created:** 2026-09-09 · **Status:** LIVING. Every port appends; nothing is
closed here without a sha. **Not acc conformance** — this is house conformance:
one specification these eight spells are all supposed to satisfy.

The convergence's premise is that a fix costs six edits and reliably gets one to
four of them. This document is the other half of that premise: **the things we
chose not to fix yet, written down at the moment we chose**, so the choice is a
decision rather than an omission. When the last spell ports, this list is the
work.

---

## The rule for fix-now versus defer

**Fix now** when any of these is true:

1. **This branch created it.** A port that breaks something owns it. (imago's
   dropped `proposalId`, bounty's silent-on-pass ARM 1b.)
2. **It makes a shipped document, type or comment LIE.** A false claim is worse
   than a missing one, because a reader stops looking. (`shared/types.ts`
   declaring a field the daemon no longer sends; a SKILL section teaching the
   pre-port exit codes.)
3. **It is an instrument that guards the ports still to come.** Repairing a
   guard inside the port it guards means fixing it while a 1,700-line relocation
   competes for attention. (The spawn-path ward's blindness; the
   launcher-pairing ward.)
4. **Leaving it makes the NEXT port pay the same cost.** Playbook gaps, always.
5. **It is one line and its absence would mislead.** Rename a ward cell whose
   title no longer matches what it asserts.

**Defer to this register** when any of these is true:

1. **It is pre-existing and this branch did not change it.** (bounty's
   four-entry watchdog gap predates the port — though see below: it moved to
   fix-now because the CODE claimed otherwise.)
2. **The fix requires a decision that spans spells.** One spell cannot choose
   the house's `hint`/`choices` convention alone.
3. **It would change caller-visible behaviour beyond the port's contract.** A
   port's contract is "behaviour unchanged except what is named".
4. **It can only be decided once every spell is in one shape** — which is the
   whole reason this register exists.

⛔ **The exception that overrides "pre-existing": if the code or a doc CLAIMS
the thing is already true, it is fix-now.** The gap is then not the defect; the
false claim is.

---

## A · Contract inconsistencies — the spells do not agree with each other

| #   | item                                                                                                                                                        | spells                              | evidence           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------ |
| A1  | **`hint` / `choices` half-applied.** glamour 12/12, magpie 3/6, imago 2/0, bounty 1/0. An agent routing on `error.choices` gets nothing from three spells.  | imago, bounty, magpie               | Phase 3 + 4 verify |
| A2  | **`conflict` (6) advertised, emitted nowhere** in bounty — a claim conflict is the textbook case.                                                           | bounty                              | Phase 4 verify     |
| A3  | **Two entries of one spell disagree on failure shape** — `join.ts` bare prose + exit 2 beside a converted CLI.                                              | bounty                              | Phase 4 verify     |
| A4  | **Four spells have no `acc.config.json`** and no grade; the ports changed exactly what acc grades and nothing in the gate says so.                          | bounty, digestify, grapevine, imago | D37, D45           |
| A5  | **No test guards the new failure contract** on the spells that adopted it without an acc grade.                                                             | imago, bounty                       | Phase 3 + 4 verify |
| A6  | **Teardown ORDER diverges** — glamour unlinks discovery before the `closed` frame, imago after. Observable between spells, not within one.                  | glamour, imago                      | D40                |
| A7  | **`--timeout 0` reversed meaning** (immediate close → never close); negative `ASTROLABE_IDLE_TIMEOUT` diverges. Accepted as out-of-range, never reconciled. | magpie, bounty, astrolabe           | D24                |
| A8  | **`info` against a dead daemon exits 0** with a stale pointer on stdout — a third failure shape nobody named.                                               | imago                               | Phase 3 repair     |

## B · The spine is not finished

| #   | item                                                                                                                                                                                                                                                                   | evidence               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| B1  | **The epoch query parameter.** D23's restart gap closes only when the cursor is strictly greater; at equality a tail is connected-and-silent. The right fix is epoch-aware and must be designed against all seven tails at once. **The single largest deferred item.** | D19, D23               |
| B2  | **Five daemons stamp no epoch**, so the client's `epochOf`/`onEpochChange` hook is inert for them.                                                                                                                                                                     | D23, L6                |
| B3  | **The watchdog is not in the kit** — a named absence in `drainAndStop`, because it would put the only unconditional `process.exit` inside a module every spell inlines. Revisit once every spell's teardown is one shape.                                              | D46                    |
| B4  | **`printJson` still lives in `kit/lib/`**, not `kit/wire/`, because its path is spelled in eight prose locations.                                                                                                                                                      | D7                     |
| B5  | **`emitEvent` takes `Record<string, unknown>`** — what let a typed two-sided contract go false with no type error.                                                                                                                                                     | Phase 3 repair         |
| B6  | **grapevine's event bus cannot be served** by the shared spine (durable `.jsonl` replay, presence metadata on subscriber records). Named from the start; decide whether the spine grows or grapevine stays out.                                                        | proposal               |
| B7  | **`mind-mapper/scripts/tail.test.ts`** — the only executable spec of tail behaviour — must be re-pointed at the shared client rather than rewritten.                                                                                                                   | proposal, "done means" |

## C · Instruments

| #   | item                                                                                                                                                                       | evidence            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| C1  | **`dirname(process.argv[1])` still passes the spawn-path ward**, declared rather than closed: treating `process.argv` as an anchor ingredient would redden every artifact. | D36                 |
| C2  | **`dist-check` ARM 2 is CI-scoped**, so source/inlined-copy staleness of two-sided modules is not caught by the local gate.                                                | D10, Phase 3 verify |
| C3  | **`grimoire` populations read `git ls-files src`** for hand-authored sources — judged a different subject than emitted artifacts, recorded not changed.                    | D42                 |

## D · Documentation and release

| #   | item                                                                                                                                                                                                                                                                                                                                             | evidence         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| D1  | **`docs/releases/DRAFT-next-release.md` is 174 commits stale** and asserts three things now false (glamour's acc grade; "four spells still need a rewrite"; grapevine's SKILL version/breaking item). Whole areas absent, including three spells' exit-code change and a verb that shipped dead for eight days. **Own branch, before any push.** | Phase 4 verify   |
| D2  | **Phase B is not safe to hand digestify** — four steps wrong if followed literally, two silently. Pre-work, like the build.ts generalisation.                                                                                                                                                                                                    | Phase 4 verify   |
| D3  | **The architecture document** — after the last port, inputs accumulating now.                                                                                                                                                                                                                                                                    | Cole, 2026-09-09 |

## E · Design questions — worth asking once every spell is in one shape

These are not defects. They are places where the shape we have may not be the
shape we want, and only a complete roster can answer them.

- **Is `join.ts`'s participant model general?** One spell has a second
  caller-facing participant. If co-presence is the direction, is that a bounty
  feature or a missing kit module?
- **Should the two discovery conventions (D3) survive long-term**, or did they
  encode a distinction that the shared spine has since dissolved?
- **Is a spell's daemon the right unit at all** for the two spells that are
  single-shot (digestify) versus standing (everything else)?
- **Does the surface belong in the same repo boundary as the backend**, given
  four spells' surfaces reach into the skill folder for types?
