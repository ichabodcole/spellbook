# Investigation: what the backends are independently reinventing

**Date:** 2026-09-08 · **Status:** reconnaissance closed; a narrow detailed pass
is recommended, not yet scoped · **Run by:** one broad-read agent over the
backend corpus, verified in part by the orchestrator · **Asked by:** Cole
**Feeds:** the backend build-and-share project (seams Contract 3's DIRECTION)

## Summary

**There is a lot of duplication, and the prior census saw about a fifth of it.**

`docs/backlog/2026-09-03-six-dies-the-cli-boilerplate-census.md` measured ~25
duplicated lines per spell and concluded, correctly for what it measured, that
"extraction saves ~100 lines repo-wide — which on its own does not justify
anything." This pass estimates **1,500–2,500 lines** of independently
open-coded, structurally identical procedure, concentrated in the daemon
lifecycle and the CLI's SSE tail.

**The real cost is not lines. It is that a fix costs six edits and reliably gets
one to four of them** — and this investigation found four verified instances of
exactly that, two of them created the day before it ran.

## The question, as posed

> _"I'm curious if that included not just necessarily the same named functions …
> but actually looking through the code and seeing if we're essentially
> duplicating utility functions — stuff that's like, all of a sudden if you
> actually do a deep dive you realize we're reinventing a lot of the same things
> across CLIs that aren't maybe the same function name but they're just sort of
> scattered code that is essentially doing the same thing."_ — Cole, 2026-09-08

## Why the prior census could not answer it

The 2026-09-03 census compared **named function declarations** by normalised
body. That design catches divergence between things already recognised as "the
same helper" — and it did, finding `die` implemented six times with one pair
agreeing.

**It is structurally blind to logic that was never given a name.** None of the
ten clusters below are named functions everywhere they occur; most are inline
blocks inside larger functions. A declaration census cannot notice that six
daemons each grew their own event bus.

## The tell: the comments were copied too

The characteristic artifact is not a shared helper that drifted. It is **the
same explanatory comment, verbatim, in files that share no code**:

- the `P0f — SHAPE B` drain-callback comment — **four files** (glamour, imago,
  magpie, astrolabe)
- the Contract 5 `daemonCwd()` block — **seven files**
- `/* persistence is best-effort */` — three files
- the "Bun.spawn can't detach a surviving daemon" note — three files

And the copying is acknowledged in prose: magpie's discovery write says _"as
imago does it"_; mind-mapper's error taxonomy is annotated _"magpie's taxonomy,
bounty's delivery"_; a version reader says _"astrolabe's pattern, via
mind-mapper"_. **The house knew it was copying and had no way to share.** That
is the finding, not an accident of style.

Only `src/kit/lib/printJson.ts` is genuinely shared today, by the two spells
that build.

## The clusters, ranked

1. **The CLI's SSE tail reader** — ~150 lines × 6, three near-verbatim. Same
   `boundId`/`grounded` pinning, same `delay = Math.min(delay*2, 5000)`, same
   frame splitter, same keepalive line. `glamour/scripts/cli.ts:1269`,
   `imago/scripts/cli.ts:255`, `src/magpie/backend/cli.ts:399`. Astrolabe's is a
   fourth variant; mind-mapper's (`cli.ts:656`) is a structurally different and
   better fifth (AbortController + idle watchdog) that splits on `"data: "`
   where the others split on `"data:"`. Grapevine's `cmdTail` is a sixth.
   **Heavily drifted at the top, byte-identical in the middle.**
2. **Daemon discovery + session pointer** — two rival conventions (per-session
   tmpdir JSON: bounty, glamour, imago, magpie; singleton
   `$HOME/daemon.{port,pid}`: astrolabe, grapevine, mind-mapper), with a third
   reader inside bounty itself (`join.ts:78`).
3. **Surface mode / dist serving** — `resolveMode()` byte-identical in 8;
   `daemonCwd()` byte-identical in 7, each with its own hand-counted `../`
   depth; `serveDist()` in 8, 5 byte-identical; `STATIC_CONTENT_TYPES` in 8,
   already diverged.
4. **Daemon event bus** — 5 copies of the same ~80 lines.
   `bounty/scripts/server.ts:936` and `imago/scripts/server.ts:796` are
   **byte-identical**.
5. **Daemon housekeeping** — 6 copies of idle-timeout + snapshot debounce +
   close-and-drain.
6. **CLI error contract** — the full `ErrKind`/`EXIT_FOR`/`writeEnvelope`
   taxonomy written out three times with identical comment prose, while three
   other spells still use bare `process.stderr.write` + `process.exit(2)` and
   astrolabe has a fourth shape.
7. **Command table + acc declaration emitter** — 2 full (glamour, grapevine), 2
   partial. The stage-2 stray-flag check exists three times.
8. **Micro-utilities** — `openBrowser` ×8 in three dialects, `randHex` ×5,
   `MIME_BY_EXT` ×5, `readPluginVersion` ×6 at three different relative depths,
   `readStdin` ×5 with three trim semantics, filename sanitizers ×4.
9. **Daemon spawn handshake** — 6 copies, deadlines ranging 3s to 45s, two
   different handshake mechanisms.
10. **Snapshot persistence** — 5 copies.
11. **Test harnesses** — 7 `release-serve.test.ts` files sharing a shape and
    several test names. ⚠ Weakest claim here: it rests on filenames, one grep,
    and three files actually read.

## Live bugs — one copy fixed, siblings left standing

**This set is the argument for extraction that "~100 lines saved" could never
make.** The first two were verified independently by the orchestrator.

| defect                                        | fixed in                                  | still present in                               |
| --------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| no `idleTimeout` on `Bun.serve`               | astrolabe, bounty, grapevine, mind-mapper | **glamour, imago, magpie**                     |
| `readSession` swallows every error as absence | glamour (2026-09-07)                      | **imago, magpie, bounty**                      |
| non-atomic session-pointer write              | glamour (2026-09-07)                      | **imago, magpie, bounty**                      |
| `STATIC_CONTENT_TYPES` charset                | bounty, grapevine, digestify              | astrolabe, glamour, imago, magpie, mind-mapper |
| idle-close ignores live subscribers           | astrolabe, bounty                         | glamour, imago, magpie                         |
| `--stdin` trim semantics                      | —                                         | three different meanings across five spells    |

**`idleTimeout` is the worst.** Bun's default is 10s and it kills held SSE
connections; the three daemons without it run a **15s heartbeat against that
default**. Astrolabe's comment names the observed failure it was added for:
presence flap and an event-log flood. Four spells hit that wall and fixed it.

**Two of these rows were widened by a fix.** Glamour's `readSession` and atomic
write were repaired on 2026-09-07 in a branch scoped to a flaky test — which
turned two roster-wide defects into two roster-wide _inconsistencies_. Fixing
one copy is the mechanism that produces this table.

## Where it is concentrated

- **Daemon-side is worse than CLI-side.** CLI duplication is wide and shallow;
  the daemon's event-bus + lifecycle + dist-serving spine is one design
  implemented six times.
- **imago is the source everyone copied from.** Magpie's CLI and daemon are
  close to a fork of it; glamour's is that fork with an error contract added.
- **grapevine and mind-mapper are the outliers** — genuinely their own inside,
  both still carrying the copied shell.
- **digestify pays the tax for nothing.** One-shot, no session, no CLI, and it
  still carries `serveDist`, `resolveMode`, `STATIC_CONTENT_TYPES`,
  `openBrowser`, `randHex`, `MIME_BY_EXT` and `escapeHtml`.

## Recommendation

**Run a detailed pass, but a narrow one**, and do not repeat the prior census's
method — comparing named declarations cannot see any of the clusters above.
Point it at three things:

1. **The daemon spine.** One table: for each of `resolveMode` / `serveDist` /
   `STATIC_CONTENT_TYPES` / event bus / `sseResponse` / idle+snapshot /
   discovery write / close-and-drain — which spells have it, and which
   divergences are deliberate versus stale. That table is the whole decision.
2. **The tail reader.** Six implementations of one protocol client, one of them
   (mind-mapper's) materially better. Worth a convergence design, not a diff.
3. **The live-bug set as a single finding**, since it is the cost argument.

**Do not spend it on the micro-utilities.** They are real and numerous and the
least interesting part; a decision about the spine settles them as a side
effect.

## ⚠ Coverage — what this rests on

This was a **reconnaissance pass, deliberately scoped as a vibe check**, not a
census. Roughly **55–60% of the corpus went unread**.

- **Read in full:** astrolabe (cli, server, state + backend/cli), imago (cli,
  imageOptimize.server), glamour (all five scripts), magpie (persist.server,
  source.server, backend, cli), `src/kit/lib/printJson.ts`.
- **Read substantially:** `src/magpie/backend/cli.ts` (~800/1,184), bounty cli,
  grapevine cli + daemon head, mind-mapper cli head + tail loop, digestify.
- **Greps only:** the server interiors of bounty (1,689 lines), imago (1,724),
  magpie (966), mind-mapper (1,708), and the middle of grapevine's daemon.
- **Not read at all:** all 20 mind-mapper domain modules (~3,300 lines),
  `magpie/discover.ts`, `magpie/reduce.ts`, `glamour/reduce.ts`.

The unread portion is concentrated in domain interiors, where the pass expected
**less** duplication rather than more — but that expectation is unverified and
is the most likely place for this report to be wrong.

## Related

- `docs/backlog/2026-09-03-six-dies-the-cli-boilerplate-census.md` — the prior
  declaration census; this supersedes its scope, not its findings
- `docs/investigations/2026-08-29-shared-code-and-the-build-boundary.md`
- `.anthill/dev/seams.md` — Contract 3, whose 2026-09-04 amendment carries the
  ruling that every spell gets a build: _"The open question is ORDER, not
  WHETHER."_
- `docs/backlog/2026-08-08-cli-empty-vs-failed-read.md`,
  `2026-08-06-discovery-pointer-is-machine-global.md`,
  `2026-09-03-five-spells-write-a-session-pointer-into-a-shared-tmpdir.md`,
  `2026-08-08-tmpdir-leak-house-wide.md` — four earlier sightings of this same
  animal, each filed separately as its own animal
