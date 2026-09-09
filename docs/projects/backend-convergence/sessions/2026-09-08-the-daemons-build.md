# 2026-09-08 — the daemons build, and then they share a spine

**Agent:** Claude Opus 5 (1M context), as the implementing agent · **Branch:**
`feat/backend-spine-phase-1b` · **Mode:** brief-driven, single implementer;
orchestrator reviews, Cole finalizes.

**Phase 1b of the backend convergence**, both chapters. Chapter 1 moved
astrolabe's and magpie's daemons into the build and was independently verified
before chapter 2 began (D9's gate). Chapter 2 is the adoption, and this file
covers the whole phase with the weight on chapter 2.

---

## What shipped, by sha

| chapter | sha       | what it is                                                                                                                                                                      |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `ded9ccd` | **astrolabe relocates and builds** — `src/astrolabe/backend/server.ts` → `dist/server.js`, launcher at `scripts/server.ts`, wards and tests re-anchored.                        |
| 1       | `3749a78` | **magpie relocates and builds** — six modules and five test files move; `magpie extract` works again for the first time since `7bb0f4a`.                                        |
| 1       | `04e0abd` | **The chapter 1 records** — journal, D9–D14, and the verify pass's two ward rulings (D15, D16).                                                                                 |
| 2       | `9db9829` | **Ward 1b stops swallowing `bun`** (D16) — the emitted-root exemption minus the names the other two exemptions own. Calibrated by mutation, both directions.                    |
| 2       | `7d876f7` | **The daemon-side spine** — six modules in `src/kit/wire/`, both daemons adopting, the heartbeat crossing the seam, astrolabe's epoch, 40 new unit cells, both `dist/` rebuilt. |
| 2       | `ea68ece` | **The spawn-path ward** (D15) — every path a built backend pins must resolve from the emitted location; population derived from `buildableSpells()`.                            |
| 2       | (this)    | **The records** — this file, the chapter 2 journal, D17–D22.                                                                                                                    |

## The numbers

|                                                    | before this phase | after                                              |
| -------------------------------------------------- | ----------------- | -------------------------------------------------- |
| `bun run gate`, unpiped, exit read from a file     | 0 · 1,891 / 0     | **0** · **1,955 pass / 0 fail** · ~266 s           |
| `bun scripts/dist-check.ts`                        | 0                 | **0** — 8 spells, 28 tracked files                 |
| daemons that build                                 | 0                 | **2** (`dist/server.js`, committed)                |
| daemon-side spine concerns with one implementation | 0                 | **6** modules, both servers using all six          |
| hand-written event logs in the two spells          | 2                 | **0** + 1 shared                                   |
| hand-written `sseResponse` in the two spells       | 2                 | **0** + 1 shared                                   |
| hand-mirrored heartbeat expressions                | 4 (2 per spell)   | **0** — one per-spell constant, both halves import |
| census defects closed by construction              | —                 | **L1, L3, L5** (+ two the census never found)      |

## The three things this phase was for

**1 · The seam is real, and the heartbeat is the proof.** `TAIL_IDLE_MS` was
derived in each CLI by copying its own daemon's heartbeat expression, under
comments in all four files saying so, because a CLI importing a daemon drags the
server graph into `dist/cli.js`. There is now one
`src/<spell>/backend/heartbeat.ts` per spell — a leaf that imports the kit's
derivations and nothing else — and both halves read it. **A value that could not
previously cross the boundary now crosses it**, and the comments asking the next
author to remember are deleted rather than annotated.

**2 · Defects are closed by construction, not by editing.** `subscriberCount` is
a REQUIRED argument of `shouldIdleClose`, so L1 — an agent tailing a quiet board
killed with its connection open — cannot be re-expressed. Driven on a real
magpie daemon with a five-second floor: alive at fourteen seconds with a tail
held, gone nine seconds after it dropped.

**3 · The instrument gap D15 named is closed.** The spawn-path ward resolves a
built backend's anchor arithmetic the way the runtime will and asserts the file
is there. It governs seven pins today — both spawn targets, `remove.py`, both
`dist/index.html` probes, and the `plugin.json` both CLIs read — and its
population comes from `src/build.ts`'s own `buildableSpells()`, so the next
spell to build arrives in the ward on the same commit.

## What was driven, and how

Everything below was run, not argued. Every daemon got its own home under the
session scratchpad and was torn down; nothing outside those homes was touched.

- **The `bun` ward mutation**, exactly as D16 specified: planted in
  `dist/server.js`, ward red (17/1) where it had been green (18/0), restored.
  And the reverse mutation, reverting the fix, reddening the synthetic clause.
- **The epoch restart, fail-first.** The chapter-1 bundle booted from a temp
  skill root answers `/events?since=4` with zero bytes over three seconds while
  serving its `ready` happily at `since=0`. The chapter-2 daemon answers the
  same request with the `ready`. Then the real thing: a live `tail`, `kill -9`,
  a respawn, and `{"type":"epoch.changed",…}` followed by the new daemon's
  `ready` under a tail that had resumed at 4.
- **L1, both directions**, on magpie with `--timeout 5` (above).
- **Dev mode, both spells, through the real launchers** — `"mode":"dev"` on the
  ready frame and Bun's dev-bundler asset paths in the served document. This is
  the line nothing in CI can see, and it still resolves from `dist/`.
- **Release mode, both spells** — `text/html; charset=utf-8`, the committed
  entry document, the `: connected` opening comment, the `ready` frame.
- **Discovery cleanup** — after `astrolabe close`, only `registry.json` remains:
  `unlinkIfMatches` removed the pid file and the port file went with its
  verdict.
- **The spawn-path ward, against the real defect** — `REMOVE_PY` reverted to its
  shipped-defect form in `dist/cli.js`, ward red naming file, line, expression
  and resolved path, restored.

## What I could not verify

- **That the seven other daemons would adopt these modules cleanly.** Only two
  consumers exist. `serveFromDist` deliberately excludes the URL mapping because
  digestify and grapevine diverge there, but that is read off the census, not
  driven — neither spell was booted against the shared module.
- **The browser.** Chapter 1's verify pass rendered both surfaces in a real
  browser with HMR observed. Chapter 2 changed the SSE and dist-serving paths
  and I drove them with `curl` and the CLIs, not with a browser. The WebSocket
  path is unchanged by this chapter and untested by me.
- **The bounded buffer under real load.** `REPLAY_BUFFER_SIZE` is 1000,
  inherited from mind-mapper. No daemon in this session emitted more than a
  handful of frames, so the eviction path is covered by a unit cell and by
  nothing else.
- **That `charset=utf-8` breaks no consumer.** One test cell asserts by
  `toContain`. No browser or client outside this repo was checked.

## Where the documents disagreed with the tree

The brief's own rule is that the tree wins and the disagreement is a finding.

| the document said                                                                             | the tree said                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| brief: "give the daemon an epoch and the gap closes with no client change"                    | ⛔ **No.** The client acts on a frame it RECEIVES and the bug is that none is sent. The daemon must also replay when the cursor is beyond its own — the load-bearing half. Driven fail-first. D19.                                                                      |
| brief: re-home "`resolveMode`'s note that a hashed `index.html` makes release mode invisible" | **No such scar exists.** The live ones are bounty's "the FILE, never the directory" and magpie's "`dist/` existing is not the discriminator". Both re-homed; the hashed-entry hazard is written down as the consequence it is, since it is true and nobody had said it. |
| census: the `bun` exemption's differential cell governs `dist/`                               | It could not see a runtime `bun` import there at all — `builtinModules` contains `"bun"`. D16, closed first.                                                                                                                                                            |
| both daemons: "the monotonic `id` MUST win over any `id` in the payload"                      | The spread order let the payload win. The comment was the only thing holding it. Now enforced.                                                                                                                                                                          |
| `kit-prose-ward`'s claim to catch prose leaks before the artifact                             | It missed `grow`, and `dist-check` caught it downstream in four unrelated spells' stylesheets — the exact failure its header warns about. D22.                                                                                                                          |

## The scars, and where they now live

| scar                                                                            | home now                                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `try { enqueue } catch` never fires on an orphaned stream (Bun 1.3.14)          | `src/kit/wire/sse.ts` header — with the teardown funnel it justifies               |
| bounty's `shouldIdleClose` rationale ("linger after the LAST subscriber")       | `src/kit/wire/housekeeping.ts`, on the function                                    |
| bounty's shutdown watchdog                                                      | `drainAndStop`'s header, as a NAMED absence with the reason and the re-entry point |
| `resolveMode` — the FILE, never the directory; `dist/` is not the discriminator | `src/kit/wire/serveDist.ts`, both halves, plus magpie's own local history          |
| the atomic-pointer torn read (glamour, 2026-09-07)                              | `src/kit/wire/discovery.ts`, on `writeFileAtomic`                                  |
| the 23-minute hang behind the raced `server.stop`                               | `drainAndStop`'s header and a cell that hangs `stop` on purpose                    |

## For whoever picks this up

The five remaining spells port into a spine that now exists. The journal's
playbook section is the thing to read first; the two lines that will cost the
most time are **prose in `src/kit/` is Tailwind content** and **a bundled
module's `import.meta.dir` is the emitted directory** — one changes artifacts
you did not touch, the other changes nothing until a user runs the verb.
