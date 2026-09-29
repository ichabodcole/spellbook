---
type: item
title: "Scriptorium: small chat and toast leftovers"
description:
  A chat link to a missing doc gives no feedback; GFM footnote ids repeated
  across messages (fixed); the agent's version-new then activate mounts the
  new-version toast for ~1 ms.
status: draft
lifecycle: backlog
id: 01a0eab2-ed0c-7292-8381-bc4a228e93da
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
---

# Scriptorium: small chat and toast leftovers

Found by the browser verifier of
[cycle/2026-09-scriptorium-from-real-use-2](../cycles/2026-09-scriptorium-from-real-use-2.md)
(2026-09-28); filed, not scheduled.

- **A chat link to nowhere gives no feedback.** A relative link to a missing doc
  (`nope.md`) or a protocol-relative one (`//evil.example/x`) goes to the daemon
  and nothing happens: no log line and no toast. With no document open, a
  relative link is dropped silently (`if (open)` in `App.tsx`).
- ~~**Footnote ids repeat.**~~ **Fixed.** Each chat message with a GFM footnote
  added its own `footnote-label` / `user-content-fn-1` ids, and the
  `#user-content-fn-1` ref link went to the daemon as a document link. Cole hit
  it on 5.0.0: "That link points at #user-content-fnref-1, which is not in this
  set." Now a chat message's footnote ids carry its message id
  (`renderMarkdown(text, { idPrefix })`), and a link that is only a fragment
  jumps within the container that was clicked (`renderedLink.ts`). It never
  reaches the daemon and does nothing when there is no target. The document view
  follows the same rule.
- **A toast mounts for about 1 ms.** The agent's `version-new` followed by
  `activate` is two acts, so the new-version toast mounts and is replaced about
  1 ms later by "Now editing". On screen it's one toast, but a screen reader may
  announce both.
