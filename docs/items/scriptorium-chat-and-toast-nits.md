---
type: item
title: "Scriptorium: small chat and toast leftovers"
description:
  "Small Scriptorium leftovers from real use and three verifier rounds: chat and
  toast nits, the kit modal's focus trap, crash-path refusals with no restore
  hint, a bare tail that retries after an end, same-named documents, a double
  saved on ⌘S, phone width."
status: stable
lifecycle: done
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

- [x] Each bullet re-checked against the kit Scriptorium, then marked fixed
      (with a commit), fixed in this cycle, or moved to its own item. None is
      left unchecked.
- [x] Offered on kit-parity (message 58, 2026-10-26).

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

**Fixed in this cycle, 2026-10-25** (on `impl/chat-toast-nits-fixes`, from
`cycle/release-6` at bd5018fe):

- **3, two toasts announced:** fixed in `6566ee18` and `5c38f09b`. A new-version
  toast is held 400 ms and dropped only if that version becomes active (or is
  deleted) meanwhile, so `version-new` then `activate` announces "Now editing"
  alone. A switch to another document does not drop it: it is raised after the
  hold, with Activate only.
- **4, Tab leaves modals:** fixed in `6da778d2` and `abac3e49`. The kit's modals
  make the rest of the page `inert` and send focus that lands on a focus guard
  round to the popup's other end. Nested modals may close in any order: each
  element counts the modals holding it.
- **5, `--doc` refusal:** fixed in `3fc868f5`. A filename of a context document
  that is not open gets a `hint` with its absolute path; a verb that takes a
  path (`version-new`, `show`, `backlinks`, `profile`, `graph --focus`) also has
  it in `choices`. SKILL says so.
- **7, disabled buttons:** fixed in `d02c67f1`. Compare and Split stay focusable
  with `aria-disabled` and their reason as their description. Show diff's name
  starts "Show diff:". #12's leftover is folded in: End session (and Settings)
  say why they are off while the daemon is not answering.
- **9, Compare's default target:** fixed in `8e271cd6` and `ad4b3e67`. Opened by
  the human, Compare asks the daemon to pick the first side whose text differs
  from the active version's: the file, then the other versions, newest first (an
  untouched `version-new` copy is passed over). When none differs it opens on
  the file and says "v1 matches the file on disk, and so does every other
  version." Against the file and the same, it says "v1 matches the file on
  disk." With no other version, it says that and that there is nothing else to
  compare.
- **13, close's `choices`:** fixed in `34ffd2be`. It is `[id]`, the stopped
  session the hint names.
- **15, same-named documents:** fixed in `2fd1ee96` (and `a0e55083` for
  Scriptorium's own note-remove line), with the agent's text kept in `0ac98880`.
  Human chat lines name a document as the sidebar does (`other/beta.md`). The
  agent's events keep their fields and their sentences as on base (absolute path
  or slug, names it can pass back to `--doc`): a full `tail --all` of one
  scripted session is identical on base and this branch.
- **18, `"cursor": -1`:** fixed in `30a32fc7`. A `tail.closed` or `tail.lost`
  that read nothing leaves `cursor` off.
- **19, link refusal toasts:** fixed in `b101136e`. A link refusal closes on
  Escape or when another document opens, with no timer.
- **35, the frontmatter summary cache:** fixed in `2361070c`. `docMeta` and
  `noFrontmatter` key on inode, size, mtime and ctime.
- **17's leftover** (optional): fixed in `34ffd2be` and `479ee39a`. An ENOENT or
  EACCES on a path the caller wrote (a `--body-file`) is `usage` (exit 2); on
  any other path (an unreadable session home) it stays `internal` (exit 1).

**Own items (12 bullets, 8 items):** 24, 25, 26, 29 and 30 →
`kit-link-check-matches-rendered-view`; 6 → `scriptorium-phone-width`; 22 →
`kit-windows-drive-path-links`; 27 → `kit-bare-name-links`; 28 →
`kit-folder-and-link-one-set`; 33 → `kit-unreadable-document-reported`; 34 →
`kit-scan-cap-says-so`; 20 → `kit-search-line-once`.

## Done and verified

The ten "fix in this cycle" bullets and 17's optional leftover are fixed in
`30a32fc7`, `34ffd2be`, `2361070c`, `3fc868f5`, `2fd1ee96`, `b101136e`,
`6566ee18`, `d02c67f1`, `8e271cd6`, `6da778d2` and `a0e55083`, with the rebuilt
dist in `0a8b2a07`. A second round after the no-stake verifier's "With fixes"
added `ad4b3e67` (9), `479ee39a` (17), `0ac98880` (15), `5c38f09b` (3),
`abac3e49` (4) and `eec47ac3` (tests for three mutations it found surviving).
With the 13 already fixed and the 12 moved to eight items of their own, all 35
bullets are accounted for. Each fix has a test, each test was seen to fail with
its fix reverted, and the gate passed. The surface fixes (3, 4, 5, 7, 9, 15, 19)
were checked in a real headless Chromium against the built base (bd5018fe) and
this branch, with real keyboard and mouse input.

