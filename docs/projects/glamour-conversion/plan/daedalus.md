# daedalus lane — glamour conversion: the backend half (S1 daemon side · S2 · S3)

Owner: daedalus (engine). Branch `feat/glamour-conversion`. Plan of record
[`../plan.md`](../plan.md) @ `95dc287` — build to each seam's **CORRECTION —
RATIFIED CONTRACT** block, never to the blockquoted claim above it. Rulings
honoured: `#1124` (reduce.ts SPLITS; Phase 3 DROPPED), `#1130` ruling 3 (the cwd
pin and the `bunfig.toml` move are mine; the styled-board cell is circe's).
Authored as of `#1132`; rulings R1–R5 (`#1142`) folded in as of `#1143`. Seat
doc: [`daedalus.md`](../../../../.anthill/dev/daedalus.md); contracts:
[`seams.md`](../../../../.anthill/dev/seams.md) — pointed at, not restated.

**The method is the playbook** —
[`porting-a-spell-playbook.md`](../../../playbooks/porting-a-spell-playbook.md)
— Phase 0 → 1 → 2 → prove. This lane is the glamour-specific fill for the
backend half of each phase. Where this lane and the playbook disagree, the
disagreement is a finding for thoth (S7), not something to absorb.

## Seams I consume, at their ratified grain (self-review before building)

| seam | grain I build to                                                                                                                                                                                                                                                                                                                                                                               | what I do NOT rule                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| S1   | **symbol** for `reduce.ts`: the backend half → `scripts/reduce.ts`; the surface half (the exports the surface imports — derived by command in T1.3, not quoted) stays surface-side. **module** for `types.ts` and `imageOptimize.ts` → `shared/`.                                                                                                                                              | the surface half's filename and home (circe; unruled, `#1130`)         |
| S2   | **specifier**: exactly one `src/`-naming specifier in the deployed spell, in `scripts/server.ts`, inside the `mode === "dev"` branch as a dynamic string-literal import. `resolveMode()` + `mode` emitted on **every** transport glamour has (three, see T2.2). Contract 5 cwd pin in `scripts/cli.ts` → `src/glamour/`; `bunfig.toml` leaves the deployed folder.                             | what the surface renders under either mode (circe's styled-board cell) |
| S3   | **file list**: post-port deployed folder = `SKILL.md` · `acc.config.json` · `tsconfig.json` · `scripts/{cli,server,persist.server,styles.server,imageOptimize.server,reduce}.ts` · `shared/{types,imageOptimize}.ts` · `tests/` (backend half) · `dist/`. GONE: `surface/`, `bunfig.toml`. `git ls-files` of the tracked subtree is the assertion; `.gitignore` un-ignore is the PREREQUISITE. | whether the move-vs-copy check is built here (filed, lead's call)      |

_Note on S3's list vs the plan's: the plan's list omits `acc.config.json` and
`tsconfig.json`, both tracked today and neither relocating. Named here so the
`git ls-files` assertion in T2.9 is checked against the real tree, not the
prose. Flagged to prospero as a plan correction, not silently widened._

## Integration order (matches the skeleton's: S1 → S2 → S3, S4/S5 ride with the move)

```
Phase 0  measurements            mine, read-only, before any file moves
Phase 1  the seam                ONE ATOMIC commit, BOTH seats' paths, landed by prospero (R1 #1142) — tree shippable after it
Phase 2  my half of the move     lands INSIDE circe's relocation commit (atomic land via prospero;
                                 neither half is green alone — the 1a/1c shape)
Prove    the arms the gate is blind to   mine to supply the artifact; cassandra's to run cold
```

---

## Phase 0 — measure before anything moves (no commit)

Every number below is produced by the command beside it and pasted into
`.anthill/scratch/daedalus/2026-09-03-glamour-conversion-build.md`. **No figure
is typed from memory** (seat epitaph).

### T0.1 — Census, both roots, split by erasure

```sh
ls src/glamour/backend/ 2>&1                 # expected: No such file — glamour has ONE root today
grep -rn '\.\./surface/' plugins/spellbook/skills/glamour/scripts/ src/glamour/backend/ 2>/dev/null
```

Split value vs type-only with the repo's scanner, never by eye:

```sh
bun -e '
import { scanSpecifiers } from "./grimoire/lib/import-graph.ts";
import { readFileSync } from "node:fs";
for (const f of ["plugins/spellbook/skills/glamour/scripts/server.ts","plugins/spellbook/skills/glamour/scripts/cli.ts"])
  for (const r of scanSpecifiers(readFileSync(f,"utf8")))
    if (r.spec.includes("../surface/")) console.log(f, r.line, r.kind, r.erased ? "TYPE-ONLY" : "VALUE", r.spec);
'
```

`erased` is the erasure axis (Contract 16's value / type-only split); `kind` is
the resolution-time axis and **includes** `import type` under `static` — the
scanner's own header says the two are deliberately not synonyms, and my first
draft of this snippet printed the wrong one. Measured at `c8730ec`: **6 sites, 6
static, 6 VALUE** (every statement carries at least one runtime binding). The
Phase 1 target is **exactly one line**, kind `static`, specifier
`../surface/index.html` — the deferred entry import the playbook names as Phase
1's expected end state.

### T0.2 — tsc baseline as ERROR LINES (Gotcha 5)

```sh
bunx tsc --noEmit -p . > .anthill/scratch/daedalus/tsc-baseline.txt 2>&1; echo "tsc exit=$?"
grep -c TS2307 .anthill/scratch/daedalus/tsc-baseline.txt
```

The diff after each phase is by lines (`diff` of the two files), never by count
— errors leaving and arriving cancel.

### T0.3 — resolve-sweep floor (Gotcha 9; re-measured after each phase)

`.anthill/scratch/daedalus/resolve-sweep.ts` (throwaway; scratch is outside the
gate's target set): walk `plugins/spellbook/skills/glamour` + `src/glamour`,
`scanSpecifiers` every `.ts`/`.tsx`, resolve each relative specifier against
`[".ts",".tsx",".js",".json",".css",".html","/index.ts","/index.tsx"]`, print
`file:line specifier` for every miss. The floor is **this instrument's**, on
**this tree**, **now** — not a number from the playbook or from a peer.

### T0.4 — gate baseline

**TAKEN ON REPORT from circe `#1131`, VERIFIED BY circe:**
`1568 pass / 0 fail / 4545 expect() / 119 files`, exit 0, at `95dc287`, tree
clean, unpiped. Not re-run here — a second concurrent 175 s gate on the shared
tree buys nothing and costs every peer (SOP: announce a gate start, then wait).

### T0.5 — the deps-free CLI control, re-run (the ratify's positive control)

```sh
D=$(mktemp -d /tmp/glamour-deps-free-XXXX); mkdir -p "$D/skill"
git ls-files -z plugins/spellbook/skills/glamour | xargs -0 -I{} sh -c 'mkdir -p "$D/skill/$(dirname "${1#plugins/spellbook/skills/glamour/}")" && cp "$1" "$D/skill/${1#plugins/spellbook/skills/glamour/}"' _ {}
ls "$D"/node_modules "$D"/../node_modules 2>&1 | head -2      # expected: No such file (no deps up-tree of $D)
( cd "$D/skill" && bun --no-install scripts/cli.ts --version; echo "exit=$?" )
( cd "$D/skill" && bun --no-install scripts/cli.ts bogus-verb 2>"$D/err.json" >"$D/out.txt"; echo "exit=$?"; wc -c "$D/out.txt"; jq .error.kind "$D/err.json" )
```

Expected: `--version` exit 0 JSON; bogus verb exit 2, stdout 0 bytes, kind
`usage` (Contract 15). **Positive control**, so the green can fail: delete the
CLI's one runtime dependency from the copy and re-run — pre-Phase-1 that is
`rm "$D/skill/surface/state/imageOptimize.server.ts"`, post-Phase-1 it is
`rm "$D/skill/scripts/imageOptimize.server.ts"` — expected `Cannot find module`.
The control is what makes the green mean something.

---

## Phase 1 — the seam: the daemon stops reaching into the surface (ONE ATOMIC commit)

**Ruled R1 `#1142`: one `refactor(glamour):` commit carrying BOTH seats' paths,
landed by prospero** (precedent `5d918e2`, two seat trailers). A two-step
(derive.ts first, the move after) would put the four selectors in two files
between the lands — a live instance of
`docs/backlog/2026-09-02-nothing-can-tell-a-move-from-a-copy.md`; the single
commit never enters that state. Cost: I wait on circe; taken deliberately.
Commit type per the imago precedent `3e00e73` and the `ward` skill's routing
(consumer gets a byte-different, behaviour-identical spell). My paths are
drafted in place only once circe's are ready, posted as `READY: <paths>`, and
prospero calls the land — I do not run this gate.

### T1.1 — `shared/` is born; two modules move whole (module grain)

```sh
cd plugins/spellbook/skills/glamour
mkdir -p shared
git mv surface/state/types.ts          shared/types.ts
git mv surface/state/imageOptimize.ts  shared/imageOptimize.ts
```

`types.ts` goes **whole** — the split criterion is runtime reach and types erase
(S1 correction). `imageOptimize.ts` is the third module, two-sided via
`fileIntake.ts` (browser) and `imageOptimize.server.ts` (daemon) — both VALUE
imports of `OPTIMIZE`, verified in the tree at authoring time.

### T1.2 — three `.server.ts` files go to `scripts/`

```sh
git mv surface/state/persist.server.ts        scripts/persist.server.ts
git mv surface/state/styles.server.ts         scripts/styles.server.ts
git mv surface/state/imageOptimize.server.ts  scripts/imageOptimize.server.ts
```

Their own relative imports now resolve from `scripts/` (Gotcha 2's second form —
a moved file's OWN specifiers): `./types` → `../shared/types`, `./imageOptimize`
→ `../shared/imageOptimize`. Written by the T1.4 rewrite, not by hand.

### T1.3 — `reduce.ts` SPLITS at the symbol (ruled `#1124`)

Derive the two halves by command; do not copy the plan's `22` / `4`:

```sh
# every export of the file
grep -oE '^export (function|const|type) [A-Za-z_]+' surface/state/reduce.ts | awk '{print $3}' | sort > /tmp/reduce-exports.txt
# every symbol the SURFACE imports from it (excluding the file itself)
grep -rhoE 'import \{[^}]+\} from "\.{1,2}/state/reduce"' surface --include='*.tsx' --include='*.ts' \
  | sed -E 's/import \{//; s/\} from.*//; s/type //g' | tr ',' '\n' | sed 's/ //g' | sort -u > /tmp/reduce-surface.txt
comm -23 /tmp/reduce-exports.txt /tmp/reduce-surface.txt   # -> the BACKEND half
comm -12 /tmp/reduce-exports.txt /tmp/reduce-surface.txt   # -> the SURFACE half
```

**Backend half → new file `scripts/reduce.ts`** (created by `git mv` of the
whole file, then deleting the surface-half functions — so git tracks it as the
rename; the surface half is the smaller diff). Its `./types` import becomes
`../shared/types`. `AMBIENT_CLIENT` and `isImperative` have no consumer outside
`tests/reduce.test.ts` (measured at authoring: a grep over the spell finds only
the test) and go with the backend half — they are agent-notification policy.

**Surface half → circe's `surface/state/derive.ts`** — RATIFIED at the FILE
grain, R2 `#1142` (post-Phase-2 `src/glamour/surface/state/derive.ts`; the house
idiom, `src/imago/surface/state/derive.ts` is the one existing instance). **Who
writes it:** the split is one act —
`git mv surface/state/reduce.ts scripts/reduce.ts` (the rename, mine), then the
surface-half functions are cut out of `scripts/reduce.ts` and pasted into
`surface/state/derive.ts` with `import type … from "../../shared/types"`. The
paste is circe's file; proposed on comms that I perform the mechanical
cut-and-paste inside the Phase 1 commit and she reviews the file before the land
— or she creates it from the T1.3 `comm` output. Either way the surface
importers of `./state/reduce` re-point to `./state/derive` (two files:
`App.tsx`, `components/LibraryGrid.tsx`), which is the T1.4 rewrite's job.

**Contract 13 moves with `applyAgentMsg`** (thoth's A3, `#1135`): the `/cmd`
verdict's reducer is now `scripts/reduce.ts`, not a surface file. thoth DRAFTS
the seams.md amendment; **I land or ratify it** in the Phase 1 commit, after
circe's filename is ruled. This is the first thing the port changes in canon.

**Test split (tests/ are the backend half → mine):** the cells that exercise the
surface half — `tests/reduce.test.ts` lines 84, 110, 165, 265 at authoring
(`itemsByKind` ×2, `matchesMarks`, `agentRepliedSince`) — move to a new
`tests/reduce.surface.test.ts` importing `../surface/state/derive`. That file is
**labelled in its header as relocating with the surface half in Phase 2**: once
the surface lives under `src/glamour/`, a test in `plugins/…/tests/` importing
it is a relative escape ward 1a forbids (Gotcha 6) — the test moves with its
subject, as magpie's `cli.test.ts` did. The remaining cells stay in
`tests/reduce.test.ts` importing `../scripts/reduce` and `../shared/types`.

Red → green: before touching source, run
`bun test plugins/spellbook/skills/glamour/tests/reduce.test.ts` (green, 28
cells at authoring); after the split both files green, **cell count preserved
across the two files** — `pass / fail / CELLS`, never `0 fail`.

### T1.4 — rewrite every importer by directory class, then resolve-sweep

`.anthill/scratch/daedalus/rewrite-specifiers.ts`: for each `.ts`/`.tsx` under
`plugins/spellbook/skills/glamour/` (both `scripts/`, `tests/`, and `surface/`),
for each relative specifier that resolved to a moved module's OLD path, emit
`relpath(NEW, dirname(file))` and **print the class table as output**
(`old-specifier → new-specifier · N files · depth class`). Never a blanket `sed`
— `./types` means the moved contract in `surface/state/*` and the SAME string in
a moved `.server.ts` needs a different rewrite (Gotcha 2, both forms).

⚠ **Cross-lane, said out loud:** the surface's own importers of the moved
modules (13 `import type` sites in `surface/components/*.tsx` + `App.tsx`,
`useSession.ts`, `fileIntake.ts`; and two VALUE imports — `FacetBar.tsx`
`VALID_KIND`, `LibraryGrid.tsx` `itemsByKind`/`matchesMarks`) are in circe's
files. The imago seam commit rewrote them in the same commit (specifier-only,
zero judgement). Proposed on comms: my script rewrites the whole tree, I post
the class table, **circe reviews the surface rows before the land**. If she
prefers to apply them, the script output is the spec and the commit becomes the
two-seat atomic shape.

Then, same phase: run the T0.3 sweep. Compare against the Phase-0 floor. Every
new entry is either a defect or a comment I just wrote (Gotcha 9); name which.

### T1.5 — `server.ts` and `cli.ts` re-specify (my files)

`scripts/server.ts` lines 6–36 at authoring:

```ts
import { loadSnapshot, materializeItem, saveSnapshot } from "./persist.server";
import {} from /* backend half */ "./reduce";
import {
  loadTray,
  materializeCanon,
  projectKey,
  saveStyle,
  setStyleArchived,
} from "./styles.server";
import {
  type AgentCommand,
  type ClientToServer,
  defaultState,
  type GlamourState,
} from "../shared/types";
```

`import index from "../surface/index.html"` (line 5) **stays** — Phase 1's
expected end state, made dynamic only in Phase 2 when `resolveMode()` has a
`dist/` to read.

`scripts/cli.ts` line 37: `"../surface/state/imageOptimize.server"` →
`"./imageOptimize.server"`.

### T1.6 — tests re-point (backend half, mine)

| file                                        | old                                                        | new                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/persist.test.ts`                     | `../surface/state/persist.server`, `…/reduce`, `…/types`   | `../scripts/persist.server`, `../scripts/reduce`, `../shared/types`                                                                                                                                                                                                                                                                                                       |
| `tests/styles.test.ts`                      | `../surface/state/styles.server`                           | `../scripts/styles.server`                                                                                                                                                                                                                                                                                                                                                |
| `tests/imageOptimize.test.ts`               | `../surface/state/imageOptimize`, `…/imageOptimize.server` | `../shared/imageOptimize`, `../scripts/imageOptimize.server`                                                                                                                                                                                                                                                                                                              |
| `tests/types.test.ts`                       | `../surface/state/types`                                   | `../shared/types`                                                                                                                                                                                                                                                                                                                                                         |
| `tests/reduce.test.ts`                      | `../surface/state/reduce`, `…/types`                       | `../scripts/reduce`, `../shared/types` (+ T1.3 split)                                                                                                                                                                                                                                                                                                                     |
| `tests/daemon.integration.test.ts`          | `../scripts/server`                                        | import unchanged; **+1 line** (cassandra `#1166`/`#1167`, prospero `#1168`): `process.env.TMPDIR = mkdtempSync(join(tmpdir(), "glamour-tmp-"))` beside the `GLAMOUR_HOME` line — measured: the suite as-is DELETES a live user's `glamour-latest.json` at 16/0 green (claim at boot, own-id unlink at close). Fixture-side only; the spell-side pointer move stays filed. |
| `tests/cli.test.ts`, `cli-contract.test.ts` | `../scripts/cli`                                           | unchanged                                                                                                                                                                                                                                                                                                                                                                 |

All written by the T1.4 script; the table is what I check its output against.

### T1.7 — the ward pins this phase moves (expected reds, re-declared by hand)

- `grimoire/import-boundary-wards.test.ts:1089` pins `glamour/scripts/server.ts`
  **line 77** by number (the `import("bun")` type query). The import block at
  the top shrinks, so the pin reds — **the pin doing its job** (Gotcha 10).
  Re-pin by hand to the measured new line; the commit body says the move is
  bookkeeping. thoth's file; announced, not silent.
- `grimoire/gate-honesty.test.ts` `DECLARED_BLIND` rows for glamour
  (`surface/index.html`, `surface/styles.css`, `bunfig.toml`) do **not** move in
  Phase 1 — those files stay put until Phase 2.
- `grimoire/import-boundary-wards.test.ts:~668` lists glamour's `server.ts` as
  one of five files reddening without the `bun` exemption — path unchanged, no
  re-pin.
- Ward 1b population: `shared/` is on the shipped execution path by
  `/\/(scripts|shared)\//` (line ~496) — the new files enter its population
  automatically. Report `files / bare specifiers / violations` before and after;
  expect the specifier count to grow by zero non-builtins (the whole point).

### T1.8 — Phase 1 verification (all four instruments; the gate is one)

```sh
# census: both roots, expect exactly ONE line (the entry import)
grep -rn '\.\./surface/' plugins/spellbook/skills/glamour/scripts/ src/glamour/backend/ 2>/dev/null
# class (b): Bun.build on the surface entry — CALIBRATE FIRST by re-breaking one specifier and watching it fail by name
bun build plugins/spellbook/skills/glamour/surface/index.html --outdir "$(mktemp -d)" ; echo "build exit=$?"
# class (c): tsc by LINES
bunx tsc --noEmit -p . > .anthill/scratch/daedalus/tsc-phase1.txt 2>&1; diff .anthill/scratch/daedalus/tsc-baseline.txt .anthill/scratch/daedalus/tsc-phase1.txt
# class (a) + everything else: the gate, UNPIPED, exit read from the file
bun run gate > .anthill/scratch/daedalus/gate-phase1.log 2>&1; echo "gate exit=$?" >> .anthill/scratch/daedalus/gate-phase1.log
# acc criterion 2 — from the spell dir; exit 9 is NOT CONFORMANT, anything else non-zero is the kit
( cd plugins/spellbook/skills/glamour && bunx acc check scripts/cli.ts --config-dir . ; echo "acc exit=$?" )
# T0.5 again, now with the positive control at scripts/imageOptimize.server.ts
```

Done-when: census = 1 · surface build exit 0 · tsc line-diff empty (or every
delta named) · gate green with `pass / fail / CELLS` quoted from the log · acc
exit 0 at `0.1.11` · deps-free CLI control green **and** its control red.

---

## Phase 1.5 — S3 clause 1, mechanised (ask 1, ruled `#1145`; lands on its own, before Phase 2)

**Ruled by prospero `#1145`:** one **tree-only** cell in
`grimoire/dist-roster-ward.test.ts` asserting S3 clause 1 over every spell in
`roster()` — no tracked path under `<spell>/surface/`, no tracked
`<spell>/bunfig.toml`. **I author; cassandra calibrates as the non-author and
names the mutation she ran** (H16 with a real card). Built for the four spells
already shipped, which have never had this asserted; it turns on for glamour the
day `src/glamour/surface/index.html` puts it in the roster.

- `scripts/dist-check.ts` gains `trackedFiles(...pathspecs)` (generic index
  read, so a control can point it at a known-tracked path) and
  `trackedBuildInputs(spell)` (`<spell>/surface` + `<spell>/bunfig.toml`,
  tracked, **named per path** — the remedy is `git rm` of exactly those).
- The cell: `rows.flatMap((r) => trackedBuildInputs(r.spell))` deep-equals `[]`.
- Positive control — **routed THROUGH the predicate** (cassandra's R4 bounce,
  `#1160`; prospero `#1165`): the first draft asserted `<spell>/scripts` was
  tracked, which proves `git ls-files` works and nothing about the pathspecs;
  with both pathspecs typo'd and a real leak planted it stayed `5 / 0`. Now
  `trackedFiles`/`trackedBuildInputs` take an optional `root`, and the control
  mints a throwaway git repo (`probe/surface/state/x.tsx` + `probe/bunfig.toml`
  staged; `probe-clean/scripts/cli.ts` beside it) and asserts
  `trackedBuildInputs("probe", root)` returns **exactly** those two paths and
  the clean sibling returns `[]`. Not keyed on glamour's own `surface/` — the
  port drains that, and a control the roadmap drains goes vacuous in silence
  (Contract 19's shape, applied to a control).
- Author-side mutations, worktree, **not evidence**: C `5 / 0 / 9`; R4 (typo'd
  pathspecs + planted leak) `4 / 1` — the **control** reds by name; R1 (leak,
  pathspecs correct) `4 / 1` — the **clause-1 cell** reds by name; unstaged
  plant `5 / 0` (the cell reads the index, which is what ships).
- Commit type `test(grimoire):`; no CI ARM added to `dist-check`'s `main()` —
  one cell was the ruling, an ARM is a follow-up if wanted.

## Phase 2 — my half of the relocation (inside the atomic land)

**Ruled `#1158`: Phase 2 is ONE atomic commit** — `src/glamour/surface/` arrives
and `plugins/…/glamour/surface/` + `bunfig.toml` leave in the same commit. **The
Phase 1.5 cell is the mechanical trigger:** glamour joins `roster()` the moment
`src/glamour/surface/index.html` exists, so a two-commit Phase 2 reds the
clause-1 cell at its first commit. Its inverse is the failure to watch for:
until the successor arrives, glamour's 25 tracked `surface/` paths are **not
accused** — the cell is green on glamour today for a reason that has nothing to
do with glamour being clean.

circe moves `surface/` → `src/glamour/surface/` and builds. **Nothing below is
green until her half lands and nothing of hers boots until mine does**, so these
paths go to prospero as `READY: <paths>` for one land, drafted in scratch until
then. Rebuilt `dist/` is staged in the same commit (Contract 18; Gotcha 4:
`git ls-files` reads the index).

### T2.1 — `server.ts`: `resolveMode()` and release serving (Contract 1, S2)

Copy imago's **substance** (`plugins/spellbook/skills/imago/scripts/server.ts`
lines ~55–100 and ~1335–1360, ~1444 at authoring), not its location:

- `const SKILL_ROOT = join(SCRIPT_DIR, "..")`,
  `DIST_DIR = join(SKILL_ROOT, "dist")` — anchored at the skill root, never cwd
  (Contract 5 pins cwd elsewhere). glamour's `server.ts` has no `SCRIPT_DIR`
  today; add `dirname(fileURLToPath(import.meta.url))`.
- `resolveMode()`: env override `SPELLBOOK_SURFACE_MODE=dev|release`, else
  **`existsSync(join(DIST_DIR, "index.html"))`** — the FILE, never the dir.
- `STATIC_CONTENT_TYPES` + `serveDist(path)` with the bare-filename guard
  (`rel.includes("..") || rel.includes("/")` → null).
- Inside `startDaemon`, before `Bun.serve`:
  ```ts
  const mode = resolveMode();
  const devIndex =
    mode === "dev"
      ? (await import("../../../../../src/glamour/surface/index.html")).default
      : undefined;
  const routes = (devIndex ? { "/": devIndex } : {}) as Record<string, never>;
  // Bun.serve({ …, routes, development: { hmr: mode === "dev" }, … })
  ```
  The specifier is computed once, written once, and **checked by
  `existsSync(fileURLToPath(new URL("../../../../../src/glamour/surface/index.html", import.meta.url)))`
  in a test cell** rather than by counting `../` (Gotcha 2).
- In `fetch`, AFTER the existing `/assets/` handler and BEFORE the final 404:
  `if (mode === "release") { const a = serveDist(path); if (a) return a; }`.
  glamour has the same `/assets/<name>` session-files route imago has, so
  imago's "disjoint by the nesting guard" property holds here for the same
  reason — cassandra's cell, my mechanism.
- **Delete** the top-level `import index from "../surface/index.html"`. ⚠ Do NOT
  quote the removed import in a comment (Gotcha 7/9: a text-scanning sweep reads
  the quotation and the floor rises by one, and the new entry is my own
  paragraph). Describe it without spelling it.

### T2.2 — `mode` on EVERY transport glamour has — there are THREE, not two

S2's correction says "both transports (ready event and discovery JSON, as imago
does)". glamour differs from imago: **it also prints a stdout handshake** at
`import.meta.main` (`{url, port, session_id}`), which `cli.ts open` parses and
prints verbatim. So:

1. `emitEvent({ type: "ready", mode })` — the ready event (Contract 1's named
   transport; cassandra's gate reads it off `/events?since=0`).
2. the discovery `info` JSON (`$TMPDIR/glamour-<id>.json` +
   `glamour-latest.json`) gains `mode`.
3. the stdout handshake gains `mode`; `startDaemon` returns `mode` so
   `import.meta.main` can print it. `cli.ts open` then surfaces it for free
   (`printJson(parsed)`); `cli.ts info` reads the discovery file and surfaces it
   too. **This is an additive field on `open`/`info` output — named in the
   commit and to acc's criterion 2 as "what the port changed", if acc notices.**

Test (mine, `tests/daemon.integration.test.ts`, appended AFTER the
state-sensitive cells — the shared-daemon rig is order-coupled): the `ready`
frame at `/events?since=0` carries `mode` ∈ {`dev`,`release`}, and it equals the
value in the discovery file for the same session. Named
`mode rides the ready event AND the discovery file` — it is red pre-change (no
`mode` field), so it is a RED-PRE-FIX cell, not a guard.

### T2.3 — `cli.ts`: the Contract 5 cwd pin (ruled mine, `#1130`)

`scripts/cli.ts` lines 39–41 at authoring (`SCRIPT_DIR`, `SERVER_SCRIPT`,
`SKILL_ROOT`) gain:

```ts
const DIST_DIR = join(SKILL_ROOT, "dist");
// Contract 5: in dev the daemon's cwd MUST be src/glamour/ (bunfig.toml lives there
// now); in release dist/ is static and src/ need not exist (a marketplace clone has none).
const SURFACE_CWD = join(
  SCRIPT_DIR,
  "..",
  "..",
  "..",
  "..",
  "..",
  "src",
  "glamour"
);
function daemonCwd(): string {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release") return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev") return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
```

and `cmdOpen`'s `spawn(…, { cwd: SKILL_ROOT, … })` → `cwd: daemonCwd()`. The
comment at lines 465–466 is rewritten to name the two cwds and why. `existsSync`
joins the `node:fs` import.

Test (mine, `tests/cli.test.ts`): `daemonCwd()` is exported for the test;
`SPELLBOOK_SURFACE_MODE=dev` → `existsSync(daemonCwd())` is true and
`basename(daemonCwd()) === "glamour"` with `basename(dirname(…)) === "src"`;
`=release` → equals `SKILL_ROOT`. The first cell is what turns "I counted five
`..`" into an assertion that runs in-repo. **The failure it guards is circe's
cell** (an unstyled board reds on her side); this cell proves only that the pin
points where Contract 5 says.

### T2.4 — `bunfig.toml` leaves the deployed folder (ruled mine, `#1130`)

```sh
git mv plugins/spellbook/skills/glamour/bunfig.toml src/glamour/bunfig.toml
```

Content is byte-identical to `src/imago/bunfig.toml`
(`[serve.static] plugins = ["bun-plugin-tailwind"]`) — verified at authoring by
reading both.

`grimoire/gate-honesty.test.ts` `DECLARED_BLIND`: **prospero's hand writes the
re-declaration (R3 `#1142`); I name my row on the wire in my own words and he
transcribes it verbatim.** My row:
`"plugins/spellbook/skills/glamour/bunfig.toml": 2` →
`"src/glamour/bunfig.toml": 2` — the file is 2 lines (`wc -l`), byte-identical
content, same blind line count at the new path. circe names `index.html` (13)
and `styles.css` (12). Re-declared by hand, never regenerated.

### T2.5 — `.gitignore`: the un-ignore lines are the PREREQUISITE (S3)

```
!plugins/spellbook/skills/glamour/dist
!plugins/spellbook/skills/glamour/dist/**
```

appended beside the magpie pair (`.gitignore` lines 18–19 at authoring). Without
them `git add` stages nothing at exit 0 and glamour ships with no `dist/`
(Contract 18 corollary 3). **prospero writes them (R3 `#1142`; his file by
Contract 4) — a PREREQUISITE of the arm, not a consequence.** In the atomic
land. My T2.9 assertion is what tells us they landed.

### T2.6 — build, stage, count five

`src/glamour/build.ts` is the 12-line delegator (`src/imago/build.ts` is the
template — `buildSpell("glamour")`). It is Contract 2's artifact (circe);
offered on comms that I write it if she prefers, since it is content-free.

```sh
bun run build glamour                                   # src/build.ts main([spell])
git add plugins/spellbook/skills/glamour/dist          # Gotcha 4: ls-files wards read the INDEX
bun scripts/dist-check.ts; echo "dist-check exit=$?"   # expect: 5 buildable spells, ARM 0/1 green; exit 3 = NO VERDICT
```

Reproducibility, without committing (Contract 18): build twice and compare tree
shas via a throwaway index —
`GIT_INDEX_FILE=/tmp/idx git read-tree HEAD && GIT_INDEX_FILE=/tmp/idx git add -A plugins/spellbook/skills/glamour/dist && GIT_INDEX_FILE=/tmp/idx git write-tree`
before and after the second build; equal shas or the artifact is not
reproducible and the port says so.

### T2.7 — what this phase makes cassandra's forced-dev cell able to convict

`tests/release-serve.test.ts` (S4's real deliverable — **circe authors it** per
`#1128`/`#1141`, **cassandra calibrates it non-author**, six arms) spawns
`scripts/server.ts --port 0` from a copied tree with `dist/` and no `surface/`,
and reads `mode` off the **stdout handshake** (glamour prints one, unlike
imago). The forced-dev cell needs, from my side:

- under `SPELLBOOK_SURFACE_MODE=dev`, the daemon dies **at the `await import`**
  with a message naming `src/glamour/surface/index.html` (a dynamic import of a
  missing path throws with the specifier in it — measured at ratify, four arms);
- it dies **before** the discovery file is written (the `await` precedes
  `Bun.serve`, which precedes `writeFileSync(sessionFile, …)` — true by
  ordering; her cell asserts the file's absence);
- **non-zero exit** — the throw escapes `startDaemon` into `import.meta.main`'s
  top-level `await`, which Bun reports as exit 1. Verified by drive, not read.

The cell I do NOT write is circe's; the calibration is cassandra's (she will
move the discovery write above the import in a worktree and expect exactly the
file-absent assertion to red); the mechanism it convicts is mine, and I
mutation-check it once (hoist the import out of the ternary → forced-dev stops
dying → her cell reds) in a **detached worktree**, never the shared checkout
(seat doc: the shared tree must never go deliberately red).

### T2.8 — the ward pins this phase moves

- `gate-honesty` `DECLARED_BLIND`: three glamour rows re-pathed (T2.4).
- `import-boundary-wards.test.ts:1089`-family line pin on `server.ts` moves
  again (imports change at the top). Re-pin by hand, say so.
- `import-boundary-wards` ward 1a pinned inventory gains **one** dynamic escape:
  `glamour/scripts/server.ts` → `../../../../../src/glamour/surface/index.html`,
  beside astrolabe's, imago's, mind-mapper's and magpie's entries. **My hand
  (ask 6, `#1165`), and it carries a CHECK BY HAND:** the ward compares strings
  and calls no `existsSync`, so a broken spec launders straight into the pin
  (cassandra measured it at ratify). Before pinning I run
  `existsSync(resolve(dirname(server.ts), spec))` and the land message says
  "pinned, resolved path exists, checked" — never "pinned". Declared with the
  file/spec/resolved triple.
- `grimoire/spell-css-scope-ward.test.ts` **REDS ON ARRIVAL AND BLAMES
  ASTROLABE** — glamour's `2xl:` escapes to `\32 ` and the ward's regex invents
  a phantom class `32`. **Ward defect, not glamour's**:
  `docs/backlog/2026-09-02-css-scope-ward-invents-a-phantom-class-from-escapes.md`.
  I do not touch astrolabe and I do not touch the ward; it goes to prospero as
  the named red, and the land waits on his ruling (thoth's ward).
- `grimoire/dist-roster-ward.test.ts` ARMs 0/1 now count glamour: needs the
  `.gitignore` lines and the staged `dist/` or it reds naming exactly the two
  lines to add — which is the test working.
- `exit-site-inventory`, `flag-invariant`, `terminator-invariant`,
  `strict-parse-invariant`: `scripts/cli.ts` and `scripts/server.ts` do not
  move; `server.ts`'s `process.exit(res.code)` pin (E-terminal) stays. Expect
  zero movement; **report the population, not the colour**.

### T2.9 — Phase 2 verification (mine to run; cassandra runs it cold too)

```sh
# S3 by the file list, over the TRACKED subtree — the third clause the plan did not have
git ls-files plugins/spellbook/skills/glamour | grep -E '^plugins/spellbook/skills/glamour/(surface/|bunfig\.toml$)'   # expect: NO output
git ls-files plugins/spellbook/skills/glamour | grep -c '/dist/'                                                        # expect: > 0
# S2 by the specifier: exactly one src/-naming specifier in the deployed spell
grep -rn 'src/glamour' plugins/spellbook/skills/glamour/scripts/ plugins/spellbook/skills/glamour/shared/               # expect: ONE line, server.ts, inside the dev ternary
# mode on all three transports, in-repo (dist present => release)
bun plugins/spellbook/skills/glamour/scripts/cli.ts open --no-open | jq .mode                                            # "release"
bun plugins/spellbook/skills/glamour/scripts/cli.ts info | jq .mode                                                      # "release"
curl -sN "$(jq -r .url /tmp/glamour-latest.json)/events?since=0" | head -1                                              # data: {"type":"ready",…,"mode":"release"}
bun plugins/spellbook/skills/glamour/scripts/cli.ts close
# the forced-dev CONTROL over the same in-repo tree: dev boots here because src/glamour/ exists — that is the positive arm
SPELLBOOK_SURFACE_MODE=dev bun plugins/spellbook/skills/glamour/scripts/cli.ts open --no-open | jq .mode               # "dev"; then close
# acc criterion 2, from the spell dir, kit 0.1.11
( cd plugins/spellbook/skills/glamour && bunx acc --version | jq -r .data.version && bunx acc check scripts/cli.ts --config-dir . ; echo "acc exit=$?" )
# the gate, unpiped, exit from the file
bun run gate > .anthill/scratch/daedalus/gate-phase2.log 2>&1; echo "gate exit=$?" >> .anthill/scratch/daedalus/gate-phase2.log
bun scripts/dist-check.ts; echo "dist-check exit=$?"
```

Then the **local-sim** (cassandra's lane, my artifact): copy the tracked subtree
to a path with no `node_modules` up-tree,
`bun --no-install scripts/server.ts --port 0` → handshake `mode:"release"`, `/`
serves `dist/index.html`, `/state` 200; and `SPELLBOOK_SURFACE_MODE=dev` there →
dies naming `src/glamour/surface/index.html`, no discovery file. Written into
the commit message because nothing automates it.

---

## Absent from this lane (asserted, so nobody hunts a mirror)

- **Phase 3 — no backend build.** Trigger is `printJson` convergence; owner is
  whoever rules it. glamour keeps its local `printJson`. If I find myself
  needing `src/kit/` from the backend, that is a finding to prospero, not a
  build.
- **No new npm dependency** (ward 1b's specifier count must not grow by a
  non-builtin). **No kit extraction. No surface rewrite. No release.**
- **No move-vs-copy check, no ward 1a `existsSync` guard, no Bun-pin work** —
  filed at ratify; if one blocks me I say so and prospero rules.
- **No fix to the css-scope ward and no edit to astrolabe** when it reds.
- **No `release-serve.test.ts` authored by me** — circe authors, cassandra
  calibrates (`#1141`); I supply the daemon it convicts.
- **No ruling on the surface half's filename/home** — circe proposes, prospero
  ratifies.

## Cross-lane asks (posted on comms with this lane)

1. **circe** — Phase 1's surface-side specifier rewrite: my script over the
   whole tree + class table posted; you review the surface rows pre-land, or
   apply them yourself from the table. The `derive.ts` cut-and-paste: I do the
   mechanical cut inside the Phase 1 commit and you review the file, or you
   create it from the `comm` output — say which. Also: the 4 selector cells
   carved to `tests/reduce.surface.test.ts` (importing `derive.ts`), relocating
   with your half in Phase 2.
2. **circe** — `src/glamour/build.ts` delegator: yours by Contract 2; I write it
   if you would rather (12 lines, content-free).
3. **prospero** — RULED R3 `#1142`: his hand writes both; I name the bunfig
   `DECLARED_BLIND` row on the wire (`"src/glamour/bunfig.toml": 2`).
4. **prospero** — ACCEPTED R4 `#1142`: S3's post-port file list omits
   `acc.config.json` and `tsconfig.json`; both stay. He fixes the plan's list
   when he next touches it.
5. **circe / cassandra** — the forced-dev cell reads `mode` off glamour's
   **stdout handshake** (glamour prints one; imago does not) as well as the
   ready event and the discovery file. Three transports, three reads, one value.
   Taken by cassandra `#1141`; circe authors the cell.
