---
type: item
title: "Scriptorium: small chat and toast leftovers"
description:
  "Small Scriptorium leftovers from real use and three verifier rounds: chat and
  toast nits, the kit modal's focus trap, crash-path refusals with no restore
  hint, a bare tail that retries after an end, same-named documents, a double
  saved on ⌘S, phone width."
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

**From the round-three second verifier (2026-10-01):**

- **After a crash, verbs answer `internal` with no way back.** After a
  `kill -9`, the session pointer stays, and `say`/`state` on that session return
  `internal` (exit 1, "Unable to connect…") with no restore hint; the hint only
  appears once the pointer is gone. `tail.lost` does name `open --restore`.
- **Search spins forever on a killed daemon.** The map and path box say
  "disconnected"; search keeps showing "Searching…". Round three fixed the same
  shape for a deliberate end only.
- With a killed daemon, the disabled End session button keeps its "End this
  session…" title.
- An agent-close refusal's `choices` lists every saved session, including
  unrelated live ones (the hint names the right one).

**From the round-three third verifier (2026-10-01):**

- **A bare `tail` (no `--session`) never stops after a session ends.** Even with
  `--once` it prints "# no session yet, retrying…" every ~3 s while the pointer
  names an ended session, though `say`/`info` with no `--session` correctly say
  the human ended it. The kit's tail handoff waits on a bare first arm by design
  (D1); after an end that wait is false.
- **Same-named documents get identical human lines.** With `docs/beta.md` and
  `other/beta.md` open, both outside-write lines say "v4 of beta.md…"; nearby
  system lines use the agent's slug `beta-2`, which the sidebar never shows.
- **One ⌘S in the raw editor sends two `saved` events** about 1 ms apart, and
  the chat shows "Saved vN to …" twice; the Save button sends one.
- A `--body-file` inside a folder that cannot be opened (folder chmod 000) is
  reported as not found rather than cannot be read.
- A re-armed `tail --once` with no `--since` prints `"cursor": -1` in
  `tail.closed`.