Deliberate choices:

- **3:** the hold is 400 ms (`NEW_VERSION_HOLD_MS`). A version nobody activates
  is announced 400 ms later than before.
- **4:** the fix is in the kit (`ui/inertOutside.ts`) rather than Base UI.
  Inside a real browser, Base UI 1.6.0's own guards took focus but did not send
  it back; in happy-dom they do, so `inertOutside.test.ts` tests the module on
  plain DOM. It also covers the kit's Move to and location dialogs, which share
  the defect. The spells' own copies of the dialog recipe (bounty, grapevine,
  mind-mapper) are not kit and are unchanged.
- **7:** Settings sits beside End session in the same component and was disabled
  with no reason too, so it got the same reason.
- **9:** the header still says "identical" when the two sides match. That word
  does not call the file a version; the body sentence says what matched.
- **15:** the disk-change lines ("… changed on disk") now use the same short
  name instead of the absolute path.
- **19:** only the sidebar notice that Scriptorium owns changes. The kit's toast
  path for an app that does not own the notice, and the stand-in toast while the
  context column is collapsed, still time out as every refusal toast does. The
  daemon's other refusals are unchanged.
- **#17's leftover:** an ENOENT or EACCES is `usage` only when its path is one
  of the arguments (`callerNamed`); otherwise it is `internal`, as on base.
- **5:** a set-relative path also matches at the session (`unopenedNamed`), but
  the CLI makes any `--doc` with a `/` absolute (`docArg`), so from the CLI only
  a bare filename reaches that hint.

Landed on `cycle/release-6` (`25e904c2`). The gate there had 5 failures in
`hide.integration.test.ts` (5 s timeouts under parallel load); the file passes
alone, 11 of 11. Left after round two, filed as
`scriptorium-held-toast-goes-stale`: a held toast raised while another document
is open stays up if the agent activates or deletes that version from the CLI.
Also a behaviour change to know: Compare now picks its side each time it opens,
so a side the human chose is not remembered across closing Compare.

## Port-back notes

These are for Story Studio's agent. Each one is generic and names no app.

- **`wire/tailHandoff.ts`:** a stop line (`tail.closed` or `tail.lost`) leaves
  out `cursor` when it is below 0. `HandoffLine.cursor` is now optional.
- **`workspace/verbs.ts`:**
  - `noSession`: when the session is saved but stopped, `choices` is `[id]`.
  - `run`: ENOENT and EACCES map to usage only for a path the caller wrote
    (`callerNamed`); otherwise internal.
- **`workspace/session.ts`:**
  - `docOrDie(slug, { takesPath })` adds a `hint` naming the context paths that
    an unopened filename or set-relative path matches (`unopenedNamed`). With
    `takesPath`, those paths are also in `choices`.
  - `newVersion`, `doc(slug, { takesPath })` (used by `show`) and `linkSubject`
    pass `takesPath`.
- **`workspace/server.ts`:**
  - `docName(slug)` is `session.display(original)`. Every human chat line uses
    it, and the `original.*` lines use `display`.
  - `announce(text, fact, agentText)`: the event's sentence, when it must keep
    the absolute path or slug the chat line replaced (also on the app ctx).
  - The diff op's `pick` asks `session.compare({ pick })` for the first side
    that differs; the payload says `picked`, and `everyMatches` when none does.
- **`context/daemonClient.ts`:** a state frame that opens a different document
  clears a refusal titled `LINK_REFUSED`.
- **`shell/WorkspaceShell.tsx`:**
  - Escape clears a link refusal, unless something else already handled the key
    (`defaultPrevented`).
  - `ColumnButton` takes `disabledReason`, used by End session and Settings
    (`NOT_CONNECTED_REASON`).
- **`ui/disabledReason.tsx` (new):** a button that is off keeps focus, with
  `aria-disabled` and an `aria-describedby` note. The document pane's view
  buttons use it.
- **`chat/NewVersionToasts.tsx`:**
  - `holdMs` (default `NEW_VERSION_HOLD_MS`, 400): a version that settles
    (becomes active or is deleted: `versionSettled` in `newVersions.ts`) during
    the hold is never announced; a document switch does not drop it.
  - The Show diff `ariaLabel` starts with "Show diff:".
- **`document/CompareView.tsx`:**
  - `everyVersionMatches(active)` for a picked comparison with `everyMatches`.
    The pane asks with `pick` on the Compare button and when the document
    changes, then keeps the side the daemon named.
  - Against the file, two matching sides say `matchesFile(active)`.
    `NothingToCompare` takes `active` and then shows `nothingButTheFile`.
- **`ui/inertOutside.ts` (new):** wired as `ref` on the popups of
  `DialogContent` (merged with a caller's ref by `inertOutsideWith`),
  `ConfirmDialog`, `MoveToDialog` and `AskLocation`. Inert is held by a count
  per element, so nested modals close in any order.
