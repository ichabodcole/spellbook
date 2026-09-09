# Phase 1b journal — chapter 1: the two daemons come into the build

**Date:** 2026-09-08 · **Branch:** `feat/backend-spine-phase-1b` · **Agent:**
Claude Opus 5 (1M context), implementing under the orchestrator's
[brief](./brief-1b.md).

Chapter 1 only: **relocate and build.** Chapter 2 (adopting the daemon-side
spine) is gated behind a verify pass and is not in this file yet.

Written as the work happened. The failures are the part Phase 2 inherits.

---

## The pre-move census the brief demanded (measurement 4)

**Every `import.meta.*` and every path-pinned sibling in both backends**, read
before anything moved.

| site                                                               | what it anchors                                                         | verdict                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `magpie/scripts/backend.ts:63`                                     | `REMOVE_PY = join(import.meta.dir, "remove.py")`                        | ⛔ **already broken in the tree — see below**           |
| `astrolabe/scripts/server.ts:85`                                   | `SCRIPT_DIR = import.meta.dir` → `SKILL_ROOT`/`DIST_DIR`                | ✅ ancestor-relative; survives (asserted, not reasoned) |
| `magpie/scripts/server.ts:66`                                      | `SCRIPT_DIR` via `fileURLToPath(import.meta.url)` → same                | ✅ ancestor-relative; survives                          |
| `src/astrolabe/backend/cli.ts:45` · `src/magpie/backend/cli.ts:60` | `SCRIPT_DIR` → `SERVER_SCRIPT`, `SKILL_ROOT`, `DIST_DIR`, `SURFACE_CWD` | ✅ already built; already ancestor-relative by ruling   |
| `magpie/tests/discover.test.ts:96`                                 | a temp PNG beside the test                                              | ✅ test-local, follows the test                         |
| both servers, dev branch                                           | `await import("../../../../../src/<spell>/surface/index.html")`         | ⚠ the trap — see D11                                    |

**No other path-pinned sibling exists in either backend.** `remove.py` is the
only non-TS runtime asset in the two spells.

## ⛔ The `import.meta.dir` defect is not a future breakage. It shipped.

The brief said magpie's `REMOVE_PY` **will** break when `backend.ts` is bundled.
Measured against the tree: **it is already bundled and already broken.**

`src/magpie/backend/cli.ts:46` imports `backend.ts` today, so
`plugins/spellbook/skills/magpie/dist/cli.js:45` already reads

```js
var REMOVE_PY = join(import.meta.dir, "remove.py");
```

with `import.meta.dir` = the **`dist/`** directory, and `remove.py` sitting in
`scripts/`. `ls plugins/spellbook/skills/magpie/dist/` has four files and none
of them is `remove.py`.

So `magpie extract`'s rembg path has been dead since Slice 2 (`7bb0f4a`) — in
the built CLI, which is the only CLI that runs. The relocation did not introduce
this; the relocation is what made anyone look. Drive + fix recorded below.

### Driven, fail-first, before any change on this branch

```
$ MAGPIE_HOME=… TMPDIR=… bun plugins/spellbook/skills/magpie/scripts/cli.ts open --no-open
{"url":"http://127.0.0.1:62370",…,"mode":"release"}
$ … source <png> ; … element-add --bbox "10,10,80,80" --name box --type object
$ … extract
magpie: cut FAILED for box: rembg remove.py failed (exit 2):
  …/python3: can't open file
  '/Users/colereed/Projects/Spellbook/plugins/spellbook/skills/magpie/dist/remove.py':
  [Errno 2] No such file or directory
{"ok":true,"cut":0,"failed":1,"total":1,"keptWhole":0,"model":"crop"}
```

Two things worth carrying to Phase 2:

1. **The default `extract` path — plain crop, no `--remove`, no rembg model —
   goes through `remove.py` too.** The brief and the decision log both describe
   this as the _rembg extraction_ path, which reads as an optional feature
   behind a flag. It is the only extraction path there is.
2. **The envelope is `{"ok":true,…}`.** A total failure of the verb answers
   success-shaped JSON with a `failed` count buried in it. That is why nobody
   noticed for eight days: the exit code is 0 and the top-level key says ok.

