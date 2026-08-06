# Investigation: Retrofitting agent co-presence onto human-first apps

**Date Started:** 2026-07-14 **Investigator:** Cole Reed + Claude Code
**Status:** Active **Outcome:** In Progress

---

## Question / Motivation

Spellbook's spells are **agent-conjured** surfaces: the agent spins up the
daemon, the human joins, and collaboration is the whole point of the artifact.
But Cole has a fleet of **human-first apps** — built traditionally, fully usable
solo, no agent in the loop — where the same collaborative back-and-forth would
be valuable: a chat pane, a shared view of state, real-time creative
collaboration between a human working the UI and a terminal agent working the
data.

The core question: **what is the right architecture for adding agent co-presence
to an existing human-first app, without foundationally restructuring it?**

Sub-questions that motivated this:

- Is **MCP** the right layer for this? It's the obvious "let an agent manipulate
  the app" answer, but it feels wrong for real-time co-presence — the thing we
  most value in spells is the agent's live view of events and ambient state, and
  MCP's request/response shape doesn't obviously give that.
- Or is the answer closer to the spellbook stack (Bun daemon + WebSocket + thin
  CLI)? And if so, can that be an **adapter** bolted onto an existing app rather
  than a rebuild?
- The agent in question is a **terminal agent** (Claude Code or similar) that
  lives _outside_ the app — not an embedded API-call-to-a-service assistant. It
  should be able to join a working session, co-operate, and leave, with a
  lifetime independent of the app's.

**Pilot candidates (deliberately contrasting):**

- [dream-flute](/Users/colereed/Projects/dreamwood/dream-flute) — a
  browser-based generative-soundscape studio (Nuxt/Vue, client-side only,
  Rust→WASM DSP engine). Built entirely human-first; **no backend, no agent
  affordances** today.
- [story-loom](/Users/colereed/Projects/dreamwood/story-loom) — a generative
  story app (Nuxt studio + Elysia API + Postgres/Redis, auth). **Already has a
  substantial MCP layer** (`apps/api/src/features/mcp/` — ~10 tool modules over
  stories/storylines/context/library/structure, stateless per-request,
  auth-bound) plus an agent-facing project CLI (`loom`). The question it poses:
  how does the co-presence bridge complement — not replace — an existing MCP
  surface?

## Current State Analysis

### What Spellbook already knows (the exportable lessons)

- **Co-presence as a shared-state board** — human and agent each perceive the
  shared object through their own channel (UI vs. data) and act through their
  own affordances. ([[surface-as-shared-state-board]])
- **Ambient vs. intent** — the board is ambient state the agent _pulls_
  (`state`); the event stream is an _intent bus_, pushed only on human commits
  or completed mechanical facts, never on micro-gestures.
  ([[co-presence-ambient-vs-intent]])
- **Conversation-primary** — buttons/CTAs are shortcuts for conversational acts,
  never the only path. ([[conversation-primary-surfaces]])
- **The conjuration mechanics** — a persistent daemon holds canonical state and
  broadcasts to the surface over WebSocket; the agent drives it through a thin
  `cli.ts` (`open` / `state` / `send` / `tail`, with `tail` wrapped in Monitor
  for live reaction). Multi-agent presence over one board is proven (bounty
  `join`, grapevine channels).

### What dream-flute looks like (the retrofit target)

- Nuxt/Vue studio, **SSR off, fully client-side** — state lives in browser
  composables; there is **no backend process at all**.
- The entire authoring state is already projected onto a **frozen, agent-legible
  JSON contract** (`apps/studio/app/lib/project.ts`) because the deterministic
  Rust/WASM engine renders from it. Domain mutations are pure operations in
  `app/lib/`.
- This means the hardest prerequisite for co-presence — a disciplined,
  agent-readable state projection — **already exists**. What's missing is purely
  plumbing: a way for a terminal agent to see that document, watch it change,
  and push changes back through the same domain operations.

## Investigation Findings (so far — from the framing conversation)

### 1. MCP vs. WebSocket is a false dichotomy — they're different layers

Any retrofit has three pieces:

1. **Browser ↔ bridge:** WebSocket, necessarily — a browser tab can't be reached
   any other way. The app connects _out_ to a local bridge when one is present.
2. **The bridge:** a small sidecar **session daemon** (structurally a spellbook
   conjuration `server.ts`) that mirrors state, buffers an event log, and relays
   commands.
3. **Agent ↔ bridge:** the interchangeable front door — and _this_ is where CLI
   vs. MCP is a real choice.

### 2. For terminal-agent co-presence, CLI-with-tail beats MCP today

- MCP is request/response and agent-initiated; there is no good harness
  affordance for a terminal agent to **block on or wake to an event**
  (subscriptions exist in the spec; support is weak). The intent bus needs
  `tail` + Monitor.
- The CLI keeps token cost proportional: `state` pulls ambient context on
  demand; `tail` delivers only intents. MCP tends toward wall-of-state per tool
  call.
- MCP remains the right **interop** front door later (foreign agents, hosted
  contexts without a local CLI) — same daemon, second adapter. Additive, not
  foundational.

