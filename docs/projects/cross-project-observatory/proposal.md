# Astrolabe — a higher-level board for projects in flight

**Status:** Draft **Created:** 2026-06-29 **Author:** Cole Reed (with familiar)

> **Named at coalescence: `astrolabe`** (conjuration) — reserved in
> `grimoire/trigger-registry.md`. An astrolabe is the wizard's-study instrument
> for getting your bearings across the heavens; here, across your projects. The
> docs folder/branch keep the `cross-project-observatory` working handle for
> now.

---

## Overview

A standing **observatory**: one board that shows the live state of every project
you have in flight, so you can see what's active, what needs your attention, and
what's just chugging along — without hopping between terminals, grapevines, and
bounty boards. Its lean is **observation, with the door open** (manifesto §2): a
window onto work the agents are doing underneath, where you step in when it
matters and dive down into the real spell or terminal for anything detailed.

It sits a level _above_ the existing spells. Where grapevine is a channel for
one agent team and bounty is one team's task board, the observatory is the view
_across_ all of them.

## Problem Statement

Running several projects in parallel means constant context-switching: jumping
across terminals to check on different agent teams, multiple grapevine channels,
multiple bounty boards. There's no single surface that answers "what's the
higher-level state of everything right now — what's moving, what's blocked, what
needs me?" The cost is attention: you either over-check (interrupting yourself
to poll each project) or under-check (missing the moment an agent needed a
decision).

## Proposed Solution

The observatory is a board of **project cards**, and the whole design turns on
keeping two lifecycles separate:

1. **Add / register a project** — _durable, infrequent._ Creates a persistent
   project card with minimal metadata: **name, description, path on disk, and an
   avatar** (for fast visual recognition once several projects are listed;
   either explicitly set, or a generated/random fallback so a card always has
   one). A dedupe safeguard shows the existing list so you don't register a
   collision. Reachable three ways, all hitting the same registration: an agent
   inside the project, an agent anywhere ("go look at this path and add it"), or
   a UI **"add project"** button + form for the occasional manual case. You
   mostly seed a batch up front, then rarely touch it.

2. **Join / activate a project** — _live, frequent._ An agent connects to an
   _already-registered_ project, takes over its communication, and that
   connection is what flips the card to **active**. This is the everyday motion:
   open the observatory, agents come online against existing projects. When the
   agent stops, the project goes idle (a presence lifecycle).

**On the board, per active project:** last status update, current phase /
whether things are moving, and an **attention signal** — a visual change
(styling, alert) when an agent flags that input is needed. Two interactions
close the loop:

- **Poke** — a one-tap action that asks the responsible agent for a fresh status
  update. (Human → agent.)
- **Needs-attention** — the agent raises a flag that surfaces on the board.
  (Agent → human.)

For poke and attention to work, an active project's agent is _listening_ —
sitting in a Monitor/tail loop on the daemon so it catches a poke and posts
updates. So "active" means an agent is connected _and watching_ — exactly the
duplex loop grapevine and bounty agents already run.

### How it's experienced

You open the observatory and see your projects, the active ones visually
distinct. One card shows "Phase 3 of 5, last update 2m ago"; another is pulsing
an attention alert — its agent needs a decision. You read the alert, click into
that terminal, resolve it, and come back. A third project has been quiet a
while, so you poke it; its agent (which may itself be coordinating sub-agents
over a grapevine or bounty) replies with a status a moment later. You never had
to remember which window was which.

## Scope

**In Scope (MVP):**

- Register projects (name, description, path, avatar-with-fallback) with a
  dedupe check — via agent command _and_ a UI add form.
- An agent **joins/activates** a registered project; presence marks it
  active/idle.
- Board surface: project cards grouped into zones — **Needs you** (attention),
  **Active** (agent connected + working), and a collapsible muted **Quiet** zone
  (idle / stale / done). Each card shows agent-connected **presence**, a status
  chip, the **current** status summary, and a timestamp. No history — the card
  always reflects the present state.
