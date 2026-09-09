# Phase 2 journal — chapter 1: glamour's whole backend comes into the build

**Date:** 2026-09-08 · **Branch:** `feat/glamour-backend-port` · **Agent:**
Claude Opus 5, implementing under the orchestrator's [brief](./brief-2.md).

Chapter 1 only: **relocate and build.** Chapter 2 (adopting `src/kit/wire/`) is
gated behind this chapter being green and demonstrated, and is not in this file
yet.

Written as the work happened. **Five spells port after glamour and they follow
the playbook this journal produces, so the failures are the payload.**

---

## What this chapter did, in one paragraph

Six modules and nine test files left
`plugins/spellbook/skills/glamour/{scripts,tests}/` for `src/glamour/backend/`.
`shared/` stayed. Two launchers took the old addresses. `dist/cli.js` and
`dist/server.js` are emitted and committed. Six instruments reddened, one of
them **because this chapter repaired it first**, and the ward that was supposed
to be the phase's headline instrument **was green over a real, shipped-shaped
defect until it was fixed.**

## D10, measured rather than assumed

The rule: a module moves to `src/<spell>/backend/` **iff nothing under
`src/<spell>/surface/` imports it.**

| module                                             | surface importers | verdict   |
| -------------------------------------------------- | ----------------- | --------- |
| `glamour/shared/types.ts`                          | **16**            | **stays** |
| `glamour/shared/imageOptimize.ts`                  | **1**             | **stays** |
| `scripts/{cli,server,reduce}.ts`                   | 0                 | move      |
| `scripts/{styles,persist,imageOptimize}.server.ts` | 0                 | move      |

**17 surface import sites, and the brief's count was exactly right** — 16 of
`types` and 1 of `imageOptimize`, all under `src/glamour/surface/`. Zero of them
were re-pointed, because `shared/` did not move. **The direction of the answer
is the same as magpie's and for the same reason,** and the rule found it without
anyone having to notice the analogy: the answer is a property of the import
graph, not of the module's name.

`tests/types.test.ts` stayed with its subject in the skill folder;
`imageOptimize.test.ts` moved, because its subject is `imageOptimize.server.ts`
— it happens to import the two-sided `shared/` module as well, and **which side
a test follows is decided by its subject, never by its imports.**

---

## ⛔ THE HEADLINE: THE SPAWN-PATH WARD WAS GREEN OVER THE DEFECT IT EXISTS FOR

This phase is the first time `grimoire/spawn-path-ward.test.ts` met a spell it
had never seen. **It stayed silent.**

### The defect the port introduced

Astrolabe and magpie both spawn their daemon **up and back down**:

```ts
join(SCRIPT_DIR, "..", "scripts", "server.ts");
```

which is correct from `scripts/` and correct from `dist/`, so their launchers
were free and the 1b journal recorded "the launcher pattern transferred
verbatim". **Glamour did not.** It spawned its own directory:

```ts
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts"); // glamour, before
```

true for exactly as long as the CLI and the daemon lived in the same folder.
Bundled to `dist/cli.js`, that resolves to
`plugins/spellbook/skills/glamour/dist/server.ts` — **a file that does not exist
and must not**, because `dist/` holds the bundle and the spawnable entry is the
launcher one directory over.

**The symptom is not a crash.** `cmdOpen` spawns, waits for a stdout handshake
that never comes, and dies at its 45-second `--start-timeout` with
`glamour server failed to start: daemon start timeout (45s) — first bundle build can be slow; retry or pass --start-timeout <seconds>`.
That message names the wrong cause and invites a retry. It is `magpie extract`'s
eight-day defect in a different verb: quiet, plausible, and about a path.

### Why the ward could not see it

The ward registers an anchor with two patterns, and glamour matched neither:

```js
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // astrolabe
var SCRIPT_DIR = dirname2(fileURLToPath(import.meta.url)); // magpie
var SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url)); // glamour
```

`ANCHOR_URL` required a **bare** `fileURLToPath`. `Bun.` in front of it is the
same function under a namespace, and it made `SCRIPT_DIR` unregistered — so
**every pin computed from it was dropped**: `SERVER_SCRIPT`, `SKILL_ROOT`,
`DIST_DIR` and `SURFACE_CWD`, all four. The ward printed **eight** shipped pins,
none of them glamour's, and reported **5 pass / 0 fail**.