**The transferable rule for the roll:** a bundled backend's `import.meta.dir`
re-anchors into `dist/`, and _nothing in the gate can see it_ — no type-check,
no unit test, no ward. The only instrument that finds it is running the verb.
Every spell that ports must have its non-TS sibling assets enumerated and each
one driven.

---

## Astrolabe — what held and what did not

### The launcher pattern transferred verbatim (brief measurement 1) ✅

`cli.ts` spawns `join(SCRIPT_DIR, "..", "scripts", "server.ts")` and that line
is untouched. `grimoire/lib/entry-points.ts` and `exit-site-inventory` both name
the same path and both still find a real `.ts` there. Zero prose edits across
the roster. The brief was right and it is the reason this chapter is cheap.

### `SKILL_ROOT`/`DIST_DIR` survived (measurement 2) ✅ — and are now asserted

`dist/` sits at the same depth as `scripts/`, so `join(import.meta.dir, "..")`
lands on the skill root from either address. Asserted in
`src/astrolabe/backend/server.test.ts` ("the relocation's path arithmetic —
asserted, not reasoned about"), per the brief's instruction not to trust the
line it was written on.

### ⛔ What the brief did not say: the daemon has NO ENTRY once it is bundled

`if (import.meta.main)` is **false** in `dist/server.js`, because the launcher
imports it. Left as-is, the relocated daemon would have started, run no code,
and exited 0 — and every test would have failed as _"daemon never bound a
port"_, which reads like flake. The fix is an exported `run()`, exactly as the
CLI already does; D12 records why the daemon gets ONE entry where the CLI has
two.

### ⛔ `*/` CLOSES A BLOCK COMMENT. The build refused to parse.

The first draft of `src/build.ts` explained the new flag by writing
`--external '*/surface/index.html'` inside a `/** … */` docstring. Those two
characters end the comment, so the rest of the sentence was handed to the
parser:

```
110 |  * remedy: D6 measured `--external '*/surface/index.html'`, which leaves that
                                                          ^ error: Unterminated string literal
```

This is `.anthill/principles.md` #2 live, in the file that introduces the flag —
and it is the _third_ recorded instance in this repo, after
`grimoire/lib/entry-points.ts`'s own comment about the `scripts` glob. The
specifier is now named once as a constant and the prose spells it out in words.
**A brief that quotes a shell flag containing a glob is handing the implementer
this trap;** worth a line in Phase 2's playbook.

### ⛔ `release-serve.test.ts` had to change what it tests, not just where it lives

It built its fake release tree by copying every non-test `.ts` beside the daemon
into `<root>/scripts/`, with a scar attached: _"a new module is in the copied
tree by construction this way"_, earned because mind-mapper's hand-maintained
mirror shipped a broken release twice.

After the move that glob copies files whose `../../../plugins/…` specifiers
cannot resolve from a temp directory — it would have tested a tree that does not
exist. The scar is **re-homed, not deleted**: the property it protects ("a new
module is in the copied tree by construction") is now true by **bundling**
instead of by globbing, because `dist/server.js` IS the whole module graph. The
tree is now built from the two files that actually ship — the bundle and its
launcher.

The same reasoning forced `server.test.ts` to spawn the **launcher** rather than
`./server.ts`. Both suites now depend on a built `dist/`; the gate builds before
it tests, and the thing worth asserting is the thing that ships.

### The wards that reddened, and every one of them was right

Nothing here was a surprise in kind — it was Contract 19, five times, and the
loud failures are the ward working:

| instrument                             | what it said                               | repair                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `daemon-lifecycle-ward`                | population 7 → 5, zero-guard red           | **extend the walk** into `src/*/backend/*.ts`; `clis()` one function away already had both roots                                                                                                                                                                   |
| `import-boundary-wards` 1a             | the pinned dynamic escape "disappeared"    | population extends into the emitted roots; **the pin now sits on `dist/server.js`**, where the specifier executes (D11)                                                                                                                                            |
| `import-boundary-wards` 1b             | the `bun`-exemption cell lost a named file | astrolabe's `import type … from "bun"` is type-only, so the bundler erases it — the dependency stopped existing in anything that ships. Five → four, re-derived by running the mutation                                                                            |
| `import-boundary-wards` re-export cell | 7 → 6 re-exports                           | population spans both roots; astrolabe's row re-pinned at its new address and new specifier                                                                                                                                                                        |
| `entry-points.INTERNAL_ENTRY_POINTS`   | (silent)                                   | `astrolabe/scripts/server.ts` → `astrolabe/backend/server.ts`. **This one would NOT have reddened** — a stale exclusion for a file that is no longer a member is inert, and leaving it would have published the daemon's private argv as a caller-facing interface |

⚠ **That last row is the one to carry forward.** Four of the five failures were
loud. The fifth was an entry in an exclusion SET, and an exclusion for an absent
member is invisible in both directions. Contract 19's corollary — _the pin is
what converts a silent shrink into a loud failure_ — does not cover exclusion
lists, because a pin says "this must be here" and an exclusion says "ignore this
if it is". **Every spell that relocates must hand-check
`INTERNAL_ENTRY_POINTS`.**

### Driven — release mode

Booted through the real launcher (`cli.ts` → detached spawn →
`scripts/server.ts` → `dist/server.js`), against an isolated `$ASTROLABE_HOME`:

- `add "Probe"` → `{"ok":true,"applied":true,"id":"probe"}`
- `GET /events?since=0` → `{"id":1,"type":"ready",…,"mode":"release"}`
- `GET /` → 200, `text/html`, 1,357 B, the committed `dist/index.html`
- `GET /index-yda4rtjd.js` → 200 `text/javascript` 1,020,767 B ·
  `GET /index-zfjgtr8r.css` → 200 `text/css` 35,472 B (the committed hashed
  chunks)
- `state` read back the registered project; `close` →
  `{"ok":true,"applied":true}`

### Driven — dev mode (the brief's measurement 3, the one CI cannot see)

`SPELLBOOK_SURFACE_MODE=dev`, fresh `$ASTROLABE_HOME`:

- ready frame reports `"mode":"dev"` — **which alone proves the dev import
  resolved**, because a daemon that cannot resolve it dies before the handshake
  (that is the assertion `release-serve.test.ts`'s override cell makes)
- `GET /` → 200, 1,667 B, referencing `/_bun/client/index-00000000c62e5c07.js`
  and `/_bun/asset/ff3dcd8132915acb.css` — **Bun's dev bundler paths, not the
  hashed dist chunks**
- that CSS: 200, 36,498 B, 151 Tailwind markers → the Tailwind plugin ran, so
  Contract 5's cwd pin survived the relocation too
- that JS: 200, 1,590,811 B — the unminified dev React graph

Independently, `dist/server.js:457` carries the specifier byte-for-byte and it
resolves: `plugins/spellbook/skills/astrolabe/dist` + `../../../../../src/…` =
`<repo>/src/astrolabe/surface/index.html`, `existsSync` true.

### `dist/cli.js` is byte-identical

`git diff --stat` on it is empty after the build. That is the whole reason
`buildServer` is a second `Bun.build` call rather than a second entrypoint: one
call with two entrypoints hoists shared modules into a hashed chunk and rewrites
an artifact this chapter did not touch, which Contract 18 verifies by
reproduction.

---

## Magpie — the larger subject, and the one real bug

The brief called magpie "the larger subject by a wide margin" and it is: six
modules and five test files moved against astrolabe's one and two. **It was also
the cheaper of the two to do**, because astrolabe's journal had already answered
every structural question — the missing entry block, the launcher's exit, the
dev specifier's anchor, which wards would red. The brief's ordering ruling (D9)
paid for itself exactly as predicted.

### What moved

`server.ts`, `backend.ts`, `discover.ts`, `persist.server.ts`, `reduce.ts`,
`source.server.ts` and five of the six test files, all into
`src/magpie/backend/`. `shared/` stayed (12 surface importers),
`versions.test.ts` stayed with it, `remove.py` stayed (D13).

**A benefit the brief did not predict:** `src/magpie/backend/cli.ts` had been
importing `backend`, `discover` and `reduce` through
`../../../plugins/spellbook/skills/magpie/scripts/…` since Slice 2. Those three
specifiers are now `./backend`, `./discover`, `./reduce`. The move _removed_ a
cross-root reach rather than adding one — because D10's rule put the CLI and the
modules it actually uses in the same directory for the first time.

### ⛔ The one real bug, and it was already shipped

Full account at the top of this file. `REMOVE_PY` is now
`join(import.meta.dir, "..", "scripts", "remove.py")` — up and back down, the
same trick `cli.ts` uses for `SERVER_SCRIPT`.

**Driven after the fix**, same probe as the fail-first drive:

```
$ … extract
magpie: cut box (object, crop) → …/magpie-c2ff8b09-p53957-files/box.png
{"ok":true,"cut":1,"failed":0,"total":1,"keptWhole":0,"model":"crop"}
$ file …/box.png
PNG image data, 70 x 70, 8-bit/color RGBA, non-interlaced
```

`magpie extract` produces a cutout for the first time since `7bb0f4a`.

### Driven — release mode

Through the launcher, isolated `$MAGPIE_HOME` + `$TMPDIR`: `open --no-open` →
`"mode":"release"` · ready frame on `GET /events?since=0` reports release ·
`GET /` → 200 `text/html` 413 B (the committed `dist/index.html`) · `source` →
`element-add` → `extract` (above) → `close`.

### Driven — dev mode

`SPELLBOOK_SURFACE_MODE=dev`, fresh home: ready line reports `"mode":"dev"` —
the dev import resolved from `dist/` — and `GET /` → 200, 723 B, referencing
`/_bun/client/index-000000009d5a543a.js` (200, 1,667,880 B) and
`/_bun/asset/fb1a5a2389bfcbee.css` (200, 46,529 B, **252** Tailwind markers).
Contract 5's cwd pin holds through the relocation for this spell too.

### The wards, second time round

Everything astrolabe's half predicted, plus one:

- `INTERNAL_ENTRY_POINTS` re-keyed for **both** `magpie/backend/server.ts` and
  `magpie/backend/discover.ts` — `discover.ts` parses args and is
  sibling-imported, so it carries the same exclusion to its new address.
- `terminator-invariant`'s `HAZARD_APPLIES` key moved with it.
- ward 1a's pin moved to `…/magpie/dist/server.js`.
- the re-export inventory's four magpie rows moved to `src/magpie/backend/`,
  keeping the three-way distinction the pin was written to show (`../shared/`
  for the two-sided contracts, `./reduce` for the daemon-only one — now
  `../../../plugins/…/shared/` and still `./reduce`, so the distinction survives
  in a longer specifier).
- ward 1b's `bun`-exemption list went **five → three**. Both departures are the
  same mechanism: `import type { ServerWebSocket } from "bun"` is erased by the
  bundler. **That list is now a floor that only falls** as spells port, so the
  cell says so rather than leaving a future reader to find one entry and assume
  the ward broke.

### `daemon.integration.test.ts` needed the same repair as astrolabe's suite

It spawned `join(SCRIPT_DIR, "..", "scripts", "server.ts")` from `tests/` and
pinned `cwd` to `join(SCRIPT_DIR, "..")` — both correct from the old address and
both wrong from the new one. They are now anchored on an explicit `SKILL_ROOT`
computed from `src/magpie/backend/`, spawning the launcher. **This is the
generalisable half of the relocation cost:** a daemon's tests are full of paths
that were relative to `scripts/`, and every one of them has to be re-derived
from the skill root rather than adjusted by counting `..`.

---

## The brief against the tree — every disagreement, named

The brief's seven measurements were the spine of this chapter and six of them
held exactly. Recorded here because the brief's own rule is that the tree wins
and the disagreement is a finding.

| #   | the brief said                                                       | the tree said                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the launcher pattern transfers verbatim                              | ✅ held. Zero prose edits across the roster                                                                                                                                                                          |
| 2   | `SKILL_ROOT`/`DIST_DIR` survive by accident — assert it              | ✅ held, and asserted rather than reasoned                                                                                                                                                                           |
| 3   | the dev import is the real trap; prove it on a booted dev daemon     | ✅ held. The specifier survives byte-for-byte and the anchor moves twice, exactly as described. **Both spells driven**                                                                                               |
| 4   | magpie's `remove.py` **WILL** break                                  | ⛔ **it already had.** `cli.ts` has imported `backend.ts` since Slice 2, so `dist/cli.js` has resolved a nonexistent `dist/remove.py` since `7bb0f4a`. Not a migration cost — a shipped defect the migration exposed |
| 5   | "three astrolabe surface files" import `state.ts`                    | **four** (`useSession`, `board`, `ProjectCard`, `QuietRow`). Small, and under-stated in the direction that matters                                                                                                   |
| 6   | magpie is the larger subject; do astrolabe first                     | ✅ larger, and **cheaper to do second** — astrolabe's journal had already answered every structural question. D9 paid for itself                                                                                     |
| 7   | both servers end in `process.exit(exitCode)`; not in scope to change | ✅ held, and **not changed**. The exit stayed at its pinned `E-terminal` address by putting it in the launcher (D12), so the inventory needed no edit at all                                                         |

**The one thing the brief did not contain, and it is the first thing that
breaks:** a bundled daemon has **no entry**. `import.meta.main` is false in a
module the launcher imports, so the old `if (import.meta.main)` block is dead
code — the daemon boots, serves nothing, exits 0, and every test fails as "never
bound a port". It is obvious in hindsight and it is not obvious at the moment
you move the file, because the CLI's launcher pattern (which the brief points at
as the exemplar) already solved it and does not say so.

---

## For Phase 2's playbook — what a porting spell must do

1. **Enumerate every `import.meta.*` and every path-pinned non-TS sibling FIRST,
   and drive each one.** No type-check, no unit test and no ward reaches them.
   Magpie's had already shipped broken, behind a `{"ok":true}` envelope.
2. **The daemon needs an exported `run()` and no `import.meta.main` block.** A
   bundle the launcher imports never sets `import.meta.main`, so the old entry
   is dead code and the daemon exits 0 having served nothing.
3. **The dev-mode surface specifier is anchored at `dist/`, not at the source.**
   Keep the string; do not "fix" the `..` count.
4. **Hand-check `INTERNAL_ENTRY_POINTS`.** Every other instrument reddens; an
   exclusion set for an absent member is silent in both directions.
5. **Re-anchor the daemon's tests on an explicit `SKILL_ROOT`** and spawn the
   launcher. Do not adjust `..` counts.
6. **Build the server as its own `Bun.build` call**, or `dist/cli.js` gets
   rewritten by chunk hoisting and Contract 18 reds on an artifact you did not
   touch.
7. **Never write a `*` followed by `/` inside a block comment.**

---

# Chapter 2 — the daemons adopt the spine

Same branch, after the chapter 1 verify pass. Written as the work happened; the
failures are the part Phase 2 inherits.

## The first commit was a ward, and the mutation is why it is trustworthy

D16 said ward 1b's emitted-root exemption swallows `bun`, and the fix had to be
calibrated the way the verifier calibrated the rest. It was, twice:

- **The exact mutation.** `import { serve as __s } from "bun"` appended to
  `plugins/spellbook/skills/astrolabe/dist/server.js`. Before the fix: 18 pass /
  0 fail. After: 17/1, the differential cell naming the file. Restored.
- **The reverse.** Reverting the subtraction (`new Set(builtinModules)`) reddens
  the new synthetic clause instead — so the mechanism is guarded from both
  directions and not only by whatever the roster happens to contain today.

**The finding under the finding:** `BARE_BUILTINS` was DERIVED from the runtime,
which is the house's own rule and is why it was trusted — and deriving it is
exactly what put `"bun"` in it. A derived set is not automatically the right
set; it is the right set only if what you derive it from means what you think.
Bun's `builtinModules` answers "what does this runtime resolve without an
install", and the exemption needed "what does the bundler leave behind after
stripping `node:`". Those are different questions with a 76-entry overlap.

## Where the brief was wrong, and it is the deliverable it was wrong about

**The epoch does not close the restart gap on its own.** The brief says the
client already carries `epochOf`/`onEpochChange`, so "give the daemon an epoch
and the gap closes with no client change". Measured against the tree, that is
false and the mechanism says why: the client detects the change on a frame it
RECEIVES, and the whole bug is that no frame is received.

Driven fail-first, on the chapter-1 bundle, from a temp skill root:

```
$ curl -sN "http://127.0.0.1:56958/events?since=4" --max-time 3 | od -c
        (nothing — zero bytes in three seconds)
$ curl -sN "http://127.0.0.1:56958/events?since=0" | head -1
data: {"id":1,"type":"ready", … "mode":"release"}
```

The daemon is alive, holds a `ready`, and will not send it — because `ready` is
id 1 and the resuming tail asked for `> 4`. A `join` in this state is connected,
silent, and indistinguishable from a quiet board.

So the repair is two-sided, and `createEventLog.subscribe` treating
`since > cursor` as "a cursor from a prior process" is the load-bearing half.
Driven on the real thing — a live `tail --since 0`, `kill -9` on the daemon,
`open` again:

```
{"id":4,"type":"project.add", … "epoch":"e38d0a4f-…"}
{"type":"epoch.changed","epoch":"19c31ba7-…"}
{"id":1,"type":"ready","url":"http://127.0.0.1:56941", … "epoch":"19c31ba7-…"}
```

The new daemon's `ready` arrives under a tail that resumed at 4. That is the
deliverable, and it needed a daemon-side change the brief did not name.

## The two defects nobody was looking for, both found by writing the module down

1. **The monotonic id did not win.** Both daemons wrote
   `const ev = { id: ++eventSeq, ...msg }` under a comment saying "the monotonic
   `id` MUST win over any `id` in the payload, so callers carry a project
   identifier as `projectId`, never `id`". Spread order says the payload wins.
   The comment was the only thing holding it, and it held — nobody has passed an
   `id` — which is precisely why it survived two code reviews. The kit keeps the
   key order (`id` first, so the wire is unchanged) and assigns after the
   spread.
2. **A typo'd cursor opened an empty stream.** `parseInt(param ?? "-1")` yields
   `NaN` for `?since=x`, every `id > NaN` is false, and the tail opens connected
   with nothing in it — the same silent-and-connected symptom as the stale
   watermark, from a different cause. Absent and unparseable are now the same
   request.

Neither is in the census's L1–L7. Both were found by having to write down what
the function does, which is the argument for extraction that no defect table
makes.

## ⛔ A SENTENCE IN A COMMENT CHANGED FOUR UNRELATED SPELLS' STYLESHEETS

`src/kit/wire/eventLog.ts` said "five daemons **grow** an array for the life of
the process". `src/kit/theme/base.css` declares `@source "../"`, so Tailwind
scans every file in `src/kit/` — including prose — and `.grow { flex-grow: 1 }`
was emitted into bounty's, digestify's, grapevine's and imago's CSS. Four
spells' artifacts changed because of a verb.

**`kit-prose-ward` was green.** Its `BARE_UTILITIES` list did not contain
`grow`. What caught it was `dist-check`'s reproduction arm — four
`?? index-*.css` files and four modified `index.html`s in `git status` — i.e.
**downstream, by luck of the artifact being committed**, which is verbatim the
failure the ward's own header describes and claims to prevent. Its prescribed
repair is to add the word; `grow` and `shrink` are added, and a second
pre-existing `grow` was standing in `tailEvents.test.ts` from Phase 1a.

**For the playbook:** when a phase adds files to `src/kit/`, `bun run gate` is
not sufficient. Run `bun scripts/dist-check.ts` and read `git status` for
stylesheet churn in spells you did not touch. A green gate and a dirty artifact
is the pairing to look for.

## What the adoption cost, per spell

**Astrolabe** — the `events`/`eventSeq`/`sseClients`/`sseTimers` quartet became
one `log` plus one `SseClients`; `emitEvent` shrank to a snapshot-flag line and
a call; `sseResponse` became a mapping function that hands presence to the kit's
open/close hooks; the idle and snapshot timers became one `startHousekeeping`;
the whole teardown block became `drainAndStop` plus one loop over its own
presence-debounce timers, which are astrolabe's and belong to it. Net −80 lines
in the daemon and every one of them was a copy of something.

**Magpie** — the same, plus `writeAtomic` deleted in favour of the kit's, plus
its `cleanupDiscovery` learning `unlinkIfMatches` for `magpie-latest.json` (the
session file is unconditionally ours; the latest pointer is not).

**One test cell moved and one changed.** `shouldIdleClose`'s cell left
`astrolabe/backend/server.test.ts` for the kit, where it now also carries
magpie's case. `release-serve.test.ts` read the FIRST LINE of an SSE stream and
now looks for the first `data:` line, because the stream opens with a comment.

## Driven

**L1, both directions, on a real magpie daemon** (`--timeout 5`):

```
14s after boot, with a tail held:   GET /state -> 200 · GET / -> 200 text/html; charset=utf-8 413B
9s after the tail was dropped:      GET /state -> 000   (idle-closed, unwatched)
```

Before this chapter the first line was a dead daemon: magpie's sweep could not
see its subscribers, so an agent tailing a quiet session was killed with its
connection open at the 30-minute floor.

**Dev mode, both spells, through the real launchers** — magpie `"mode":"dev"`,
`GET /` 200/723 B referencing `/_bun/asset/fb1a5a2389bfcbee.css`; astrolabe
`"mode":"dev"`, `GET /` 200/1,667 B referencing
`/_bun/client/index-0000000063e6978e.js`. The dev import still resolves from
`dist/`, which is the line nothing in CI can see.

**Discovery cleanup** — after `astrolabe close`, `$ASTROLABE_HOME` holds only
`registry.json`: `unlinkIfMatches` removed the pid file and the port file went
with its verdict.

**The spawn-path ward, calibrated by re-breaking the real defect.**
`dist/cli.js`'s `REMOVE_PY` reverted to its shipped-defect form; the ward went
red naming file, line, expression and resolved path; restored.

## For Phase 2's playbook — what chapter 2 adds

1. **Prose in `src/kit/` is Tailwind content.** A single English word can change
   an artifact in a spell you have never opened. Check `dist-check`, not just
   the gate.
2. **A derived set is only as good as the question it derives from.**
   `BARE_BUILTINS` was derived, which is why nobody looked at it, which is how
   `"bun"` got in.
3. **The client half of a protocol repair is not the whole repair.** Ask what
   the daemon must SEND before believing a client-side mechanism can act.
4. **Extraction finds defects that defect tables do not.** Two here, both in
   comments that described code they did not govern.
5. **A required argument is a better fix than a fixed bug.** L1 is closed
   because `subscriberCount` cannot be omitted, not because three daemons were
   edited.

## The spawn-path ward asserts nothing about the servers it was written for

Found by the chapter 2 verify pass, and it is the kind of thing only a
population print reveals. The ward's population is right — 8 spells, 12 emitted
files, derived from `buildableSpells()` — but of the **7 governed pins, all 7
come from `dist/cli.js` and the two `dist/server.js` files contribute zero.**
Their only anchors resolve to directories, and `resolveMode`'s
`join(distDir, "index.html")` now runs inside the inlined kit off a
**parameter** rather than an anchor, so it is not an anchored pin at all.

This is inside the ward's declared blind spots and it is not a defect: the ward
catches the real historical defect, catches a novel one it has never seen, and
stays green on a correct up-and-back-down pin. But **its framing implies it
guards the daemons, and today it guards the CLIs.** The coverage will arrive on
its own as the remaining six spells bring servers with real assets into the
build — magpie's `remove.py` is the only non-TS runtime sibling in the house
today, and it is pinned from a CLI.

**The generalisation for the roll:** a ward whose population is derived can
still have zero coverage of the thing it was written for, because population and
coverage are different measurements. Print both.