### 3. The right frame is _multiplayer_, not "agent integration"

The daemon is a **session server** (the role the Google Docs backend plays, but
local and per-session). The browser is one client (human, pixels); the terminal
agent is another (CLI, JSON). Neither lives inside the other. Chat stops being a
feature and becomes just another message type on the same bus — nearly free once
the bus exists. Presence and attribution are first-class: peers announce
themselves ("Claude joined"), and agent mutations are tagged with their author
so the surface can render _who did what_ rather than a haunted-app state jump.

### 4. Invocation direction is **inverted** relative to spells

Spells are agent-conjured; these apps are **human-owned, agent-visited**. The
app must run fully solo with zero peers, and collaboration is switched on
mid-session — from either side:

- App-side: an "invite an agent" affordance starts/connects the session daemon
  and surfaces a join token.
- Agent-side: "join my dream-flute session" → the CLI discovers the running
  session and connects.

This constraint is a feature: because the app must work with no daemon, the
bridge is _forced_ to remain an optional adapter rather than a load-bearing
rewrite.

### 5. State ownership diverges from the spell pattern

In spells, the **daemon owns canonical state**. In a retrofit, the **browser
must own it** (Web Audio, live composables); the daemon is a mirror, not the
source of truth. Working hypothesis for single-human sessions: "browser is boss,
daemon re-syncs on reconnect" suffices. This is the main architectural
divergence to validate.

### 6. Estimated retrofit surface (dream-flute)

No engine or domain-model changes. Roughly:

- A Nuxt plugin/composable (`useAgentBridge`-shaped) that, when a bridge is
  present, pushes project snapshots/deltas + commit-grade intents, and applies
  incoming agent commands through the existing domain operations (one writer,
  existing code paths).
- The sidecar session daemon (likely startable from a spellbook conjuration
  daemon nearly verbatim).
- A thin `cli.ts` for the agent.

### 7. Story-loom clarifies the MCP relationship: data plane vs. session plane

Story-loom's existing MCP server operates on the **durable domain model** —
stateless, per-request, authenticated, database-backed. It answers "let an agent
read and mutate the app's data," and it works remotely and outside any live
session. What it _cannot_ express is exactly what the bridge provides: what the
human is looking at right now, in-flight session state, commit-grade intent
events, presence, chat. These are **two planes, not two competitors**:

- **Data plane (MCP / API):** verbs on the durable model. Session-less,
  location-independent, auth-scoped.
- **Session plane (the bridge):** the live shared board — ambient session state,
  intent bus, presence, chat. Local-collaboration-scoped, ephemeral.

