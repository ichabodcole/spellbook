---
name: inscribe
description:
  Author or revise a spell in the Spellbook. Use when a recurring problem looks
  like it wants an agent surface, when prototyping such a surface, when an
  exploration has coalesced and is ready to become a named spell, or when
  revising an existing one. Also when the user says "inscribe a spell", "add a
  spell", "this should be a tool", "let's prototype a surface for this". Walks
  the arc from problem → design → prototype → coalescence/naming → harden.
---

# Inscribe — from problem to spell

A spell is born from a **problem, not a name.** You don't decide "I'll make a
spell called X" and then build it — you have an itch, you design and prototype a
solution with your familiar, and somewhere in the iteration it stops being "what
even is this?" and starts being _a thing you'll return to._ **That** moment of
coalescence is when it becomes a spell: when you name it, give it an identity,
and solidify it. Naming is the act of solidifying, not the starting gun.

## Read these first (don't proceed without them)

- `docs/PROJECT_MANIFESTO.md` — what a spell _is_ (cantrip vs conjuration, the
  agent-as-runtime model, why "spells").
- `grimoire/house-style.md` — the conventions, each with its boundary check and
  repeal criterion. **The source of truth.**
- `scaffold/README.md` — currently a pointer (the real templates get derived
  after the migration). It forwards to an existing spell to clone and to the
  `agent-surface-bun` recipe for the shared shape + Bun gotchas.

## The arc (problem → spell)

The earlier phases are exploratory and theme-light; the spell crystallizes only
at coalescence. Don't rush to the later phases — most of the value is in the
messy middle.

### 1. The itch

Start from the problem, not a name. "I keep needing X." "Reading this in the
terminal is painful." "I can't see what the agents are doing." Name the _need_,
not the tool — there is no tool yet.

### 2. Design with the familiar

Talk it through (your normal brainstorming flow). What's the real interaction?
Does it even want a surface, or is chat the right channel (_surface-fit_)? What
does the agent do underneath? Where does auth/API live (MCP-thin)? You're
shaping a solution, not committing to one.

### 3. Prototype scrappily, and iterate

Build a throwaway and feel it out — the `html-mockup-prototyping` skill is built
for exactly this. See how the surface reads, how the agent-interface works, what
the round trip feels like. Let the **shape** emerge from use: is it
cast-and-resolve, standing, or a mix? Don't reach for "cantrip/conjuration" or a
name yet — you're still finding out what this is. Iterate until it either
fizzles (fine — most things should) or starts to feel like _a thing you'll
return to._

### 4. Coalescence — name it and solidify

This is the graduation, and only now does the theme attach. When the exploration
has cohered:

- **Name it.** The name is the canonical handle — the folder name, the registry
  key, and the identifier the spell's many invocation phrasings resolve to (and
  the exact argument the planned **wand** CLI will take — a mage-facing tool,
  see `docs/fragments/2026-05-29-the-wand-mage-cli.md`). Open
  `grimoire/trigger-registry.md`, check collisions + reserved namespaces (a
  clash with a common word or another spell is a bug), and reserve the name. A
  clumsy name is a fumbled cast. (Conversational invocation stays plural —
  that's the SKILL.md's job, below.)
- **Fix its kind** (the prototype already told you): cantrip (one
  `POST /submit`, exits) or conjuration (standing daemon/board with a state
  snapshot), or the capability for both.
- **Give it an identity** — the visual treatment that makes it _this_ spell.
- **Solidify** the prototype into a real, self-contained spell at
  `plugins/spellbook/skills/<name>/` (the file anatomy — `SKILL.md` + `scripts/`
  - `assets/` — is in `plugins/spellbook/skills/README.md`). Clone an existing
    spell of the matching kind as the structural starting point (the tell: a
    conjuration ships a `daemon.ts`/`server.ts`, a cantrip doesn't), and bring
    the prototype's surface and contract into it, house-style in hand. Protocol
    types at the top; assets self-contained; honor the exit-code contract and
    the Bun gotchas (`grimoire/house-style.md` → "Carry the Bun gotchas"; full
    detail in the `agent-surface-bun` recipe).
- **Write the spell's SKILL.md** (this is what ships) — invocation, response
  shape, exit codes, Bun-on-PATH prerequisite. **Write the invocation
  generously:** multiple natural-language phrasings and any distinct lenses
  (e.g. creating vs. joining) so the agent recognizes intent however it's said —
  not one magic word. Include a **feedback touchpoint** (a structured opening
  for agent friction, and a human-feedback prompt when there's a surface —
  routed to GitHub issues against this repo). Write it all for a reader who
  shares none of your context: _architect for the reader, not yourself._

### 5. Harden

- **`bun test`** — pure-function coverage of parsers / state-merge, plus
  subprocess integration tests (submit / cancel / timeout).
- **Subtraction pass.** Before the cold agent sees it, cut the spell's SKILL.md
  to the least-explicit version you think works — you just did the work, so
  you've almost certainly over-specified. The fresh-agent test, next, tells you
  what was actually load-bearing.
- **Fresh-agent test** (`grimoire/fresh-agent/`) — send a cold agent in with
  only the name and intent; harvest its _questions_, not just its fixes; log
  findings. What it stumbles on is what you add back.
- **Capture scenarios** (`grimoire/scenarios/`) for any judgment the mage had to
  supply; bind each to a house-style rule and bump `grimoire/decay-ledger.md`
  for rules that got re-walked.

## When revising an existing spell

It's already coalesced, so skip the genesis arc — go straight to building the
change and **phase 5**. A revision is exactly when fresh-agent friction and new
judgments surface, and it's the moment to check `decay-ledger.md` for rules that
have gone stale and could be retired.

## Finishing

Hand off to **`ward`** — the consistency checklist that catches every listing
the new or revised spell must appear in (marketplace tags, the two spell tables,
the trigger registry), plus version bump, smoke test, and decay-ledger upkeep.
Spell work is plugin work: version the `spellbook` plugin and follow the
project's branch/finalize flow. A spell's _internal_ narrative version (the
"V1.x" banner some carry in their SKILL.md) is separate from the plugin semver.
