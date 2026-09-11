# Phase 3 — the long tail: astrolabe, magpie, glamour

**Branches:** one per spell, from `develop` · **Date:** 2026-09-10 ·
**Decisions:** [`decision-log.md`](./decision-log.md) **T25–T27**

Per the proposal: one branch each, shipped code before test files. The
`plugins/` area, measured but assigned to no phase, is split by spell (T25).

---

## 3a · astrolabe — 39 → 0

**Branch:** `feat/type-debt-phase-3-astrolabe` · `src/astrolabe/backend` 19 → 0
· `src/astrolabe/surface` 1 → 0 · `plugins` 21 → 2 · total 535 → 496.

**Four shapes, and only one of them was `noUncheckedIndexedAccess`:**

| errors | where                                        | shape                                                             | fix                                                              |
| ------ | -------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| 18     | `scripts/state.test.ts`                      | a reducer's created entry read as possibly-undefined              | LOCAL `must(v, "<invariant>")` (T22 test-file row)               |
| 17     | `backend/server.test.ts`                     | `cardOf` typed its input `Array<{ id: string }>`                  | `ProjectCard[]`, **and** the daemon's projection annotated (T26) |
| 2      | `scripts/state.ts`, `surface/state/board.ts` | a non-empty literal indexed modulo its own length                 | explicit named branch (T22 shipped-code row)                     |
| 1      | `backend/server.ts`                          | `ReturnType<typeof Bun.serve>` inferred `WebSocketData = unknown` | `Bun.Server<undefined>` (T27)                                    |
| 1      | `backend/cli.ts`                             | `for await` over `Bun.stdin.stream()` — DOM lib has no iterator   | `Bun.stdin.text()`, the house shape                              |

(18 + 17 + 2 + 1 + 1 = 39: 19 in `backend`, 1 in `surface`, 19 in `plugins`.)

### No reachable `undefined`

None of the 20 indexed or optional reads was reachable. The 18 test reads follow
reducers whose contract is to create the entry; the two shipped reads index a
non-empty constant modulo its length. **The phase's real finding is not an
`undefined`: it is T26.** The daemon's board projection was not held to the wire
type the surface reads, so the two could drift silently. Now they can't, and the
drift is a ROSE.

### Drives and calibrations

- **`--stdin`, built launcher, isolated `ASTROLABE_HOME`:**
  `naïve café — 🔭 multi\nline\n\n` arrived as `'naïve café — 🔭 multi\nline'`
  (UTF-8 intact, trailing blank lines trimmed); status `'  phase two ✨\n'` →
  `'phase two ✨'`.
- **`/ws` upgrade:** a Bun `WebSocket` client got a `state` frame with one
  project. Daemon closed; no process left; home under the scratchpad.
- **`must()` calibration:** `applyAttention` mutated to DROP the status entry on
  clear → the "clearing drops the question" cell reds naming the invariant. ⚠
  **The first attempt at this mutation matched two sites, the edit script
  refused, and the test run that followed was green over an unmutated file** — a
  vacuous drive caught only because the script asserted its anchor count.
  Re-anchored on text unique to `applyAttention`, then it reddened.
- **ROSE calibration:** the projection's `zone` → `"idle"` → ratchet
  `ROSE — area "src/astrolabe/backend" 0 -> 1 (+1)`.
- `bun test src/astrolabe plugins/spellbook/skills/astrolabe`: **70 pass / 0
  fail**. Ratchet **13 pass / 0 fail** at 496.

---

## 3b · magpie — 39 → 0

**Branch:** `feat/type-debt-phase-3-magpie` · `src/magpie/backend` 38 → 0 ·
`src/magpie/surface` 1 → 0 · total 496 → 457.

| errors | where                                                              | shape                                                              | fix                                                        |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| **4**  | `discover.ts` `normalizedToPixel`                                  | ⭐ **REACHABLE** — a model's malformed `box_2d`                    | `isBox2d` at the boundary; a pinned, calibrated cell (T28) |
| 27     | `reduce.test.ts`, `daemon.integration.test.ts`, `discover.test.ts` | a test's own setup read as possibly-undefined                      | LOCAL `must()` per file (T22)                              |
| 2      | `discover.test.ts`                                                 | `(async () => …) as typeof fetch` — Bun's `fetch` has `preconnect` | `fakeFetch` builds a real `typeof fetch`; no re-cast       |
| 3      | `reduce.ts`, `server.ts`, `discover.ts`                            | impossible absences in functions with their own answer             | explicit named branches (T22)                              |
| 1      | `server.ts`                                                        | `ReturnType<typeof Bun.serve>`                                     | `Bun.Server<undefined>` (T27)                              |
| 1      | `cli.ts` `source`                                                  | guard read `pos.length`, not the value it narrows                  | `pos[0] === undefined`; same refusal set                   |
| 1      | `surface/RemoveGallery.tsx`                                        | a second lookup into a record the keys came from                   | iterate `Object.entries`                                   |

### Drives and calibrations