Two cells were silently wrong at once. The `EVERY SHIPPED PIN RESOLVES` cell
missed the bad spawn target, and the
`a pin that leaves the skill folder is ENUMERATED` cell — whose whole job is to
make a new escape loud — stayed green because glamour's `SURFACE_CWD` escape was
invisible to it too.

### ⛔ THE GENERALISATION, AND IT IS THE PHASE'S MOST TRANSFERABLE SENTENCE

**A ward whose population is derived is not thereby covered.**
`buildableSpells()` put glamour in the population automatically, on the same
commit, exactly as designed — and the ward then examined its files and found
nothing, which is indistinguishable from finding nothing wrong. Phase 1b's
closing paragraph had already noticed the shape ("population and coverage are
different measurements. **Print both**") and printing is what it prescribed.
**Printing was not enough.** Nobody reads a green ward's console output.

### The repair, in three parts

1. **The anchor pattern learned an optional qualifier** —
   `(?:[A-Za-z_$][\w$]*\d*\s*\.\s*)?` before both `dirname` and `fileURLToPath`.
2. **A new cell asserts COVERAGE, not population:** every emitted `cli.js` /
   `server.js` that _declares an anchor_ must yield **at least one pin**. A file
   that asks where it is and then pins nothing is either a scanner that failed
   to read it or a backend that stopped resolving siblings — both want a human.
   A backend with no anchor is exempt and stays exempt.
3. **`emittedJs` stopped crashing on an index/disk divergence.** It reads
   `git ls-files`, and mid-port the index still names the previous hashed chunk
   while the disk holds the new one — three cells then failed with an ENOENT
   stack trace that says nothing about paths. Playbook Gotcha 4, in a new file.

**Driven fail-first after the repair**, on the real tree:

```
plugins/spellbook/skills/glamour/dist/cli.js:36 -> plugins/spellbook/skills/glamour/dist/server.ts (join(SCRIPT_DIR, "server.ts"))
```

and the escapes cell simultaneously demanded
`plugins/spellbook/skills/glamour/dist/cli.js -> src/glamour`. Then
`SERVER_SCRIPT` became `join(SCRIPT_DIR, "..", "scripts", "server.ts")`, the
escape was declared, and the ward went green with **six** glamour pins under it
where it had governed **zero**.

**Coverage, printed by the new cell:**

```
astrolabe/dist/cli.js     anchor=yes  pins=6
astrolabe/dist/server.js  anchor=yes  pins=2
glamour/dist/cli.js       anchor=yes  pins=6
glamour/dist/server.js    anchor=yes  pins=3
magpie/dist/cli.js        anchor=yes  pins=7
magpie/dist/server.js     anchor=yes  pins=2
```

---

## ⛔ THE SECOND INSTRUMENT FINDING: A HAND-KEPT LIST INSIDE A DERIVED WARD

`grimoire/import-boundary-wards.test.ts` derives its populations from the tree —
except `DECLARED_EMITTED_ROOTS`, which is **a hand-written array of two
strings** that both ward 1a and ward 1b read to decide which emitted files they
look inside at all.

An omission there is not an exemption. It is **unseeing**: a ported spell's
`dist/*.js` leaves ward 1a's population (otherwise `.ts`/`.tsx` only) and ward
1b's, and both go green because they stopped looking. It is
`INTERNAL_ENTRY_POINTS`'s hazard — 1b's silent fifth failure — in a second file.

Repaired the way that hazard should always be repaired: **glamour was added, and
a cell now derives the required set from the tree**
(`src/<spell>/backend/ {cli,server}.ts` exists ⇒ `<spell>/dist` must be
declared) and fails naming any spell that is missing. The next port cannot be
silently unseen.

---

## ⛔ THE THIRD FINDING, AND IT COST ME A WRONG CONCLUSION FIRST

**`bun run build glamour` and `bun run build` produce DIFFERENT glamour surface
artifacts, from identical source.**

Measured, repeatedly and deterministically:

| invocation                                              | glamour's surface chunk |
| ------------------------------------------------------- | ----------------------- |
| `bun run src/build.ts glamour`                          | `index-mccrznc4.js`     |
| `bun run src/build.ts glamour astrolabe` (either order) | `index-mccrznc4.js`     |
| `bun run build` (whole roster)                          | `index-39c5b79f.js`     |

The difference is real content, not just a hash: Tailwind emits slightly
different palette values (`#b75000` vs `#bb4d00`, `#007956` vs `#007a55` — the
same colours at a different rounding) and Bun's bundler emits a different form
of its own `__commonJS` / `__copyProps` helpers. **It is a property of which
spells share the build process, not of the order they are built in.**

⚠ **AND THE FIRST CONCLUSION I DREW FROM IT WAS FALSE.** Seeing a single-spell
rebuild dirty the tree, I wrote down "glamour's committed `dist/` is stale at
HEAD — a pre-existing Contract 18 violation the local gate cannot see", and I
checked it the way the brief demands: work stashed, rebuilt at HEAD, still
dirty. **That check confirmed a false conclusion, because it reproduced the same
wrong invocation.** What settled it was rebuilding the WHOLE roster, which
restored the committed bytes exactly. The committed artifact was correct the
whole time.

**The transferable rule, and it belongs in the playbook:** `dist-check` ARM 2
runs `bun run build` with no arguments, so the artifact it verifies is the
whole-roster build; **a per-spell build is a different artifact and dirties the
tree with no source change.** Always rebuild the roster before reading
`git status` for artifact churn. And the meta-rule: **a reproduction that
repeats the suspect step is not a control.**

---

## The other four instruments, and every one of them was right

| instrument                           | what it said                                         | repair                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exit-site-inventory`                | 4 added / 4 removed, `foundTotal` unchanged at 27    | three CLI rows re-addressed to `glamour/backend/cli.ts`; the daemon's E-terminal row **stayed at `glamour/scripts/server.ts`** and only its TEXT changed |
| `import-boundary-wards` 1a           | the pinned dynamic escape "disappeared"              | re-pinned at `glamour/dist/server.js`, where the specifier executes (D11)                                                                                |
| `import-boundary-wards` 1b           | the `bun`-exemption floor lost a named file          | glamour's `bun` dependency is a **type query**, erased by the bundler; three → two, re-derived by running the mutation                                   |
| `import-boundary-wards` scanner cell | the line-154 type-query pin read `undefined`         | re-addressed to `src/glamour/backend/server.ts` — same line by coincidence, same KIND, which is what the cell is about                                   |
| `terminator-invariant`               | `HAZARD_APPLIES` key absent                          | `glamour/scripts/cli.ts` → `glamour/backend/cli.ts`                                                                                                      |
| `flag-invariant`                     | glamour has undocumented flags `--port`, `--project` | ⭐ `INTERNAL_ENTRY_POINTS` re-keyed — see below                                                                                                          |

### ⭐ The exclusion set failed LOUDLY this time, and that is worth recording

Phase 1b's fifth finding was that `INTERNAL_ENTRY_POINTS` is an **exclusion**
set, so a stale entry for an absent member is inert and invisible in both
directions — and that every relocating spell must hand-check it.

Glamour produced the **opposite half of the same defect, and it is loud.** The
key `glamour/scripts/server.ts` went stale when the daemon moved; the daemon's
new address was _not_ excluded, so the roster enumerator promoted it to a
caller-facing entry point and `flag-invariant` reported the daemon's private
`--port` and `--project` as undocumented SKILL.md flags.

**So the hazard has two faces and only one of them is silent:** a stale
exclusion is silent when the file simply leaves, and loud when the file arrives
somewhere the exclusion does not cover. Glamour is the loud case only because
its daemon parses flags a CLI does not. **A daemon with no private flags would
have moved in silence**, which is the case the playbook must warn about.

---

## The tests: what re-anchoring actually cost

Every daemon-adjacent path had to be **re-derived from an explicit skill root**,
never adjusted by counting `..` — D14, and it is the generalisable half of the
relocation cost.

- **`cli-contract.test.ts`** — `CLI` and the acc `--config-dir` were both `../…`
  from the skill's own `tests/`. Both now hang off one `SKILL_ROOT`, and `CLI`
  is the **launcher**: the contract these 30 cells assert is what the PROCESS
  writes and exits with, and the process an installed caller runs is
  `scripts/cli.ts` → `dist/cli.js`.
- **`cli.test.ts`** — the two path cells now **import the emitted
  `dist/cli.js`** rather than the source. `daemonCwd()` and
  `SKILL_ROOT_FOR_TEST` are computed from `import.meta.url`, so their value is a
  function of where the module is; read out of `src/glamour/backend/cli.ts` they
  answer `src/glamour/`, a directory with no `SKILL.md`, no `dist/`, and a
  `SURFACE_CWD` five levels above the repo. **Importing the source would assert
  arithmetic nothing executes.**
- **`release-serve.test.ts`** — the scar re-homed exactly as astrolabe's was.
  Its fake release tree globbed every non-test `.ts` beside the daemon, under
  the property "a new module is in the copied tree by construction". That glob
  would now copy files whose `../../../plugins/…` specifiers cannot resolve from
  a temp directory. The property is now true by **bundling**: `dist/server.js`
  IS the module graph. The tree is the launcher, the bundle, and `shared/` —
  which genuinely ships as source because the surface imports it (D10).
- **`cli-open-envelope.test.ts`** — same, plus `dist/cli.js`, because
  `scripts/cli.ts` is now an importer and a tree with `scripts/` and no `dist/`
  dies at module resolution before reaching the guard the cell is about.
- **`daemon.integration.test.ts`** — see below.

### ⛔ D12 ARRIVED AS A TEST FAILURE, AND THEN AS A CROSS-SUITE ONE

`daemon.integration.test.ts` imports `startDaemon` and drives it **in-process**,
thirty cells deep against one shared instance. After the move every cell failed
in `beforeAll` with

```
Cannot find module '../../../../../src/glamour/surface/index.html'
  from '/Users/…/src/glamour/backend/server.ts'
```

which is D12 stated as an error: `SKILL_ROOT` is only the skill root from the
emitted `dist/`, so imported from source it computes `src/glamour/`, finds no
`dist/index.html`, **silently chooses DEV**, and then resolves the dev specifier
from the wrong anchor. **A daemon booted from its source is a wrong daemon.**

The repair is `SPELLBOOK_SURFACE_MODE=release` around the boot — the honest way
to say "mode is not what this file tests"; `release-serve.test.ts` spawns the
real launcher and is where mode resolution and serving are asserted.

⛔ **And the first version of that repair broke a sibling suite.** A bare
`process.env.SPELLBOOK_SURFACE_MODE = "release"` in `beforeAll` is a **global**:
`bun test` runs a directory's files in ONE process, and
`cli-open-envelope.test.ts` spawns a CLI whose entire premise is that mode is
AUTO-DETECTED at a surface-free destination. With `release` leaking in it
detected release, skipped the guard, spawned a daemon, and hung out its
four-second race.

**The signature is the tell: the suite passed alone and failed in the
directory.** It is now set and restored in a `try/finally`, and the spawning
suite additionally clears the variable out of its child's environment, because a
cell whose premise is auto-detection must not inherit an override from anywhere.

---

## Driven — release mode, through the real launcher chain

`scripts/cli.ts` → `dist/cli.js` → detached spawn of `scripts/server.ts` →
`dist/server.js`, against an isolated `$GLAMOUR_HOME` and `$TMPDIR`:

```
open --no-open  → {"url":"http://127.0.0.1:51501","port":51501,
                   "session_id":"glamour-0e423544","mode":"release"}
GET /events?since=0 → data: {"id":1,"type":"ready","mode":"release"}
GET /                → 200 text/html 414 B  (the committed dist/index.html)
GET /index-39c5b79f.js  → 200 text/javascript 1,056,224 B
GET /index-ek8hd2gz.css → 200 text/css          41,048 B
say / section / state / info → all {"ok":true}, exit 0
--version → {"name":"glamour","version":"2.2.0"}   ← the plugin.json pin, resolved from dist/
unknown verb → one JSON envelope on stderr, kind usage, exit 2
close → {"ok":true,"sent":"close"}; $TMPDIR is EMPTY afterwards
```

`--version` is worth naming separately: it reads
`join(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json")`, which is a pin
that leaves the skill folder and lands inside the plugin — the ward governs it,
and it answers a real version from the emitted location.

## Driven — dev mode, the line nothing in CI can see

`SPELLBOOK_SURFACE_MODE=dev`, fresh home:

```
open → {"…","mode":"dev"}          ← the dev import RESOLVED; a daemon that
                                      cannot resolve it dies before the handshake
GET /  → 200 text/html;charset=utf-8, 724 B, referencing
         /_bun/client/index-00000000cb24a190.js  and  /_bun/asset/3e654c7a017d5cbc.css
that JS  → 200  1,637,073 B   (the unminified dev React graph)
that CSS → 200     42,754 B   with 155 `--tw-` markers → the Tailwind plugin ran,
                                so Contract 5's cwd pin survived the relocation
```

and independently, resolved by hand against the emitted file:

```
dist/server.js: "../../../../../src/glamour/surface/index.html"
  -> /Users/colereed/Projects/Spellbook/src/glamour/surface/index.html   exists: True
```

The five `..` are counted from `plugins/spellbook/skills/glamour/dist/`, **not**
from `src/glamour/backend/server.ts`. It is the same string as before the move
because `dist/` sits at the same depth as the `scripts/` it replaced — a
coincidence of depth, not a property, which is why it is asserted.

## The gate

Green, **unpiped, exit read from a file**: `1957 pass / 0 fail` across 157 files
(baseline at HEAD was 1955; the two new cells are the spawn-path coverage cell
and the emitted-root declaration cell). `bun scripts/dist-check.ts` ARMs 0 and 1
pass; ARM 2 names the two new artifacts as untracked-at-the-moment-of-check,
which is the state it is documented to be unusable in before the commit lands.

---

## The brief against the tree — every disagreement

| the brief said                                                       | the tree said                                                                                                                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the backend is 2,436 lines across six files                          | ✅ held                                                                                                                                                        |
| the surface imports the skill folder **17 times**                    | ✅ **exactly 17** — 16 `types`, 1 `imageOptimize`. The first count in this project that was not under-stated                                                   |
| **BOTH** entries use `if (import.meta.main)` — D12's defect exactly  | ✅ held, and it cost nothing, exactly as predicted                                                                                                             |
| the 250 ms reconnect storm is at `cli.ts:623`/`:667`                 | ✅ **both exact.** `let delay = 250;` at 623 and `delay = 250;` at 667, plus three `Math.min(delay * 2, 5000)` growth sites at 642 / 659 / 664                 |
| glamour has `acc.config.json` = `{"defaultOutput":"json"}` and is L0 | ✅ held (re-run reported in chapter 2's section)                                                                                                               |
| `shared/` is imported by the surface, so expect D10 to keep it       | ✅ held                                                                                                                                                        |
| the launcher pattern is copied from astrolabe                        | ⛔ **the REASONING copies; the PATH did not.** glamour spawned its own directory, not up-and-back-down. This is the chapter's whole finding — see the headline |
| `grimoire/spawn-path-ward.test.ts` "**will fail you**" on a bad pin  | ⛔ **it did not.** Green, 5/0, over a `dist/cli.js` spawning a nonexistent `dist/server.ts`. Reported as the brief asked; repaired here                        |

## For the playbook — what chapter 1 adds

1. **A derived population is not coverage.** Assert that each member of the
   population actually contributes, or the ward reports "found nothing wrong"
   when it means "found nothing".
2. **Read the spell's OWN spawn expression before trusting a sibling's launcher
   pattern.** "Up and back down" was astrolabe's and magpie's accident of style,
   not a house convention, and the failure is a start-timeout that blames the
   bundle build.
3. **Rebuild the WHOLE roster before reading `git status` for artifact churn.**
   A per-spell build emits different bytes.
4. **A reproduction that repeats the suspect step is not a control.**
5. **Hand-check every hand-kept list a derived ward reads** — exclusion sets and
   root lists both. The stale key is silent when a file leaves and loud when it
   arrives somewhere uncovered.
6. **`process.env` in a `beforeAll` is process-global.** Set and restore it, and
   clear it out of any child you spawn whose premise is auto-detection.
7. **Test the ARTIFACT for anything computed from `import.meta.url`.**
