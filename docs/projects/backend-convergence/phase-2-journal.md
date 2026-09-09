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

---

# Chapter 2 — glamour adopts the spine

Same branch, after the chapter 1 verify pass. glamour is the **first consumer of
these eight modules that is not one of the two they were designed against**, so
this half of the journal is mostly about where the boundaries were drawn too
narrowly.

## ⛔ TWO BOUNDARIES WERE WRONG FOR GLAMOUR, AND BOTH WERE WIDENED RATHER THAN WORKED AROUND

The brief's instruction was that a wrong boundary is a finding about the MODULE.
Both findings have the same shape: **the module was extracted from two spells
that happen to agree, and the thing they agree on is a coincidence rather than a
design.**

### 1 · `errors.ts` could not carry the daemon's own words

glamour's failure envelope has a field the kit's did not: `error.server`, the
refusing daemon's body **verbatim**, so a caller branches on what the other side
actually said instead of on the CLI's prose about it. Its contract suite asserts
the round trip for HTTP 400, 404 and 409.

`ErrExtra` was `{ hint?, choices? }` — because **astrolabe and magpie both throw
the body away.** magpie's is `die(\`state failed (HTTP ${status})\`,
"internal")`: the number survives, the reason does not. Two spells agreeing is
not evidence; **seven of the eight spells put a CLI in front of a daemon**, so
keeping the upstream's body is the general shape and glamour is the only one
that got it right.

`ErrExtra` gained `server?: unknown`, emitted last so the key order of an
already-shipping envelope does not move. Adopting glamour made the shared
contract **wider**, not glamour narrower.

⚠ And writing the cell for it turned up that **`errors.ts` had no test file at
all** — the module that decides what every spell's failures look like was
covered only transitively, by whichever spell adopted it next. `errors.test.ts`
exists now.

### 2 · `sse.ts`'s registry could END a stream but not SPEAK to one

`SseClients` was `Set<() => void>` — bare closers. glamour needs to push
`{type:"connected"}` / `{type:"disconnected"}` at the **agent's SSE tail**:
deliberately unlogged, so a reconnecting agent does not re-see every past
connect, and carrying no `id`, so it never advances a tail cursor.

Astrolabe and magpie announce presence over their browser **WebSocket**, so a
registry of closers was sufficient for both and the boundary looked right.

The alternative was to keep a second, parallel
`Set<ReadableStreamDefaultController>` inside glamour's daemon — **which is
verbatim the drift the registry exists to remove**, and which the module's own
header warns about (the copies kept a parallel set of heartbeat timers and swept
it separately). So the registry entry became
`{ close(): void; send(chunk: string): void }`, and `send` routes through the
same closed-check and teardown funnel as every other write. `drainAndStop` was
the only other consumer.

**The generalisation:** "tell the live subscribers something that is not part of
the history" is a normal daemon act, and a registry that can only end a stream
cannot express it. It took a third consumer to see it.

## ⭐ B5 IS DEAD BY CONSTRUCTION, AND HERE IS THE MEASUREMENT

The census's B5: `cmdTail` set `let delay = 250` and reset it to 250 **on every
successful OPEN** — three of its four sleep sites doubled the delay and the
fourth did not, which is exactly why a hand-written reconnect loop cannot be
judged from one of its branches.

Driven against a server that accepts `/events`, answers 200, and **ends the body
immediately** — B5's precise trigger, since the old code reset on `res.ok`
regardless of whether a byte arrived. Fourteen-second window, the pre-port CLI
extracted from `6af53f2` and run side by side with the shipped one:

```
OLD (6af53f2)  attempts: 51
  gaps (ms): 252 253 252 252 253 250 253 252 252 252 253 250 253 252 252 253 251 251
             252 253 251 252 253 252 252 252 252 251 252 253 252 253 251 253 251 252
             251 251 250 253 252 252 252 253 252 252 253 250 252 253

NEW            attempts: 6
  gaps (ms): 252  503  1001  2002  4002
