# House Style

The conventions for casting spells. This is the **source of truth** — the
`inscribe` ritual and the scaffold point here; they do not copy it.

Each rule is written in the manifesto's mature shape: **an imperative plus its
own boundary check, plus a repeal criterion.** A bare imperative curdles into
its own failure mode; the boundary check is the appeal clause, and the repeal
criterion is Chesterton's fence with the builder's note nailed to it.

> Rules here **decay by default.** Reinforcement dates live in `decay-ledger.md`
> — a rule that no recurring scenario re-walks is a candidate for removal.
> Survival requires reinforcement; nobody has to make the frightening delete.

---

## Authoring — the governing rule

### Architect for the reader's context, not your own.

The agent that did the work sediments its own hot context into the artifact. The
reader (a fresh agent, a future you) shares none of it. Write for them.

- **Boundary check:** the one operational test is **reachability from the
  agent's trajectory.** A hazard _on the route_ → include it. Information
  _reachable from_ the route → omit it; the agent will fetch it. Something the
  goal needs but sits _off_ the route → include it; it can't be reached. Off the
  route and not needed → say nothing. Two refinements: **(a) if you _are_ the
  index** — the place meant to help discover the thing (a README table, the name
  registry) — then enumerate; that's the deliberate exception to "omit the
  reachable." **(b) Even when inclusion passes the route test, ask "does the
  explicitness add anything?"** If a generalization carries the same meaning,
  prefer it — it's less brittle and more flexible. It's situational; weigh it.
- **Repeal when:** never — this is the project's whole thesis. Refine the
  boundary check, not the rule.

### Reference, don't inline.

Inlining a tool's docs duplicates a source of truth and rots when it drifts.

- **Boundary check:** unless the thing is _off the route_ and small — then a
  one-line copy with a pointer beats a fetch.
