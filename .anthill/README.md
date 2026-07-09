# team — how this team works (SOP)

The standard operating procedure for the agent team that builds this project. A **map, not a
manual** — it points at the source of truth rather than restating it. This is a **seed**: everything
here is meant to evolve by use, not stand as the final answer. The team coordinates on the
**`spellbook`** grapevine channel (substance) and the bounty board (task state); **prospero** leads.

## The idea: living context (stigmergy)

The team is **ephemeral agents in durable seats**. An agent's hard-won understanding would evaporate
between sessions — so each seat keeps a committed **living doc** (its brain), and the next agent in
that seat re-grounds from it. We're ants; the docs-and-code are the anthill; the **trail carries the
memory and shapes the next worker**. The docs are not documentation — they are the **pheromone trail
the next instance follows**.

### The three principles (the soul of the method)

1. **Stigmergy — docs as pheromone.** Each agent is an ant: ephemeral, but it leaves context for its
   successor. **Curation = strengthening the load-bearing trails and letting unimportant ones fade**,
   called over time. A lean, true trail beats an exhaustive, rotting one.

2. **Running capture → curated synthesis.** Don't wait for the end. Keep a cheap **running session
   scratch** as you work (`.anthill/scratch/<handle>/<date>-<slug>.md`, gitignored) — "this just bit
   me," "this seam is fuzzy." **Finalize** is where those are articulated into durable form for the
   next agent. Cheap capture, deliberate synthesis.

3. **The anthill adapts to the work.** Structure — app, process, **and team** — is mutable in service
   of the work. Persistent friction (toe-stepping, a seam that won't hold, an overloaded or idle
   seat) is a **signal to reshape, not to endure**.

## Three homes — where knowledge lives

- **Taste → the seat doc** (`dev/<handle>.md`) — each seat's own face: scope + boundaries,
  relationships, reflexes, anti-patterns, hard-won lessons. Opinionated. **Capture judgments, not
  file maps** — the reasoning and the generalizable lesson, never a lesson-less event.
- **Truth → `dev/seams.md`** — the contracts _between_ seats, stated **once**, owned by the
  authoritative seat. Seat docs **point** at it, never restate it.
- **Proof → the tests** — executable where it exists. A lesson pinned to a green test can't rot.

**The one strict rule: defer to one source — don't restate shared truth.** Restating a contract in
three docs guarantees drift. Everything else stays flexible.

## The seats

See **`dev/README.md`** for the roster + division of labor. Each seat has its own living doc under
`dev/`. Decisions and questions route to the human **through prospero** (the lead / liaison), not
direct.

## Tools

- **Bounty board** — task state (`todo → doing → review → done`). The **doer owns its card's
  lifecycle**; the lead creates + assigns (leaves in `todo`) and hands off on the vine; the reviewer
  closes. The board is _state_.
- **Grapevine (`spellbook`)** — the back-channel. Seats discuss, coordinate, reconcile. The vine is
  _substance_. Decisions route to the human **through prospero**, not direct.
- **The CLI** — `anthill` (run from the plugin; `convene` / `join` / `spawn` / `status` / `commit` /
  `down` wrap grapevine + bounty + tmux). `anthill join <handle>` emits your grounding docs + an
  action checklist — that checklist is the single source; don't restate it.

## Workflow — convene → work → finalize

- **Convene** — the lead grounds, gathers the work from the human, stands up coordination (channel +
  board), seeds cards, briefs + spawns the seats the **current phase** needs. Composition is a
  _hypothesis_, not law.
- **Work** — builders build; the lead and seats watch for **structure signals** (toe-stepping, a
  renegotiated seam, an overloaded/idle seat, a verify finding that bounces work back).
- **Finalize (+ reflection)** — each seat curates its scratch → seat doc; a shared `seams.md` pass;
  then the **structure reflection** (below). The lead lands the doc commits and tears down the
  session.

**Verification is dynamic, not end-of-line.** A verify seat engages at **verification points** —
which may be early (we need tests before building further), mid (prove a feature), or late — and
often **stays** and ping-pongs with builders (fail → back to the owner → re-verify). The lead decides
per phase when to pull each seat in; the plan's phases drive that, not a fixed end slot.

## Committing on the shared tree

Seats share **one working tree + one git index**. A bare `git commit` (after `git add`) takes the
whole index → it **sweeps a peer's staged file** into your commit; concurrent commits also race git's
index. So:

**Use `anthill commit -m "<msg>" <path>…`** for every land. It (1) commits the **named paths only**
(refuses to run with no paths — no accidental sweep) and (2) holds a **serialize lock** so concurrent
seats queue instead of racing. The same command **is** the atomic cross-seat land: the lead collects
every seat's paths and passes them in one call → one commit across the seats. (The raw discipline
holds if you commit by hand: `git commit -m "<msg>" -- <explicit paths>`, never `git add -A`.)

## Shared practices (true for every seat)

- **Root-cause before cutting.** Report the root cause with evidence _before_ editing a fix — don't
  cut a phantom, don't assert a cause you haven't proven.
- **Verify the real artifact, not a proxy.** Trust the rendered output; distrust the measurement or
  the stub. A proxy will eventually lie.
- **One sentence per line in the living docs.** These docs live in the host repo, so its formatter
  (prettier / biome) may reflow them — and a hard-wrapped continuation line can be mangled into a
  stray list bullet, corrupting the trail. One sentence per line makes a reflow a no-op.

## Finalize + the structure reflection

At finalize, **synthesize**: promote the durable lessons from your scratch into your seat doc (or
`seams.md` if it's a boundary truth), **prune**, keep it lean. Pin a lesson to a green test where you
can; to a durable concept or a commit otherwise; never to a transient line/file ref.

Then the **structure reflection** — the team turns the lens on itself:

- **Where did we step on each other?** (overlapping scope → a boundary to draw or a seat to split.)
- **What are the natural seams?** (the contracts that actually emerged vs. the ones we guessed.)
- **Who actually owned what?** (vs. the roster on paper.)
- **Did the composition fit the work?** (an idle seat, an overloaded one, a missing lens.)

Its output flows to seat docs, `seams.md`, and **occasionally the roster/config itself** — re-run
`anthill init` after a reshape to render new seat docs (existing ones are never clobbered). The
anthill is yours to re-shape.

## Onboarding a fresh agent

Ground in the **product** first (the `grounding` docs in `.anthill/config.json`), then: this SOP →
`dev/seams.md` (shared contracts) → your seat's `dev/<handle>.md` → go. For the current state of
play, check the bounty board + the active project docs. Then **keep your seat doc honest**: when
something's no longer true, fix it.
