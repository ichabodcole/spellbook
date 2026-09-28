---
type: item
title:
  "The error-site enumerator's `: never` pattern reads into the next function"
description:
  "grimoire/lib/error-sites.ts recognises always-throwing helpers with a lazy
  600-character span, so a signature can match the next function's ): never and
  miscount census sites."
status: draft
lifecycle: triage
id: 01a0e6ff-78bd-77cc-bd2a-bb4348d0aa9e
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
---

# The error-site enumerator's `: never` pattern reads into the next function

Found by the astrolabe implementer in
[cycle/2026-09-one-act-one-answer](../cycles/2026-09-one-act-one-answer.md),
2026-09-28; worked around, not fixed.

`grimoire/lib/error-sites.ts` finds always-throwing helpers with
`\bfunction\s+NAME\s*\([\s\S]{0,600}?\)\s*:\s*never\b`. The lazy 600-character
span can cross the closing `)` of a function whose return type is not `never`
and end on the next function's `): never`. A draft that put a shared `: never`
helper after `coldBoard` made the census count `coldBoard` as a throwing helper
and report 17 astrolabe sites instead of 16; the implementer inlined the
refusals instead, so the shipped count is right.

The census pins are only as true as this enumerator. The likely fix: stop the
span at the parameter list's own closing parenthesis (no unbalanced `)` inside
it), and add a census test with a non-`never` function followed by a `never`
one.
