---
type: write-up
title: What still differs from Atlas after the shell port
description:
  Atlas, the flagged Scriptorium on the kit's shell and the shipped Scriptorium
  side by side, area by area, with a call on each remaining difference.
tags: [kit, scriptorium, atlas]
status: draft
generated: { by: claude-opus-5-5, at: 2026-10-19 }
---

# What still differs from Atlas after the shell port

**Outcome:** Work Items Filed, once Cole rules (each call below is a
recommendation, not a ruling).

---

## Question

Scriptorium now runs in the kit's shell behind `SCRIPTORIUM_KIT=1`. Beside
Atlas, what still differs in layout, density and behaviour, and for each
difference, whose version do we keep? The shipped Scriptorium is the third
column: it is the reference for what Scriptorium does better and must not lose.
Colour is out of scope: Spellbook keeps its own theme (Cole, 2026-10-13).

## How it was run

All three apps ran at once in one Chromium, each in its own tab at **1440 ×
900** CSS pixels, on the same seven documents: a `harbour` set of six (with one
broken link, one link to a missing heading, and one link leaving the set) and
one document outside it.

- **The flagged Scriptorium:** `cycle/shell` at `04debecd`, with
  `kit-broken-links-visible`'s two code commits (`b075d47d`, `048b4079`) picked
  into the working tree only, then rebuilt. `SCRIPTORIUM_KIT=1`, scratch `HOME`,
  `SCRIPTORIUM_HOME` and `TMPDIR`.
- **Atlas:** Story Studio's `develop` at **`c93e8426`** (2026-10-19 21:24, "sort
  the context panel by folder order, name, updated or created"), taken with
  `git archive` into a scratch folder, installed with `--ignore-scripts`, built,
  and run from there with its own scratch `HOME`, `TMPDIR` and
  `STORY_STUDIO_HOME`, on a scratch workspace holding a copy of the fixture.
  Nothing ran inside the Story Studio repo and no Story Studio process but ours
  was touched. Atlas ran from the archive without credentials or the user's
  data, so everything below was seen, not read from code.
- **The shipped Scriptorium:** the same build, no flag, its own scratch homes.

An agent was simulated with each app's own `tail`, started after a human message
had waited 35 seconds, so each app's "no agent" and "agent listening" states
were both seen. macOS `open` was stubbed. All three sessions were closed at the
end.

**Screenshots** are in the session scratchpad, one file per app per step, named
`<app>-<step>-<what>.png` with `<app>` one of `atlas`, `kit` (the flagged
Scriptorium) and `shipped`:

`/private/tmp/claude-501/-Users-colereed-Projects-Spellbook/70601405-0242-407f-934e-3dd3364fb2e8/scratchpad/cmp/shots/`

Each row below names its step; the same step number across the three apps is the
same state.

| Step   | State                                                         |
| ------ | ------------------------------------------------------------- |
| 01     | First load, nothing open                                      |
| 03     | `places/lighthouse.md` open (Atlas opens raw; 04 is rendered) |
| 05     | One human message, no agent, just sent                        |
| 06     | The same message 35 s later, still no agent                   |
| 07     | An agent's `tail` started                                     |
| 08     | Conversation column collapsed: the floating composer          |
| 09     | Composer closed (`09b` zooms the rail)                        |
| 10     | Both columns collapsed                                        |
| 11     | Link check opened from the status strip                       |
| 12, 13 | Search, empty and with `keeper`                               |
| 14     | Settings                                                      |
| 15, 16 | A passage selected, then a note added                         |
| 17     | Split view                                                    |
| 18     | A note gone quiet, hovered                                    |
| 19     | Floating composer with a waiting note and a waiting message   |
| 20     | End session asked (the kit page with an unsaved edit)         |
| 21     | Ended                                                         |
| 22     | Ended, dialog closed (kit only)                               |
| 23     | The session restored (kit and shipped)                        |

## Current State