- **The reachable defect, before the fix:** `elementsFromRaw` on four shapes
  printed `[200,80,null,null]`, `[null,null,null,null]` and a coerced string box
  (T28's table).
- **The new cell, calibrated:** `isBox2d` reduced to `Array.isArray` → the
  malformed-box cell reds; restored by sha. ⚠ **The first attempt did not
  apply** — biome had reflowed the function, the anchor matched nothing, and the
  edit script refused; the green run after it was void. Second time this phase
  that an anchor-count assertion is what separated a real drive from a vacuous
  one.
- **`source` with no argument**, built launcher: exit 2, `kind: "usage"`,
  unchanged.
- **acc** from the skill directory (`bunx acc check scripts/cli.ts`): exit 0,
  L0, 18 pass / 5 unverified.
- `bun test src/magpie plugins/spellbook/skills/magpie`: **93 pass / 0 fail**
  (the integration suite drives the `/ws` upgrade).

---

## 3c · glamour — 50 → 0

**Branch:** `feat/type-debt-phase-3-glamour` · `src/glamour/backend` 49 → 0 ·
`plugins` 2 → 1 (glamour's `tests/types.test.ts`; grapevine's launcher is Phase
4's) · total 457 → 407.

| errors | where                                          | shape                                                              | fix                                                                   |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 17     | `cli.ts` COMMANDS                              | handler type narrower than its own "`void` means 0" contract       | the type widened to exactly dispatch's accepted set (T29)             |
| 20     | four test files                                | a test's own setup read as possibly-undefined                      | LOCAL `must()` per file                                               |
| 4      | `cli.ts` builders                              | `pos[0]` that arity dispatch guarantees                            | local `positional()` — a named usage throw; a new cell pins it        |
| 3      | `reduce.test.ts`, `styles.test.ts`             | ⚠ **stale fixtures** — types gained `canonical`, `canon`, `colors` | fixtures completed                                                    |
| 3      | `imageOptimize.server.ts`, `persist.server.ts` | mandatory regex groups                                             | explicit branches taking each function's own answer                   |
| 1      | `cli.ts` `open`                                | `unref` not on node's `Readable` type                              | a method check + named throw — **not** `instanceof Socket` (measured) |
| 1      | `cli-contract.test.ts`                         | `Set<Flag>.has(string)`                                            | `ReadonlySet<string>` — the cell asks about arbitrary spellings       |
| 1      | `tests/types.test.ts`                          | a `string[]` literal against a literal-union list                  | `as const`                                                            |

### What it found

- **No reachable `undefined`.** Every indexed read was guaranteed by a test's
  own setup, by arity dispatch, or by a mandatory regex group.
- **Three fixtures had drifted from their types.** The reducer tests were
  exercising `LibraryItem`s that no longer satisfied `LibraryItem` — harmless at
  run time (the reducer never read the missing fields), and exactly the drift
  nothing else would ever report.
- ⚠ **The `unref` fix was nearly a regression.** The obvious honest narrowing,
  `instanceof net.Socket`, is **false** for Bun's pipe (measured: constructor
  `Readable`), so it would have skipped the `unref` silently and restored the 91
  s `open` hang the adjacent comment documents. Guard the method, not the class.
- The only `!` touched was removed (`child.stdout!.unref()`); the other
  pre-existing `child.stdout!` at the handshake read is not a type error and was
  left.

### Drives and calibrations

- **Built launcher, isolated `GLAMOUR_HOME` and `TMPDIR`:** `open --no-open`
  exit 0 in under 1 s; `gen-cost` with no id → exit 2, `kind: "usage"` from
  dispatch (unchanged); `section palette --status agreed` → `{"ok":true}`;
  `close` → no daemon left, `TMPDIR` empty.
- **`positional()` calibrated:** its throw removed → the new builder cell reds.
- **T29 calibrated:** a handler returning `"not-a-code"` → `TS2322` at the
  table.
- **acc** from the skill directory: exit 0, L0, 19 pass / 4 unverified.
- ⭐ **The A1 census caught the new raise site on its own.** The first gate run
  after the builders changed failed `error-choices-census` arm 3: glamour
  `sites` 25 → 26 — `positional()`'s `UsageError`. That is the census working as
  pinned: a new raise site cannot arrive unannounced. The pin moved with its
  reason beside it; `choices` stays 9 by A1's ruling (an id is not an enumerated
  set).
- `bun test src/glamour plugins/spellbook/skills/glamour`: **127 pass / 0 fail**
  before the new cell; `cli.test.ts` 17 / 0 after.

---

## Phase 3 · close

**Three spells, 128 errors, 535 → 407.** Astrolabe 39, magpie 39, glamour 50.
One reachable `undefined` (magpie's `box_2d`, T28) — the first in the project.
Three decisions that generalise to Phase 4:

- **T26** — an annotation over an `any` source is honest only when the producer
  is held to the same type; tighten the producer in the same change.
- **T27** — `ReturnType<typeof Bun.serve>` is wrong in bounty and imago too;
  check `ws.data` before copying the fix.
- **T29** — a widening is honest when it equals the consumer's quoted accepted
  set and a mutation outside it still reds.

**Twice this phase an edit script's anchor-count assertion was the only thing
between a real mutation drive and a vacuous one** (3a's two-site match; 3b's
biome-reflowed function). Every drive here asserted its anchor count before
writing, and both times the assertion fired, the green that followed was
correctly discarded. That is the calibration hazard T23 named, one level down: a
mutation that did not apply reads exactly like a mutation that was survived.