The intersection is real but thin: the bridge tells the agent _when and what_ (a
human just committed an edit to storyline X); the data plane is often _how the
agent acts_ (an MCP/CLI mutation on that storyline). Any data-plane mutation
made mid-session must surface back into the session plane (broadcast "agent
changed X" so the studio updates and the change is attributed) — that reflection
is the one genuine coupling point to design.

### 8. Process topology varies; the contract is the invariant

The two pilots have opposite backend situations, which splits the pattern:

- **Backend-less apps (dream-flute):** the session bus is a **sidecar daemon**
  spun up per session; browser owns canonical state.
- **Server apps (story-loom):** no sidecar needed — the session bus can live
  **inside the existing API** (it already has Redis pub/sub and WebSocket-able
  Elysia; the studio already talks to it). The server may also own more of the
  canonical state.

What must stay identical across both is the **contract**: ambient state doc +
intent bus + presence/attribution + peer command set, with the same
CLI-with-tail front door for terminal agents. In story-loom the natural home for
those agent verbs is the existing `loom` CLI (which already emits JSON envelopes
for agents) rather than a new binary.

### 9. Design-forward: what makes an app co-presence-ready by construction

Beyond retrofitting, there's the forward question: **is there an architectural
pattern for future apps that makes this functionality cheap to add?** The two
pilots suggest the prerequisites, and they turn out to be a familiar set —
"co-presence-ready" is very close to "multiplayer-ready," which is very close to
"undoable":

1. **A serializable domain document, separate from view state.** Dream-flute has
   this by accident of the engine boundary (`project.ts`); it's why the retrofit
   is cheap there. The domain model must be projectable to a JSON document at
   any moment — no canonical state trapped in component trees or closures.
2. **All mutations through a closed set of named domain operations.** If every
   change goes through named commands (`addWall`, `editSeam`) rather than
   scattered direct state writes, then any peer — UI, agent, future collaborator
   — can be a command source, and one writer applies them.
3. **An event seam at the command layer.** If commands are the only write path,
   the intent bus is just an emitter on that layer. The commit boundary
   (gesture-end, not knob deltas) tends to coincide with what the app would want
   for **undo granularity** — designing one buys the other.
4. **Semantic naming, for agent legibility.** The one demand beyond ordinary
   multiplayer-readiness: the document's shape and the commands' names are read
   by an agent _as language_. `applySeamCurve(seamId, curve)` is
   self-describing; `setState(patch)` is not. Domain-verb commands over anemic
   setters.
5. **View/session state segregated but nameable.** Selection, focus, playhead —
   not part of the document, but the ambient board wants some of it, so it
   should live in an identifiable layer rather than diffused through components.

Prior art to check rather than reinvent: Flux/Redux-style action architectures
(actions ≈ intents), event sourcing / CQRS-lite, and the document-model +
command pattern used by collaborative editors (tldraw, Yjs / CRDT-based apps).
The likely deliverable here is a short **co-presence-ready checklist** — a canon
artifact future dreamwood apps adopt at design time — rather than a framework.

### 10. Where the real design effort lands

The transport is commodity. The per-app design work is defining the **commit
boundary** (which human gestures are intents — "seam edited" at gesture-end, not
forty knob deltas) and the **ambient state document** (project JSON plus what?
playhead, focused panel, selection?). Multi-agent falls out of the peer bus;
grapevine/bounty lessons (handles, roles, rosters) apply but don't drive the
design.

## Open Questions

- **Sync ownership details:** is browser-authoritative + resync-on-reconnect
  actually sufficient? What happens on daemon restart mid-session, tab reload,
  or two tabs? Are there fleet apps where the daemon _should_ be authoritative?
- **Session discovery/join contract:** how does the agent CLI find a running
  session (well-known port? session file? registry)? What does the join token /
  handshake look like? Should it mirror bounty's caller-owned session keys?
- **The bridge contract, concretely for dream-flute:** enumerate its
  commit-worthy intents and the ambient `state` shape beyond the project JSON.
- **Intent granularity rules:** general heuristics for the commit boundary that
  transfer across apps (gesture-end, debounce, explicit save?).
- **Chat + attribution UI:** what does the minimal in-app collaboration pane
  look like (presence roster, chat, change attribution) — and can it be a
  drop-in component shared across the fleet?
- **Packaging:** where does the eventual deliverable live? Two candidate homes,
  split by what the reusable part turns out to be: if mostly _knowledge_
  (checklist, contract shape, plane distinction) → a **HiveMind playbook**
  (cross-project, materializable with provenance); if a real _kit_ crystallizes
  (protocol types, presence/chat bus, bridge composable, CLI scaffold) → a
  **dedicated repo**, with the playbook referencing it. Likely sequential:
  playbook first, repo only if repeated retrofits show the same few hundred
  lines being copy-pasted. (Spellbook itself ships plugins, not npm packages, so
  it's the home of the _investigation_, not the kit.)
- **Data-plane reflection:** when an agent mutates via MCP/API mid-session,
  what's the mechanism that reflects it into the session plane with attribution
  (server-side hook? bridge-mediated writes only during a session?)? Does the
  answer differ between sidecar and in-server topologies?
- **How much topology can the kit share?** Sidecar daemon vs. in-server bus —
  same contract, but how much code (protocol types, presence/chat handling, the
  bridge composable, the CLI verbs) is genuinely reusable across both?
- **Validate the readiness hypothesis against the pilots:** dream-flute scores
  high on the checklist by accident (engine boundary); story-loom is
  server-centric with a different write path. Does the checklist actually
  predict retrofit cost in both? What does prior art (Redux-style actions, event
  sourcing, tldraw/Yjs document models) confirm or add?
- **Naming/lexicon:** this is adjacent to but distinct from a spell —
  human-owned apps that agents _visit_ vs. agent-conjured surfaces. Does it
  deserve its own name in the canon?

## Next Steps

1. Draft the **bridge contract** against dream-flute's actual composables and
   `project.ts` — the ambient state doc, the intent list, the command set. (This
   is the concrete validation of the whole pattern.)
2. Work the **sync-ownership question** with the failure cases above.
3. Define the **session discovery/join** mechanics (borrowing from bounty's
   session-key work).
4. Sketch the **story-loom variant**: session bus inside the existing Elysia API
   (Redis pub/sub), agent verbs added to the `loom` CLI, and the MCP-mutation →
   session-plane reflection mechanism.
5. Distill the **co-presence-ready checklist** (finding 9) into a standalone
   design-time artifact, after checking it against prior art and both pilots.
6. If the contract holds together: recommend pilot projects in each app's own
   `docs/projects/` (implementation lives there; the pattern stays here), and
   decide the kit's packaging home.

---

**Related Documents:**

- [Project manifesto](../PROJECT_MANIFESTO.md) — co-presence, agent-as-runtime
- [Spell Surface Pipeline proposal](../projects/spell-surface-pipeline/proposal.md)
  — the adjacent "spells grow real builds" thread
- [Astryx investigation](2026-07-06-astryx-component-library-evaluation.md) —
  precedent for cross-project investigations living in this repo
- dream-flute grounding:
  `/Users/colereed/Projects/dreamwood/dream-flute/AGENTS.md` (frozen JSON
  contract: `apps/studio/app/lib/project.ts`)
- story-loom grounding:
  `/Users/colereed/Projects/dreamwood/story-loom/AGENTS.md` (MCP layer:
  `apps/api/src/features/mcp/`; agent CLI: `scripts/` → `loom`)
