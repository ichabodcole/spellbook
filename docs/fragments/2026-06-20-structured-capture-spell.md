# A structured-capture spell — brain dump → mapped artifact (digestify's inverse)

> **Merged → `2026-06-30-mind-mapper-spell-concept.md`** (the consolidated
> best-of for this spell). Kept as the origin spark — its provenance/source-span
> mechanic, the digestify-inverse framing, and the consulting field-precedent
> were folded into the merged doc. Same concept, captured at a different time.

**Date:** 2026-06-20 **Tone:** Type 2 (curiosity / "what if we tried…") — a
thing we'll probably build **Status:** captured spark, not yet a project

## Context

Came up in a brain-dump _about_ brain-dumping (the irony noted at the time). The
recurring move: Cole talks an idea out — to an agent, or as a client/consultant
in a real session — and the value is locked in the talking. What's missing is a
spell whose **artifact is the capture itself**: you dump (or converse), and it
crystallizes into a saved, structured document holding the content, an analysis,
the takeaways, and (where it applies) a relationship map.

Field-tested precedent, not hypothetical: Cole already does this in consulting
work. A Zoom transcript of a client session (e.g. an HR team explaining their
process) gets fed to an agent → the agent pulls out **claims** ("so-and-so said
X about this system"), notes who **confirmed/denied** them, points each one
**back to its source** in the transcript, and diagrams the systems/relationships
discussed with mermaid. This spell generalizes that workflow into a re-castable
surface.

Explicitly framed as **the inverse of digestify**: digestify pushes structured
content _to_ the human to consume (read + answer inline); this captures _from_
the human and structures it. Same spirit (a co-presence surface for shared
understanding), opposite direction of flow.

## The idea

A brain-dump / mind-mapping spell. Core loop: human dumps → agent(s) probe and
distill → a structured, saved artifact materializes alongside the conversation,
which the human validates and extends on the board ("yes, that's the right map,"
"that insight matters — let me add to it"). It's an imago-style **game board**:
a thing built together to understand something — here, the contents of a dump or
conversation.

The captured cards distilled from the playback:

1. **The core inversion — produce, not consume.** The artifact _is_ the capture
   (content + analysis + takeaways). Mirror of digestify.
2. **Evidence-linked cards.** The dump distills into cards — a claim, an
   insight, a takeaway — each with a short synopsis **and a pointer back to the
   source span** it came from (sentence / line-range references). The point is
   the evidence-based back-and-forth: every distilled claim is traceable to
   "here's where you said it." (Straight from the consulting claims-with-sources
   workflow.)
3. **Mermaid as the relationship surface.** Text-driven diagrams the human sees
   (and the agent can re-read) to land on shared understanding — mapping the
   _systems_ or _relationships_ discussed, or even _the conversation itself_.
4. **Game-board / co-presence.** The human is in the loop on the artifact, not
   just receiving a report — validating and editing what the agent surfaces.
5. **Multi-agent role split.** Modeled on a consulting team: one agent is the
   **liaison / "therapist"** running the conversation and probing; one or two
   **documenter** agents watch and build the cards / notes / diagrams in
   parallel. The human mostly dumps; capture happens alongside, not after.
6. **Feeds forward.** The artifact is a launchpad — far easier to turn a
   captured-and-mapped dump into a proposal or project than to start cold. A
   natural upstream feeder into the brainstorming → proposal pipeline.

## Why it might matter

- It closes the **produce** half of a pair digestify only half-covers — a clean,
  legible identity ("digestify's inverse") that doesn't duplicate any existing
  spell.
- The provenance mechanic (claims ↔ source spans) is genuinely valuable and
  already proven in real consulting work — this isn't a guess about utility.
- It's a co-presence surface in the manifesto's sense (board, not form), and a
  natural **upstream feeder** into the existing brainstorming/proposal pipeline
  — it makes the cold-start of a project warmer.
- The multi-agent liaison + documenter split is a concrete instance of the
  manifesto's still-open familiar/liaison thread, and lands near grapevine
  territory (multi-agent comms) — worth a real design pass.

## Open questions (the forks to settle at brainstorm time)

These are the decisions that reshape the surface — each was flagged as a fork in
the originating conversation:

- **Input mode** — live conversation (agent probes in real time) vs.
  paste-a-transcript-and-analyze vs. both. Biggest fork; changes everything
  downstream.
- **Single vs. multi-agent** — the liaison + documenter split is elegant but
  lands on grapevine territory. Is it MVP, or a later evolution over a
  single-agent core?
- **Provenance mechanism** — anchoring cards to source spans reliably needs an
  append-only, line-addressable transcript log. This is the load-bearing
  technical bit.
- **Surface shape** — cards + a mermaid canvas; relationship to the house
  surface stack (Bun daemon + React) and to grapevine.
- **Name** — open. Reserve at coalescence per `grimoire/trigger-registry.md`,
  not before.

## Trigger for revisit

When glamour-v2 is underway or done and there's appetite for a new spell —
brainstorm this properly (it's project-shaped, not backlog-shaped: it needs
design and option exploration). Graduate to its own project
(`docs/projects/<name>/`) at that point, starting from the forks above.

## Related

- `plugins/spellbook/skills/digestify/` — the consume-direction sibling; this is
  its inverse.
- `docs/PROJECT_MANIFESTO.md` — co-presence (board, not form); the still-open
  familiar/liaison thread the multi-agent split instantiates.
- `docs/projects/glamour-v2/proposal.md` — the queued work this sits behind.
- `grimoire/trigger-registry.md` — where the name gets reserved at coalescence.