- **Poke** mechanic (request a fresh status) and agent-posted status updates
  (each update replaces the card's current state; updates are not accumulated).
- Live updates to the board (the standing-daemon + watch-surface pattern).

**Out of Scope (initially):**

- Free-form board-level messaging / chat with an agent (beyond poke). Phase 2.
- A higher-level coordinating/liaison agent that watches the board and can act
  on your behalf. Phase 2+.
- Cross-project awareness between individual project agents. Later.

**Future Considerations:**

- A **work session** with history: capture the feed of summaries the agent posts
  across a scope of work — useful for onboarding into a project's recent arc, or
  analyzing the work, without scrolling a terminal. It would be **scoped and
  resettable** (the grapevine channel-reset lesson: reuse a project across
  successive scopes, but clear the feed so new work doesn't inherit stale
  history). Explicitly _not_ the MVP pain — the card's current state already
  answers "where are things right now?".
- Lightweight reply/messaging from the board without dropping into a terminal.
- The liaison agent (manifesto §5) as the board's point-person across projects.
- Project agents with some visibility into sibling projects.
- **Linked work surfaces.** Optional per-card grapevine / bounty URLs an agent
  sets when it spins up a work session, surfaced as quick-open buttons on the
  card. Astrolabe is the high-level view; the actual work usually runs in a
  grapevine channel + a bounty board, so linking them is a natural composition
  (spells composing — cf. manifesto §8). Optional by design — not every project
  uses them, so the fields are nullable and the buttons appear only when set.

## Technical Approach

This lands squarely in the **conjuration family** alongside grapevine and
bounty, so we clone that proven scaffold rather than invent architecture:

- A **daemon** holds canonical state: the durable project registry plus live
  presence/status, with an append-or-merge model and SSE for live push to the
  surface.
- A **thin `cli.ts`** is the agent's interface — command in, `state` read-back,
  events out via `Monitor` (the house daemon + thin-CLI pattern). Provisional
  verbs: `add` (register), `join` (activate), `status` (post update),
  `attention` (raise/clear), `poke`, `state`, `list`, and a `tail`/Monitor loop
  for listening agents.
- A **human watch surface** (the board), rendered locally — Alpine-CDN is likely
  enough given it's board-shaped (cf. bounty/grapevine watch), pending the
  prototype.

**Data model (high-level — details belong in the plan):**

- _Project_ (durable): id, name, description, path, avatar.
- _Presence/status_ (live): active (agent connected + watching), lastStatus,
  phase, needsAttention, lastUpdated.

**Auth/API:** kept thin — a local daemon, no external auth for MVP (same posture
as grapevine/bounty).

**Dependencies:** Bun runtime; the `agent-surface-bun` recipe and
`grimoire/house-style.md` for conventions; clone `grapevine` or `bounty` as the
structural start.

## Impact & Risks

**Benefits:** Removes the cross-project context-switching tax; turns "go poll
every terminal" into "glance at one board"; gives agents a sanctioned way to
pull you in only when it matters. Immediately dogfoodable against real parallel
work.

**Risks:**

- _Scope creep toward a control tower._ The pull toward board-messaging and a
  liaison agent is strong; MVP must stay observation + poke or it balloons.
  (Open threads are explicitly parked.)
- _"Active" semantics._ Presence depends on an agent staying in a listening
  loop; define idle/disconnect cleanly so stale "active" cards don't mislead.
- _Overlap with grapevine._ Must read as a higher-altitude view, not a second
  chat channel — the anti-pattern to resist (manifesto §2: board, not the form).

**Complexity:** Medium — the pattern is proven, but presence/liveness semantics
and the listening-agent loop need care.

## Open Questions

- **Add vs. join surface symmetry** — confirmed both exist; exact command shape
  (same verb with different effect, or two verbs) settles in the prototype.
- **Onboarding flow** — how a project "joins the observatory" end to end (the
  precursor sketched "tell a project team to join"); echoes grapevine's join.
- **Name and kind** — deferred to coalescence (strongly leans conjuration).
- Phase-2 threads above (messaging, liaison agent, cross-project awareness).

## Success Criteria

- Cole can register a handful of real projects and, from one board, see which
  are active, read a status, and get pulled in by an attention flag — without
  opening each terminal.
- A poke returns a fresh status from a listening agent.
- The board feels like a higher-altitude _window_, not another chat — confirmed
  by dogfooding across genuinely parallel work.

---

**Related Documents:**

- Grounding precursor: the **crystal-ball-observatory** spell-precursor
  (Operator Spellbook project → `fragments/`), scaffolded via the
  `scaffold-spell-idea` operation.
- [Manifesto](../../PROJECT_MANIFESTO.md) — §2 (observation lean), §5 (liaison).
- Inscribe ritual: `.claude/skills/inscribe/SKILL.md`.
- Pattern kin: `plugins/spellbook/skills/grapevine/`,
  `plugins/spellbook/skills/bounty/`.

---

## Notes

This proposal is intentionally a _grounding_ doc, not a spec: per `inscribe`,
the spell is grown through scrappy prototyping, and name/kind/identity are
outputs of that, not inputs. Next step is a throwaway board mockup to feel how
it reads before building the daemon.
