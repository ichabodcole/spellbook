---
type: item
title: A second tab doesn't see edits typed in the first
description:
  On the kit daemon, an edit in one tab never reaches another tab on the same
  session (editActive sends no version.text to other sockets); the shipped
  Scriptorium shows it within 500 ms.
status: stable
lifecycle: done
id: 01a14e5f-1882-73d8-95fd-3bf540bd4a9f
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-18 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: 01a14dc5-6f94-7529-ac57-306dea4e021a
cycle: 2026-10-shell
---

# A second tab doesn't see edits typed in the first

Found by the `scriptorium-kit-document-centre` verifier on 2026-10-18. With
`SCRIPTORIUM_KIT=1`, a document is open in two tabs on the same session. Tab 2
types an edit, and tab 1, in rendered view, never shows it, even after 5 s. The
shipped Scriptorium shows it within 500 ms.

The cause is in the kit daemon. `editActive` (`src/kit/workspace/server.ts`,
around line 3097) sends no `version.text` to the other sockets. When both tabs
edit in raw, the last writer wins on both surfaces, so this loses no data that
the shipped app doesn't already lose. It is a regression in what the human sees,
though, and it should be fixed before the cutover.

## Definition of done

- [x] An edit typed in one tab reaches every other tab on the session that shows
      that version, and a test pins it.
- [x] A tab doesn't receive its own edit back as an outside change. _(Offered on
      kit-parity, message 46, 2026-10-20.)_
