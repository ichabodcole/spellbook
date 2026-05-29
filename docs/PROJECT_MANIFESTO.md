<!--
Mirrored from Operator → Spellbook project → "The Spellbook — a manifesto for
agent-conjured apps" (doc id XNboVJINuExcvPR44SUXv). Operator remains the living
source of truth; this copy keeps the repo self-grounding. Re-sync when the
Operator version changes. Companion: "Agent-Orchestrated Micro Apps: An Emerging
Paradigm" (the fragment this grew out of) also lives in the Operator project.
-->

# The Spellbook

**A manifesto for agent-conjured apps — and the language we built for them**

_Synthesis, May 2026. Grew out of the "agent-orchestrated micro-apps" fragment.
Declarative where things settled, honest where they're still stewing. Written,
deliberately, under its own rules: architected for a reader who wasn't in the
room, not sedimented from the conversation that produced it._

---

## 1. The thing

Across the toolbox — Digestify, Tuskboard, Grapevine, and whatever comes next —
the same shape keeps appearing, and it's distinct enough to deserve its own
name. These are **lightweight, standalone, purpose-built surfaces with an agent
as the runtime underneath.** A spell isn't wired to a database or a conventional
server. The agent is the orchestrator; the UI is served locally; authentication
and API access live at the MCP layer, which keeps the client thin. The surface
is a membrane — you act on it, intents bubble up, the agent interprets and
responds.

What they are _not_ matters as much as what they are:

- **Not chat widgets.** Much of the public "MCP Apps / generative UI" work
  renders inside a chat host. These don't. The separation is the point — chat is
  one channel, good for negotiation and clarification; other modes (drawing,
  dropping in images, moving cards on a board) deserve their own surface. Call
  it _surface-fit_: match the interaction to the place that fits it, instead of
  forcing everything through one pane.
- **Not fully generated at runtime.** The interfaces are defined and consistent,
  not conjured fresh every time a request is phrased differently. Generation
  happens at _build_ time — a way to author a surface fast — and then the
  surface freezes into something stable you return to and refine. Same problem,
  same UI; it earns its keep through familiarity, not novelty. The full
  generative-UI path wants a heavy component-abstraction framework. Too heavy.
  The light path is a scaffold plus a house-style skill.
- **Not transient.** A widget dies with the message that drew it. A spell's
  effect can persist — Tuskboard is a place you go back to, not a flash of
  light. It has its own state and identity.

Underneath all of it: the UI is a thin, ephemeral layer; the agent is the
runtime. This is an in-between stage on the road toward "the agent as the
computer" — but a deliberately conservative one, durable where the generative
frontier is disposable.

## 2. Why "spells"

The artifacts are, functionally, **skills** — portable HTML and TypeScript you
can zip up and hand to someone. "Spell" is one phoneme away, and the gap between
the two words is exactly the magic: a skill is a capability; a spell is a
capability you _cast_ to conjure a temporary effect.

The name isn't decoration — it points at something true about this moment in
computing. For forty years the interface was _manipulation_: point, click, drag,
handle the objects directly. Agents brought back _incantation_ — you say the
words and the effect occurs. A spell is the original **performative utterance**:
language that doesn't describe an effect but enacts it. "Join the vine" isn't a
report, it's a cause. The whole craft now runs on speech-acts, which is why a
metaphor from the era when people believed words could reshape the world finally
fits a technology that delivers a working version of it.

And it keeps the work honest. The moment building a spell stops feeling like
_casting_ and starts feeling like _erecting a building_, you've drifted into the
heavy machinery you were trying to avoid. The name does quality control.

## 3. The cosmology

A working metaphor needs working nouns and verbs. These are the ones that fell
out:

- **The mage** holds the intent — the goal, the taste, the judgment.
- **The familiar** channels and amplifies it. Casting is _collaborative_: the
  mage can't conjure alone, the familiar supplies the part the mage can't. The
  familiar is the continuous presence — spells come and go, the companionship
  persists.
- **The spellbook** (this) is the collection — the grimoire of what's been
  learned and inscribed.
