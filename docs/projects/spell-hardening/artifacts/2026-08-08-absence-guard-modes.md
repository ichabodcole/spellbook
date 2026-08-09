# The absence guard is not one failure — it is three

**Sprint 04 · card `g6` part 1 · cassandra · 2026-08-08**

Three landed cells guard an honesty field with `not.toBeNull()`. All three were
mutation-verified by deleting the field from its emitter. **In all three the
guard PASSED on an absent field** — `expect(undefined).not.toBeNull()` is true,
because `undefined !== null`.

**But they then fail in three different ways, and the three need three different
fixes.** The original card said "the absence guard is decorative in 3 of 3".
That is wrong in count and in category: only one is decorative.

> **Why this artifact exists.** Its evidence is a wasting asset. A future reader
> can reconstruct a red arm from a sha and a recipe; what they cannot do is
> **discover it is missing**. The moment these three sites are repaired the live
> arm is gone, and the board card that described it will be gone too.

## Pinned by TEST NAME and ASSERTION TEXT, never by line number

Line numbers in these files moved twice during the session that measured them.
Locate each site by its enclosing `test(...)` name and the assertion string.

---

## Site 1 — DIAGNOSIS becomes NOISE

|         |                                                                    |
| ------- | ------------------------------------------------------------------ |
| file    | `plugins/spellbook/skills/bounty/scripts/server.test.ts`           |
| test    | `b8: init REPORTS the tasks it dropped, and names why`             |
| guard   | `expect(body.tasksDropped).not.toBeNull();`                        |
| emitter | `bounty/scripts/server.ts`, the `init` reply's `tasksDropped:` key |

**Mutation** — delete the `tasksDropped:` property from the returned envelope so
the field is absent rather than null.

**Result**

```
guard                                     PASSED
expect(body.tasksDropped?.requested)      FAILED
   Expected: 2
   Received: undefined
```

**Why it matters.** The cell does go red, so it is not decorative — but the
message names a **count**. A maintainer reads `Expected: 2` and hunts a
seeding/counting bug. The actual defect is that the field stopped existing.

**Fix — REORDER, do not delete.** The presence check must report before the
value check, e.g. `expect("tasksDropped" in body).toBe(true)` above the value
assertions. The guard is doing real work badly; deleting it loses coverage.

---

## Site 2 — DIAGNOSIS becomes a MATCHER TYPE ERROR

|          |                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| file     | `plugins/spellbook/skills/bounty/scripts/server.test.ts`                                                                                                                          |
| describe | `P0b — open refuses rather than discarding flags on the attach path`                                                                                                              |
| test     | `PRECONDITION + RED PRE-FIX — live 0 over snapshot 2, then --restore is REFUSED`                                                                                                  |
| guard    | `expect(env.restoreSkipped).not.toBeNull();`                                                                                                                                      |
| emitter  | `bounty/scripts/cli.ts`, the attach-refusal `printJson({ ...live, restoreSkipped: { requested, reason } })` — the only non-null emit; two other sites emit `restoreSkipped: null` |

**Mutation** — delete the `restoreSkipped: { … }` property from that `printJson`
call.

**Result**

```
guard                                        PASSED
expect(env.restoreSkipped?.requested).toContain("restore")
   error: Received value must be an array type, or both received
          and expected values must be strings.
```

**Why it matters, and why it is worse than site 1.** The failure is a **matcher
type error**. It names neither the field nor a value — a maintainer reads it as
a broken assertion or a shape change in `requested`, not as a vanished field.
Site 1 at least prints `undefined`.

**Fix — REORDER**, as site 1.

---

## Site 3 — DECORATION: the guard cannot fail

|         |                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------- |
| file    | `plugins/spellbook/skills/grapevine/scripts/cli.test.ts`                                        |
| test    | `b5 GUARD — a genuinely EMPTY channel still reports 0, so 0 keeps meaning empty`                |
| guard   | `expect(ch.message_count).not.toBeNull();` — the line BELOW `expect(ch.message_count).toBe(0);` |
| emitter | `grapevine/scripts/daemon.ts`, the `message_count,` key on the listed-channel object            |

**Mutation** — remove `message_count,` from the returned channel object.

**Result**

```
expect(ch.message_count).toBe(0)     FAILED FIRST
   Expected: 0
   Received: undefined
guard                                 NEVER EXECUTED
```

**Why it is decorative.** It cannot fail in either world. If `toBe(0)` passes
the value is `0`, and `0` is not null, so the guard passes. If `toBe(0)` fails,
execution stops and the guard never runs. **A line that is unreachable-on-red
and tautological-on-green asserts nothing.**

**Fix — DELETE it, or replace with a presence check** (`"message_count" in ch`)
that says something `toBe(0)` does not.

---

## The rule these three violate

A cell about **presence** must use a predicate that distinguishes _absent_ from
_present-and-null_:

```
DISCRIMINATE   "key" in obj · Object.hasOwn(obj, "key") · x === null · x === undefined
ERASE          not.toBeNull() · toBeUndefined() · toBeFalsy() · toBeDefined()
               and any coalescing (?? ||) in the expression under test
```

`not.toBeNull()` is the sharpest trap: it **reads** as "assert this field is
populated" — the sentence a present-and-null cell wants — and is satisfied by
the field not existing at all.

## Reproducing this — the method, not just the result

- **Mutate in a detached worktree** (`git worktree add --detach <dir> HEAD`).
  Peers were editing two of these files while this ran; the shared tree was
  never touched. Mutation testing on a shared tree is what made three seats
  collide earlier the same day.
- **`bun test -t` takes a REGEX.** `-t "PRECONDITION + RED PRE-FIX"` matched
  **zero** tests because `+` is a quantifier — bun says so explicitly
  (`matched 0 tests`). Select on a metacharacter-free substring.
- **A wrong `-t` that matches OTHER tests is the dangerous one.** The first
  attempt at site 2 used a selector that matched five unrelated cells, all of
  which passed — and that was misread as "the mutation did not reproduce". A
  zero-match is announced; a wrong-match is not.

## Not done here

- **Sites 1 and 3 are NOT repaired.** Site 1's reorder is a real coverage change
  and deserves its own cell rather than a drive-by.
- **The allow/deny lists are NOT mechanized.** That is `g6` part 2, deferred to
  sprint 05: it is a new instrument, and instruments in this repo have no prior
  artifact to port from.
