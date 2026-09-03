# circe — lane: the surface half of the glamour port

**Owner:** circe (surface) · **Authored:** 2026-09-03 against
[`../plan.md`](../plan.md) @ `95dc287`, read as of comms **#1132** · **Builds
against:** S1 (surface side, symbol grain for `reduce.ts`, module grain for
`types.ts` / `imageOptimize.ts`), S4 (the surface-half subjects only — the
`release-serve.test.ts` is authored here and calibrated by cassandra), S5 (both
halves), and prospero's **ruling 3** (#1130): daedalus builds the cwd pin +
moves `bunfig.toml`; I own the cell that reds when the board comes out unstyled.

Seat doc: [`.anthill/dev/circe.md`](../../../../.anthill/dev/circe.md).
Contracts: [`seams.md`](../../../../.anthill/dev/seams.md) 1, 2, 4, 5, 16, 18,
20, 21. Neither is restated here.

## What this lane does NOT own (so nobody hunts a mirror)

- `scripts/reduce.ts` (the backend half — 21 exports by daedalus's T1.3
  derivation at `c8730ec`, not the plan's 22), the three `.server.ts` moves,
  `resolveMode()`, mode on both transports, the dev-only dynamic import, the
  `cli.ts:465–468` cwd pin (`SKILL_ROOT`, declared `:41` — the plan's `:372` is
  a `buildGenMetaCmd` line), the `bunfig.toml` move, the `.gitignore` un-ignore
  lines — **daedalus**, S1 daemon side / S2 / S3.
- The **calibration** of every cell this lane ships (`release-serve.test.ts` T7,
  `derive.test.ts` T1, the dev-styled cell T5, the ward fix T4) — **cassandra**,
  as the non-author: she authors no shipped cell (#1138) and runs the mutation
  arms she named (M1–M6 for T7). _Corrected from this lane's first draft, which
  handed her the authoring; her lane and the slices table read the other way,
  and hers is the reading that fits._
- Canon and the playbook — **thoth**.
- No kit adoption. glamour does **not** import `src/kit/theme/base.css` in this
  port: "no kit extraction" is ruled, and adoption is a design change with the
  same shape (a token layer arriving under a self-contained surface). glamour
  stays self-contained; if that is wrong it is a finding, not a lane task.

## The surface as it stands (measured at `95dc287`, working tree clean)

`plugins/spellbook/skills/glamour/surface/` — **25** tracked files
(`git ls-files` and `find` agree; cassandra's S3 pre-fix arm says the same).
_The first draft said 23 — I counted the state directory from memory and got it
wrong by two. Verified, not recalled._ Internal edges that cross a module this
port moves:

| importer                                                                                                                    | specifier         | symbol grain                                               | after Phase 1                |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------- | ---------------------------- |
| `App.tsx`                                                                                                                   | `./state/reduce`  | `agentRepliedSince` (value)                                | `./state/derive`             |
| `components/LibraryGrid.tsx`                                                                                                | `../state/reduce` | `itemsByKind`, `matchesMarks` (value), `MarkFilter` (type) | `../state/derive`            |
| `App.tsx`                                                                                                                   | `./state/types`   | type                                                       | `../shared/types`            |
| `state/useSession.ts`, `state/fileIntake.ts`                                                                                | `./types`         | type                                                       | `../../shared/types`         |
| `components/{LibraryTile,DetailsFlyout,StylesTray,LibraryGrid,StyleGuide,MessageBubble,Conversation,FocusBar,Lightbox}.tsx` | `../state/types`  | type                                                       | `../../shared/types`         |
| `components/FacetBar.tsx`                                                                                                   | `../state/types`  | type **and** `VALID_KIND` (value)                          | `../../shared/types`         |
| `state/fileIntake.ts`                                                                                                       | `./imageOptimize` | `OPTIMIZE` (value)                                         | `../../shared/imageOptimize` |

Two value edges into `shared/` survive the port (`VALID_KIND`, `OPTIMIZE`). They
are the bundler's problem in Phase 2 (a value specifier must resolve or
`bun run build` dies — the class (b) instrument from the imago port), and the
type edges are `tsc`'s problem alone (invisible to build, check and test). Both
instruments run in T3.

The three `.server.ts` files and the 21 backend exports leave `surface/state/`
under daedalus's lane. **After Phase 1 `surface/state/` holds exactly:
`derive.ts`, `derive.test.ts`, `fileIntake.ts`, `useSession.ts`.** That list is
the surface-side done-when for the seam, keyed on the successor.

## Tasks

### T0 — Baselines, before any specifier moves (no code)

All three are re-run at the end of T3; the value is the diff, not the number.

```sh
# 1. tsc error TUPLES for glamour's tree — line set, not count (seat doc: SK3 P6)
bunx tsc --noEmit -p plugins/spellbook/skills/glamour/tsconfig.json 2>&1 \
  | grep -E "^plugins/spellbook/skills/glamour" | sort > .anthill/scratch/circe/tsc-before.txt
wc -l .anthill/scratch/circe/tsc-before.txt
# 2. resolve-sweep floor over glamour (my instrument, this checkout, before anything moves)
bun .anthill/scratch/circe/resolve-sweep.ts plugins/spellbook/skills/glamour > .anthill/scratch/circe/sweep-before.txt
# 3. gate-honesty's three glamour rows: index.html 13 · styles.css 12 · bunfig.toml 2 (grimoire/gate-honesty.test.ts:172-179)
```

Suite baseline is the session's: **1568 pass / 0 fail / 119 files** at `95dc287`
(#1131, #1132). The ratify-session 1539 is a pre-acc tree; not used.

### T1 — Phase 1, S1 surface half: the four selectors get their own module

**`surface/state/derive.ts` — RATIFIED at the file grain (prospero R2, #1142):**
name, path, and exactly the four exports daedalus measured. It is the house
idiom (imago's `src/imago/surface/state/derive.ts` is the one instance;
`selectors.ts` has zero anywhere), not a minted name.

**Ordering — RULED R1 (#1142), reversing this lane's first draft:** Phase 1 is
**ONE atomic `refactor(glamour)` commit carrying both seats' paths**, landed by
prospero. My draft's two-step (derive.ts first, his move after) would have put
the four selectors in **two files between the lands** — a live instance of
`docs/backlog/2026-09-02-nothing-can-tell-a-move-from-a-copy.md`, the defect
this project filed. Withdrawn. T1 and T2 below are my **staged paths into that
one commit**, not lands of their own; the per-task `bun test` runs are how I
prove my half before staging.

**Who moves the bytes (daedalus's asks 1 and 2, mine to answer):** I do, for
everything under `surface/`. The `derive.ts` cut is not a cut-and-paste — the
four cells drop their `makeItem` fixture dependency in the same edit, which a
mechanical move would carry across — so I write `derive.ts`, `derive.test.ts`,
and the two consumer re-points. For the 13 `shared/` importer rewrites (T2) he
runs his script over the whole tree and posts the class table; I apply the
surface rows and diff them against my own expectation before staging. A row we
disagree on is the finding. He deletes the four from `scripts/reduce.ts` in his
half.

1. **Red:** create `surface/state/derive.test.ts` by moving these four cells out
   of `tests/reduce.test.ts` verbatim —
   `itemsByKind filters and excludes archived` (l.84),
   `matchesMarks unions active marks; all pass when none active` (l.110),
   `itemsByKind still excludes archived items by default` (l.165),
   `agentRepliedSince is true once an agent message lands after the timestamp`
   (l.265) — importing from `./derive`. They need `makeItem` (backend,
   `scripts/reduce.ts` after his move) to build fixtures: **replace `makeItem`
   with an inline literal fixture** in the moved cells so the surface test never
   imports the backend. Run:
   `bun test plugins/spellbook/skills/glamour/surface/state/derive.test.ts` →
   **4 fail** (module not found).
2. **Green:** create `surface/state/derive.ts` — the four exports cut from
   `reduce.ts` lines 189–201 and 227–229 plus
   `import type { ItemKind, LibraryItem, Message } from "./types"`. Re-point
   `App.tsx:25` and `LibraryGrid.tsx:2`. Run again → **4 pass**. Then
   `bun test plugins/spellbook/skills/glamour` → 1568 − 4 + 4, same total, the
   four now under a different file (print both file lists; a moved cell that
   leaves the discovered tree fails silently upward).
3. **Done-when (successor-keyed):**
   `grep -rn "state/reduce" plugins/spellbook/skills/glamour/surface` → 0 lines,
   **and** `grep -c "^export" surface/state/derive.ts` → 4 (5 with the type).
   The first alone is tautological once his move lands; the second is what makes
   it a claim.
4. **Stage, do not land:** my paths for the Phase 1 commit are
   `surface/state/derive.ts`, `surface/state/derive.test.ts`, `surface/App.tsx`,
   `surface/components/LibraryGrid.tsx`, and the four-cell removal from
   `tests/reduce.test.ts` (its import-path rewrite in the same file is his; one
   file, two seats — announce the hold and keep it short, per the SOP's
   shared-file clause). Post `READY: <paths>`; prospero calls the land.

### T2 — Phase 1, S1 surface half: consumers of `types.ts` and `imageOptimize.ts` follow them to `shared/`

Same Phase 1 commit as T1 (R1). daedalus stages the mv + backend + `tests/`
rewrites; I stage the 13 surface rewrites; one gate run over the assembled tree;
one commit landed by prospero.

1. Rewrite by **computed relpath, never by string** — the same string `./types`
   names `state/types.ts` from `state/` and would name a different module from
   anywhere else (imago's `tools/types.ts` trap). Script, output is the
   depth-class table:
   ```ts
   // .anthill/scratch/circe/repoint.ts — run from repo root
   import { readdirSync, readFileSync, writeFileSync } from "node:fs";
   import { dirname, join, relative } from "node:path";
   const S = "plugins/spellbook/skills/glamour/surface";
   const T: Record<string, string> = {
     "state/types": "plugins/spellbook/skills/glamour/shared/types",
     "state/imageOptimize":
       "plugins/spellbook/skills/glamour/shared/imageOptimize",
   };
   const walk = (d: string): string[] =>
     readdirSync(d, { withFileTypes: true }).flatMap((e) =>
       e.isDirectory()
         ? walk(join(d, e.name))
         : /\.tsx?$/.test(e.name)
           ? [join(d, e.name)]
           : []
     );
   for (const f of walk(S)) {
     let src = readFileSync(f, "utf8");
     const before = src;
     src = src.replace(/from "((?:\.\.?\/)+[^"]+)"/g, (m, spec) => {
       const abs = join(dirname(f), spec);
       const key = relative(S, abs);
       if (!(key in T)) return m;
       let r = relative(dirname(f), T[key]);
       if (!r.startsWith(".")) r = `./${r}`;
       console.log(`${f}  ${spec}  ->  ${r}`);
       return `from "${r}"`;
     });
     if (src !== before) writeFileSync(f, src);
   }
   ```
   Expected table: 1 file at `../shared/*`, 12 at `../../shared/*` (10
   components + 2 state) — **13 rows, and only if the script runs over the
   ASSEMBLED tree, after daedalus's `git mv` of `reduce.ts` and the three
   `.server.ts` files out of `surface/state/`.** Run over today's tree it
   rewrites those four too (they import `./types` / `./imageOptimize`) and
   prints 17; the extra four are his files at his destinations, and a 17 here
   means the assembly order is wrong, not the script. A row that disagrees is
   the brief being wrong, not the script.
2. `bunx biome check --write plugins/spellbook/skills/glamour/surface` **then**
   re-run the sweep and `tsc` (formatter after, instruments after the
   formatter).
3. **Done-when:** `grep -rn "state/types\|state/imageOptimize" surface/` → 0;
   `grep -rln "shared/types" surface/ | wc -l` → 12 and `shared/imageOptimize` →
   1; `tsc` line set == `tsc-before.txt` after normalising the moved paths (T0).
   Then daedalus's `tests/` half and the gate close the atomic land.

### T3 — Phase 2: the surface relocates to `src/glamour/` and builds

**Hard prerequisites from other lanes, and the mv cannot precede them:**
daedalus's `resolveMode()` + dev-only dynamic import + cwd pin (S2) and
prospero's two `.gitignore` lines (S3). `server.ts:5` is a **static**
`import index from "../surface/index.html"` — the moment `surface/` moves it
dangles and the daemon dies at load (S2's own measurement). So Phase 2 is **one
commit too**: his S2 and my mv assemble together, the gate runs over the whole,
prospero lands. _(The first draft said the mv could go first "because the static
import survives Phase 1"; the playbook line it quoted is about Phase 1 and says
nothing about surviving Phase 2. Cold read caught it.)_

**Wards that begin asserting over glamour the moment `src/glamour/surface/`
exists** (population derived from `src/`), so their reds are expected and owned,
not discovered: `spell-css-scope-ward` (T4, plus its DISCRIMINATION cell — a
fifth spell adds 8 ordered pairs that can red independently of the phantom);
`kit-adoption-ward` and `kit-styling-ward` (glamour imports no kit module and no
kit sheet, so both take the green branch — the `KIT_CONSUMERS` equality stays at
its current set); `dist-roster-ward` (red until the un-ignore lines + staged
`dist/`); `gate-honesty` (step 6). And `import-boundary-wards.test.ts:288`
**pins the exact list of dynamic `src/` escapes and asserts equality at `:408`**
— daedalus's dev branch is a fifth entry and reds the gate until re-pinned; site
is his, file is grimoire's, named as ask 6.

1. `git mv plugins/spellbook/skills/glamour/surface src/glamour/surface`. Add
   `src/glamour/build.ts` — the delegator, byte-identical in shape to
   `src/imago/build.ts`. (`bunfig.toml` → `src/glamour/bunfig.toml` is
   daedalus's, ruling 3; if he wants it in my mv for atomicity I take it into my
   pathspec and say so.)
2. Re-point the 13 `shared/` specifiers again with the same script (`S` →
   `src/glamour/surface`, targets unchanged). Expected table: **two depth
   classes** — `App.tsx` at
   `../../../plugins/spellbook/skills/glamour/shared/*`, the 12 under
   `components/` and `state/` at `../../../../plugins/…`. imago's
   `ImagoShell.tsx` / `state/useSession.ts` are the live precedent at exactly
   those depths.
3. **Resolve every rewritten specifier against the filesystem** before trusting
   anything — a type-only specifier with a wrong path is invisible to build,
   check and test (seat doc, 1a). The sweep script does this; its output diffed
   against `sweep-before.txt` must be the floor plus zero.
4. `bun run build glamour` →
   `plugins/spellbook/skills/glamour/dist/{index.html, index-<hash>.css, index-<hash>.js}`
   (unhashed entry, Contract 2). This is the class (b) instrument: `VALID_KIND`
   and `OPTIMIZE` must resolve or it dies naming the file.
5. `bunx tsc --noEmit -p src/glamour/…` — there is no `src/<spell>/tsconfig`;
   use the root run filtered to `src/glamour/` and `plugins/…/glamour/`, diff
   the line set against T0 normalised for the path move only. TS2307 delta must
   be **0**.
6. **DECLARED_BLIND re-declaration** (`grimoire/gate-honesty.test.ts` l.173,
   176, 179; consumed as exact equality at `:266`, so it is mandatory) —
   **prospero's hand, my words (R3):** I name the two rows
   `src/glamour/surface/index.html` (13, unchanged by the move) and
   `src/glamour/surface/styles.css` (**changes** — T4 adds lines; I post the
   measured `wc -l` after T4, not before) on the wire; daedalus names the
   `bunfig.toml` row; prospero transcribes verbatim. Decompose the total delta
   until it closes exactly; a path-only move that changes the total means
   something else moved.
7. `bun test src/glamour` → 4 pass (derive.test.ts) — the co-located test
   survived the discovered-tree change. Full suite total unchanged.
8. **Done-when:**
   `git ls-files plugins/spellbook/skills/glamour | grep "^.*surface/"` → **0**
   (S3's third clause — successor present is half a check; predecessor absent is
   the other half); `bun scripts/dist-check.ts` exit 0 counting **five**;
   `git status --porcelain` empty after a second `bun run build glamour`
   (Contract 18 reproduction).

### T4 — S5: glamour arrives conforming, and the ward's phantom class is a NAMED BLOCKER

`src/glamour/surface/styles.css` line 1–2 become:

```css
@import "tailwindcss" source(none);
@source "./";
```

plus the explanatory comment in imago's shape — **without spelling any class
name in the prose**, including in selector spelling (seat doc: the `.bg-muted`
scar). `bg-[#140f1d]` on `<body>` in `index.html` is the rule the glob form
silently dropped; the directory form picks it up.

Verification, in the order the falsifiers run:

1. **The glamour rule that the old glob dropped is present.** Extract the
   class-selector set from `dist/index-*.css` with the ward's own
   `classSelectors()` (import it from `grimoire/spell-css-scope-ward.test.ts`
   rather than a second harvester — two grammars over one directory is the thing
   my seat doc forbids) and assert the body-background selector is in it.
   Assemble the expected token from fragments in the check so no text scanner
   sees it whole.
2. **Half two, the byte control:**
   `sha256sum plugins/spellbook/skills/{astrolabe,imago,magpie,mind-mapper}/dist/*.css`
   before and after `bun run build` (all spells). Four equal pairs. **Stated as
   ratified: this is NOT evidence of half one** — the controls stay identical
   even when glamour arrives non-conforming.
3. **`grimoire/spell-css-scope-ward.test.ts` will RED**:
   `glamour carries 1 class(es) only astrolabe uses: 32`. That is the phantom
   from `2xl:` (`\32 ` hex escape, space-terminated; `harvest()` at l.140 stops
   at the space). **This ward GATES, so the red blocks T3's land.** The fix is
   in the ward and it is my file:
   - Red first: a unit cell over `classSelectors(".\\32 xl\\:grid-cols-5{}")`
     expecting `{"2xl:grid-cols-5"}` — today it yields `{"32"}`.
   - Fix: in `harvest()`, consume `\\[0-9a-fA-F]{1,6} ?` as one identifier unit
     (the space is the escape's terminator, not a selector boundary).
   - Control that must stay green: `.p-4{}` → `{"p-4"}`, and the four existing
     spells' shipped CSS produce the same selector sets before and after the fix
     (print the counts: they must not move).
   - Calibration by a non-author (cassandra, per H16): revert the fix, watch the
     unit cell red and the cross-spell cell blame astrolabe. **Ruling needed
     from prospero:** the backlog item is filed-not-scoped (#1125) and it blocks
     the gate at Phase 2. I am asking to fix it in-lane as above; the
     alternative is `knownFailures`-style debt, which this ward has no mechanism
     for.

### T5 — Ruling 3: the cell that reds when the dev board is unstyled

Nobody in the roster has this cell; every spell carries the hazard only as a
comment (`plugins/…/imago/scripts/cli.ts:219`,
`src/astrolabe/backend/cli.ts:128`, `src/magpie/backend/cli.ts:364`). glamour
gets the first one, at `src/glamour/dev-styled.test.ts` (co-located with the
thing it is about; `bun test` discovers it — verify by the file count).

Depends on daedalus's S2 (`resolveMode` honouring `SPELLBOOK_SURFACE_MODE=dev`
and the dev branch importing `src/glamour/surface/index.html`). Written so it is
red until his lands, which is the correct state, not a flake.

```ts
// src/glamour/dev-styled.test.ts — Contract 5 as a cell, not a comment.
// Boots server.ts in FORCED dev mode twice: cwd pinned to src/glamour/ (bunfig
// present -> Tailwind runs) and cwd at the skill root (no bunfig -> Tailwind
// silently skipped, HTTP 200, unstyled). The stylesheet the page links must
// contain the surface's own utilities in the first arm and must NOT in the
// second. The second arm is the positive control: without it a green here
// cannot tell "styled" from "the check cannot see styling".
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
const ROOT = join(import.meta.dir, "..", "..");
const SERVER = join(ROOT, "plugins/spellbook/skills/glamour/scripts/server.ts");
// assembled from fragments: a scanner must not see the utility whole
const UTIL = ["grid", "cols", "3"].join("-");
// glamour's daemon, run directly, takes ONLY --port/--title/--intent/--restore/
// --timeout/--project (server.ts DAEMON_OPTIONS) — no --id, no --no-open; the
// session id is minted inside. It prints ONE stdout JSON line
// {url, port, session_id} (server.ts:595), which is where the url comes from.
async function bootDev(cwd: string, label: string) {
  const proc = Bun.spawn([process.execPath, "run", SERVER, "--port", "0"], {
    // TMPDIR is scoped too: the daemon UNCONDITIONALLY writes glamour-latest.json
    // into tmpdir() (server.ts:460), so an unscoped test daemon clobbers a live
    // user session's pointer. daemon.integration.test.ts scopes only GLAMOUR_HOME.
    cwd,
    env: {
      ...process.env,
      SPELLBOOK_SURFACE_MODE: "dev",
      GLAMOUR_HOME: scratch(label, "home"),
      TMPDIR: scratch(label, "tmp"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const line = await firstLine(proc.stdout); // helper: read until "\n"
  const { url } = JSON.parse(line) as { url: string };
  return { url, kill: () => proc.kill() };
}
async function linkedCss(url: string): Promise<string> {
  const html = await (await fetch(`${url}/`)).text();
  const href = /<link[^>]+href="([^"]+\.css[^"]*)"/.exec(html)?.[1];
  expect(href).toBeDefined();
  return (await fetch(new URL(href as string, url))).text();
}
test("dev mode, cwd pinned to src/glamour: the linked stylesheet carries the surface's utilities", async () => {
  const { url, kill } = await bootDev(join(ROOT, "src/glamour"), "styled");
  try {
    expect(await linkedCss(url)).toContain(`.${UTIL}`);
  } finally {
    kill();
  }
});
test("POSITIVE CONTROL — dev mode, cwd at the skill root: same page, HTTP 200, NO utilities", async () => {
  const { url, kill } = await bootDev(
    join(ROOT, "plugins/spellbook/skills/glamour"),
    "unstyled"
  );
  try {
    expect(await linkedCss(url)).not.toContain(`.${UTIL}`);
  } finally {
    kill();
  }
});
```

The `bootDev` body is written against **whatever transport daedalus's S2
ratifies for `mode`** (ready event + discovery JSON per Contract 1) — that is
the one line of this cell that consumes his seam, and it is at the specifier
grain he ratified, no finer. If the second arm turns out to error rather than
serve unstyled, that is a finding about Contract 5's mechanism and the cell
asserts whichever actually happens, with the reason in its name.

### T7 — S4's real deliverable: `tests/release-serve.test.ts` with the forced-dev cell

Authored here; cassandra calibrates (her M1–M6, #1138). Fourth port of the gate
after mind-mapper, astrolabe, imago — start from
`plugins/spellbook/skills/imago/tests/release-serve.test.ts` and state, in the
header, which cells glamour earns and which it does not (a shortened copy is how
a template's coverage erodes with nobody deciding to erode it).

**What is glamour-specific, measured at `95dc287`:**

- **THREE transports for `mode`, not two.** glamour prints a stdout handshake
  (`server.ts:595`, like mind-mapper/astrolabe) **and** writes a discovery file
  (`$TMPDIR/glamour-<session_id>.json`, like imago) **and** emits the ready
  event. S2's "both transports" undercounts by one for this spell — named as ask
  4 below so daedalus adds `mode` to all three, and the test asserts all three
  (`stdout`, discovery JSON, first SSE frame).
- **No `--id` flag.** The session id is minted inside (`server.ts:129`), so the
  test reads it off the stdout line, then locates the discovery file from it;
  teardown unlinks `glamour-<session_id>.json` and must NOT touch
  `glamour-latest.json` unless it points at this session (the daemon's own rule,
  `server.ts:512`).
- **Shipping dirs:** `scripts/` and `shared/` (imago's glob form, not a
  hand-kept list); rig asserts `surface/` absent, `bunfig.toml` absent,
  `shared/types.ts` and `shared/imageOptimize.ts` present.
- **Backend-still-works cell:** `/state` reads back `state.title`, `/cmd` with
  the glamour envelope (`{type:"say", …}` is imago's — use one of glamour's own
  ambient verbs from `AMBIENT_CLIENT`, read from the wire rather than assumed).
- **The forced-dev cell:** `SPELLBOOK_SURFACE_MODE=dev` over the same
  dist-present rig; daemon must exit non-zero within 3s with stderr naming
  `src/glamour/surface/index.html`, and no discovery file written.
- **Not ported:** the STALE DIST / buildInfo cells (subject removed from the
  tree by ruling); the `/assets/` disjointness cell is imago-only unless
  glamour's `sessionFilesDir` route (`server.ts:130`, `/files/`?) shares the
  shape — check the route table and port the cell if it does, say so if not.

Red before daedalus's S2 lands (no `mode` anywhere) — the correct state. Cell
count added to the suite is reported at land as `1568 + N`, with N enumerated,
so the total is arithmetic and not an impression.

### T6 — Phase 3's visual half, as an instrument rather than an eyeball

Cassandra's local-sim proves release from a copied tree. Mine is the
computed-style diff (seat doc, 4b): boot dev (`SPELLBOOK_SURFACE_MODE=dev`, cwd
`src/glamour`) and release (`dist/` present) against the same `GLAMOUR_HOME`,
dump `getComputedStyle` for 31 properties over every element in both, diff.
Every differing element must be explicable (a clock, an animation frame). Posted
with the boot command as the what-to-try for Cole; the pixels are his, the diff
is mine.

## Answers to daedalus's cross-lane asks (#1140), so the blanks are filled

| ask                                                  | answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — who applies the surface importer rewrites        | **You run the script over the whole tree and post the class table; I review the 13 surface rows against my own T2 expectation (1 at `../shared`, 12 at `../../shared`) and stage my paths into the atomic land.** A disagreement between the two tables is the finding. The `derive.ts` cut is **mine, not mechanical inside your commit**: T1 lands first, standalone, so your `git mv reduce.ts` has zero surface consumers — and the four cells lose their `makeItem` fixture dependency in the same edit, which a cut-and-paste would carry across. |
| 2 — where the four cells live during Phase 1         | **`surface/state/derive.test.ts`, co-located from day one**, not `tests/reduce.surface.test.ts`. In Phase 1 it sits under `plugins/…/glamour/surface/` importing `./derive` — no `plugins/ → src/` edge exists at any point, so Gotcha 6 cannot fire, and Phase 2 moves it with the directory it is in rather than by a second rename. `src/glamour/build.ts` is mine (T3, the delegator).                                                                                                                                                              |
| 3 — DECLARED_BLIND rows                              | As you split it: `index.html` + `styles.css` rows mine, `bunfig.toml` row yours, all three in the atomic land; whose hand types the file is prospero's call.                                                                                                                                                                                                                                                                                                                                                                                            |
| 5 — discovery file absent after the forced-dev death | Already an assertion in T7 (imago's shape), and cassandra's mutation (move the discovery write above the import) is the calibration that proves it is that assertion and only that one.                                                                                                                                                                                                                                                                                                                                                                 |

## Self-review against the ratified seams

- **S1 at the symbol grain for `reduce.ts`:** I take exactly `itemsByKind`,
  `MarkFilter`, `matchesMarks`, `agentRepliedSince` — the four daedalus
  measured. I do not take `leanItem`/`leanState`/`isImperative` even though they
  read as view-shaped; the surface never imports them (measured: only
  `App.tsx:25` and `LibraryGrid.tsx:2` import from `reduce`).
- **S1 at the module grain for `types.ts` / `imageOptimize.ts`:** moved whole,
  to `plugins/spellbook/skills/glamour/shared/`, consumers re-pointed by
  computed relpath. I do not split `types.ts` (the split criterion is runtime
  reach; types erase).
- **S2 consumed at the specifier grain:** my cell reads `mode` and the URL off
  the transports daedalus ratifies; it does not assume a stdout handshake (imago
  has none) and does not assume a field name finer than "mode".
- **S3 consumed at the file-list grain:** T3's done-when asserts `surface/` and
  `bunfig.toml` absent from the tracked subtree, and `dist/` present.
- **S4, my subjects only:** the four selector cells move with their subject
  (co-located, `src/` precedent — **measured today at `5ace21c` with prospero's
  instrument, run by me: `find src -name '*.test.ts'` → 47, of which 0 contain
  `/tests/`; imago alone 7, all beside their module.** The "37 of 38" this lane
  first cited was my seat doc's mind-mapper-only figure from 2026-08-31,
  misquoted as src-wide; withdrawn, conclusion unchanged.) The six value-import
  tests in `tests/` fail loud on a vanished path (cassandra's measurement) and
  their path rewrites belong to whoever moves the module — daedalus.
  `release-serve.test.ts` is T7, authored here, calibrated by cassandra.
- **S5:** `source(none)` + `@source "./"`; the byte control is run and
  explicitly not read as evidence of half one; the ward defect is named as a
  blocker with its fix and a non-author calibration route.
- **Absent list:** no npm dep, no kit import, no component rewrite, no release.
  Nothing in `src/kit/` is touched.

## Asks on comms at lane-landed

1. ~~Ratify `surface/state/derive.ts`~~ — **RULED R2 (#1142).**
2. Rule on fixing **`spell-css-scope-ward`'s hex-escape harvest in-lane** (it
   gates; the red arrives at T3 and blames astrolabe — and possibly mind-mapper
   too, since its `usedIn` matches a bare `32` token in both spells' source
   text; no landed spell's shipped CSS contains `\32`).
3. **S2 finding for daedalus (mode transports)** — see ask 4 in the list above
   the self-review; **ask 6 — ward 1a's pinned escape list**
   (`import-boundary-wards.test.ts:288`/`:408`) gains a fifth entry from his dev
   import and reds the gate until re-pinned by hand, announced. Site his, file
   grimoire's; whose hand is prospero's call.
4. The T2/T3 done-whens `grep … → 0` and `git ls-files … surface/ → 0` are
   **necessary, not load-bearing** — each is satisfied by the act it audits (the
   rewrite, the mv). The load-bearing ones are the 12/1 successor counts,
   `dist-check` counting five, and the second-build `git status` clean; stated
   so nobody reads the first pair as the proof.
5. ~~Atomic land for T2 / order T1 → his move~~ — **RULED R1 (#1142):** one
   Phase 1 commit, both seats' paths; the two-step is withdrawn.
6. **S2 finding for daedalus:** glamour has **three** mode transports (stdout
   handshake `server.ts:595`, discovery file `server.ts:459`, ready event
   `server.ts:475`). "Both transports" is imago's count; T7 asserts all three,
   so `mode` needs to reach all three. Consumed at the specifier grain — I read
   a field named `mode`; I do not assume its position.
7. Observation, not scoped: `glamour-latest.json` lives in `tmpdir()` — the
   shared-namespace pointer house-style's `drive-conjuration-through-daemon`
   boundary check names. Four spells do it; glamour is the fifth. Filed by
   pointer, not fixed.