- [x] The change is generic, and it is offered on kit-parity. (Generic: yes. The
      Port-back notes below are written; offering them on kit-parity is the
      coordinator's step.)

## Done and verified

Fixed in `bfc0476e` (the daemon, protocol, client and tests) and `e03a9eca` (the
rebuilt Scriptorium `dist`), on `impl/kit-second-tab-misses-edits` from
`cycle/shell`. After the verifier's pass, fixup commits added:

- `732225fb`: a test of the rebased (`rev`) path;
- `a458127d`: coalesced redraws in the rendered view;
- `99b44038`: the stamp set before anything can refuse the edit;
- `49c0ec6b` and `0e4c585b`: their rebuilt `dist`.

After the second pass, more fixups added:

- `6ab3a996`: positions mapped while a redraw is held;
- `89782e4a`: tests of the coalescing wiring;
- `af328178`: their rebuilt `dist`.

After the third pass, these fixups added the place kept during a hold:

- `e63c8df6`: the change itself;
- `3d1e6275`: its rebuilt `dist`.

Nothing is ported from Story Studio: its daemon has the same `editActive` at
`develop` `a4752a72`.

**The approach.**

- **The daemon relays the edit.** `editActive` now takes the socket that typed
  the edit. `relayEdit` sends the kept text as `version.text`
  (`origin: "remote"`) to every other socket, and not to the typing one. After a
  rebase onto a link rewrite (`rev`), the typing socket is sent it too, as
  before.
- **Each relayed frame is stamped per socket.** `editSeen` is the `rid` of the
  newest `edit` the daemon had answered (taken or refused) from the socket the
  frame goes to, or null. The daemon records it where the socket's frame is
  dispatched, before anything can refuse it (`editTaken`, a per-socket
  `WeakMap`, like `viewSent` for state frames). Recorded later, a refused edit's
  `rid` would never be stamped, and its tab would pass over every relay until it
  sent an edit the daemon took.
- **The client keeps its own typing.** `daemonClient` records the id of each
  edit it sends on the current socket (`unconfirmed`, by `doc@version`, emptied
  on every open). A relayed frame stamped older than that edit was sent before
  the daemon took it. The client passes over that frame, because the daemon
  takes its edit next and relays it on. A frame stamped at or past the edit
  confirms it, and the client takes it.

Without the guard, two tabs typing at once each take the other's text and end up
swapped. The daemon holds one text, and the next keystroke in the other tab
reverts its own typing. The browser runs below show this.

Deliberate choices:

- **`ctx.edit` does not relay.** An app writing what it holds tells the surfaces
  itself. Story Studio's stage sends its own `version.text` after `ctx.edit`,
  and its canvas writes boards on every change, so a relay there would double
  the sends and change the semantics of an app's hook.
- **An edit to a version a switch just left (`editLeft`) is not relayed.** The
  other tabs show the new active version.
- **The read-reply guard (`sentEdit`) is unchanged.** Relayed frames carry no
  `requestId`, so that guard never applies to them. Frames without `editSeen`
  (replies, and the daemon's own news) are handled exactly as before.
- **The relay goes to every socket, not only those showing the document.** The
  daemon does not track what each socket shows, and the client stores texts by
  `doc@version`. The text is serialized once per relay, and only the stamp
  differs per socket.

**A large document in a second tab's rendered view.** Each relayed text made the
rendered view (`MarkdownView`) redraw the whole document. In Chrome, a
5,000-line document with 3,500 links costs about 5 s of main thread per redraw,
most of it in micromark's `resolveAllText`; without links it costs about 1 s.
Texts that arrived meanwhile queued a whole redraw each. The tab fell behind,
and it froze long after the typing stopped.

`useCoalescedText` (`src/kit/document/coalesce.ts`) now keeps redraws apart.
After a redraw of 50 ms or more, the next one waits. The wait ends at whichever
comes first:

- as long again as that redraw took, so the page is free at least half the time
  while texts keep coming;
- half that long with no new text (at least 300 ms), so the newest text shows
  soon after the typing stops.

Only the newest text waiting is drawn, and the selection and notes use its
offsets. A cheap redraw waits for nothing, so small documents behave exactly as
before. A new document or version (`MarkdownView`'s new `textKey`, which
`DocumentPane` passes) is drawn at once. A single redraw still costs what the
renderer costs, which this item does not change. A 50,000-line document in
rendered view already hangs on the base, and that is out of scope.

**Positions while a redraw is held.** While a redraw is held, the DOM shows the
text drawn last, and the pane holds a newer one. Every position crossing between
them is mapped through the one change between the two texts (`minimalChange`,
with the new `rangeThrough` and `invertChange` in `text.ts`):

- **View to pane.** A selection or a context menu measured on the drawn text is
  reported in the newer one, with its lines and words read from it.
  Rendered-view "Add link" and notes take the selection the pane holds, so they
  get these positions too.
- **Pane to view.** Notes, the pending note and a flash placed in the newer text
  are painted on the drawn one.
- **Inside what changed.** A position there means nothing in the other text, so
  it is dropped and never guessed. A selection there is cleared, and a note
  there is not painted until the redraw.

The verifier's browser repro (`sel3`) adds six lines above while tab A is held,
then double-clicks "ipsum" in "Line 7:" in A:

- Before (`84c09970`), the daemon got `fromLine: 10`, but the line is at 16.
- After, it got `fromLine: 16`, with the same text. This held on two runs.

When A catches up, the browser's own selection still goes, because the redraw
replaces the DOM. That has always happened on any redraw. The line the daemon
holds is now the right one.

The shared place (`place.ts`) speaks lines of the pane's text, so its lines are
moved through the change too (`lineThrough` in `text.ts`):

- A line asked for is moved onto the drawn text before scrolling. That covers a
  note click, the agent's `show`, and the place kept across a mode switch.
- The line at the top is said in the pane's text.
- A line inside what changed goes to the nearer edge of the change, so a reveal
  still scrolls.

In the verifier's note-click repro (`sel4 noteclick`), "Line 30:" landed at y =
27, above the viewport (top 106), before this fix. After it, it landed at y =
103 on two runs, where it lands with no hold. The other four `sel4` scenarios
(remove, span, link, agentnote) still pass.

**Tests.**

- `src/kit/workspace/editRelay.server.test.ts` runs two and three sockets on the
  real fixture daemon. It checks that:
  - the other socket gets the text, stamped null;
  - the typing socket gets nothing back;
  - the stamp is the receiver's newest taken `rid`;
  - a later socket starts at null;
  - a refused edit (an app's `beforeKitAct`) still stamps the next relay to its
    surface;
  - after `rename --update-links`, a stale edit's rebased text goes back to the
    typing socket with `rev`, stamped with that edit's `rid`, and to the other
    socket with the same `rev`.
- `src/kit/context/daemonClient.test.ts` ("an edit typed in another tab"):
  - two clients on the real daemon, one idle and then each in turn;
  - two clients typing in the same tick, ending on the daemon's last writer;
  - a fake-socket test that pins which relayed frames are passed over and which
    are taken: a stale stamp, another version, unstamped news, a confirming
    stamp, after a confirm, and after a reconnect.
- `src/kit/document/coalesce.test.tsx` uses a happy-dom component whose redraw
  advances a fake clock. It checks that:
  - a cheap redraw is never held;
  - texts that arrive within a costly redraw's pause are drawn once, as the
    newest;
  - another document or version is drawn at once;
  - a quiet window ends the wait early, and a new text restarts it;
  - after the pause, the next text is drawn at once.
- `src/kit/document/MarkdownView.held.test.tsx` holds a redraw in happy-dom, by
  moving `performance.now` on while the view draws. It checks that:
  - with lines added above, a selection and a context menu are reported at the
    newer lines;
  - a selection in a rewritten line is cleared;
  - notes are painted on their own words, and a note inside the change is not
    painted.
- `src/kit/document/DocumentPane.coalesce.test.tsx` runs the pane against a real
  daemon, with a widget that makes each redraw cost a second. It checks that a
  newer text of the same version waits out the pause, and that another version
  is drawn at once.
- `MarkdownView.held.test.tsx` also checks the hold against stubbed paragraph
  positions:
  - the pending note and a flash paint on their own words;
  - a line asked for scrolls to that passage in the held text;
  - the line at the top is said in the newer text.
- `src/kit/document/text.test.ts` pins the rules of `rangeThrough` and
  `lineThrough`.
- **Mutations.** Each of these turned the suite red:
  - no relay;
  - relay to the sender too;
  - stamp always null;
  - client guard removed;
  - `unconfirmed` not cleared on open;
  - never confirmed;
  - the stamp set after the edit is handled (the verifier's M1);
  - on `rev`, the relay sent only to the typing tab (M4);
  - the stamp set inside the `edit` case, after `beforeKitAct`;
  - never coalesce;
  - no quiet rule;
  - the key ignored;
  - cheap redraws held too;
  - the quiet not restarted by a new text;
  - `MarkdownView` without `useCoalescedText` (the verifier's C5);
  - no `textKey` (C6);
  - `textKey` without the version (C7);
  - selection not mapped;
  - lines read from the drawn text;
  - notes not mapped;
  - an unmappable range clamped instead of dropped;
  - a start at an insertion point left in front of it;
  - the flash not mapped (the verifier's V4);
  - `pendingNote` not mapped (V5);
  - a line asked for not moved onto the drawn text;
  - the line at the top said in the drawn text;
  - a line inside the change always sent to its start.

**In a real browser.** The flagged Scriptorium (`SCRIPTORIUM_KIT=1`) ran on a
scratch HOME, SCRIPTORIUM_HOME and TMPDIR, with `open` stubbed, in two
Playwright tabs on one session. It ran three times direct and three times behind
a 400 ms-each-way lag proxy.

- **Tab B types in raw while tab A is idle in rendered view.** A showed the edit
  228 to 238 ms after the last key direct, and 1027 to 1038 ms behind the lag
  (250 ms pause plus 800 ms of lag). B was never sent its own edit back.
- **Both tabs type in raw within one pause.** Both editors and the daemon ended
  on one text in all six runs. One more key in each tab, typed apart, was kept
  in both editors and in the daemon.
- **At `cycle/shell`, the base:** A never showed B's edit within 8 s, and the
  tabs diverged.
- **With the client guard removed and the surface rebuilt:** behind the lag, the
  two tabs ended swapped in all three runs. Direct, they happened to converge.

**Redraws in the second tab, measured.** These are the verifier's `midtab`
(5,000 lines, 3,500 links) and `plaintab` (5,000 lines, no links) scripts, run
three times each, every run on a fresh daemon and scratch env. Tab B types ten
bursts 350 ms apart while tab A sits in rendered view. A's long tasks are
counted for 2.5 s after the typing, and again until A shows the last key, polled
for up to 20 s. Before means the relay without coalescing (`732225fb`); after
means `a458127d`.

|                 | relayed frames A handled | A's long tasks, to 2.5 s after typing | A shows the last key, after typing | A's long tasks until then |
| --------------- | ------------------------ | ------------------------------------- | ---------------------------------- | ------------------------- |
| midtab before   | 2 of 10                  | 4, 9.6–11.8 s                         | never, within 20 s                 | 8–10, 24–26 s             |
| midtab after    | 10 of 10                 | 2–4, 4.8–7.8 s                        | 6.2–8.9 s                          | 4, 7.8–9.8 s              |
| plaintab before | 8–9 of 10                | 8–9, 6.8–7.4 s                        | 4.6–6.1 s                          | 10, 7.6–9.2 s             |
| plaintab after  | 10 of 10                 | 3, 2.5–2.7 s                          | by 2.5 s (the first poll)          | 3, 2.5–2.7 s              |

What is left on `midtab` is the cost of one redraw (about 4.8 s, the renderer's
own), paid about twice. The typing tab had no long tasks in any run.

**The shipped Scriptorium.** Its daemon's `edit` case sends no text to other
sockets either. A two-socket check on a scratch flag-off daemon got no
`version.text`, only `state`. In a two-tab browser run, tab A did not show tab
B's raw edit within 8 s, although the daemon held it. So the "within 500 ms" in
this item's report did not reproduce here. The kit path now does better than the
shipped one in this case.

## Port-back notes

For kit-parity, against Story Studio `develop` at `a4752a72`, whose `editActive`
(`packages/kit/src/workspace/server.ts`, around line 3560) is the same as ours
was.

- **Port `kit-read-reply-reverts-sent-edit` first.** Story Studio's
  `daemonClient.ts` has no `sentEdit` yet, and the client change below sits
  beside it.
- **Then port these three files together, as for `StateFrame`.** A daemon that
  relays without a client that reads `editSeen` reverts a tab's typing when two
  tabs type at once.

- **`packages/kit/src/workspace/protocol.ts`:** `version.text` gains
  `editSeen?: string | number | null`, with its doc comment.
- **`packages/kit/src/workspace/server.ts`:**
  - `editTaken`, a `WeakMap<ServerWebSocket, rid>`. It is set in the websocket
    `message` handler, as soon as `rid` is read, for any frame whose `op` is
    `edit`. That is before anything that can refuse the edit: `gateWrite`,
    `beforeKitAct`, and the `edit` case's own `refuseOwnFile`. Story Studio's
    `edit` case starts with `refuseOwnFile`, and its apps can refuse in
    `beforeKitAct`. Set any later, a refused edit's `rid` stays unconfirmed in
    the client, and that tab passes over every relay until it sends an edit the
    daemon takes.
  - `relayEdit(from, doc, version, text, rev)` sends to every socket but `from`,
    and to `from` too when `rev` is set. The frame is serialized once, with
    `editSeen` spliced per socket.
  - `editActive` gains a fifth parameter, `from`. With `from` set it relays.
    Without it (`ctx.edit`), it does as before: it sends to all only on `rev`.
    The `edit` case passes `ws`. `ctx.edit` is unchanged, so the canvas and
    stage plugins are unaffected.
- **`packages/kit/src/context/daemonClient.ts`:**
  - an `unconfirmed` map, set in `fireWrite` beside `sentEdit` and cleared at
    the top of `ws.onopen`;
  - in the `version.text` case, after the `sentEdit` skip: when `editSeen` is
    present and this socket has an unconfirmed numeric id for the version, skip
    the frame if `editSeen` is not a number or is lower than that id; otherwise
    delete the entry and take the frame.
- **`packages/kit/src/document/` (separate from the three above):**
  - the new `coalesce.ts` (`useCoalescedText`) and `coalesce.test.tsx`;
  - `MarkdownView.tsx` takes a `textKey` prop and draws
    `useCoalescedText(text, textKey)`. Every use of the text inside reads the
    drawn one.
  - `DocumentPane.tsx` passes `textKey={`${doc.slug}@${doc.active}`}`.
  - `text.ts` gains `rangeThrough`, `invertChange` and `lineThrough`.
    `MarkdownView` maps between the drawn text and the given one (`toShown`,
    `toDrawn`):
    - what it reports out: `onSelect` (its lines and text read from the given
      text), and `onContextMenu`'s range;
    - what it paints in: notes, `pendingNote` and `flash`;
    - the place's lines, through `lineThrough`: in `join`'s `to`, and in the
      scroll report.
    - A range that can't be mapped is dropped. Port this together with the
      coalescing, or a held view reports and paints the wrong passage.
  - The name `rangeThrough`, not `mapRange`, is deliberate: the kit's layer ward
    (`layers.test.ts`) keeps "map" out of the document pane's exports.
  - It helps any case where a large document's text changes often in rendered or
    split view, the agent's edits included, so it ports with or without the
    relay.
- **Tests.**
  - `editRelay.server.test.ts` uses the kit's fixture app, `seedDocs` and
    `FakeSurface`. Its `rev` case uses the fixture's `rename` with
    `updateLinks`, and its refusal case uses a `beforeKitAct` hook.
  - The client tests use `boot` and `connect` from `daemonClient.test.ts`.
  - All of them port with their files.
- **Cost.**
  - **Bandwidth.** Each other socket gets one extra `version.text` per taken
    edit (one per typing pause). That is the document's whole text, so a large
    document open in several tabs costs its size per pause per tab.
  - **Rendering.** Each relayed text is also a redraw in a receiving tab that
    shows the document rendered. A large document's redraw is a long task: about
    1 s for 5,000 plain lines and about 5 s with 3,500 links, in Chrome.
    `useCoalescedText` keeps that from piling up (see the table above). A tab
    showing it raw only replaces the editor's text, and was fine in the
    verifier's runs.