```

**Fifty-one connection attempts against one dead-ish daemon in fourteen seconds,
at a flat quarter-second, forever.** The replacement is six, doubling, capped at
`maxMs`. It cannot be re-expressed because **there is no loop left to put it
in** — `tailEvents` has one backoff, and Phase 1a's second door is closed by the
same single implementation: in the emitted `dist/cli.js` the reset sits at
`delay = retry.initialMs` immediately after a chunk is READ, not after a
successful open.

## The censused defects glamour closed, and which module closed each

| defect                                                         | closed by                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **B5** — 250 ms constant-interval reconnect storm              | `tailEvents` — one backoff, no branch that resets without growing                                             |
| **L1** — idle sweep blind to its subscribers                   | `housekeeping.shouldIdleClose`, whose `subscriberCount` is a REQUIRED argument                                |
| **L3** — non-atomic discovery pointer                          | `discovery.writeFileAtomic` (glamour is where this was found; now it is one implementation for three spells)  |
| **L5** — unbounded event buffer                                | `eventLog`'s replay window                                                                                    |
| the unlink-a-successor's-pointer hazard                        | `discovery.unlinkIfMatches` — glamour hand-rolled the `session_id` comparison; it is now the shared predicate |
| dead-client detection that rests on a `catch` that never fires | `sse.ts`'s teardown funnel plus `req.signal` — the old copy was not wired to the signal at all                |
| a tail with **no watchdog at all**                             | `tailEvents`'s `idleMs`, DERIVED from glamour's own heartbeat                                                 |
| the monotonic `id` losing to a payload `id`                    | `eventLog.emit` assigning after the spread                                                                    |
| `?since=x` opening an empty, connected stream                  | `eventLog.subscribe`'s non-finite cursor rule                                                                 |

**L1, driven both directions on a real daemon** (`--timeout 5`):

```
14s after boot, with a tail held:   GET /state -> 200
 9s after the tail was dropped:     GET /state -> 000   (idle-closed, unwatched)