The shell port did most of the converging. At first load the flagged Scriptorium
and Atlas are the same frame to the pixel: header height, search width, column
widths, tab bar, empty document pane, composer and status strip (`atlas-01`,
`kit-01`). What is left is short, and most of it is wording, one missing act,
and a few places where the shipped app knew something the kit does not.

**Already noticed, confirmed arrived:**

- **Rails for both columns.** Each column collapses to a 40 px rail with its
  reopen button (`kit-10`), as Atlas's does (`atlas-10`). The shipped app
  collapses all the way and moves the reopen button into the document toolbar
  (`shipped-10`).
- **The chat rail's composer-closed state.** With the conversation column
  collapsed, the floating composer closes to a "Show the composer" button on the
  rail (`kit-09`, `atlas-09`). See row C6 for what it loses.

## Findings

The calls, area by area. **Atlas** means keep Atlas's (which the kit already
has, unless the row says otherwise); **Scriptorium** means keep or bring back
the shipped app's; **both** means take each one's part, as the reason says.
"Work" says whether a call needs a change.

### Header

| #   | Difference                                                                                                                  | Steps | Call        | Reason                                                                                                                                                                  | Work                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| H1  | Title: shipped is a lowercase serif "scriptorium"; kit and Atlas are a capitalised sans name                                | 01    | Scriptorium | The wordmark is the spell's identity, not layout, and costs no height; set it through Spellbook's theme, not the kit                                                    | Small: theme the shell's title                                   |
| H2  | End session: shipped is a labelled button; kit and Atlas a power icon with a tooltip                                        | 01    | Atlas       | Rare, confirmed by a dialog, and named by its tooltip and label; the label cost header width                                                                            | None                                                             |
| H3  | "connected" as text in the shipped header; kit and Atlas move it to the status strip                                        | 01    | Atlas       | One place for session state, beside the listening dot (row S1)                                                                                                          | None                                                             |
| H4  | Search placeholder: shipped "Search documents (⌘K)"; kit and Atlas "Search (⌘K)"                                            | 12    | Atlas       | It searches text as well as names, so "documents" undersold it; the accessible name still says "Search documents"                                                       | None                                                             |
| H5  | Settings: kit and Atlas have a gear and an image-import dialog; shipped has none. The dialog says "the same in every world" | 14    | both        | Keep the dialog; "world" is Story Studio's noun, hard-coded in `src/kit/shell/SettingsDialog.tsx:113` and in `image-settings`' help (`src/kit/workspace/verbs.ts:1553`) | Small: an app noun for the kit, or neutral wording, offered back |

### Sidebars and rails

| #   | Difference                                                                                                                                                                                                  | Steps  | Call                                   | Reason                                                                                                                                                                 | Work                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| L1  | Rails: kit and Atlas collapse to a rail; shipped collapses to nothing                                                                                                                                       | 10     | Atlas                                  | Arrived with the shell port; the way back stays where the column was                                                                                                   | None                                        |
| L2  | Set rows: kit "6 · …/harbour" behind a document icon; shipped "6 documents · …/harbour"                                                                                                                     | 01     | Atlas                                  | Denser, and the count's accessible name still says "6 documents"                                                                                                       | None                                        |
| L3  | Workspace row: shipped shows "Workspace …" with a change pencil; Atlas shows its workspace path and pencil; kit shows neither                                                                               | 01     | Scriptorium's model, as the kit has it | No home workspace (`homeWorkspace: false`, the cycle's paradigm note); the shipped row is the thing the kit retires                                                    | None                                        |
| L4  | Drop hint: kit "Drop documents or images, then choose a set"; shipped "Drop files here to copy them in"; Atlas "…here to copy them in". Kit's and Atlas's are cut off with an ellipsis at the default width | 01     | both                                   | Kit's words are true to the model (shipped's "copy them in" is not), but a hint that is cut off is not read; shorten it to fit 316 px, as shipped's did                | Small: wording in `ContextSidebar.tsx:1075` |
| L5  | Atlas has a second toolbar row (new document, new folder, graph, stage) and a sort menu ("Folder order"); kit puts new document and folder on the hint row and has no sort                                  | 01     | Atlas, for the sort                    | Sorting by name, updated or created is generic and landed after our port base (`c93e8426`, past `7832083`); the stage and the folder arrows are the diverging paradigm | Port the sort at the next sync              |
| L6  | Atlas's folder rows carry an arrow to enter the folder as the tree's root; kit and shipped do not                                                                                                           | 01     | Scriptorium                            | Left out on purpose (`kit-port-shell`, the diverging paradigm)                                                                                                         | None                                        |
| L7  | The map: Atlas has "Map of the links" in the document toolbar and "Show as a graph" in Linked from; shipped has "Show the map of this set" in the set header; kit reaches its map only from a row's menu    | 03, 04 | both                                   | A map behind a context menu is a map nobody finds; give the kit's `appView` map a visible entry in the set header, as shipped, and keep the menu entry                 | Small: a header action for the map          |