- **A spell** is a skill that conjures a surface. A **cantrip** is the cheap,
  instant, cast-and-resolve kind (a quick reading surface). A **conjuration**
  summons something with _duration_ — a construct that stands and acts until
  dismissed (a daemon, a board you live in).
- **Casting** is the incantation — spoken or written, in conversation. The
  spell's **name is its trigger**: to name a thing is to be able to summon it,
  so naming is not cosmetic, it's the mechanic. A clumsy name is a fumbled cast.
  Reserved, set-apart trigger words — Latin, even — aren't whimsy; they're an
  unambiguous command namespace that can't be confused with ordinary talk.
  Grimoires used Latin for the same reason.
- **The conjured effect** is the running surface itself.

There's an older lineage under "spell" worth keeping, because it answers a
question the magic frame raises. The surface is also a kind of **mask** — and
_mask_ traces to _persona_, "to sound through": the agent's voice sounds
_through_ the surface, shaped by it. The mask was never about concealment; it
was about projection. Whether the surface is a mask the agent _wears_
(expressing a particular agent) or a **vessel** any agent can _step into_ (a
neutral form) is left open below — but "spell" mostly sidesteps it: a spell
isn't worn or inhabited, it's conjured.

## 4. The liaison — a spell whose effect is a translator

The strongest signal from the multi-agent work: when several agents grind
through something deep and technical and you drop in late, reconstructing the
state is brutal. You're needed for maybe a tenth of the decisions — but those
matter, and they need context.

The **liaison** is the spell that solves this. Not a separate channel competing
with the raw conversation — a **read model over the swarm.** The agents'
conversation is the source of truth, the write side, the event log; the liaison
maintains a synthesized, human-facing _projection_ of it. You keep full
drill-down whenever you want to watch the agents talk, _and_ you get the
filtered feed, because one is the substrate and the other is a view derived from
it. (CQRS, applied to human attention.)

What it hands you is a **decision brief**, not a transcript: the question, the
current state, the background you specifically need, what's already decided,
what's referenced, the options. And it must **link back into the raw log at the
exact moments it summarizes** — because a liaison that summarizes confidently
and omits the one thing that mattered is a single point of trust failure. The
drill-down is the verification path that makes the feed safe to act on.

Implementation shape: cheap continuous note-taking (a running model of decisions
and open threads) plus heavy synthesis only at decision points. The hard part
isn't summarizing — it's the liaison modeling _what you already know_, so the
brief carries the right context and no more.

## 5. The deeper pattern — co-evolution

The apps were the surface. The thing underneath, the one that actually animates
the interest, is **living, self-modifying systems** — and it shows up at three
nested scales:

- **The spell** refines through use.
- **The familiar relationship** compounds — mage and familiar learn to cast
  together, and the practice deepens.
- **The anthill** — agents are ants; the project, the docs, the environment is
  the nest. They are symbiotic: the form conforms to the ants' needs and evolves
  as those needs evolve.

The anthill has a precise mechanism behind it: **stigmergy.** Ants don't message
each other; they modify the shared environment (pheromone trails, the structure
of the nest), and the next ant responds to the changed environment. The
environment _is_ the coordination medium. The docs, the shared store, the event
log — those are the pheromone trails. This carries a design directive that cuts
against the obvious move: a colony is robust _because_ no single ant matters. So
invest in a **richer substrate** — better trails, better-structured docs — more
than in making each agent a genius who reads everything. Make the nest carry the
intelligence; keep the ants light.

## 6. The craft — how spells are learned, and pruned

Spells aren't written once, they're grown. Two systems, which are really two
halves of one loop:

- **Fresh-agent testing (the empirical half).** Send a cold agent in to use a
  tool and report the friction. This reveals the agent's _actual_ failure
  distribution — where things break, not where you imagined they would. The
  fresh agent's true asset isn't authorship, it's **interrogation**: it asks
  about the things the doer found too obvious to mention, and each question is a
  curse-of-knowledge gap located precisely. The breakdowns tell you _that_
  something's missing; the questions tell you _what_.
