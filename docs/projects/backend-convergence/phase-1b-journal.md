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
