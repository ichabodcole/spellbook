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
  and, with a document open, the board shows an error bar ("… which is not in
  this set"), which is feedback, if blunt; checked 2026-09-29. With no document
  open, a relative link is dropped silently (`if (open)` in `App.tsx`).
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

**From the round-three no-stake verifier (2026-10-01):**

- **Keyboard focus leaves confirmation modals.** Tab from the dialog's last
  button reaches the search box and top-bar buttons behind it; the page root is
  `aria-hidden` but not `inert`. It is the kit's `ConfirmDialog`, so version
  delete has it too; it predates the End session button.
- **A `--doc` refusal lists only open documents.** `--doc other.md` for a
  document in the context but not open lists `choices: ["ch"]`, though
  `SKILL.md` says the refusal names the paths that would have worked.
- **Phone width:** at 390 px the top bar pushes End session partly off-screen
  and the theme toggle out of view. The three-pane layout was never built for
  that width.
- **Compare's tooltip is mouse-only:** a disabled Compare cannot take keyboard
  focus, so a keyboard user never learns why. Show diff's accessible name does
  not contain its visible label.
- **"Session ended" is easy to miss:** it uses the same muted style as
  "connected".
- With several versions, Compare opens against the file and says "These two
  versions are identical" when v1 equals the file, which can confuse.
