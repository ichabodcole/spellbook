---
type: item
title: "Scriptorium: small chat and toast leftovers"
description:
  "Small Scriptorium leftovers from real use and three verifier rounds: chat and
  toast nits, the kit modal's focus trap, crash-path refusals with no restore
  hint, a bare tail that retries after an end, same-named documents, a double
  saved on ⌘S, phone width."
status: stable
lifecycle: active
id: 01a0eab2-ed0c-7292-8381-bc4a228e93da
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
priority: medium
cycle: 2026-10-release-6
---

# Scriptorium: small chat and toast leftovers

Found by the browser verifier of
[cycle/2026-09-scriptorium-from-real-use-2](../cycles/_archive/2026-09-scriptorium-from-real-use-2.md)
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

**From the "Links tell the truth" verifier (2026-10-04), predating that cycle:**

- **Link toasts stay up until dismissed.** A followed link's "not in this set"
  or folder toast never times out.
- **Search lists a line twice** when the query matches twice on it.
- **`backlinks` repeats the same source once per link**, with no line to tell
  the entries apart (#127 adds `line` and `raw`).
- **`C:/win/path.md` is read as a link with scheme `c`** and reported under
  `dangling`'s `unsupported`, not as a path.

**From the second "Links tell the truth" verifier (2026-10-04), predating that
cycle:**

- **Links inside an HTML block are counted** (`<div>\n[x](./a.md)\n</div>`, or
  after `<table>` or a custom tag), though the view shows the block as text.
- `[x](<./a.md)` (unclosed `<`) is counted with the target `<./a.md`.
- `[x](./a&amp;b.md)` is looked up literally; the view opens `a&b.md`.
- **Missed though clickable:** reference-style links (`[x][r]`, `[r][]`, `[r]`;
  documented as unsupported), labels nested two deep, a target with two levels
  of parentheses.
- **A bare name searches only the link's own set:** `[x](Real)` in `other/` says
  "no document here is named Real" with `world/real.md` open.
- **A symlinked folder is entered twice:** `open world wlink` adds `/world` and
  `/wlink`; `open world world` echoes the entry twice in `entries`.

**From round three of "Links tell the truth" (2026-10-04), predating that
cycle:**

- A link label whose `[` ends a line, followed by a list line
  (`x][\n- 1. \[a](./a.md)`), is still counted; the view ends the paragraph
  there.
- Links in table cells beyond the header's column count are counted; the view
  drops those cells.
- **pdocs folder keys do not resolve:** `parent: feature/spell-hardening` names
  `docs/features/<slug>/feature.md`, so on this repo's `docs/` 39 of 124
  dangling links are false.

**From the third "Links tell the truth" verifier (2026-10-04), predating that
cycle:**

- **An absolute filesystem path in a link is joined onto the set root**: a chat
  link to an existing `/…/cc.md` toasts "nothing at $S/sets/e$S/sets/e/cc.md",
  and `graph` calls an absolute body link `missing`. Agents write absolute
  paths.
- **An unreadable document (chmod 000) reads as having no links**, and nothing
  reports it, so its outbound links vanish silently.
- `links.partial` stays on the parent set after the `add <sub-folder>` remedy
  until that folder is also hidden; one flat folder over 2,000 files has no
  remedy.
- The frontmatter summary cache (`metaCache` in `session.ts`) keys on mtime only
  (since 2026-09-11), so an edit that restores the exact mtime can leave the
  sidebar's summary stale. The links cache now also keys on ctime and inode.

## Definition of done

Approved by Cole at triage, 2026-10-24.

- [ ] Each bullet re-checked against the kit Scriptorium, then marked fixed
      (with a commit), fixed in this cycle, or moved to its own item. None is
      left unchecked.

## Re-check, 2026-10-25

Every bullet was re-checked on `cycle/release-6` (78303c66) against the kit
Scriptorium, in a real browser for UI bullets and through the CLI and daemon for
wire bullets. Bullets are numbered in the order above. Cole approved the split
on 2026-10-25.

**Already fixed (13):** 1 (chat link to nowhere: an alert now), 2 (footnote
ids), 8 ("Session ended": an Ended pill and dialog), 10 (crash: `not_found` with
an `open --restore` hint), 11 (search on a killed daemon), 12 (killed daemon's
End session title), 14 (bare `tail` after a human end: stops after 45 s), 16
(one ⌘S, one save; `e1e42d50`), 17 (`--body-file` in an unreadable folder: now
says EACCES, still labelled `internal`), 21 (`backlinks` entries carry line and
raw), 23 (links in HTML blocks), 31 (pdocs keys listed as unresolved, not
counted; their resolution is `scriptorium-link-rules`), 32 (absolute paths in
links).

**Fix in this cycle (10):** 3 (two toasts announced), 4 (Tab leaves modals), 5
(`--doc` refusal names no path), 7 (disabled Compare's reason is mouse-only;
Show diff's name), 9 (Compare against the file says "identical"), 13 (close's
`choices` offers an unrelated live session), 15 (same-named documents told apart
by a slug), 18 (`"cursor": -1`), 19 (link refusal toasts never close; Cole:
close on Escape or when another document opens, no timer), 35 (frontmatter
summary keyed on mtime only).

**Own items (12 bullets, 8 items):** 24, 25, 26, 29 and 30 →
`kit-link-check-matches-rendered-view`; 6 → `scriptorium-phone-width`; 22 →
`kit-windows-drive-path-links`; 27 → `kit-bare-name-links`; 28 →
`kit-folder-and-link-one-set`; 33 → `kit-unreadable-document-reported`; 34 →
`kit-scan-cap-says-so`; 20 → `kit-search-line-once`.