### Status strip and the broken-links mark

| #   | Difference                                                                                                                                                                                                                                                   | Steps  | Call                              | Reason                                                                                        | Work                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| S1  | A status strip: kit and Atlas have one ("connected", the listening dot, the link check); shipped has none                                                                                                                                                    | 01, 07 | Atlas                             | Session state in one quiet line, always visible                                               | None                                               |
| S2  | The broken-links mark: kit reads "1 broken link, 1 link to a missing heading, 1 leaving the set", and its list groups by set with a "Leaving the set" section; Atlas has no grouping and no "leaving" count; shipped shows link problems nowhere in the page | 11     | Scriptorium (the kit's extension) | Ruling 3, seen working: one mark for the session, grouped by set, each entry opening its line | Offer back (already in the item's port-back notes) |
| S3  | Atlas posts a "Startup check: 1 links.heading. Run `doctor`" line into the chat; kit posts nothing                                                                                                                                                           | 01     | Scriptorium                       | The strip already carries the count, and `doctor` is the agent's verb, not the human's        | None                                               |

### Chat and the floating composer

| #   | Difference                                                                                                                                                                                                                                          | Steps      | Call        | Reason                                                                                                                                                                                                                                              | Work                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1  | The tab: shipped "CONVERSATION"; kit and Atlas "CHAT"                                                                                                                                                                                               | 01         | Atlas       | Shorter, so "NOTES (1) •" and the dots fit; the column's accessible name is still "Conversation column"                                                                                                                                             | None                                                                              |
| C2  | Empty chat: shipped an icon, "No messages yet" and "Ask the agent something. If you have text selected, it comes too."; kit and Atlas one faint line, "Nothing said yet. Ask the agent something below, or wait for it to speak."                   | 01         | both        | Keep the one line, and add shipped's teaching that a selection goes with the message, the one thing a newcomer would not guess                                                                                                                      | Small: wording in `ChatSidebar.tsx:105`                                           |
| C3  | Waiting with no agent: shipped says "working on this…" though nothing listens; kit and Atlas say "no agent is listening yet; this waits until one is", tint the tab ("CHAT •") and show "No agent is following this session yet" above the composer | 05, 06     | Atlas       | The shipped mark is wrong: it claims work no one is doing. The kit's says what is true and what will happen                                                                                                                                         | None                                                                              |
| C4  | Waiting with an agent gone quiet: all three say "took this in, then went quiet; may be stuck" at 30 s (E53)                                                                                                                                         | 07         | both kept   | Arrived intact                                                                                                                                                                                                                                      | None                                                                              |
| C5  | The floating composer's waiting line: shipped echoes the message ("You What does the keeper do at dusk?") before the badge; kit and Atlas show only the badge                                                                                       | 08, 19     | Scriptorium | With the column closed, the echo is the only way to tell which message waits; the kit already echoes a note ("Your note …"), so the chat line is the odd one out                                                                                    | Small: echo the message in the float's chat line                                  |
| C6  | Composer closed: kit and Atlas close to a rail button; **no waiting mark is shown anywhere** while it is closed (the rail's two buttons carry no dot)                                                                                               | 09, 09b    | both        | Keep the closed state, but E53's mark must survive it: a dot on the rail's composer button while something waits                                                                                                                                    | Small: a waiting dot on the rail                                                  |
| C7  | A stalled note: shipped offers **"Ask the agent"** beside "no word from the agent — may be stuck", and the floating line offers it too; kit and Atlas show the badge with no act                                                                    | 17, 18, 19 | Scriptorium | E65's mark carries its act ("a warning needs an action"); without it the only way out is to resolve the note unanswered. The port-shape write-up listed it for cycles 3 and 5, and it did not arrive (`src/kit/chat/NotesPanel.tsx` has no `onAsk`) | Port: `onAsk` and `askedIn` in the kit's notes panel and float line, offered back |
| C8  | Each message shows what it was sent with ("lighthouse.md · v1") in kit and Atlas; shipped shows nothing when no text is selected                                                                                                                    | 05         | Atlas       | What was sent is visible                                                                                                                                                                                                                            | None                                                                              |

### Document pane

| #   | Difference                                                                                                                                       | Steps | Call        | Reason                                                                                                  | Work                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------- |
| D1  | Default view: kit and shipped open rendered; Atlas opens raw                                                                                     | 03    | Scriptorium | Deliberate, kept by the prefs adapter (`doc:view`)                                                      | None                       |
| D2  | A "stable" chip on every document without a status, in shipped only                                                                              | 03    | Atlas       | The default marks nothing; shipped's own tree model says so (`surface/components/context/model.ts:207`) | None                       |
| D3  | "Linked from" under the rendered document: kit and Atlas; not in shipped                                                                         | 03    | Atlas       | Backlinks where you read, each opening its line                                                         | None                       |
| D4  | Heading scale: shipped's h1 is clearly larger than its h2s, with more space around both; in kit and Atlas the h1 and h2 are nearly the same size | 03    | both        | Keep Atlas's density, but give h1 a step of its own: the page's hierarchy reads at a glance             | Small: prose heading scale |
| D5  | Split view: shipped has a draggable, saved divider; kit and Atlas split into two fixed halves                                                    | 17    | Scriptorium | Already filed (the verifier's note; see `scriptorium-kit-shell`'s "split divider" paragraph)            | Filed                      |
| D6  | Split is refused below 720 px of pane, in all three ("the pane is too narrow")                                                                   | 17    | both kept   | Same rule; the button says why                                                                          | None                       |

### Search

| #   | Difference                                                                                                                                                                                               | Steps | Call | Reason                                                                                               | Work                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| F1  | Results: shipped groups text hits under each file, counts them ("IN TEXT (9)") and shows a document's title beside its name; kit and Atlas list each hit with its file under it, and highlight the match | 13    | both | Shipped's grouping is denser for many hits in one file; the kit's highlight shows why a line matched | Small: group by file in the kit's results |

### Dialogs and the ended state

| #   | Difference                                                                                                                                                                                                                                                          | Steps  | Call                                      | Reason                                                                                         | Work                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------- |
| E1  | End session asked: kit names the restore command and warns about unsaved documents ("v1 of lighthouse.md has unsaved changes…"); Atlas has the command without the warning; shipped has neither                                                                     | 20     | Scriptorium's warning on the kit's dialog | Ruling 4, seen working                                                                         | None (offered back) |
| E2  | Ended: kit and Atlas show a "Session ended" dialog with the restore command and Copy; closing it leaves an "Ended" chip in the header and "session ended" in the strip (seen on the kit page). Shipped shows "Session ended" as header text, with no way back named | 21, 22 | Atlas                                     | The ended state carries its act, the command that brings the session back; the chip reopens it | None                |
| E3  | The tab across sessions: kit restores the tab you left (Notes, here); shipped always opens on Conversation                                                                                                                                                          | 23     | Atlas                                     | The prefs adapter keeps layout and the tab alike, and the tab dot still flags a waiting chat   | None                |

### A connected session, and an agent that is listening

The shipped app has one signal, "connected", in the header. It cannot tell a
page that reaches the daemon from an agent that is reading what the page sends,
so a message sent with no agent reads "working on this…" (`shipped-05`).

The kit, as Atlas, keeps the two apart, in four places:

- the strip's two dots, "connected" and "no agent listening" or "agent
  listening" (`kit-01`, `kit-07`);
- "No agent is following this session yet. Messages wait here until one picks it
  up.", above the composer until a `tail` starts (`kit-01`; gone in `kit-07`);
- the message's own mark: "no agent is listening yet; this waits until one is"
  before a `tail`, and E53's "took this in, then went quiet" after (`kit-05`,
  `kit-07`);
