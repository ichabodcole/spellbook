# Phase 4 — the three big ones: imago, bounty, grapevine

**Branches:** one per spell, from `develop` · **Date:** 2026-09-10 ·
**Decisions:** [`decision-log.md`](./decision-log.md) **T30–**

Ordered by shipped-code share, fewest first: imago (37 shipped of 135), bounty,
grapevine. Each spell's diff gets a no-stake verifier before it lands.

---

## 4a · imago — 135 → 0

**Branch:** `feat/type-debt-phase-4-imago` · `src/imago/backend` 99 → 0 ·
`src/imago/surface` 36 → 0 · total 407 → 272.

| errors | shape                                                                           | fix                                                                |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **1**  | ⭐ **REACHABLE from the wire** — a label-less pin opened for "Edit note" (T30)  | `initialLabel={editing.label ?? ""}`; premise cell added           |
| 2      | ⭐ **DEAD READ** — `res.conflicts`, never produced, never declared (`5e6aacde`) | removed; no response byte changes                                  |
| 3      | `TOOL_ORDER` and `TOOL_REGISTRY` — two hand-kept string lists                   | `ToolId` derived from the registry; drift is a compile error       |
| 8      | `Canvas.tsx` — a guard naming `variant` but not the `batch` it implies          | the guard names both                                               |
| 10     | index reads inside loops                                                        | total by construction (`findLast`, `.entries()`, a carried `prev`) |
| 12     | impossible absences in functions with their own answer                          | explicit branches (T22)                                            |
| 1      | `ReturnType<typeof Bun.serve>`                                                  | `Bun.Server<undefined>` (T27)                                      |
| 1      | `sharp` 0.35.0 untyped under bundler resolution                                 | lockfile to 0.35.4, upstream's fix (T31)                           |
| 97     | test reads of a test's own setup                                                | local throwing readers                                             |

### ⚠ The mechanical pass that nearly inverted four cells

The integration suite has 68 errors, mostly `st.marksByVariant[vid]` and
`st.layersByVariant[vid]` reads. A regex rewrite onto throwing accessors
(`marksOf`, `layersOf`) was the obvious move, and the first pass **also
rewrote**:

- **38 reads inside `waitForState` predicates**, where the bucket legitimately
  does not exist yet — a throwing reader would have crashed the poll on its
  first tick;
- **four ABSENCE assertions** — `expect(...).toBeUndefined()` and
  `expect(... ?? []).toEqual([])` — where a throwing reader turns "the bucket is
  gone" into a crash, i.e. inverts the cell.

All were restored before any test ran, found by grepping the rewritten file for
`?.`, `?? []` and `toBeUndefined` on accessor calls. **The transferable rule:**
a throwing reader is right for a read the test's setup guarantees, and wrong for
one the test is polling for or asserting absent. A mechanical rewrite cannot
tell them apart; the diff's `?.` and `??` sites are where to look.

### ⚠ A generic arrow in a `.ts` test file breaks an unrelated ward

The first gate run failed two cells of `import-boundary-wards` with a bare
`AggregateError: Parse error`. The cause was `const first = <T>(xs…) =>` in the
integration test: that ward runs **every file** through Bun's transpiler, which
reads `<T>(` as JSX. `tsc` and `bun test` both accept the line. Now a function
declaration, with a comment saying why. **For bounty and grapevine: write local
generic helpers as `function`, never as a generic arrow.**

### The verify pass

A no-stake verifier re-derived every count on clean `git archive` exports of
`develop` and `HEAD` (the working tree already held the next spell's edits) and
found **no behaviour change** in any rewritten read. It corrected four claims,
all fixed before landing: T30's reachability (WebSocket only — not `/cmd` — and
never from the shipped UI); a still-open same-class defect (`mark.update`
accepts a numeric label, filed to the backlog); the sharp lockfile also moving
`semver`; and the registry comment, which is true only for an id in the order
but missing from the registry.

### Drives and calibrations

- **Premise cell:** a pin with no label is accepted and stored with no `label`
  key (1 pass).
- **Registry calibration:** `"text"` appended to `TOOL_ORDER` → `TS2322`.
- `bun test src/imago plugins/spellbook/skills/imago`: **125 pass / 0 fail**
  before the premise cell; the cell passes on its own.
- `imageOptimize.test.ts` after the `sharp` bump: 2 pass.

---

## Between 4a and 4b · the census measures workspaces under their own config (T32)

Grapevine's surface would not add up: 37 errors under the root config, 0 under
`src/grapevine/tsconfig.json`. The census had scoped workspace configs out on
bounty's 126-vs-128 evidence. It now measures each `src/<dir>/tsconfig.json`
workspace with its own run, each file owned by exactly one run. Landed as its
own change before bounty: total 272 → 232, entirely the two surfaces, no source
file touched. Bounty's first pass had rewritten two `@/` imports to satisfy the
root config; that was reverted when the instrument moved instead.

## 4b · bounty — 125 → 0

**Branch:** `feat/type-debt-phase-4-bounty-v2` · `src/bounty/backend` 125 → 0 ·
total 232 → 107.

| errors | shape                                                                     | fix                                                      |
| ------ | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| **58** | ⭐ `const die = kitDie;` — an un-annotated alias hid `die`'s `never`      | import `die` directly (T33); calibrated: alias back → 58 |
| 1      | `ApplyResult` missing `tasksDropped`, which the wire has carried since b8 | the type completed (T34)                                 |
| 2      | `validateTask` relying on a check made in `taskRejection`                 | restated where read (T34)                                |
| 9      | impossible absences / index reads in loops                                | own-answer branches and `.entries()` (T22)               |
| 1      | `ReturnType<typeof Bun.serve>`                                            | `Bun.Server<undefined>` (T27; no `ws.data`)              |
| 54     | test reads, a `Bun.spawn` stdout union, two `as RegExpExecArray` casts    | local `must`/`at`; a named throw; the casts removed      |