```

Before this chapter the first line was a dead daemon: glamour counted its idle
floor down while an agent held `/events` open, so a watch on a quiet session was
killed **with its connection open**.

## ⛔ `idleMs` IS DERIVED FROM GLAMOUR'S OWN HEARTBEAT — Phase 1a's rule, obeyed

`src/glamour/backend/heartbeat.ts` is new, and it is the seam: before it, the
15,000 ms heartbeat was a **literal inside `sseResponse`**, and `cli.ts` had no
corresponding number **at all** — its tail blocked on `await reader.read()`
forever, so a half-open socket parked it in silence with no way out.

`TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS)`. Not 45,000. The number it
currently evaluates to **is** 45,000, which is also the default
`--start-timeout`, and the file says in as many words that the two are unrelated
so nobody de-duplicates them later. Astrolabe measured what a copied watchdog
costs: reconnects at +47.4 s, +92.6 s and +137.9 s against a perfectly healthy
daemon.

## The wire-observable changes, named rather than smuggled

1. **`Content-Type: text/html` → `text/html; charset=utf-8`** on the release
   surface. The kit's content-type map, which resolved the census's one
   divergence toward the correct copy (three of eight daemons carried the
   charset; an HTML document served without one is decoded by the browser's
   guess). glamour is the third spell to inherit it.
2. **The SSE stream now opens with a `: connected` comment**, which flushes the
   response headers so a genuinely quiet stream does not leave a `fetch()`
   unresolved. It broke two cells that read **line 0** of the stream and handed
   `JSON.parse` a comment; both now take the first `data:` line. Every house
   tail client already drops `:` lines.
3. **The teardown grace is 150 ms, not glamour's 50.** The number all eight
   daemons converged on, and the thing that turns "the daemon told you why it
   died" into an observation. glamour's `closed` frame is what its own `tail`
   watches for, so it is the frame the grace exists for.

## What the adoption cost, in the daemon

The `events` array + `eventSeq` + a `Set<ReadableStreamDefaultController>`
became one `log` and one `SseClients`. A 34-line hand-rolled `sseResponse`
became an eight-line mapping function. `writeAtomic` was deleted in favour of
the kit's. The unlink-if-ours block became `unlinkIfMatches` with an `identify`
hook. Two `setInterval`s and the whole teardown block became `startHousekeeping`
and `drainAndStop`. `resolveMode` and the content-type map went entirely; what
stayed is the one line that says WHICH file a URL means — deliberately, because
two spells route that differently and a signature wide enough for both stops
being a file server.

In the CLI, the whole error contract (a 60-line block: taxonomy, exit map,
`CliError`, `die`, `writeEnvelope`) became four imports, and a 110-line tail
loop became a 30-line options object.

## D8's audit, performed and reported

⛔ **REACHABILITY, NOT CALL SITES** — the call graph, followed, not a grep.

- **12 `die` call sites** in `cli.ts` (192, 199, 205, 454, 468, 516, 575, 601,
  731, 874, 889, 900 at the pre-port addresses); **0** in
  `imageOptimize.server.ts`.
- **Ten functions reach a `die` transitively** — `readSession`,
  `requireSession`, `resolveGenSrc`, `cmdOpen`, `cmdInfo`, `cmdState`,
  `cmdTail`, `postCmd`, `dispatch`, `main` — plus **fifteen of the nineteen
  `COMMANDS[].run` closures**.
- **25 further invocation edges audited**, for **37 audited positions in
  total**.
- **ZERO sit inside a `try`.** ⭐ **No swallowing site on any die-reachable
  path.**

Three `catch` blocks in the file do swallow, and **none has a die-reachable call
inside it**: `api`'s `res.json()` (a non-JSON body is a legitimate `null`),
`versionInfo`'s degrade-to-`"unknown"`, and the tail's malformed-frame skip
(which the adoption has now deleted along with the loop).

**The structural reason the count came out clean is worth copying:** nine of the
twelve dies sit **inside a `catch` or after a `try`**, never inside one.
`readSession` and `cmdOpen` both use a "try narrowly, die in the handler" shape,
which is exactly what D8 wants and which no rule anywhere told them to do.

⚠ **One CONDITIONAL, reported because it is one refactor from being a defect.**
`postCmd`'s ECONNRESET catch tests `message.includes("ECONNRESET")` on an
untyped error and answers `{"ok":true,"sent":"close"}` at exit 0. Today its only
die-reachable call (`requireSession`) is three lines ABOVE the `try`, so no
`CliError` can enter it. If one ever became reachable inside — `api` gaining a
`die`, or `daemonRefused` moving up — a taxonomy failure would be reported as
success. **The one-line ward is `if (err instanceof CliError) throw err;` as the
catch's first statement.** Not applied here: it is a behaviour change in a
chapter whose contract is adoption, and it is filed rather than smuggled.

## The two instruments that reddened, and both are the phase's best news

- **`exit-site-inventory`: three REMOVED, zero added.** All three of glamour's
  CLI exit sites — the A-drain write-then-exit, the C-signal handler, the F-live
  "pinned session went away" — **are gone**, because `tailEvents` RETURNS an
  exit code instead of ending the process from inside three nested loops.
  glamour's CLI now has **zero live `process.exit` sites**, the third to reach
  that after magpie and mind-mapper.
- **`import-boundary-wards`'s line-number pin** moved 154 → 141 and its own
  comment predicted it, for the fourth time. It reds on any edit ABOVE the line
  and reports only `undefined`, which reads as "the escape vanished". **A line
  number is the wrong pin** and this ward says so about itself.

## Driven — chapter 2, both modes, through the real launcher chain

**Release**, with an agent tail held and a browser WebSocket opened and closed:

```
open  → {"…","mode":"release"}
GET / → 200  text/html; charset=utf-8  414 B    ← the charset, arriving
GET /nope → 404
the agent tail received, in order:
  {"type":"grounding","session_id":"glamour-18342c11","port":55746}
  {"id":1,"type":"ready","mode":"release"}
  {"type":"connected"}          ← transient: no id, not in the replay log
  {"type":"disconnected"}       ←   …through the registry's NEW `send`
  {"id":2,"type":"closed"}      ← arrived inside the 150 ms grace
