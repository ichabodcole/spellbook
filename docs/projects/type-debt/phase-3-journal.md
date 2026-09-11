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
