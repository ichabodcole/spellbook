---
type: item
title: Smaller follow-ups from the Atlas comparison
description:
  "The calls Cole took from the shell cycle's Atlas comparison that need small
  work: the float's waiting echo, a visible map entry, three wordings, search
  grouped by file, a heading scale, the wordmark, and Atlas's sort."
status: stable
lifecycle: ready
id: 01a157fc-bd8d-74f5-b201-a7320f4f31bd
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-shell
cycle: 2026-10-polish
---

# Smaller follow-ups from the Atlas comparison

Cole took every recommendation in the
[Atlas comparison](kit-atlas-scriptorium-comparison/write-up.md) on 2026-10-20.
The two before-the-cutover calls are items of their own and joined the shell
cycle: [kit-composer-closed-waiting-mark](kit-composer-closed-waiting-mark.md)
(C6) and [kit-stalled-note-ask-act](kit-stalled-note-ask-act.md) (C7). The split
divider (D5) is [kit-split-divider](kit-split-divider.md), and the shared
finding is
[waiting-marks-after-session-end](waiting-marks-after-session-end.md). The rest
is small, and gathered here. The call's id points into the write-up.

## Definition of done

- [x] **C5:** with the chat column closed, the floating composer's waiting line
      echoes the waiting message, as it already echoes a note.
- [x] **L7:** the map has a visible entry in the set header, as the shipped app
      has, and keeps its row-menu entry.
- [x] **H5:** the kit's settings dialog and `image-settings`' help no longer say
      Story Studio's "world": an app noun or neutral wording, offered back.
- [x] **L4:** the context pane's drop hint ("Drop documents or images, then
      choo…") and the add-path field's placeholder ("Add a file or folder by…")
      fit the default width without being cut off (Cole, 2026-10-22).
- [x] **C2:** the empty chat's line also says that selected text goes with a
      message.
- [x] **F1:** search results group text hits under each file with a count, and
      keep the kit's match highlight.
- [x] **D4:** the rendered view's h1 is a step larger than its h2s.
- [x] **H1:** the shell's title takes Scriptorium's wordmark through the theme,
      not through kit code.
- [ ] **L5:** Atlas's context sort is ported at the next sync with Story Studio.
      Not done in this cycle, on purpose: its "folder order" depends on Story
      Studio's `.order` files, so it waits for that sync.

## Done and verified

Eight of the nine calls, on `impl/kit-atlas-follow-ups` over `cycle/polish`
(`90c36b2a`). L5 waits for the next Story Studio sync, as above.

- `43c6b647` **C5:** with the chat shut, the float's line reads "You" and the
  waiting message, then its badge, as the note row reads "Your note". The echo
  truncates; the badge never clips.
- `7a184cb9` **L7:** "Show the map of this set" is an icon button in the open
  set's header, beside New document and New folder; the row's menu keeps it.
- `0ff9595e` **H5, L4, C2**, the wordings:
  - Settings: "For this app, the same in every session." `image-settings`' help:
    "the same for every session". The CLI golden records the new help.
  - Drop hint: "Drop files, then choose where they go" (the location dialog's
    own question, and true now that a dropped file can also stay where it
    lives). Add-path placeholder: "Type a path to add…".
  - Empty chat: "Nothing said yet. Ask the agent something below, or wait for it
    to speak. Text you select goes with your message."
- `ccf5477f` **F1:** text hits grouped under their file, the file's name and a
  count on a line of its own, the section counted ("In text (4)"; "In text (30,
  and more)" when the daemon held some back). The match highlight stays on every
  hit; each hit names its file for a screen reader.
- `f2658eda` **D4:** the rendered document's h1 is 1.4em (19.6 px), its h2s stay
  1.1em (15.4 px). Spacing and the lower headings are unchanged, and a chat
  message keeps the compact scale.
- `314bf0ab` **H1:** Scriptorium's sheet styles the kit's title slot: the
  manuscript serif, 1rem, regular, lowercase. No kit code; the declared title
  stays "Scriptorium".
- `3b91d8f0` the rebuilt dist (Scriptorium's only; +192 bytes of CSS, the two
  new rules).

Deliberate choices:

- **The wordmark is an unlayered rule in Scriptorium's `styles.css`** on the
  kit's `data-slot="app-title"`. The kit's utilities on the title sit in
  Tailwind's utilities layer, which only an unlayered rule outranks. Its test
  lives at `src/scriptorium/wordmark.test.ts`, outside `surface/`, so its
  strings stay out of the page's Tailwind scan.
- **The h1 step is scoped to the document** (`md-document` on the rendered
  body), not to `.md-prose`, which chat messages share.
- **"Session", not an app noun,** for H5: the prefs hold across every session of
  the app, in any app on the kit.
- **L4 kept the meaning, not the old words.** The other two drop hints (with a
  workspace folder, and with no location dialog) are not Scriptorium's and were
  left alone; see the port-back notes.
- **No new colours or tokens.** The header button and the search groups use
  existing classes only.

Checked in a real browser (Playwright Chromium, 1440 × 900, real mouse and
keyboard, on a scratch Scriptorium with a three-document set), before on
`90c36b2a` and after on this branch:

- **L4:** pane 316 px. Before, the hint needed 249 px of its 244 and the
  placeholder 244 of the field's 214, both cut. After, the hint fits its 244 and
  the placeholder takes 160 of 214. See the verifier's round below for narrower
  windows.
- **H1:** before Inter 14px/500, "Scriptorium"; after "Iowan Old Style"
  16px/400, shown "scriptorium".