**No reachable `undefined`.** Almost half of bounty's debt was one line that
stopped the compiler seeing the error contract.

### Process and verify pass

- First built in the imago branch's working tree while imago's verifier ran;
  parked in the scratchpad by shasum, restored byte-identical after imago
  landed. Then rebuilt as `-v2` on top of T32, cherry-picking the fix and test
  commits and restoring the two `@/` imports.
- The no-stake verifier found **no behaviour change and no weakened assertion**
  (327 pass; census 32 sites before and after, raiser set minus the dead
  `kitDie` name). It corrected three documentation claims, all fixed:
  `tasksDropped` came from **b8**, not "#b7"; "two missing return" was one
  missing return and one narrowing; and T34's first-draft grapevine figures.

---

## 4c · grapevine — 105 → 0

**Branch:** `feat/type-debt-phase-4-grapevine` · `src/grapevine/backend` 104 → 0
· `plugins` 1 → 0 · total 107 → 2. (`src/grapevine/surface` already read 0 once
T32 measured it under its own config.)

| errors | shape                                                                          | fix                                                          |
| ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **47** | ⭐ the channel router's `chMatch[1]`, read inside `if (chMatch)`               | read once as `chMatch?.[1]`; the branch requires it (T35)    |
| 18     | fourteen `cmd*` functions guard `if (!name) die(…)` yet declare `name: string` | `name: string \| undefined` — the signature tells the truth  |
| 1      | the launcher typed by the bundle's `return;`                                   | `run()` returns `0`; exit behaviour identical (T35)          |
| 8      | index reads / mandatory regex groups                                           | `.at(-1)`, `for…of`, an `indexOf` slice, own-answer branches |
| 31     | test reads; a `.find()` result read after a `toBeDefined()`                    | local `must`/`at`; the `find` wrapped where it is assigned   |

**No reachable `undefined`.** One near-miss worth recording: `who`'s positional
is optional in the registry, so `grapevine who` passes `undefined` into
`cmdWho(name: string)` — reachable, and already handled by its first line. The
bug was only ever in the type.

### Drives

Built launcher, isolated `GRAPEVINE_HOME`: `who` (no args) → exit 2 usage;
`open drivechan` → ok; `send` → ok; `pull` → 2 messages, cursor 2;
`mark drivechan 1` → exit 2 "missing required <disposition>" (dispatch, before
the command function's own guard); `who drivechan` → ok; `stop` → no daemon
left. `bun test src/grapevine plugins/spellbook/skills/grapevine`: **219 pass /
0 fail**.

### The verify pass

No behaviour regression; 219 pass; the shipped `dist/` matches a fresh build.
Two real corrections, both fixed before landing:

- **`requiredArg()` rested on a false premise.** All five functions it guarded
  already refuse a missing name on their first line, so they got the widened
  signature like the other nine and `requiredArg` was removed (A1 pin back to
  58). "Nine functions" was fourteen.
- **The T32 census could not detect a double count** — the verifier removed the
  ownership filter and watched a root-owned error count twice with every check
  green. A cross-run `doubleCounted` check now refuses it, the fixture cell has
  the import that exposes it, and that mutation now exits `DOUBLE COUNT`.

And one found after it: the comment that replaced `requiredArg` quoted a usage
refusal literally, and the A1 census counted it as a raise site (58 → 59) until
it was reworded — filed as
`docs/backlog/2026-09-10-a1-census-counts-a-raise-site-quoted-in-a-comment.md`.

Smaller: two `(line as string)` casts were removed, not one; T32's cascade count
was 10 implicit-any plus 1 missing-property.

### ⚠ One mechanical slip, caught before anything ran

A regex replacement string containing `\n` was written into the test file as a
real newline, splitting three `split("\n")` literals across lines. `tsc` would
have caught it; a grep for the rewritten pattern caught it first. Python's
`re.sub` interprets backslash escapes in the REPLACEMENT, not just the pattern.

---

## Phase 4 · close

**Three spells, 405 errors — 365 fixed in code, 40 removed by measuring two
surfaces correctly (T32) — 407 → 2.** Imago 135, bounty 128 (3 of them by
measurement), grapevine 142 (37 by measurement). Two `undefined`s reachable from
the wire, both imago's (T30) — and, in magpie's Phase 3b, the project's one
reachable from real input (T28).

**The phase's lesson is about concentration, not volume.** 58 of bounty's errors
were one alias (T33); 47 of grapevine's daemon were one read (T35); 37 of
grapevine's surface were one instrument scope (T32). Reading errors one at a
time would have produced three hundred local fixes and missed all three causes.

**The repo total is 2**: `src/kit/wire/serveDist.ts:153` and one in
`src/mind-mapper/backend`, both outside Phase 4's areas. They are the last row
of "Done means".

---

## Zero · `src/kit` and mind-mapper — 2 → 0

**Branch:** `feat/type-debt-to-zero`. One `.filter()` type predicate taken with
its existing clause (`serveDist.ts`), one stated return type (mind-mapper's
`onHttpError`). T36. Every dist rebuilt, since `serveDist.ts` is bundled into
every daemon. The ratchet reads **0 errors in 0 files**.
