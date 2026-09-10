---
name: inscribe
description:
  Author or revise a spell in the Spellbook. Use when the user wants to turn a
  recurring problem into an agent surface, prototype such a surface, graduate an
  exploration into a named spell, or revise an existing one. Also when the user
  says "inscribe a spell", "add a spell", "this should be a tool", "let's
  prototype a surface for this". Walks the arc from design → prototype →
  coalescence/naming → harden.
---

# Inscribe — grow a spell

A spell is **grown through iteration, not specced up front.** The user has an
itch; you design and prototype with them, and somewhere in the iteration it
stops being "what even is this?" and becomes _a thing they'll return to._ That
moment — coalescence — is when it gets a name, an identity, and a real home.
This can span sessions; don't rush to the later phases.

## 1. Frame the conversation

Before building, get the shape of the need. The questions worth asking:

- **The goal** — what's the problem, in the user's terms?
- **Surface-fit** — does this even want a surface, or is chat the right channel?
- **What the surface gives the human** — what do they see / decide / submit?
- **What the agent does underneath** — the work the surface is a membrane over.
- **One agent or several** — solo, or multi-agent (orchestration / assignment /
  watching)? This shapes the whole design.
- **Where auth/API lives** — kept thin, at the MCP layer.

Don't reach for "cantrip vs. conjuration" or a name yet — those are outputs of
the prototype, not inputs.

## 2. Prototype scrappily, and iterate

Build a throwaway and feel it — the `html-mockup-prototyping` skill is built for
this. See how the surface reads, how the agent-interface works, what the round
trip feels like. Let the **shape** emerge from use: cast-and-resolve, standing,
or a mix. Iterate until it either fizzles (fine — most explorations should) or
starts to feel like a thing worth keeping. Most of the value is in this messy
middle.

## 3. Coalescence — name it and solidify

When the exploration has cohered:

- **Name it.** Reserve the name in `grimoire/trigger-registry.md` (check
  collisions + reserved namespaces — a clash with a common word or another spell
  is a bug). The name is the canonical handle: folder name, registry key, and
  the token the future `wand` CLI will take. A clumsy name is a fumbled cast.
- **Fix its kind** — the prototype already told you: cantrip (one
  `POST /submit`, exits) or conjuration (standing daemon holding state), or
  both.
- **Give it an identity** — the visual treatment that makes it _this_ spell.
- **Give it a real home — and this step is a PLAYBOOK, not a clone.** ⛔ It used
  to read _"solidify into a self-contained spell at
  `plugins/spellbook/skills/<name>/`; clone an existing spell of the matching
  kind"_, which describes the world before the backend convergence. **All eight
  spells now build**: the authored source lives at
  `src/<name>/{backend,surface}/`, the skill folder carries a **committed,
  generated `dist/`** and **launchers** at `scripts/`, and the kind (cantrip vs
  conjuration) decides **none** of the structure. Follow
  [`docs/playbooks/scaffolding-a-spell-playbook.md`](../../../docs/playbooks/scaffolding-a-spell-playbook.md)
  — start with its eight questions, which are the design choices everything else
  dispatches on. Then hand off to `ward`, which is the checklist.
  (`grimoire/house-style.md` remains the source of truth for conventions and the
  Bun gotchas.)
- **Write the spell's SKILL.md** (this is what ships). Write the invocation
  **generously** — multiple natural phrasings and any distinct lenses (e.g.
  creating vs. joining) so the agent recognizes intent however it's said.
  Include a **feedback touchpoint** (a structured opening for agent friction,
  plus a human-feedback prompt when there's a surface — routed to GitHub issues
  against this repo). Write for a reader who shares none of your context.

## 4. Harden

- **`bun run build`, then `bun scripts/dist-check.ts` unpiped (expect `0`)** —
  the generated `dist/` is **committed**, so source without it ships nothing.
  Confirm the spell appears **by name** in the roster `dist-check` prints; a
  spell absent from that roster has not been examined, not passed. Exit `3` is
  NO VERDICT.
- **`bun test`** — cover parsers / state-merge, plus subprocess integration
  (submit / cancel / timeout). **Test the ARTIFACT, not only the source**, and
  expect the pinned instruments to red on a new spell's arrival — that is them
  working. See the playbook's instrument phase for the twelve pins.
- **Drive the launcher end to end and watch the process** — it either exits when
  it must or stays up when it must, and reading the file does not tell you
  which.
- **Subtraction pass.** Cut the spell's SKILL.md to the least-explicit version
  you think works — you just did the work, so you've almost certainly
  over-specified. (Two house disciplines to apply: only include what the agent
  can't discover at the moment of use, and don't write an exclusion unless the
  wrong path is reachable from what you've already said.)
- **Fresh-agent test** (`grimoire/fresh-agent/`) — send a cold agent in with
  only the name and intent; harvest its _questions_, not just its fixes. What it
  stumbles on is what you add back.
- **Capture scenarios** (`grimoire/scenarios/`) for any judgment the user had to
  supply; bump `grimoire/decay-ledger.md` for rules that got re-walked.

## Revising an existing spell

It's already coalesced — skip to building the change, then phase 4. A revision
is exactly when fresh-agent friction and new judgments surface, and the moment
to check `decay-ledger.md` for rules gone stale.

## Finishing

Hand off to **`ward`** — the consistency checklist for everything a new or
revised spell must touch (listings, version bump, smoke test, decay-ledger).
