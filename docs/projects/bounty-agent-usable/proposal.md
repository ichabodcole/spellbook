# Bounty: modernize to the house agent-interface pattern

**Status:** Draft **Created:** 2026-06-15 **Author:** Cole Reed (triaged +
architecture review with Claude Code)

---

## Overview

Bounty (the board spell, formerly _Tuskboard_) is the **last spell still on the
old substrate**. Two newer/heavily-iterated spells — **Grapevine** (V1.7, deep
investment in its agent interface) and **Imago** (the rich canonical-state
daemon) — have independently converged on the same **house pattern** for how an
agent drives a spell: a **persistent daemon holding canonical state + a thin
`cli.ts` verb wrapper + HTTP `/cmd` (write) + `/state` (read-back) + `/events`
SSE tail + on-disk persistence with restore.** Bounty predates that convergence
and never made the jump on its agent interface.

The five issues filed from a real multi-agent build session (#6–#10) are not
five unrelated fixes — they are **symptoms of being on the old substrate**, and
each already has a proven answer in a sibling spell. This project therefore
reframes the work: **modernize Bounty's agent interface to the house pattern,
and the five issues fall out of it** — plus an Alpine surface port (the
Grapevine tier) as the view complexity grows. (A Tuskboard→Bounty branding
cleanup was anticipated, but verification found no live "Tuskboard" string left
in the spell — it's a guard, not a rename.)

## Problem Statement

From real usage hosting + driving the board from Claude Code during a
multi-agent build (a lead coordinating ~3 workers), each pain point traces back
to a substrate gap the siblings already closed:

- **Write-only for agents (#8).** Bounty has **no read-current-state primitive
  and no command ack** — the agent infers state from the event stream or renders
  the HTML. Imago solved this with `GET /state?lean=1` (confirm + discover
  server-assigned ids).
- **Brittle authoring path (#7).** The documented `bun -e '…appendFileSync…'`
  snippet breaks on apostrophes/metachars because card text is inlined into a
  single-quoted shell arg. Grapevine retired exactly this class of bug with a
  real `cli.ts` + a `--stdin` body path.
- **No scoping → notification flood (#9).** Every event wakes every watcher, so
  the only safe pattern is "one lead maintains it, everyone ignores it."
  Grapevine's anti-flood toolkit (self-echo suppression, stdout/stderr
  discipline, scoped reads, grounding line) is precisely the `--owner`/`--mine`
  filter this needs.
- **Can't represent structure (#10).** No notion of what's blocked on what — the
  board's one genuine edge over a chat log. A `blockedBy` field + an `unblocked`
  event slots straight into a **curated wake-set** (imago's
  `AGENT_EVENT_TYPES`).
- **Not durable (#6).** Canonical state is **in-memory and dies with the
  process**; the idle timer counts **board-UI activity only**, so an
  agent-hosted board times out (exit 124) mid-build. Imago persists a debounced
  snapshot + `open --restore` with migration-merge, and both sibling daemons
  `touch()` on **every agent request**, not just UI events.

Net: Bounty's value as a fleet coordination surface is gated behind an interface
generation it never upgraded to.

## Proposed Solution

Adopt the house pattern as the spine; let the issues resolve as outcomes; port
the surface to Alpine as the new views land.

### The house pattern (what Grapevine + Imago converged on)

| Concern       | The convergent pattern                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process model | Persistent **daemon** holds canonical state; agent runs a **stateless `cli.ts`** that does an HTTP round-trip per verb (detached `node:child_process` spawn — already the house spawn pattern Bounty shares) |
| Write         | `cli.ts <verb>` → `POST /cmd`; `--stdin` for natural-language/generated text (no shell inlining)                                                                                                             |
| Read-back     | `cli.ts state` → `GET /state[?lean=1]` — confirm a command applied + discover server-assigned ids                                                                                                            |
| Live push     | `GET /events?since=<id>` SSE tail, wrapped by the **Monitor** tool; a **curated wake-set** decides which events wake the agent vs. which are read from `/state` on the next action                           |
| Anti-flood    | self-echo suppression; payload on **stdout**, liveness/echo on **stderr** (don't `2>&1`); scoped/filtered reads                                                                                              |
| Persistence   | debounced snapshot to `$BOUNTY_HOME` + `open --restore <id>` that **merges over defaults** (forward-compat for evolving state)                                                                               |
| Idle          | `touch()` on every HTTP/agent request; idle = genuinely no agent _or_ user activity                                                                                                                          |

### What Bounty has instead (the gap)

Bounty drives the board through `bg.ts`: a background launcher that re-exposes a
**blocking stdio host** over two append-only files — the agent **appends**
JSON-lines to a cmds file (250ms size-poll) and reads an events file via
`tail -F | grep` Monitor. State is in-memory only; there is no `cli.ts`, no
`/state`, no `/cmd`, no ack, no persistence. The surface is a single 575-line
`template.html` of vanilla inline JS rendered via string `.replace()`.

### How each issue resolves once Bounty adopts the pattern

| #       | Issue                        | Resolved by adopting…                                                                                                 |
| ------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **#7**  | `bun -e` apostrophe breakage | a real `cli.ts` + `--stdin` body path (retire the inline snippet) — _Grapevine_                                       |
| **#8**  | no state readback / ack      | `GET /state?lean=1` + `cli.ts state` — _Imago_                                                                        |
| **#6**  | idle-timeout / durability    | snapshot + `open --restore` + migration-merge; `touch()` on agent activity — _Imago_ (+ Grapevine's JSONL durability) |
| **#9**  | ownership + scoped subs      | self-echo suppression + stdout/stderr discipline + `--owner`/`--mine` scoped reads — _Grapevine_                      |
| **#10** | deps + `unblocked` event     | curated event wake-set (`unblocked` ∈ wake-set) — _Imago_                                                             |

### Surface: Alpine port (the Grapevine tier — NOT React)

Three surface tiers exist in the repo, governed by the house rule "React only
past a complexity threshold": **vanilla inline JS** (Bounty, digestify) →
**Alpine-over-CDN no-build** (Grapevine V1.7) → **React + Bun bundler** (Imago,
glamour). The new view complexity (owner badges + per-owner filtering, blocked
rendering, dependency cues) justifies moving **off raw vanilla** — but a Kanban
board with drag/edit/filter is squarely **Alpine territory**, not React's.
Alpine's reactive binding retires the brittle `.replace()` templating + the
untested imperative-DOM inline JS, stays no-build (single file the daemon serves
verbatim), and matches a proven sibling. React's weight only earns out at
imago/glamour scale (multi-pane, subsystems), which the board doesn't approach.

## Scope

**In Scope (phased):**

- **Phase A — substrate core:** stand up the daemon + thin `cli.ts`; `POST /cmd`
  write (with `--stdin` body), `GET /state[?lean=1]` read-back,
  `GET /events?since=<id>` SSE tail (wrapped by Monitor). **Retire `bg.ts` and
  the file-pump bridge.** Resolves **#7** and **#8**; agent-activity idle-touch
  comes free with the daemon (part of **#6**).
- **Phase B — durability:** debounced snapshot persistence + `open --restore`
  (merge-over-defaults). Completes **#6**.
- **Surface — Alpine port:** port `template.html` to Alpine-over-CDN here,
  before the new views land, so #9/#10 are built once (not in vanilla then
  rewritten). Browser↔daemon stays WebSocket.
- **Phase C — ownership + scoping:** `owner` field on `Task`;
  `--mine`/`--owner <name>` scoped tail + self-echo/stderr discipline;
  **`review` as the human-facing handoff signal**; light self-claim of
  unassigned To-do cards (assignment is mostly lead-driven); the board=state /
  chat=substance workflow doc. Resolves **#9**.
- **Phase D — dependencies:** `blockedBy: id[]`, blocked-state visual,
  `unblocked` event in the curated wake-set, cycle guard. Resolves **#10**.
- **Branding:** verification guard only — `grep -rni tuskboard` over the spell
  returns no live hits (the one "tusk" match is a palette note), so this is a
  fold-in check, not a rename.

**Out of Scope:**

- Full DAG editor UI for dependencies — field + cue + signal only.
- Hard locks on blocked tasks — gate is a convention + cue, like Review today.
- React component breakup (reserve for if Bounty ever grows multi-pane
  subsystems).
- Rewriting historical docs that mention Tuskboard (CHANGELOG, manifesto,
  rebrand proposal, reports stay as history).

**Future Considerations:**

- Richer claim/auction model beyond a light claim.
- Per-owner filtered board views in the surface.
- Sharing a small `cli.ts`/daemon helper library across spells if the house
  pattern keeps recurring (consolidation, not in this project).

## Technical Approach

**The core migration:** move Bounty from the **`bg.ts` blocking-host + file-pump
bridge** to the **persistent daemon + stateless `cli.ts`** model the siblings
use. Concretely:

- **Reference implementations to mirror:**
  `plugins/spellbook/skills/grapevine/scripts/cli.ts` (verb wrapper, `--stdin`,
  stdout/stderr discipline, scoped reads) and
  `plugins/spellbook/skills/imago/scripts/{server.ts,cli.ts}` (`GET /state` lean
  projection, `POST /cmd`, SSE `/events?since=`, snapshot + `open --restore` +
  migration-merge).
- **Bounty touch points (current):** `server.ts:332` (`Bun.serve`), the
  `BoardState`/`Task` shape (`server.ts:300`), the idle timer (`server.ts:569`,
  default `:274`, `lastActivity` `:313-315`), `bg.ts` cmds pump (`:226,266`) and
  stdout pump (`:160`), `watch-events.sh` (`tail -F | grep` Monitor), `join.ts`
  (the multi-agent WS client — must keep working), `SKILL.md:~288` (the `bun -e`
  example to retire).
- **Data additions are small + additive:** `Task` gains `owner?` (#9) and
  `blockedBy?: id[]` (#10); new event type `unblocked` (#10) + a `state`
  snapshot read (#8). Honors the spell exit-code contract (0/2/124/130).
- **State persistence:** introduce `$BOUNTY_HOME` (default `~/.bounty`)
  snapshots keyed by session id, restored via `open --restore` with
  merge-over-defaults so old snapshots gain new fields (the imago migration
  recipe).

This is a Spellbook **conjuration** — changes go through the house-style /
fresh-agent loop. Server/contract changes redeploy (close + `open --restore`);
the Alpine surface can iterate without a bundler.

## Impact & Risks

**Benefits:** Flips the board from a human-only mirror to a fleet-drivable
shared source of truth; brings Bounty onto the same agent interface as its
siblings (consistency, shared mental model, future shared tooling); resolves all
five issues structurally rather than patching each.

**Risks:**

- **Bigger refactor than the issues as filed.** Mitigate by phasing (A→D), each
  phase independently shippable, keeping the existing protocol tests green and
  `join.ts` working throughout.
- **Regressing a working board.** Bounty has solid protocol-boundary tests
  (`server.test.ts`, incl. real-subprocess E2E) — extend them per phase; don't
  rip out file mode until `cli.ts`/`/cmd` is proven at parity.
- **Discipline cost (#9):** a board that lies (someone forgot to move a card) is
  worse than no board. Mitigate with the workflow convention (card move _is_ the
  signal) + self-updating workers.
- **Scale-dependent value:** at 3–4 agents with one relaying lead, a chat
  back-channel alone genuinely suffices; the board's value grows with fleet
  size, task count, and run length. Ship the primitives small.
- **Cycle wedging (#10):** guard against self/cyclic `blockedBy` edges.

**Complexity:** Medium-High — the substrate migration is the bulk; the per-issue
features are small once the pattern is in.

## Resolved Decisions

- **Transport (agent read path): full daemon + SSE `/events?since=<id>`,
  retiring the `bg.ts` file-pump.** Best agent experience and cross-spell
  consistency coincide here: monotonic event ids + resume-from-cursor mean a
  reconnecting or restarted agent never loses or re-processes events; it pairs
  directly with `/state` read-back (#8) and restore (#6); and the curated
  wake-set + stdout/stderr discipline is exactly the anti-flood machinery #9/#10
  need. The Monitor workflow is preserved — the agent wraps `cli.ts tail`
  (strictly better than `tail -F | grep`).
- **`cli.ts`: copy-and-adapt grapevine + imago now; consolidate later.** Derive
  Bounty's CLI from the refined sibling patterns (verb dispatch, `--stdin`,
  stdout/stderr split, SSE tail w/ resume, exit-code contract, detached spawn +
  discovery files) rather than sharing code yet — the domains differ enough that
  a premature shared lib is the wrong abstraction. Once Bounty makes three
  spells on the identical scaffold, factor a shared helper + write it into
  house-style.
- **#6 mitigation: agent-activity idle-touch + snapshot/restore; defer the
  pre-close warning.** In the daemon model every `/cmd` and `/state` request
  resets the idle timer, so agent-heavy stretches keep the board alive (fixes
  the reported symptom); snapshot+restore is the durability floor (survives
  crash, sleep, deliberate close). A `closing_soon` warning event is largely
  redundant once those two exist — deferred unless real usage still shows
  surprise closes.
- **#9 ownership: assignment-first (lead-driven), `--mine` + `--owner <name>`,
  `review` as the human signal.** `--mine` is sugar for "tasks owned by my own
  `--as` identity" (the worker's lane + claimable unassigned); `--owner <name>`
  is explicit (lead inspecting a worker); the lead watches the whole board.
  Because the board leans agent-driven (agent sets up + orchestrates; human
  mostly watches), `owner` is set primarily by the lead at planning time, with a
  light self-claim as a secondary path. The human's main touch is the **review
  gate**, so a task entering `review` is a first-class human-facing cue.
- **Phasing:** A (substrate, retires `bg.ts`) → B (durability) → Alpine port → C
  (ownership) → D (dependencies). Each phase is independently shippable; the
  surface ports before C so the new owner/blocked views are built once.

## Open Questions

- None blocking — the forks above are resolved. Remaining detail (exact snapshot
  cadence, claim ergonomics, blocked-state visual treatment) is plan-level.

## Success Criteria

- An agent can `cli.ts state` and **read back** confirmation a command applied —
  no HTML render, no inference (#8).
- The documented append path works with `loom's done` verbatim via `--stdin`
  (#7).
- A worker watching `--owner <name>` is woken only by its own + claimable tasks,
  not the whole board (#9).
- A blocked task renders distinctly and its owner gets an `unblocked` event when
  the last blocker hits done (#10).
- A board survives an agent-heavy idle stretch (no spurious exit 124), or
  restores its state in one `open --restore` if closed (#6).
- Bounty's agent interface matches the house pattern (`cli.ts` + `/cmd` +
  `/state` + `/events`) — same shape an agent already knows from
  Grapevine/Imago.
- No live "Tuskboard" string remains in the bounty spell surface/contract.

---

**Related Documents:**

- GitHub issues [#6](https://github.com/ichabodcole/spellbook/issues/6),
  [#7](https://github.com/ichabodcole/spellbook/issues/7),
  [#8](https://github.com/ichabodcole/spellbook/issues/8),
  [#9](https://github.com/ichabodcole/spellbook/issues/9),
  [#10](https://github.com/ichabodcole/spellbook/issues/10)
- Architecture precedent (in-repo): `grapevine/scripts/cli.ts`,
  `imago/scripts/{server.ts,cli.ts}`
- [spellbook-rebrand proposal](../spellbook-rebrand/proposal.md)
  (Tuskboard→Bounty rename context)

---

## Notes

All five issues were filed 2026-06-15, agent-reported (Claude Code) from a
single real multi-agent build session. They were triaged together, then an
architecture review of Grapevine + Imago found that Bounty is the last spell on
the old agent-interface substrate and that each issue is already solved in a
sibling — which reframed this project from "fix 5 issues" to "modernize Bounty
to the house pattern." Decisions taken: (1) project framed around the substrate
modernization; (2) surface targets the **Alpine-over-CDN** tier (Grapevine), not
React. GitHub labels applied during triage: #6/#7 `bug` (+#7 `documentation`),
#8/#9/#10 `enhancement`; all `area: bounty`; #6/#7/#9 `priority: high`, #8/#10
`priority: medium`.
