# Spell backends — how a spell is built, shipped and spawned

**Created:** 2026-09-09 · **Last Updated:** 2026-09-09 · **Status:** ⚠
**ACCUMULATING — NOT YET AUTHORITATIVE**

> **Read this banner before you trust anything below.** This document is being
> written by the backend convergence as it runs, not after it. Five of eight
> spells now build and share the spine — astrolabe, magpie, glamour, imago and
> bounty (astrolabe's and magpie's CLIs built before the convergence; all five
> now build their daemons too). **Two subjects still ahead are the ones most
> likely to change the shape described here:** grapevine, whose event bus the
> shared spine cannot serve, and mind-mapper, the sibling half the spine was
> converged toward. The per-spell caveats table is filled in by each port as it
> lands; the prose sections are written when the last one does.
>
> **Until then, treat the caveats table as the reliable part** and the outline
> as a promise.

---

## Why this document exists

Cole, 2026-09-09: an architecture doc explaining "how we build these apps — the
structure of the source directory, how the elements relate, and the caveats we
found in different apps."

The rulings and the defects are already recorded — `decision-log.md` (D1–D54),
the phase journals, playbook Phase B, three census investigations. **What none
of those capture is shape that is not a defect**: that digestify has one entry
and it is not called `cli`, that bounty's `join.ts` is a second participant
rather than a helper, that grapevine names its daemon `daemon.ts`. Facts like
those never become decision-log entries and are archaeology within weeks. Hence
the table below, appended to by each port at the moment it learns something.

## Outline — written when the roster is uniform

1. **What a spell is** — a skill folder an agent spawns, plus a surface a human
   opens; why the two halves ship differently.
2. **The layout, as a file tree** — `src/<spell>/{surface,backend}/` as authored
   input; `plugins/spellbook/skills/<spell>/{scripts,dist,shared,assets}/` as
   the deployed artifact. What is generated, what is committed, what is both.
3. **The seam** (⛔ **this one gets a diagram**) — source → `bun run build` →
   committed `dist/` → launcher at a fixed path → spawned by an agent. The shape
   is counter-intuitive in three ways and prose has failed at it repeatedly in
   this project's own briefs: a **generated** file is committed; a launcher
   containing **no logic** is the fixed contract; and the kit crosses the
   boundary at **build** time, not run time, which is what makes "the kit is a
   leaf" load-bearing rather than stylistic.
4. **The shared spine** — `src/kit/wire/` is what a caller observes (D7);
   `src/kit/lib/` is the honest residual; nothing under `src/kit/` imports out
   of it, and that is what makes it safe to inline into any bundle.
5. **Two discovery conventions, deliberately** (D3) — session-JSON for
   multi-session spells, singleton `port`/`pid` for standing daemons. Diagram
   only if it shows both in one frame; otherwise a table.
6. **The contracts** — 3, 4, 5, 18, 19 in prose, by consequence rather than by
   number.
7. **The instruments** — what each ward actually guards, and the rule four
   instrument defects produced (D42): _a subject an instrument names and does
   not examine must produce a row saying "not looked at"; absence of a finding
   must never be spelled the same way as absence of a subject._
8. **Per-spell caveats** — the table below.

**What does NOT get a diagram:** the layout (a file tree IS the picture) and the
module inventory (a table says it better and stays current).

## Per-spell caveats — APPEND AS YOU PORT

One row per spell. Shape, not defects — defects go to `decision-log.md`, live
inconsistencies go to
[the conformance register](../projects/backend-convergence/conformance-register.md).

| spell           | entries                     | shape worth knowing                                                                                                                                                                                                                                                                                                              |
| --------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **astrolabe**   | `cli`, `server`             | Singleton daemon per `$ASTROLABE_HOME`; binds an ephemeral port, so a tail that captured a URL cannot survive a restart (B1). Its event log stamps an epoch; four other daemons do not.                                                                                                                                          |
| **magpie**      | `cli`, `server`             | Ships a **Python** runtime sibling (`remove.py`) resolved from the emitted location — the first non-TS pinned path, and the defect class that produced the spawn-path ward. Daemon heartbeats on a literal 15,000 with no override.                                                                                              |
| **glamour**     | `cli`, `server`             | A fork of the imago line, so the pattern transfers. Its `shared/` is imported by the surface and stays in the skill folder. Only spell with an `acc.config.json` among the ported set at port time (CONFORMANT L0, and the port had to preserve it).                                                                             |
| **imago**       | `cli`, `server`             | Daemon is 1,765 lines — larger than glamour's whole backend. Surface reaches into the skill folder **33 times**. Emits payload-bearing event types, which is how a payload `id` came to collide with the tail cursor. No acc config.                                                                                             |
| **bounty**      | `cli`, `server`, **`join`** | **Three** caller-facing entries; `join.ts` is a WebSocket _participant_ an agent spawns directly, not a helper — daemon-shaped, its exit terminates a live socket. Serves `assets/` (favicon, wordmark, two mascots, a README) from the skill folder. Where half the spine was copied FROM, so adoption ran backwards in places. |
| **digestify**   | **`review` only**           | ⚠ _not yet ported._ One entry, and it is **not** called `cli` — an agent following a cli/server playbook literally will conclude the spell is unbuildable. Single-shot rather than standing.                                                                                                                                     |
| **grapevine**   | `cli`, **`daemon`**         | ⚠ _not yet ported._ Names its daemon `daemon.ts`. Its event bus **cannot be served** by the shared spine: replay reads a durable `.jsonl` off disk and subscriber records carry presence metadata.                                                                                                                               |
| **mind-mapper** | `cli`, `server`             | ⚠ _not yet ported._ The sibling the spine converged toward (`sseResponse`, the event bus). Owns `tail.test.ts`, the only executable specification of tail behaviour in the repo.                                                                                                                                                 |
