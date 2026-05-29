---
date: 2026-05-29
spell: cross-cutting
rule: Architect for the reader's context (+ Context is an attention budget)
disposition: changed-rule
---

# Reference the source of truth; reserve enumeration for the index

## The situation

While generalizing the spell-authoring docs (`inscribe`, `scaffold/README`,
`ward`), the drafts named the current roster inline — listing the specific
spells as examples ("cantrip → digestify, conjuration → tuskboard/grapevine")
and writing "the four spells."

## What the familiar concluded

Naming the concrete spells made the guidance vivid and complete — the reader
sees exactly which ones to copy, no ambiguity.

## What the mage wanted instead

Generalize. Those lists rot when the roster changes (names change, spells get
added) and create maintenance debt — does every such doc then need updating? The
reasoning was a stricter Occam's razor for instructional content: optimize for
**portability and low maintenance**, not explicit completeness. Two tests fell
out: _is this easily discoverable from where the agent stands?_ (the skills
folder + the daemon/no-daemon tell are right there) and _does the explicitness
add anything?_ If a generalization carries the same meaning, prefer it.

## The distilled judgment

Provide what is **not** discoverable from the agent's position; defer the
discoverable to its source. Reserve enumeration for the place that **is** the
index (README tables, the name registry) — and even there, only when the
explicitness earns its keep. When you do include a specific that could vary,
caveat it rather than assert it.

## Binding

- **Rule affected:** sharpened "Architect for the reader's context" boundary
  check (the _index exception_ + the _does-it-add-value_ test); reinforces
  "Context is an attention budget."
- **Repeal criterion:** if a generalization ever loses needed meaning, the
  specific belongs back — caveated ("X or similar"), not omitted.