- **D4:** h1 16.8 → 19.6 px; h2 and h3 15.4 px, as before.
- **H5, C2:** the dialog and the empty chat read the new words.
- **F1:** "lantern" over the set: "In text (4)", `keeper.md · v1` with 3 hits
  and `lamp.md` with 1; four highlights.
- **L7:** a click on the set's row opens it, and the header lists "Show the map
  of this set"; a click on it draws "Map of harbour" with its three documents.
  The row's right-click menu still has the entry.
- **C5:** the chat collapsed with its button, a message typed in the float and
  sent with ⌘↩: the line reads "You What does the keeper do at dusk? · working
  on this...". Before, the badge alone.

Each new test was mutation-checked: ten planted regressions (the echo; both
"world" wordings at once; the grouping; the highlight; the header filter; the
map's `header` flag; the selection line; the h1 size; the wordmark moved into a
layer; a wordmark in the kit's title), each turned its test red and was restored
byte-equal. L4's fit is a layout fact, held by the browser measurement above,
not by a test.

The gate's blind-set ward (`grimoire/gate-honesty.test.ts`) is re-declared in
the D4 and H1 commits, for the lines `document.css` and `styles.css` grew, each
with the test that reads them. The rendered view's exact class string in
`frontmatterView.test.tsx` gains `md-document`.

## Port-back notes

For Story Studio's agent to weigh at the next sync. Each is generic.

- **`MenuAction.header`** (`src/kit/context/menuActions.ts`, drawn in `SetView`
  in `ContextSidebar.tsx`): the field is generic, a hint that an action deserves
  a visible button as well as its menu entry, honouring `disabled` and
  `destructive`. Where it is drawn is not: Story Studio's kit has no open-set
  header and no `entry` target kind, so it would need a place of its own to draw
  it (Atlas's document toolbar, say, for "Map of the links").
- **The float's waiting echo** (`waitingLine` in
  `src/kit/chat/FloatingComposer.tsx`): Atlas shows the badge alone.
- **"Every session", not "every world"** in `SettingsDialog.tsx` and
  `image-settings`' help.
- **Drop hint and placeholder** (`ContextSidebar.tsx`, `AddPath.tsx`): "Drop
  files, then choose where they go" and "Type a path to add…". The hint wraps
  onto a second line rather than truncating, whichever words it shows. The field
  measures its placeholder against its own width and shows "Add a path…" while
  the full words do not fit (`placeholderFor`, `shortPlaceholder`; a caller's
  own placeholder has no short form unless it passes one). The workspace
  variant, "Drop documents or images here to copy them into the workspace", is
  Atlas's and is cut off at the same width; it was left for Story Studio to
  word.
- **The empty chat's line** (`ChatSidebar.tsx`) adds "Text you select goes with
  your message."
- **Search grouped by file** (`groupResults` in `src/kit/shell/SearchBox.tsx`).
- **The h1 step** (`.md-prose.md-document h1` in `src/kit/theme/document.css`,
  the class on `MarkdownView`'s body).
- **The wordmark** is Scriptorium's theme only; nothing to port. The kit's
  `data-slot="app-title"` is the hook an app themes.

### After the verifier's round

The no-stake verifier passed all eight in a real browser and found four gaps,
all fixed in `6f7b5d6b` (dist `4696cdfd`):

- **L4 still cut off at a 1024 px window** (a 225 px column: the hint needed 207
  of 153 px, the placeholder 160 of 123). The words are unchanged. Instead the
  hint wraps (no `truncate`), and the path field measures its placeholder
  against its own text box on every resize and shows "Add a path…" while "Type a
  path to add…" does not fit. Its accessible name stays "Type a path to add".
  Measured in Chromium, after:

  | Window | Column | Hint               | Placeholder shown, width / room  |
  | ------ | ------ | ------------------ | -------------------------------- |
  | 1024   | 225    | two lines, not cut | "Add a path…", 93 / 123          |
  | 1280   | 281    | one line, not cut  | "Type a path to add…", 160 / 179 |
  | 1366   | 300    | one line, not cut  | "Type a path to add…", 160 / 198 |
  | 1440   | 316    | one line, not cut  | "Type a path to add…", 160 / 214 |

  A live resize 1440 → 1024 → 1440 switched the placeholder to the short words
  and back, and typing in the narrow field (a real click, then `~/`) worked.
  Guarded by a class test (the hint carries no `truncate`, `whitespace-nowrap`,
  `text-ellipsis` or `line-clamp-1`), a character budget on the short words, and
  the choice itself (`placeholderFor`).

- **D4:** a test now holds that no `.md-prose` h1 rule outside
  `.md-prose.md-document` is larger than 1.2em, and that the chat's body carries
  no `md-document`, so an unscoped enlargement fails.
- **L7:** the header button honours `disabled` (now tested) and draws
  `destructive` as the menu does (`data-variant="destructive"`, the destructive
  button variant).
- **L7's port-back note** no longer overstates: Story Studio would need its own
  place to draw a `header` action.

Five more planted regressions, each red and restored byte-equal: the header
ignoring `disabled`, the header dropping `destructive`, `truncate` back on the
hint, the placeholder always the full words, and the h1 step unscoped to
`.md-prose h1` (red in both h1 tests). Other spells' `dist` is unchanged: the
first try at the wrap used `leading-snug` and `text-pretty`, which added 45 to
172 bytes to five spells' stylesheets, so the hint uses classes the pages
already had.