stderr: ": glamour-keepalive"
$TMPDIR after close: EMPTY      ← unlinkIfMatches removed the pointer
```

**Dev**, fresh home:

```
open  → {"…","mode":"dev"}      ← the dev import resolved, from dist/
GET / → 200 text/html;charset=utf-8 724 B
        → /_bun/asset/3e654c7a017d5cbc.css   200  42,754 B, 154 `--tw-` markers
        → /_bun/client/index-00000000cdc03237.js  200  1,637,073 B
```

## acc, re-run from the skill directory

```
$ cd plugins/spellbook/skills/glamour
$ bun scripts/cli.ts schema > /tmp/decl.json
$ bunx acc check scripts/cli.ts --declaration /tmp/decl.json
  level L0   conformant true
  core 17 · corePassed 16 · coreFailures 0 · diagnosticFailures 0 · unverified 1
```

**CONFORMANT L0, unchanged**, run twice — once after chapter 1 and once after
the adoption — and the config was discovered at
`plugins/spellbook/skills/glamour/acc.config.json`, which is the point of
running it from the skill directory. `--version` answers
`{"name":"glamour","version": "2.2.0"}` through the launcher, so acc's identity
probe reads the built CLI.

## The gate, and the kit's blast radius

Green, **unpiped**: `1962 pass / 0 fail` across 158 files.

⚠ **Changing three kit modules dirtied SIX artifacts across THREE spells** —
astrolabe's and magpie's `dist/cli.js` and `dist/server.js` as well as
glamour's, because the kit is inlined into every bundle. All six are rebuilt and
committed in this chapter, or Contract 18 breaks on a spell nobody touched.

**And the Tailwind-prose hazard did NOT fire this time**, which is only knowable
by looking: `git status` after a whole-roster rebuild shows six `.js` files and
**zero `.css` or `index.html`**, so no English word added to `src/kit/` this
chapter became a utility class in a spell I never opened. Phase 1b's rule holds
and it is a rule about CHECKING, not about the outcome.

## For the playbook — what chapter 2 adds

1. **A module extracted from two consumers encodes what those two agree on**,
   and agreement is not design. Both of glamour's boundary findings were places
   astrolabe and magpie happened to match.
2. **Widen the shared module; do not keep a parallel structure beside it.** A
   second `Set` next to the shared registry is the exact drift the registry
   exists to remove.
3. **`idleMs` is DERIVED from that spell's own heartbeat.** Never copied. The
   number may coincide with a sibling's; the expression must not.
4. **Run D8's audit by following the call graph.** Report the count, the
   transitive functions, and any CONDITIONAL swallow even when it is currently
   unreachable.
5. **A shared-module change dirties every spell that inlines it.** Rebuild the
   roster and commit every artifact in the same chapter.
6. **Adopting a shared SSE server changes the first line of the stream.** Any
   test reading line 0 breaks; take the first `data:` line.

## ⛔ THE REPAIR CHAPTER — a backstop computed from the same predicate it backstops is not a backstop

Three items, all falsified by the verify pass, all of them things this phase had
already written down as done.

### The ward's coverage cell was the ward's own bug, one level up

D27's proudest sentence was that the new coverage cell "fails on the next
unrecognised spelling without anyone having to think of it in advance". **It
does not, and driving it is the only reason we know.** The cell asked whether a
file _declares an anchor_, and computed that with `ANCHOR_DIR || ANCHOR_URL` —
**the two regexes the cell exists to backstop.** So a spelling neither regex
reads produced `declaresAnchor=false`, and the file became **exempt** instead of
loud. The cell could fire only on files whose anchors the ward already
understood: the one population that did not need it.

Five spellings were planted in glamour's real `dist/cli.js`, each beside a
`SERVER_SCRIPT` resolving to a `dist/server.ts` that does not exist — the exact
defect that shipped and the exact defect this ward was written for. Against
D27's predicate, **all five: 6 pass / 0 fail.** Two of them are not exotic at
all: `var SCRIPT_DIR = import.meta.dirname;` is a real Bun/Node API, and the
two-step `__fileName` form is what esbuild and Bun emit for a `__filename` shim.
At least one of the five remaining ports would have written one.

The fix gates on the **ingredients** of location-anchoring instead —
`import.meta.url`, `import.meta.dir`, `import.meta.dirname`, `fileURLToPath`
under any qualifier, `__dirname`/`__filename`, `Bun.main` — because a module
cannot ask where it is without naming one of them, and none of them is
reachable-past by the anchor patterns. Every ingredient-bearing line must be
READ (recognised, or yielding a pin) or the ward reds **naming the line**; a
file carrying any ingredient must still yield at least one pin; a file carrying
none is exempt and stays exempt. All five now red, 7 pass / 0 fail clean, and
the mutation is a synthetic cell rather than a story about a drive.

⭐ **And the fifth spelling is the part worth keeping.** The first version of
the ingredient list named four ingredients and looked complete. Twenty minutes
spent trying to break it produced `var SCRIPT_DIR = dirname(__filename);`, which
names none of the four and scored `ingredients=0 anchor=no pins=0` in silence.
**The attempt to break your own repair is not a formality; it found a hole in
the repair to the hole.** `process.argv[1]` is the one that remains, and it is
declared in the source rather than left to be discovered.

### ⛔ THE GENERALISATION, AND THIS IS THE SECOND TIME THIS PROJECT HAS MET THE SHAPE

**A backstop computed from the same predicate it backstops is not a backstop.**

Phase 1b's closing finding was its sibling: _a derived population is not
coverage_ — a ward can gain a spell automatically, examine its files, find
nothing, and report that as finding nothing wrong. D27 built the coverage
assertion that answers it, and built the assertion **out of the very predicate
whose blindness was the problem**. The instrument that was supposed to see past
the regexes could only see what the regexes could see.

The shape, stated once for the five ports that follow:

> When you add a check because some predicate `P` might be wrong, the new
> check's own gate must not be `P`. If it is, the check inherits `P`'s blind
> spot exactly, and it will be GREEN precisely in the cases it was added for —
> which is worse than absent, because it now reads as reassurance.

The test for it is mechanical and takes minutes: **name the predicate you
distrust, then read your new check's gate and ask whether that predicate appears
in it.** If it does, move the gate to a level the predicate cannot reach past —
here, from _spellings of an anchor_ down to _the ingredients any anchor must
name_. Then **drive a mutation the distrusted predicate cannot read**, and then
**try to break your own repair.** Both steps paid here; the second paid more.

### Two prose corrections of the same family

- **B10 was right by accident.** "A per-spell build emits different bytes" is
  FALSE under the pinned toolchain — a per-spell build through
  `node_modules/.bin/bun` reproduces the committed bytes exactly. The real
  variable is the **binary**: `bun run build` resolves the package script's
  1.3.14, a bare `bun run src/build.ts` resolves PATH's 1.4.0. Which means the
  stated remedy — _rebuild the whole roster_ — is precisely what an agent who
  typed the bare command does next, and it dirties all eight spells. **A rule
  can be obeyed, produce the right outcome, and still not protect anyone,
  because the reason is what an agent generalises from.**
- **B9 scoped D8's audit to the token `die(`** and therefore under-counted
  glamour 12 → ~20 (13 `die` plus seven `throw new UsageError`). And "zero
  inside a `try`" is literally false: `dispatch` sits inside `main`'s try,
  `parseArgs` inside `dispatch`'s. The substantive claim survives only because
  **both catches propagate** — which is the actual test, and is now what the
  playbook says: not _is it inside a try_, but _does any catch on the path
  SWALLOW_.