- **Repeal when:** the cost of a stale inline copy stops exceeding the cost of a
  fetch (e.g. a tool's docs become unfetchable).

### Context is an attention budget — exclusions must earn their place.

What you leave out is load-bearing. Spelling out the unwanted raises its
salience and can backfire ("don't take a shower" plants the idea). An exclusion
or negation only earns its place if the wrong path is **reachable from what
you've already affirmatively said** — otherwise the exclusion is the only thing
that introduces it.

- **Boundary check:** the reflective pause before writing "does NOT do X" or "X
  is out of scope" — _given the affirmative instructions already present, would
  the agent naturally pursue X?_ If nothing points there, drop it. A defensive
  negative is fine when the hazard is genuinely on the route ("the floor is
  wet"); the trap is warning against detours nobody's taking.
- **Repeal when:** —

### Start minimal; subtract before you test.

An agent authoring a skill **over-specifies by default** — it just did the work,
so its hot context leaks onto the page as detail that feels essential but isn't.
Counter it structurally: write the draft, then make a **subtraction pass** — cut
to the least-explicit version you think could work — _before_ the fresh-agent
test. Let the empirical signal say what to add back. Not-adding is the cheapest
defense against accretion: a line never written never has to decay. This is a
lens applied _after_ writing, not a constraint while writing.

- **Boundary check:** the fresh-agent test is the appeal — if a cold agent
  stumbles for want of something you cut, add it back (that's signal, not
  failure). Don't keep a line _because_ it might be needed; let the test decide.
- **Repeal when:** never — though as models improve and cold agents stumble
  less, the subtraction pass can grow more aggressive (a temporal edge).

---

## The craft of naming

### The name is the canonical handle — and you name at coalescence, not at genesis.

To name a thing is to be able to summon it; a clumsy name is a fumbled cast. But
be precise about what the name _is_ and _isn't_:

- The **name** (`grapevine`) is the canonical, single-token handle — the folder
  name, the registry key, and what every invocation phrasing resolves to.
  Precision matters because an identifier can't be fuzzy. (It will also be the
  exact argument the planned **wand** CLI takes — a mage-facing tool, see
  `docs/fragments/2026-05-29-the-wand-mage-cli.md` — which is _why_ a clash with
  a common word matters, but the identifier role is the primary reason.)
- **Invocation** — how the skill is actually triggered in conversation — is
  deliberately _plural_: many phrasings ("cast / start / join a grapevine") and
  distinct lenses (creating vs. joining are different intents routing to the
  same spell). Write them generously in the spell's `SKILL.md` description.
  Don't reduce triggering to one magic word — a skill has to recognize intent
  however it's phrased.

And a spell starts as a _problem_ and a scrappy prototype, theme-light — naming
is the act of **solidifying**, the moment the exploration becomes a thing you'll
return to. Naming first imposes ceremony on exploration and pretends you know
the shape before you've found it.

- **Boundary check:** if you're still asking "what even is this?", it's too
  early to name — keep prototyping. Once you keep reaching for it by a stable
  name, it has coalesced: name it and reserve the name in the registry. The
  set-apart-word discipline governs the _name as identifier / CLI token_ (where
  a collision with a common word or another spell is a real bug), **not**
  conversational casting, which stays forgiving.
- **Repeal when:** —

---

## The shape of a spell

### Match the kind to the interaction: cantrip for cast-and-resolve, conjuration for duration.

A cantrip resolves in one round (cast → act → submit → exit). A conjuration
stands until dismissed (a daemon, a board you live in) and keeps a state
snapshot so late joiners are grounded.

- **Boundary check:** if you find a "cantrip" growing a daemon, it wanted to be
  a conjuration. If a "conjuration" never holds state between casts, it was a
  cantrip.
- **Repeal when:** a third kind earns its own name (capture the scenario first).

### Surface-fit: match the interaction to the place that fits it.

Chat is one channel — good for negotiation and clarification. Drawing, dropping
images, moving cards deserve their own surface. Don't force everything through
one pane.

- **Boundary check:** if the interaction is purely linguistic, it may not need a
  surface at all — don't conjure one for ceremony.
- **Repeal when:** —

### Keep the client thin — MCP at the auth layer.

The surface is a membrane, not an app. No database, no conventional server.
Authentication and API access live at the MCP layer; the agent is the runtime
underneath.

- **Boundary check:** `localStorage` for draft survival is fine; durable
  cross-session state belongs in the agent or a separate store, not the surface.
- **Repeal when:** —

### Drive a conjuration through a daemon + thin CLI: command in, state read-back, events out.

For a conjuration the agent drives across a session, hold canonical state in one
persistent daemon and give the agent a stateless `cli.ts` — one HTTP round-trip
per verb. Three primitives: **write** with `POST /cmd` (and a `--stdin` body
path, so natural-language text is never inlined into a shell-parsed string);
**read back** with `GET /state` (confirm the command applied, discover
server-assigned ids); **receive** with a `GET /events?since=<id>` SSE tail
wrapped by Monitor (monotonic ids + resume-from-cursor, so a reconnecting agent
loses nothing). Payload on stdout, liveness/echo on stderr — never `2>&1` under
Monitor. Persist a debounced snapshot and restore by merging over defaults. (The
_human_ surface keeps its own channel — a WebSocket full-state push; this trio
is the _agent's_ interface.)

- **Boundary check:** this is the conjuration shape. A cantrip
  (cast-and-resolve, no standing state) needs none of it — stdio plus the exit
  code suffice. Don't pre-build snapshot/restore for state that's trivially
  reconstructable or genuinely ephemeral, and don't push the human surface onto
  the agent's HTTP path.
- **Repeal when:** a better agent-transport primitive supersedes
  cmd/state/events-over-HTTP (a first-class harness channel for spell state, or
  an MCP surface contract) — then rewrite the specifics; don't keep them from
  habit.

### Every spell ships a feedback touchpoint.

Agents don't volunteer friction — they work around it silently, and the signal
is lost; humans are the same unless given a place to speak. So every spell's
`SKILL.md` includes a **feedback touchpoint**: a structured opening for the
agent to surface friction it hit ("I couldn't do X," "this was confusing"), and
— when the human is on a surface — an affordance to ask "did this go well?
anything to report?" The channel is **GitHub issues against this repo** (the
tools' home), via a report-issue capability (one to build;
`project-docs:report-issue` is a model). Embodying a feedback _loop_ in the
grimoire is not the same as a _touchpoint_ in each artifact — the touchpoint is
where the signal originates.

- **Boundary check:** an _opening_, not an interrogation — offered at a natural
  close, easy to skip. Don't nag, and don't manufacture friction to report.
- **Repeal when:** never — feedback is how the system improves at all.

---

## The build (there isn't one)

### Self-contained, no build step. Bun runs `.ts` natively.

Zip one folder and it runs anywhere `bun` is on PATH. Protocol types at the top
of the file; assets load CDN libs inline.

- **Boundary check:** a heavy UI framework _may_ take a `bun build` step inside
  the spell's own setup — but the moment it feels like erecting a building,
  stop.
- **Repeal when:** the runtime makes a build step free (then it's no longer a
  cost to weigh).

### Honor the exit-code contract.

`0` submitted · `2` bad input · `124` idle timeout · `130` user cancelled
(closed tab after interacting). Cantrip and conjuration alike.

- **Boundary check:** —
- **Repeal when:** —

### Carry the Bun gotchas forward.

`FileSink` not `WritableStream` on piped stdin; race `server.stop(true)` against
a timer; grant a submit-path teardown grace; swallow `EPIPE`; `*.test.ts` only.
Full detail (the why + the code) lives in the `agent-surface-bun` recipe
(project-docs) until it graduates here — these one-liners are the in-repo
reachable summary.

- **Boundary check:** each gotcha is pinned to a Bun version — re-verify when
  the runtime moves. A gotcha that no longer reproduces is dead weight.
- **Repeal when:** the underlying Bun bug is fixed and verified gone (this is a
  _temporal_ boundary — the reachability assumption ages as the runtime
  strengthens).

---

## The meta-rule

### A mature principle is an imperative plus its own boundary checks.

Every rule above has a _spatial_ boundary ("avoid X, unless on the route") and,
where it ages, a _temporal_ one ("omit the discoverable, unless verified
reachable — re-check when the route changes"). When two principles conflict, the
arbitration is itself a capturable scenario.

- **Repeal when:** never — but the method should be turned back on itself.
