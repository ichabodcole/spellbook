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