- after End session, the strip's dot reads "session ended" (`kit-22`).

**Call: Atlas.** It is the clearest single gain of the port.

### Seen in both Scriptorium paths, not a difference

- **Waiting marks outlive the session.** After End session, the message and the
  note still read "may be stuck" in the kit (`kit-22`) and in the shipped app
  (`shipped-21`). The session is over, so nothing is stuck: the mark should say
  the session ended, or go. One state, one meaning. Worth an item of its own.

## Recommendation

- [ ] **Propose a feature** — the work is big enough to plan
- [x] **File work items** — the work is a handful of tasks
- [ ] **No action needed** — the current state is acceptable
- [ ] **Monitor** — watch for named signals or thresholds
- [ ] **More research needed** — questions remain

**Rationale:** the shell port closed the layout gap: at first load the two
frames match. What is left is one act that must not be lost (C7), one mark that
disappears (C6), one echo (C5), and a handful of wording and density fixes. None
is large, and most are kit changes worth offering back.

## Next Steps

For Cole to rule on each call. Those that need work, proposed as items:

1. **C7, a stalled note's "Ask the agent"**, in the kit's notes panel and the
   floating note line, with the one-ask guard (`askedIn`). Before the cutover:
   it is E65's act.
2. **C6, a waiting dot on the composer rail.** Before the cutover: it is E53's
   mark.
