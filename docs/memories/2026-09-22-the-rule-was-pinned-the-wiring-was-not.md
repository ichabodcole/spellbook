---
type: memory
title: "The rule was pinned; the wiring around it was not"
description:
  Two Scriptorium branches in a row kept their rule in a pure, well-tested
  function and left the code that feeds and carries it untested; mutation is
  what found it both times
tags: [scriptorium, testing, mutation, verification]
status: stable
generated: { by: claude-opus-5.5, at: 2026-09-22 }
---

# The rule was pinned; the wiring around it was not

## What happened

On `feat/scriptorium-note-in-progress`, the rule for "is this note owed an
answer" was a pure function with thorough cells, and every mutation of it failed
a test. The reviewer of record then mutated the **plumbing** instead:

- the attention tick's change key, which ignored notes, so a note would never
  visibly turn "may be stuck";
- the stored author of an edit or a reopen;
- the text on a human's `note.edited`;
- the refusal of an ask about a missing note.

Every one of those mutants survived. The rule was right and fully tested, and
the facts it reads, and the code that carries its answer to the surface, were
not.

Branch 3 had the same shape one level down: E64 notes that `anchorCache`'s cell
"holds the rule, not the wiring", with only a browser run behind the wiring.

## What to carry forward

- **When a rule is extracted into a pure function, the tests follow the rule and
  stop there.** List what the rule reads (stored fields, who set them) and what
  carries its result (keys, broadcasts, event payloads), and give each one a
  cell or an integration check of its own.
- **A change key or a comparison that decides whether to send is logic.** Make
  it a named pure function (`attentionKey` here) so it can be tested without
  waiting on a real clock.
- **Mutate the plumbing, not only the rule**, before handing a branch to review.
  A green suite says nothing about lines no test reaches.

**Key files:** `src/scriptorium/backend/waiting.ts`,
`src/scriptorium/backend/daemon.integration.test.ts`

**Docs:**
[the session](../projects/scriptorium/sessions/2026-09-22-a-note-that-says-it-is-with-the-agent.md),
[E65](../projects/scriptorium/decision-log.md#e65--a-note-shows-that-it-is-with-the-agent)
