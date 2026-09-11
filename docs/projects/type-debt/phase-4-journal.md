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
