# Fragments

Fragments are incomplete observations captured during development - both the
"this doesn't feel quite right" concerns and the "what if we tried..."
curiosities. They're pieces that don't fit into other document types but might
become important later.

## Why Fragments Matter

Think of fragments as **breadcrumbs** or **threads** - individually small
observations that form trails revealing patterns you wouldn't see otherwise.

In our documentation map metaphor:

- **Proposals** show high-level points on the map (where we're headed)
- **Plans** show tactical waypoints (gas stations, exits to take)
- **Sessions** capture the actual territory covered (what we saw along the way)
- **Fragments** are those interesting places you noticed on the side of the road
  but didn't stop to explore

### Breadcrumbs to Future Insights

One fragment means little. Multiple fragments pointing in the same direction
reveal a pattern:

- "This modal felt clunky" (one breadcrumb)
- "Another modal that was awkward, and a dropdown that was confusing" (more
  breadcrumbs)
- Following the trail → "We keep hitting input UX issues - maybe our form
  patterns need rethinking"

### Evidence Someone's Been Here Before

When you're mid-development thinking "this feels awkward" and find a fragment
from 3 months ago saying the same thing, you learn:

- **This isn't just today's mood** - Multiple visits means it's real
- **You're not starting from zero** - Past observations give you a starting
  point
- **Maybe it's time to act** - If you keep coming back, the trail is saying
  "this matters"

In team contexts, fragments create social memory: "Oh, someone else noticed this
too - maybe there's something here."

## What Are Fragments?

Fragments capture two types of incomplete thoughts:

### Type 1: "Something Doesn't Feel Right"

Unease about the current solution - mysteries, workarounds, or technical debt:

- **Unresolved mysteries** - "We worked around this but don't know why it
  failed"
- **Technical debt observations** - "This works but feels hacky"
- **Architectural concerns** - "This mismatch might matter someday"
- **Lingering doubts** - "Is this really the right abstraction?"

### Type 2: "What If We Tried..."

Curiosity about alternative paths - not dissatisfaction, just unexplored
opportunities:

- **Alternative technologies** - "Library X works, but library Y might handle
  this better"
- **Different patterns** - "Pattern A is fine, but pattern B could be more
  elegant"
- **Unexplored approaches** - "We chose simplicity, but there's a more
  sophisticated option"
- **Future optimizations** - "This scales well enough, but approach X might
  scale better"

## What Fragments Are NOT

- **Not action items** - No urgency or commitment to investigate
- **Not proposals** - Too speculative or incomplete
- **Not investigations** - No active research happening
- **Not lessons learned** - No specific bug/solution pair
- **Not architecture docs** - Not documenting existing systems

## When to Create a Fragment

Create a fragment when you notice something during development that:

1. Doesn't feel quite right
2. You worked around rather than solved
3. Might become important with more context
4. Doesn't warrant immediate investigation
5. You want to remember for later

## Fragment Lifecycle

Fragments can evolve into:

- **Investigation** - When you decide to actively research the question
- **Project** - When you have enough context to propose a solution (create a
  project folder)
- **Lesson Learned** - If the issue manifests as a bug and you fix it
- **Architecture Doc** - If it reveals insights about system design
- **Nothing** - Some fragments age out as irrelevant (and that's fine!)

## Structure

Fragments are intentionally non-conformist. Common elements include:

- **Context** - Where/when this came up
- **Observation** - What doesn't feel right
- **Why It Might Matter** - Potential future impact
- **Related Docs** - Links to project sessions, investigations, etc. that
  spawned this
- **Trigger for Revisit** - What would make this worth investigating

## Naming Convention

```
YYYY-MM-DD-brief-description.md
```

Example: `2025-11-11-testing-infrastructure-unknowns.md`

## Tips

- **Keep it lightweight** - Don't overanalyze, just capture the thought
- **Link liberally** - Connect to project sessions, code locations, related docs
- **Date them** - Helps understand context when reviewing later
- **Review periodically** - When starting new work, scan fragments for relevant
  observations
- **Archive freely** - Move stale fragments to `fragments/_archive/` when no
  longer relevant
- **Both tones are valid** - "This worries me" and "this intrigues me" are both
  worth capturing

## Examples

**Type 1 (Concern):**

- "Used workaround X because approach Y failed mysteriously - should investigate
  why Y didn't work"
- "This abstraction feels leaky - might need refactoring when we understand the
  domain better"

**Type 2 (Curiosity):**

- "Implemented with REST API, but GraphQL might offer better flexibility for
  this use case"
- "Used simple caching strategy that works well - could explore Redis for better
  performance if needed"
- "Chose library X for familiarity, but library Y has interesting features worth
  exploring"
