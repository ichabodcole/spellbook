# Phase 1 — the shared spine, proven where it costs nothing

**Created:** 2026-09-08 · **Author:** Claude Code (orchestrator), under Cole's
five rulings · **Mode:** brief, not a plan.

Read [the proposal](./proposal.md) and [the decision log](./decision-log.md)
first. The evidence is three investigations dated 2026-09-08; the
[tail convergence design](../../investigations/2026-09-08-tail-reader-convergence.md)
carries the signature you are implementing and you must read it in full.

---

## Phase 0 result — read this before scoping anything

**The daemon CAN build.** `src/build.ts:95` says _"CLIs ONLY. A server does
bundle, but drags the entire surface graph into the backend artifact; that is
unruled and out of scope. Do not add server.ts."_ That was accurate about the
default and is no longer the whole story:

```
bun build .../astrolabe/scripts/server.ts --target=bun --external '*/surface/index.html'
  → Bundled 2 modules in 4ms · server.js 20.49 KB
```

Without the flag it dies compiling `src/astrolabe/surface/styles.css`
(`@import "tailwindcss" source(none)`), because the bundler follows the daemon's
dev-mode `await import(…/surface/index.html)`. The external is **safe**: that
import sits behind `mode === "dev" ? … : undefined` and is dead code in a
release artifact, which the daemon's own comment at `server.ts:518-519`
independently states.

**This is Phase 2 information, not your work.** It is here so you do not
re-derive it and do not treat the `build.ts` comment as a closed door. **Do not
bring any server into the build in this phase.**

## The mission

Extract the **CLI-side** shared modules and prove them on **astrolabe and
magpie** — the two spells whose CLIs already build and already import
`src/kit/lib/printJson`, so neither pays a migration. Ruling D1: settle the
module boundaries against real consumers before anyone pays for a build.

**In scope, and nothing else:**

1. **`tailEvents<Ev>()`** — the SSE tail client. The signature is drafted in the
   convergence design; treat it as a strong proposal you may improve, not as
   settled. Astrolabe and magpie adopt it.
2. **The CLI error contract** — `CliError` / `die` / `EXIT_FOR` / the kind
   taxonomy. Magpie has the full taxonomy; astrolabe has a fourth, minimal
   shape. Converge them.

**Explicitly out of scope:** every daemon-side module (event bus, `sseResponse`,
`serveFromDist`, `resolveMode`, `contentTypeFor`, housekeeping, `drainAndStop`),
the discovery primitives, all micro-utilities, and the other five spells' tails.
They are later phases. A phase that grows is a phase nobody can verify.

## What proves this phase worked

**B1 must die by construction.** Astrolabe's tail resolves the daemon base
**once** (`src/astrolabe/backend/cli.ts:527,535`) and reconnects to that fixed
URL forever; astrolabe binds an ephemeral port, so `join` — the verb designed to
run for hours carrying presence — spins silently against a dead port after any
daemon restart. The design's central decision, `resolve` being a **callback
called before every connect attempt rather than a captured URL**, repairs this
without anyone fixing it. **Write the test that fails against today's astrolabe
and passes after.** That test is this phase's headline deliverable.

Also expected to fall out, and worth a cell each where cheap: B2 (no idle
watchdog), B3 (the P0f drain fix applied to the `closed` frame but not to the
signal handler — the bug sits twelve lines above its own fix), B4 (EPIPE).

## Design constraints

- **The kit is a leaf.** Nothing under `src/kit/` may import out of `src/kit/`.
  That is `grimoire`'s ward 2, not a convention, and it is what makes the kit
  safe to inline into any spell's bundle. Read `src/kit/lib/printJson.ts` — its
  header explains why it is deliberately dependency-free.
- **D5: naming and layout are yours to decide, from the modules.** Cole deferred
  it explicitly so it would be decided on evidence. `src/kit/lib/` currently
  holds a backend-only emitter beside a surface-only helper, so it is a residual
  category rather than a category. A cut worth considering is **contract versus
  utility** — change `die` and an agent observes something different and the
  spell needs an acc re-grade; change `sleep` and nothing observable moves.
  **Record your reasoning in the decision log.**
- **Design the signature against all seven tails, adopt it in two.** The
  convergence design analysed every one; grapevine is the hardest call site and
  is _not_ adopting in this phase. Check on paper that your signature serves it,
  and say so. If it cannot, that is a finding to report, not to route around.
- **Behaviour is otherwise unchanged.** Astrolabe and magpie must do what they
  do today, minus the defects named above.

## ⛔ The scars must be re-homed, not deleted

Five copies of the `P0f SHAPE B` comment document a real 23-minute hang that
shipped. Bounty's carries the fullest narrative; astrolabe's rewrote the
per-site precondition. Collapsing seven tails into one collapses that reasoning
into one place — **that is the point, and it is also the risk.** The surviving
explanation belongs on the shared client, written once and well. The same holds
for mind-mapper's measured Bun 1.3.14 finding (that `try { enqueue } catch`
never fires on an orphaned stream) if it bears on the client.

**A convergence that loses the scars re-earns them.**

## Read but do not touch

`mind-mapper/scripts/tail.test.ts` is **the only executable specification of
tail behaviour in the repo** — four behavioural tests over the watchdog, abort
and epoch. Read it as your specification. **Do not modify it and do not adopt
mind-mapper's tail in this phase**; re-pointing those tests is a later phase's
deliverable, and they are the acceptance criteria for the whole tail half.

## Conventions that bite

- `bunx biome check --write` on changed `.ts/.tsx` before every commit.
- **Gate UNPIPED, exit read from a file:**
  `bun run gate > /tmp/g.log 2>&1; echo $?`.
- Astrolabe and magpie both ship a **built** `dist/cli.js`. Rebuild and commit
  it in the same chapter as any source change, or Contract 18 breaks.
- Story chapters. Every daemon you start gets its own home under the session
  scratchpad and is torn down. **Never kill pids 23127 or 66902.**
- **Never stage, stash, commit or edit `skills-lock.json` or
  `.claude/skills/shadcn/`.**
- **Do not push. Do not merge.**
- Trailers: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  and `Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.

## Records

1. `decision-log.md` — exists; append. Your D5 reasoning goes here.
2. `phase-1-journal.md` — what held, what the design got wrong, what you had to
   discover. Later phases roll this to five more spells and will be written from
   your journal.
3. `sessions/2026-09-08-the-shared-tail.md` — what shipped by sha, what was
   driven, what was not.

## Done means

- The modules exist under `src/kit/`, the kit-is-a-leaf ward is green, and the
  layout decision is recorded with its reasoning.
- Astrolabe and magpie use them; their `dist/cli.js` are rebuilt and committed.
- **A test that fails against today's astrolabe and passes now** (B1).
- Gate green unpiped, `bun scripts/dist-check.ts` exit 0.
- The signature is checked on paper against all seven tails, with grapevine's
  verdict stated explicitly.
- All three records written.