3. **C5, the floating chat line echoes the waiting message.**
4. **L7, a visible entry for the map** in the set header.
5. **H5 and L4 and C2, wording:** the kit's "world", the cut-off drop hint, and
   the empty chat's selection hint.
6. **F1, search results grouped by file.**
7. **D4, a heading scale with a distinct h1.**
8. **H1, the wordmark through the theme.**
9. **L5, port Atlas's context sort** at the next sync.
10. **Waiting marks after End session** (the shared finding above).

D5, the split divider, is already filed.

## Open Questions (Optional)

- **Anything behind the context menus** (rename, move, hide, make-set, Trash)
  was not compared here; the shell item's browser check covered the kit's.
- **Dark theme** was not compared: colour is out of scope.
- **Atlas's stage, canvas and image-description flows** were not compared:
  Scriptorium has no counterpart.
- **One run hiccup:** partway through, the shipped tab was found on another port
  with another session's page in it, most likely another agent driving the same
  shared browser. It was pointed back at our session and every shipped
  screenshot from step 12 on was retaken there.

---

**Related Documents:**

- [What still differs from Atlas after the shell port](./item.md)
- [The flagged Scriptorium runs in the kit's shell](../scriptorium-kit-shell.md)
- [The broken-links sign](../kit-broken-links-visible.md)
- [How to port the workspace stack](../workspace-stack-port-shape/write-up.md)
- [The shell cycle](../../cycles/2026-10-shell.md)