- **Scenario capture (the theoretical half).** When the familiar reaches a
  conclusion the mage disagrees with, capture the scenario: the mage explains
  the reasoning, and what's distilled is not the fix but the _judgment that
  produced it_ — how the mage thinks, what the real problem was. That goes back
  into a skill or a methodology doc. It's apprenticeship, not instruction: you
  transmit the judgment that generates the rules, because that's the only thing
  that generalizes to cases you haven't hit.

The disease both systems fight is **context bleed** — the curse of knowledge.
The agent that did the work sediments its own hot context into the artifact
instead of architecting for a consumer who shares none of it. Hence the
governing rule of authoring: **architect for the reader's context, not your
own.**

That rule has one operational test, and it governs nearly every include/exclude
decision: **reachability from the agent's trajectory.**

- A hazard _on the route_ → include it. ("Careful, the floor is wet." A good
  defensive negative.)
- Information _reachable from the route_ → omit it; the agent will fetch it.
  (Let-me-google-that. And don't warn against detours nobody's taking — "don't
  take a shower" only plants the idea.)
- Something the goal needs but that sits _off the route_ → include it; it can't
  be reached. (The non-obvious tool.)
- Off the route and not needed → say nothing.

One question collapses all four: _what can the agent reach from where it's
standing, and what does it need that it can't reach?_ Include only the
needed-and-unreachable; let it fetch the reachable; leave the rest unsaid. Two
corollaries fall out — context is an **attention budget** (what you leave out is
load-bearing; spelling out the unwanted can backfire by raising its salience),
and **reference, don't inline** (inlining a tool's docs duplicates a source of
truth and rots when it drifts; the agent's ability to fetch the canonical source
is what lets instructions stay thin).

A shape worth naming, because every good rule here has it: **a mature principle
is an imperative plus its own boundary checks** — a _spatial_ one ("avoid
negatives, unless the hazard's on the route") and a _temporal_ one ("omit the
discoverable, unless you've verified it's reachable — and re-check when the
route changes"). A bare imperative curdles into its own failure mode. The
boundary-check is the appeal clause.

Which leaves the hardest problem: **accretion.** Rules are easy to add and
brutal to remove — adding has an attributable payoff and a diffuse cost,
removing has a diffuse payoff and a concentrated, named risk. Skills ratchet,
the way tax codes do. Two things save this system from the tax code's fate.
First, it **remembers why each rule exists** — the captured scenario is the
repeal criterion, Chesterton's fence with the builder's note nailed to it.
Second, the anthill already holds the cure: **pheromone trails evaporate unless
reinforced.** Let rules decay by default and stay vivid only when recurring
scenarios keep walking them. "Removal is hard" becomes "survival requires
reinforcement," and nobody has to make the frightening delete. Growth gets all
the attention in these systems; decay is the half nobody builds, and it's the
half that keeps the thing from collapsing under its own weight.

## 7. Still open

Kept open on purpose:

- **Who casts?** Is the mage the caster and the familiar the conjured force, or
  is the agent casting _for_ a patron? Wizard-with-familiar, or patron
  commissioning a resident sorcerer — the answer changes the feel of the whole
  system.
- **The summoned intelligence.** Behind a running spell — is it the one familiar
  showing up in different masks, or a fresh being summoned per spell? One
  persistent agent in many guises, or a swarm.
- **Mask or vessel.** Does a surface express a particular agent, or is it a
  neutral form any agent inhabits? Maybe the vessel is neutral until an agent
  steps in and makes it a persona.
- **Does the familiar accumulate?** If casting leaves a trace the two of you
  carry forward, the relationship — not the spellbook — becomes the thing that
  compounds.
- **Should authoring be a role?** A documentarian / interrogator whose _lack_ of
  context is the credential, not a deficiency — possibly the same job as the
  tester, the liaison, and the scenario-distiller seen from different angles.
- **When two principles conflict, what arbitrates?** And is reconciling them
  itself a capturable scenario — the method turned back on itself?
- **Reachability expires.** Every spell carries a reachability assumption that
  ages as the models beneath it strengthen; a line you needed today becomes dead
  weight tomorrow. Today's tester can't see that — which is the meta-layer's
  real second job: watch across _time_ for what is coalescing and what is
  quietly going dead.

---

_The spells are how it expresses itself. The familiar is who it's expressed
with. The anthill is what it's becoming._
