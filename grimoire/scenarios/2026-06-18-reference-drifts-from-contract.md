---
date: 2026-06-18
spell: imago
rule: Reference, don't inline
disposition: judgment-only
---

# A reference that restates the contract rots when the contract moves

## The situation

imago's context-library revision collapsed `styles[]`/`prompts[]` into one
unified Context Library and changed the agent-facing API: a new `context` verb,
`context.capture` event, and `state.activeContextIds`/`state.library`. The
SKILL.md was updated. The ward fresh-agent test then drove the spell cold and
found `references/mediaforge.md` still describing the _old_ API (`style` verb,
`--description`, `state.styles[].active`, `style.capture`) — and the SKILL.md
orders the agent to "read it before generating."

## What the familiar concluded

When the revision shipped, the SKILL.md was the obvious thing to update — it
holds the verb table and the loop. mediaforge.md is "just the generation
reference"; its job is model routing and prompt structure, so it was left alone.

## What the mage wanted instead

(Surfaced by the fresh-agent test, not asserted up front.) The reference had
**inlined** a copy of the style/context read+write API — the exact field names
and command shapes that belong to the contract — rather than deferring to it. A
copy doesn't get updated when the original changes; it silently contradicts it.
And because the SKILL _points the agent at the reference_ at generation time,
the stale copy isn't a dusty corner — it's on the hot path, read precisely when
the agent needs the truth. The fix wasn't "also update mediaforge": it was
**remove the inlined contract detail** so the reference defers to the single
source (SKILL.md + `types.ts`) and can't drift again.

## The distilled judgment

A reference earns its place by holding what the contract _doesn't_ — here,
generation mechanics. The moment it restates contract detail (field names, verb
shapes, event names), it has inlined a copy that will rot on the next contract
change, and the rot is invisible until a cold reader trips on it. When you
revise a contract, grep the references for the names you changed; better, author
references so they _point at_ the contract instead of restating it. Drift
between two docs is the same defect as drift between two listings — the ward
exists because copies don't update themselves.

## Binding

- **Rule affected:** `house-style.md` → "Reference, don't inline" (reinforced;
  also touches "Architect for the reader's context" — the trap sprung because
  the reader followed the SKILL's own "read this first" pointer into stale
  material).
- **Repeal criterion:** none — judgment-only; reinforces an existing rule.
