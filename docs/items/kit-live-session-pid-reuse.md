---
type: item
title: A reused pid makes a dead session count as live
description:
  A crashed session's pointer whose pid the OS hands to another process counts
  as live, so a single-session user's unpinned write is refused as ambiguous.
status: draft
lifecycle: triage
id: 01a1eb65-f951-7616-b0af-ddaaa5715ffc
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
parent: feature/workspace-kit-follow-ups
from: items/kit-unpinned-verbs-write-to-another-session/sessions/2026-11-17-ambiguous-session.md
---

# A reused pid makes a dead session count as live

Found by the review of the #137 fix (2026-11-17). `livePointers`
(`src/kit/wire/discovery.ts`) counts a pointer as live when `pidAlive` says its
pid is alive (EPERM counts as alive). A crashed session leaves its pointer
behind; if the OS later gives that pid to an unrelated process, the dead session
counts as live. With one real session open, that makes two, and every unpinned
write is refused as `ambiguous_session`. The refusal names `--session`, so it is
recoverable, but it is wrong.

The newest-live fallback had the same weakness before #137; the refusal makes it
more visible. Suggested fix: before counting a pointer as live, check that its
daemon answers on its port (the existing `answers(p)` probe), at least when the
count is two or more.

## Definition of done

- [ ] A pointer whose pid is alive but whose daemon doesn't answer on its port
      doesn't count as live.
- [ ] Tested with a stale pointer carrying a live, unrelated pid beside one real
      session: an unpinned write goes through.
