---
type: artifact
title: "Scriptorium — decision log"
description:
  Live decision log for Scriptorium, recording design choices and options not
  taken
status: stable
generated: { by: unknown, at: 2026-09-11 }
---

# Scriptorium — decision log

Series **E**. Decisions and the options not taken, logged live.

## E1 · The file of record is a real file on disk

**Ruled:** Cole, 2026-09-11. "We start with real file, can always move to in app
if needed." **Not taken (for now):** importing into an app store and exporting
at the end. **Consequence:** a version is a real path the agent edits with its
ordinary file tools; the daemon watches and pushes changes to the surface;
"session save" can mean reopening the same folder plus a manifest.

## E2 · The agent never writes the version the human is editing

**Proposed:** lead, 2026-09-11; follows from Cole's workflow ("rather than
editing the original … create another version"). Agent edits always produce a
new version file. The human's buffer and the agent's writes can then never
collide on one file, which removes the hardest sync case by construction;
merging is the only place they meet. **Not taken:** letting the agent edit the
active file in place (needs live conflict handling between a typing human and a
writing agent).

## E3 · One agent

**Ruled:** Cole, 2026-09-11. Solo agent per document session; multi-agent is out
of scope.

## E4 · Versions: any number kept, two displayed

**Ruled:** Cole, 2026-09-11. The UI shows two versions side by side; the model
holds as many as exist.

## E5 · The first slice

**Ruled:** Cole, 2026-09-11. Open → edit (with **undo/redo**, Cole's addition) →
select-and-ask → agent writes v2 → split diff → accept whole version.
Annotations (batch-send) are wanted and follow.

## E6 · Undo has two layers

**Proposed:** lead, 2026-09-11. **Text undo** is the editor's own history over
its buffer; **version undo** treats "make v2 active" as an undoable action.
Saves capture whatever state the buffer is in; undo never waits on the disk.

## E7 · Explicit save for the MVP; autosave is an optional later setting

**Ruled:** Cole, 2026-09-11. With a real file on disk the expectation is that
edits do not reach the originating file until saved — and an unsaved edit must
be easy to throw away. **Save** writes the active version to the original file;
**revert** discards unsaved edits. **Not taken (for now):** autosave to the
original (Operator's model, where the store is a database). An autosave option —
"every N seconds" — may follow after the MVP. **Reference:** VS Code's default
is the same (`files.autoSave` off); Obsidian autosaves.

## E8 · The daemon owns the session; every version is a file the agent edits

**Ruled:** Cole, 2026-09-11 — "I see this as a local app with local files" —
after he asked whether an in-app store would be the better design. Two questions
were separated: **where the user's document lives** (on disk, E1 — open and
Save) and **what the agent's best editing medium is** during a session. The
second decides it: the agent's own Read/Edit tools (exact-match find-and-replace
that fails loudly, line-numbered reads of large documents) beat CLI edit verbs,
which push replacement text through shell quoting — grapevine's `--body-file`
rule is the scar — and drift toward whole-document rewrites.

**The shape — the house's existing "materialized path" pattern (glamour, imago
carry an on-disk `path` beside state the daemon owns):**

- **Session state lives in the daemon** — the version list, which is active,
  labels, annotations, selection, version-level undo — persisted as a small JSON
  manifest in the spell's session folder. No database.
- **Each version's text is a file** in that session folder (`v1.md`, `v2.md`…).
  Opening a document writes `v1`; the human's edits reach it after a short
  pause; the agent reads it and writes its own versions (E2) with its native
  tools.
- **Save** copies the active version over the original; **Revert** copies the
  original back over the active version. Unsaved edits survive a crash.
- **The watcher watches the spell-owned session folder** (plus originals for
  outside changes: clean → reload, dirty → ask via the diff view). A write the
  daemon did not make to the human's active version is an E2 violation it can
  detect and refuse or re-label.

**When this would flip:** an agent without local filesystem access (a cloud
agent) or cross-device sync. Neither is in scope, and because the daemon already
owns the session, moving version text into a store later changes where text
lives, not the design.

**Not taken:** an in-app store with the agent editing through CLI verbs (worse
editing medium for the agent); the agent seeing only saved text (a selection
could quote text in no file it can open).

## E9 · Saved prompts — user-authored shortcuts that persist across sessions

**Asked for:** Cole, 2026-09-11 — e.g. a formatting instruction to run over a
messy speech-to-text document, saved once and reused. **Shape (proposed, from
the house precedents):**

- **Picking one fills the composer; it does not fire.** Imago's quick prompts
  work this way ("shortcuts WRITE into [the composer]"), so a prompt can be
  tweaked before it is sent — and it remains an ordinary chat message, per the
  message-surface paradigm. The current selection and any annotations ride with
  it as context, exactly as with a typed message.
- **Persisted in the spell's home directory** (`~/.<spell>/prompts…`), so it
  survives every session — glamour's style tray (`GLAMOUR_HOME`) is the
  precedent; imago's library is session-scoped, which is the part not copied.
- **Two authoring paths:** the surface ("save this message as a prompt") and a
  CLI verb for the agent (imago's `context prompt … --link quickPrompts`), so
  "save that as a prompt" works in conversation.
- **Placement:** the slice after E5, alongside annotations — both ride the same
  send-with-context path.

**Open, deliberately:** global vs per-folder/project scoping — start global.
**Not taken:** a prompt that auto-sends on click (removes the chance to adjust,
and imago's experience chose against it).

## E10 · A revision the human asks for on a PENDING agent version — revise it or make a new one? (open)

**Raised in the prototype, 2026-09-11.** Cole asked for habaneros (agent wrote
v2), then "make this jalapeños" before accepting v2. The agent revised **v2 in
place** — it was its own unaccepted proposal — rather than writing v3.
**Tentative rule:** an agent version the human has not made active is the
agent's draft, and a follow-up revises it; once the human has activated or
merged from it, a new request makes a new version. **Not taken yet:** always a
new version (keeps every step, but a conversation of small corrections would
litter the version list — E4 shows only two at a time). To confirm with use.

## E11 · The prototype has done its job; the first real slice is the FOUNDATION, not the diff

**Ruled:** Cole, 2026-09-11, after driving the prototype ("this already proves …
the experience works"): stop iterating the throwaway and build the real spell on
the house build process, getting the foundations right before app-specific
editing mechanics. E10's revise-in-place stays as is for now — the agent says
what it did, and the human can ask for a v3.

**The foundation slice (supersedes E5's ordering):**

1. **Context sidebar** — single documents _and_ folder trees, with a genuinely
   good file-tree experience (drill in, back out to the context list).
2. **Centre editor** — CodeMirror 6, one file at a time, undo/redo, explicit
   Save/Revert (E7).
3. **Chat sidebar** — consistent with the other spells (the message-surface
   paradigm; shadcn's chat primitives are the candidate).
4. **Selection as context** on every message.
5. **Right-click context menu** for quick actions — pre-canned messages.
6. **Saved prompts** (E9).

**Layout — resizable, not fixed sidebars** (Cole, same day): the context and
chat panes are drag-resizable, so a deep file tree or a long conversation can
take the room it needs. In shadcn/React terms that is the `resizable` component
(a panel group with drag handles) rather than `sidebar` (a fixed-width,
collapsible nav); the two can combine, but the three-pane split is a resizable
group. Pane sizes are a per-viewer convenience worth remembering across reloads.

**Deferred:** the split-screen diff and granular merge, annotations, rendered
view, links. The version model (E2/E8) is still built into the daemon from the
start — it is how the agent edits — so the diff UI arrives later as a view over
data that already exists, not a re-architecture.

**Prototype findings carried forward** (`scratchpad` code, not kept): a human
typing into v1 while the agent appends to v2 never collided (20 keystrokes, 5
agent writes, v1 matched the human buffer exactly); a write to the active
version from outside was detected and announced; `@parcel/watcher` on the
session folder caught the agent's Edit-tool writes; the SSE tail needs a
heartbeat and a resuming reconnect (the first run lost its stream to the idle
timeout — the kit's `heartbeat` + `tailEvents` already solve both).

## E12 · The name is `scriptorium`

**Ruled:** Cole, 2026-09-11 — "it represents the kind of space to do this work
in well." A scriptorium is the room where scribes wrote, copied and corrected
manuscripts together: an artifact-noun you open and an agent joins, per the
registry's conventions. **Not taken:** `folio` (the lead's pick — shorter),
`palimpsest` (hard to say — the registry's astrolabe-over-orrery rule), `quill`
(Quill.js is an established editor library). Long, but spoken easily.

## E13 · Several sessions at once — session-JSON discovery

**Ruled:** Cole, 2026-09-11 — usually one at a time, but working across projects
should be possible. That is concurrent sessions, which only the **session-JSON**
convention can express (D3; playbook N6): `scriptorium-<sessionId>.json` plus
`scriptorium-latest.json` in tmpdir, through the kit's `writeFileAtomic` /
`unlinkIfMatches`. Glamour is the nearest per-session reference. **Not taken:**
a singleton standing daemon (mind-mapper's shape).

## E14 · Drag-and-drop onto the context pane — wanted; approach pending a spike

**Asked for:** Cole, 2026-09-11 — dropping a markdown or text file over the
context pane adds it as a context entry. **Constraint:** a web page never learns
a dropped file's filesystem path, so it cannot be linked to its original by
path. **Candidate:** Chromium's File System Access API
(`DataTransferItem.getAsFileSystemHandle()`) returns a handle the page can read,
and write after a permission prompt, so a dropped file could stay linked, with
Save written through the handle by the surface while the agent works on the
session's version files (E8). Chromium-only; to be verified by a spike in Cole's
browser. **Fallback:** import as an unlinked copy whose Save is "save as". Not
in slice A.

## E15 · One context model for a single document and a structured set

**Asked for:** Cole, 2026-09-11, as a future direction to design against: a
document that starts alone can become a structured set, where the human adds
groups (real folders) and new documents under it. **Ruled shape:** one type, a
`ContextEntry` with a `root` directory and a tree of `doc` / `group` nodes. A
folder entry mirrors its directory; a single-file entry is rooted at the file's
parent and holds one doc node. "Single document" versus "set" is rendering, not
a type, so promotion later adds nodes without migrating anything. Built in slice
A as the model only; the promotion UX is future work.

## E16 · Build the surface one piece at a time, with the context sidebar first

**Ruled:** Cole, 2026-09-11. Surface build order: layout, then the context
sidebar (single documents and structured sets, navigation), then viewing a
selected document in the centre pane (read-only first), and only then editing
and chat. Backend and CLI foundations proceed in full. **Why:** the sidebar is
foundational, and Cole wants a context sidebar reusable across apps, so it is
built with a props-driven boundary (no daemon coupling inside) to be extracted
once a second app needs it. Its file-tree behaviour (drag-and-drop, reorder,
move) gets a dedicated design pass informed by Operator's file tree and the
other spells' sidebars.

## E17 · Tree order is sort-based; drag-and-drop means nesting, not ordering

**Ruled:** Cole, 2026-09-11. No manually maintained order, in real folders or in
assembled sets. Children display sorted, by name by default and optionally by
last-updated (Zed's and most file trees' convention). Drag-and-drop exists to
change NESTING: move a document into a group, between groups, or out to the
root, and create a group then drag files into it. **Not taken:** a manifest-held
order overlay for real folders; array order for assembled sets. Operator is the
same: its "reorder" only ever changes the parent, and the display comes from a
sort setting. The tree library (`@headless-tree/react`, lead's pick) is used
with `canReorder: false`, so drops resolve to "inside this group" rather than a
position among siblings.

## E18 · A status strip under the editor

**Asked for:** Cole, 2026-09-11. A thin strip along the bottom of the centre
pane, modelled on Operator's `StatusBar.vue`: the active version and its author
(human or agent), updated time, saved or unsaved state, and word and character
counts (debounced, per Operator's `useContentStats`). Placed in the layout now
because it takes vertical space; values arrive with the viewer.

## E19 · Scriptorium's surface may take the libraries it needs

**Ruled:** Cole, 2026-09-11 — "I'm fine with adding whatever we need for this
spell." Recorded against `grimoire/house-style.md`'s surface dependency cap as a
scoped exception: `react-resizable-panels`, `@headless-tree/core` and
`@headless-tree/react`, and the CodeMirror 6 packages (`state`, `view`,
`commands`, `language`, `lang-markdown`, later `merge`). This follows Cole's
direction to prefer well-supported libraries over hand-built components (the
tree study). `react-resizable-panels` landed in slice A before the ruling was
written, which the house rule says must come first — a gap in brief A, noted.

## E20 · The context sidebar, first build — the choices made while building it

**Made:** lead, 2026-09-11, building the sidebar with Cole's direction
(E15–E17).

- **Library:** `@headless-tree/react` 1.7 for a set's tree (the tree study's
  pick): it owns focus, expansion, selection and the ARIA keyboard pattern and
  renders nothing, so rows are ours. Drag-and-drop, rename and new group /
  document are left for the slice that adds the daemon verbs that make them real
  moves (the library carries all three; `canReorder: false` per E17).
- **Two views of one entry type:** the LIST of entries, and a SET drilled into
  with a back button (mind-mapper's breadcrumb pattern, reduced to one level).
  An entry holding exactly one document renders as that document and opens on
  click; anything else drills in. The decision reads the nodes (`singleDoc`),
  never a stored kind — E15 holds in the UI too.
- **A single click opens a document** from the tree or the list (a sidebar, not
  a file manager); Enter does the same from the keyboard.
- **Sort:** groups first, then documents, by natural case-insensitive name (E17;
  `sortNodes`, unit-tested).
- **Paths are cut from the FRONT** (`…/drafts/notes`) because the end tells two
  paths apart; the full path is the tooltip.
- **Add by path** with completion from the daemon's directory listing
  (`fs.list`), Tab completes and Enter adds — drag-and-drop still waits on E14's
  spike.
- **The sidebar's boundary is props-only** (entries, open doc, callbacks,
  `listDir`), so it can move to `src/kit/` when a second app wants it (E16).
- **Pane sizes live in the HOME's `prefs.json`**, not the browser: every session
  is a new port and browser storage is keyed by origin, port included, so sizes
  in localStorage reset at every `open` (slice-A finding). Driven: resized in
  one session, a second session opened at those sizes. ⚠ **The theme still lives
  in localStorage** (its pre-paint script reads it to avoid a flash), so it does
  not yet carry across sessions — a follow-up, not done here.
- **The read-only viewer carries no markdown language yet.**
  `@codemirror/lang-markdown` pulls HTML, CSS and JavaScript languages in at
  module scope, and the JavaScript language's snippet strings tripped the
  import-boundary ward's text scan (a string literal read as an import). A
  read-only view without a highlight style gained nothing from it, so it and its
  two sibling packages were removed; the editing slice brings them back and must
  settle the ward's string-literal reading and the bundle weight.

## E21 · One global theme, last choice wins — and the sidebar's verify-pass fixes

**Ruled:** Cole, 2026-09-11 — the theme need not follow a session; flipping it
should simply be what every session opens in next. It lives in the home's
`prefs.json` beside the pane sizes (browser storage cannot follow a new port);
the browser keeps a copy only so the pre-paint script avoids a flash. Driven:
set dark in one session, a fresh session on a new port opened dark.

**The verify pass on the sidebar slice, and what changed:**

- **Scroll was lost** when the agent's version became active (the view remounted
  per version and replaced the whole text). Now one view per document and the
  smallest change is applied, with the scroll restored; the pane keeps the last
  text while a new version's arrives. Driven: 60,000 px down, `version-new` →
  edit the top line → `activate` — still at 60,000 px.
- **`ROOT_ID` held a NUL byte**, so git showed `model.ts` as binary. It is "/".
- **Two sessions sharing a home erased each other's prefs** (each wrote back a
  copy loaded at boot). Prefs are now read fresh for every snapshot and write;
  there is a 64-key cap.
- **Tab could complete from a stale list** inside the debounce. Suggestions now
  carry the value they were computed for.
- **A failed add was silent.** Daemon refusals now show under the path box.
- **A mirrored folder holding one file rendered as that file** — losing the
  folder's name, and "Remove" on the row removed the folder. E15's rendering
  rule is refined: only a `listed` entry with one document renders as a
  document; a folder the human added stays a folder. (`membership` is a sourcing
  mode, not a doc/set kind — promotion still adds nodes to the same entry.)
- **Removing the entry that holds the open document** now closes it in the view;
  its versions stay in the session.
- **Enter on a tree document sent `open` twice**; the library's primary action
  no longer opens.
- Smaller: the status strip hides its low-priority segments in a narrow pane;
  faint subtitle text raised to `ink-dim` for contrast; the active row is tinted
  with the rubric; "partial" (a truncated folder) is a badge up front, not an
  ellipsed suffix; listing errors read as words; the first Escape closes the
  suggestions and only the second clears the path.

## E22 · A set is a folder

**Ruled:** Cole, 2026-09-11 — "set as a folder … simplest"; a virtual grouping
can come later if this stops working. "Turn a document into a set" creates a
folder named for the document beside it and MOVES the document into it; the
entry becomes that folder. Every group is a real directory and every move is a
real move on disk (E15 already said so for groups). **Not taken:** a set as a
group Scriptorium tracks around files that stay where they are (two meanings for
"set" and "folder"; combining documents from different folders gets messy).

## E23 · The workspace folder — where drops and new top-level documents land

**Ruled:** Cole, 2026-09-11, answering E14. A session has a **workspace**: the
folder it was started from (the CLI's working directory at `open` — the project
folder, for a released spell the consumer's project), changeable by the human
and the agent. **Dropping a file onto the sidebar COPIES it into the workspace**
(or into the folder it was dropped on) and adds the copy as an ordinary linked
document — duplication accepted for simplicity. New top-level documents are
created there too. **Why not link the dropped original:** a web page never
learns a dropped file's path, and Cole uses Brave, which disables the File
System Access API that could have held a writable handle — so the copy is the
one route that works everywhere. **Named "workspace"**, not "session home",
because `SCRIPTORIUM_HOME` already names where the spell keeps its own state.

## E24 · Equal capabilities, different affordances — structure changes go through the daemon

**Ruled:** Cole, 2026-09-11 — the house principle: the human and the agent can
do the same things and get the same result, though they see and do them
differently. Every structure change — new document, new folder, move, rename,
remove from Scriptorium, turn into a set, import a drop, set the workspace — is
a daemon operation the surface reaches by menus and dragging and the agent
reaches by CLI verbs. The daemon performs the real change on disk, updates every
viewer, and posts a chat line naming who did it. Changes made outside (the
agent's own `mv`) still appear live for mirrored folders through the watcher,
but the verbs are the path that keeps both sides informed. **Remove from
Scriptorium hides; it never deletes a file.** There is no Delete action (Cole:
"I don't necessarily even know if we need a delete action").

## E25 · The native picker and Reveal in Finder — the daemon's local hands

**Ruled:** Cole, 2026-09-11, asking for a file-picker button and "Reveal in
Finder", and twice wondering whether a web app can do either. It can, because
the daemon is a LOCAL PROCESS: the surface asks, and the daemon runs the OS's
own dialog (`osascript`'s `choose file` / `choose folder`, zenity on Linux) or
`open -R`. **Why not the browser's own picker:** `<input type="file">` and
`showOpenFilePicker()` hand back CONTENT and a name, never a path — all a page
can do with that is copy, which a drop already does (E23) — and Brave, Cole's
browser, disables the File System Access API. A picked path is therefore a real
LINK to the real file (E1), not a copy. Guards: one dialog at a time (a second
request is refused in words, never queued), a chosen path is admitted like a
typed one, `reveal` only accepts a path the context already shows, and the path
is passed as an argv, never a shell string. **Both are HUMAN affordances** with
no CLI verb: the agent has the paths already, and E24's rule is equal
capabilities with different controls.

## E26 · A move is confirmed when it takes a FOLDER or LEAVES A REPOSITORY

**Ruled:** Cole, 2026-09-11, after a drag of his own moved this project's docs
folder out of the repository (the session's log said so; nothing was lost, and
the repo copy came back from git). A folder move takes everything under it and
can carry files out of a git working tree, where the consequence reaches past
scriptorium — so the surface asks first, in the terms of what would happen: how
many documents move, from where to where, and — when the daemon can see it — a
warning naming the git repository being left. **A single document moves without
a question** — it is one file, the log names it, and a prompt on every drag is
the kind of friction people learn to click through — **unless it leaves a git
working tree**, which was AMENDED the same day by the same route: the rule
shipped as "folders ask, documents do not", and Cole's next drag was one FILE,
this repo's README, out of the repo into his workspace. A move's stakes are set
by where it LANDS, not by how many files it carries. Every move therefore asks
the daemon what it would do first (a local round trip), and the dialog appears
for those two cases only. The agent's `move` verb is NOT gated: E24's rule is
equal capabilities with different affordances, and a CLI verb is already
explicit.

**The dialog is `src/kit/ui/ConfirmDialog.tsx`, in the KIT** — Cole: "this is a
very common UI pattern just across apps … ideally if we can share it". It ships
with a `useConfirm()` hook (`if (await confirm({title, message})) …`). The kit
owns structure, behaviour and the L0 neutrals; the confirm button's TONE is the
caller's, because danger and primary are L1 tokens where one spell's alias is
another spell's brand slot (the rule Dot already states for its fill). A spell
importing it must import `kit/theme/base.css`, and a new `kit-styling-ward` cell
holds that pairing.

## E27 · The workspace reads at the top; the path box stays at the bottom

**Ruled:** Cole, 2026-09-11, after seeing both halves moved up together: "having
the workspace at the top is nice because it's one of the first things you read
and it tells you where you are rather than jumping down to look at … it sort of
orients you", while adding a path is "just not as immediate. Plus, we already
support drag and drop." So the two SPLIT: the workspace line is orientation and
sits above the list; the add-by-path box (with its picker buttons) is a
deliberate act and stays at the bottom. Changing the workspace opens its own
path box directly under the workspace line, where the thing it edits is. **Not
taken:** both at the top (three control bars before the first entry), and
folding New document / New set into the path row (four icon buttons crowded the
input to about 130px, two of them near-duplicates — built, looked at, dropped).
`AddPath` therefore carries an `openDown` flag: a box at the top of a panel must
drop its suggestions downward, and the same component is used in both places.

## E28 · Undo and redo: ONE shared timeline of committed acts — DEFERRED, shape decided

**Ruled:** Cole, 2026-09-11, after his own accidental moves ("if you
accidentally move something and you're like, oh, actually, I want to move that
back where it was"), and DEFERRED in the same breath — "once we get into
editing, that's also going to need undo-redo. So the question is like, is there
like a global undo-redo? Is it context specific? I'm not honestly sure." Nothing
is built. The shape is decided here so the editing slice starts from a decision
rather than reopening it, and this seat's first recommendation — two stacks, one
per domain, chosen by focus (VS Code's explorer-vs-editor model) — was
OVERRULED: Cole, "I would also say ultimately probably one shared timeline".

**The timeline records COMMITTED ACTS, not keystrokes.** A move, rename, create,
import, hide/unhide, set.make, workspace change, a Save, a version made active:
one ordered list, persisted beside the manifest, each entry naming who did it
and carrying its own inverse. Keystrokes stay in the editor, in CodeMirror's own
per-document history — a shared timeline of keystrokes would bury every
organizing act under typing, and an agent scanning the history would learn
nothing from it. **The join is Save (E7)**, which is already the line where a
buffer becomes real for everyone else: fine grain inside a version, timeline
between them.

**The timeline is shared by both parties**, because both move the same real
files (E24). The human's undo may therefore reverse the AGENT's last act — a
stack that skipped it would revert the wrong thing — so undo names the actor
when it crosses ("Undo the agent's move of plan.md?"). Still open, and flagged
rather than assumed.

**What keeps a global undo from being dangerous** is E26's rule again: undo SAYS
what it is about to do whenever the next entry is not a text edit in front of
the human, through the same ConfirmDialog. And ⌘Z in the editor does NOT fall
through: at the start of a buffer's history it stops there rather than reaching
into the filesystem. The timeline's undo is its own affordance — a visible one
on the change's line in the conversation, not only a keystroke.

**Undoing a CREATE or an IMPORT is the case that meets E24's "nothing is
deleted"**: the inverse of making a file is removing it. Ruled for the build:
remove it only while it is still empty (a new document) or unchanged since the
import, and otherwise refuse in words. An inverse whose ground has shifted (the
file moved again since) refuses too, rather than guessing.

## E29 · Rendering markdown: micromark, and three modes with split earned by width

**Ruled:** Cole, 2026-09-11, before editing rather than after — "I definitely
want to have that feature … editing is going to happen in the raw file format,
but we should also have a mode where you can see the rendered content", pointing
at Operator's three modes (raw · rendered · split) and noting the real-estate
worry: "within edit mode, we're also thinking of adding a split view where you
could have multiple versions displayed … if it feels like it's going to be
complicated, we could just go with a toggle for raw or rendered."

**All three modes, and split is offered only when the pane can hold it** (720px,
which is where two 76ch columns stop being two columns of broken lines). Below
that the button is disabled and says why, and a SAVED split falls back to
rendered until there is room — the panes are resizable and the chat pane is
beside them (E11), so "enough room" is something the human changes minute to
minute. That answers the real-estate worry without dropping the mode: when the
version split arrives, it competes for the same width and the same rule applies.
The choice is a pref in the home, like the theme (E21), and the split's own
sizes are persisted like the outer panes.

**The renderer is `micromark` + `micromark-extension-gfm`, and NOT digestify's
`marked` + DOMPurify.** The roster already had two answers; the difference is
which renderer can emit a tag it did not write. micromark encodes raw HTML
unless `allowDangerousHtml` is set, so there is no sanitiser to lose — that is
mind-mapper's C2 ruling, and `micromark` is already a root dependency. GFM is
one extension on top (tables, task lists, strikethrough), declared in
scriptorium's manifest under E19's exception.

**MEASURED, against this seat's own assumption:** micromark also refuses a link
scheme it does not allow (`javascript:`, `data:`, `vbscript:` compile to
`href=""`). A backlog note claiming mind-mapper's renderer carried that hole was
filed and then WITHDRAWN on the measurement. scriptorium keeps its own
`safeHref` as a second layer, and an empty target now renders struck through, so
a refused link reads as refused instead of looking live and doing nothing.
`src/scriptorium/sinks.test.ts` (digestify's shape) holds the one HTML sink.

**Not built, and named:** images with a relative source do not load — the page
has no route to a file beside the document. A daemon asset route restricted to
the entry's own folder is the fix, and it is the next chapter's, not this one's.
Scroll is not synced between the two halves of a split; Operator syncs, and it
matters more once editing lands.

## E30 · Scrollbars are CSS, not `ScrollArea`

**Ruled:** Cole asked for shadcn's styled scrollbar rather than the OS one ("it
allows you to use a scroll bar that is more stylized to look like your general
app style"). Done as pseudo-element rules in the spell's own tokens, NOT with
shadcn's `ScrollArea`, and the reason decides it: `ScrollArea` replaces a native
scroller with its own viewport, and **CodeMirror owns its scroller**
(`.cm-scroller`) — wrapping the editor would take its scrolling and its
virtualisation away. A `ScrollArea` surface would therefore carry a styled bar
in the sidebar and the rendered view and a NATIVE one in the raw editor, which
is the opposite of the ask. CSS reaches every scroller in the page, including
CodeMirror's, and costs no dependency.

**One mechanism, not two:** Chromium honours `scrollbar-color` and then ignores
`::-webkit-scrollbar` entirely, so declaring both would silently drop the
detailed rules. The pseudo-elements are the Chromium/WebKit path (Brave is
Cole's browser, E23); the standard properties sit behind an `@supports` only
Firefox takes.

**Repeal when** a pane wants a scrollbar that is not the OS's SHAPE — overlay
bars that fade when idle, a custom track, or scroll buttons. That is what
`ScrollArea` is for, and it can be adopted per pane, leaving the editor on these
rules.

## E31 · Editing: the buffer reaches the ACTIVE VERSION, and only Save reaches the file

**Built:** 2026-09-11, Cole — "let's continue into editing … if we can create a
really good standard editing experience for a human user, that will naturally
lead into adding the chat and the same functionality for the agent." So the
editing slice is single-user first, by his sequencing, and chat comes last.

The raw view is editable. Keystrokes settle for 250 ms and go to the daemon as
`edit`, which writes the ACTIVE VERSION's file — never the original (E7). Save
(the button, or ⌘S) writes the original; Revert takes the file back over the
version. ⌘S is bound TWICE on purpose: in the editor, where it flushes the
pending buffer first, and on the window, because in rendered mode the editor is
not mounted at all and the browser's own Save-page dialog is what opens if
nothing claims the key.

**Two writers, one document, and an ANNOTATION keeps them apart.** A change the
view applies from the daemon is stamped `remote`, and the update listener
ignores a stamped transaction — otherwise a reload from disk would be sent
straight back as if the human had typed it. The mirror of that: the prop trails
the buffer (the daemon does not echo an edit back), so the view ignores a text
equal to the last one the daemon gave it, and the viewer keeps its own copy in
step. Applying a stale prop would have thrown away everything typed since.

**E2 was driven with a live editor, not just asserted:** with the human's
unsaved text in the buffer, an outside write to the active version was kept as
v2, the buffer held its text, and the chat said so. A file changed on disk under
unsaved edits raises a bar above the document — "Keep mine" / "Take the file's"
— rather than choosing for the human.

**Markdown highlighting is back (E20's open question, answered).** Not
`@codemirror/lang-markdown`, which imports the HTML language at module scope and
drags the JavaScript language's snippet strings into the bundle — that ward-1b
false positive is what removed highlighting in the first place — and not
`@codemirror/legacy-modes`, which has 310 modes and no markdown. A hand-written
stream tokenizer of about fifty lines, with the one property the other two do
not have: it is unit-tested directly over CodeMirror's own `StringStream`,
including the rule that it must always advance (a tokenizer that returns without
consuming hangs the highlighter).

**Undo is the editor's own** (CodeMirror `history()`), which is exactly E28's
split: keystrokes inside the buffer, committed acts on the shared timeline —
still unbuilt, and now the next thing editing needs.

**The raw measure went 76ch → 104ch** on Cole's note that it read too narrow:
76ch is a prose measure and monospace is not prose.

## E32 · OKF frontmatter, read: the daemon parses, the surface shows, the agent queries

**Built:** 2026-09-11, slice 1 of the OKF plan
([okf-and-links-plan.md](./okf-and-links-plan.md)), after Cole ruled its four
open questions.

**The daemon parses and the surface renders what it is given.** `Bun.YAML.parse`
exists, so no YAML parser reaches the browser and the agent gets the daemon's
own parse rather than re-reading the block by hand. Frontmatter rides the wire
twice, at two weights: the OPEN document carries its full `DocMeta` (every key,
plus the raw block for round-tripping), and every context document carries a
`DocSummary` — type, status, tags, trust, stale — because that one rides every
snapshot. The scan is head-first (8 KB, which is where a block lives) and cached
by path and mtime, capped at 500 documents with the cap SAID on the wire.

**The spec's temper is the design.** A consumer "MUST NOT reject documents" and
"SHOULD preserve unknown keys", so: a document with no block reads as null and
that is not an error; a block that will not parse keeps its document and reports
the reason in the header; a missing `type` — OKF's only required field — is a
fact shown, never a refusal; and every key survives in `fields`, so
`hivemind_source_id` and a field invented tomorrow both render as labelled
values. **Derived values are derived**: trust tiers from `verified`
(`human:<id>` → human-reviewed) and staleness from `stale_after` as an INSTANT,
computed on read, never stored.

**One judgement the spec does not make, made here:** a document with NO
frontmatter matches only the empty filter, including `--status stable`. Absent
`status` defaults to `stable` for an OKF document, but a file with no block is
not making the claim — reading the default the other way would put every
untouched note in the result.

**The agent's verbs speak pdocs' vocabulary** (Cole: "I plan to use the project
docs frontmatter format in a lot of my projects"):
`find --type --status --lifecycle --tag --since`, ANDed, all optional, an empty
result exiting 0 with `count` — plus `meta [path]`. Same words in both tools, no
shelling out to a script found in a repo. `--since` is a DATE here and an event
id on `tail`; the flag is shared, the meaning is the verb's, and a non-date is a
usage error so a typo cannot silently widen a search.

**Known fields get explicit support, unknown fields still get shown** (Cole's
ruling): `type`, `status`, `tags` and `lifecycle` have chips, filters and
sidebar marks; `lifecycle` is never VALIDATED, because pdocs checks it against
each type's own vocabulary and only that project knows it.

Driven against the real corpus — `agent-cli-conformance/docs/wiki`, 48
documents: `find --type rule --tag exit-codes` returned exactly the five rule
pages; the header showed type, status, trust, date, tags and the unknown
`related`/`generated` fields; the frontmatter left the rendered body; a
deliberately broken block rendered its document with the parse error stated; and
a plain document showed no header at all.

## E33 · Links resolved, and the map — the bundle is a set's root

**Built:** 2026-09-11, slices 2 and 3 of the OKF plan, in one build because the
resolver IS the graph.

**Four sources of edges, kept as two kinds.** Body links (markdown and wiki) and
frontmatter references (`related`, `supersedes`, `sources[].resource`, anything
whose SHAPE resolves) are collected separately and stay separate on the wire, in
`backlinks`, and in the map's drawing — solid for a citation in prose, dashed
for a claim about the document. pdocs keeps them apart; so does this.

**Typed links, copied exactly from Operator** (Cole's ask): a relation rides the
link as a query — `[label](./other.md?rel=extends)`,
`[[other?rel=supersedes| label]]`. Rels are lowercased, trimmed, deduped and
kept in authored order, their spelling is NOT canonicalised, and **a bare link
is `[]` — the absence of an assertion, not an implicit `references`**, which is
Operator's own rule and matters because a map must not draw a claim nobody made.

**A set's entry root is the bundle**, so `/concepts/x.md` means the bundle root
and `./x.md` the document's folder. Resolution then tries, in order: the
document, the bundle root, and the git working tree — the third because pdocs
writes repo-relative paths and the wiki's rule pages carry repo-relative
`checker:` values, and neither resolves from the other two. **Measured on the
real corpus** (agent-cli-conformance's wiki, 46 documents): 508 edges resolve
inside the bundle, 140 leave it, and **1 is dangling — a checker the wiki itself
marks `planned`**. Before the third candidate, 22 were "missing" while the files
sat in the repo.

**Two resolver bugs the real corpus found**, neither visible in a fixture: a
target with an extension but no `./` (`[the linter](lint.ts)`) was read as a
NAME and reported missing while the file sat beside the document; and an
unanchored path was only ever tried against the document.

**Following a link is the daemon's**, not the page's: only it knows the bundle
and only it may open a file. In-bundle opens the document; `outside` says where
the file is and leaves adding it to the human (the admission rule holds);
`missing` says so. The rendered view's links were inert until now (E29) because
nothing could resolve them.

**The map is an overlay** (Cole's ruling), and it is drawn rather than
simulated: COLUMNS BY TYPE, ordered by inbound citations, tall types wrapping
into sub-columns. No graph library and no physics — a force layout moves while
you read it and draws differently every time; this draws the same corpus the
same way twice, and costs no dependency. **A dense map hides its own
documents**, which the real wiki proved at 508 edges, so past 150 the edges wait
for a hover — the node is what you read, the links are what you ask for — with a
toggle for the whole shape at once. Every node is keyboard-reachable, because a
map is a way INTO a corpus.

## E34 · Two map modes, and hovering mutes what a document does not touch

**Ruled and built:** Cole, 2026-09-12, on seeing the map: "on hover we should
make non-connected nodes a bit transparent and muted … I'd like to also have a
physics based mode, I think Obsidian has something like that. I think the modes
tend to be useful in different ways."

**They answer different questions, which is why both stay.** The COLUMNS answer
"what KIND of page is this, and what cites it" — deterministic, so the same
corpus draws the same way twice and a reader can point at a position. PHYSICS
answers "what clusters, and what sits alone", which a column layout structurally
cannot show: it puts that answer in the column ORDER rather than in the distance
between nodes. Driven on the real wiki, the physics mode put `STYLE`, `SCHEMA`
and `Delegator` out at the rim on their own — a fact the columns never showed,
because every column is as tall as its type.

**Hovering MUTES rather than hides**, in both modes: a document the hovered one
does not touch drops to about a fifth opacity and stays where it is. Removing it
would change the shape being read. (mind-mapper's canvas dims for its spotlight
the same way — the house already had the idiom.)

**`d3-force`, not a hand-rolled simulation**: already carried at the ROOT for
mind-mapper's `GraphCanvas`, so the physics mode enters no new package. Nodes
can be DRAGGED — pinning one and letting the rest settle around it is how a
force map is read — and the hovered node draws LAST, so its label is never
buried under a neighbour's.

**Tuned against the corpus, not guessed:** at a -220 charge and a 110 link
distance, 46 documents packed tightly enough that every label overlapped, which
is a pretty and unreadable map. -520 and 150, with a collision radius 34 past
each node's own, gives the names room.

Also in this chapter: `@codemirror/legacy-modes` left the manifest. It was
installed for E31's tokenizer and turned out to carry 310 modes and no markdown
— a dependency that earns nothing should not sit in the file.

## E35 · Frontmatter is OFFERED to a human and WRITTEN by a verb

**Built:** 2026-09-12, slice 4 — the last of the OKF plan.

**The two paths differ, and the difference is E24's rule rather than an
inconsistency.** A document with no block gets a line in the document header —
"This document has no frontmatter. Add a block" — and clicking it puts the block
in the HUMAN'S BUFFER, not on disk: they read it, fill the blank description,
and Save writes it (E7). The agent's `meta-init` writes the ORIGINAL and says so
in the conversation, meeting the conflict bar when the human has unsaved edits
(E32's ruling). Same capability; the affordance each party needs is not the
same.

**Every write is a TEXT EDIT, never a reserialisation.** A new block is BUILT
(there is nothing to preserve yet); an existing one is edited a LINE at a time,
so key order, comments, spacing and keys this spell never heard of survive byte
for byte — which is exactly what the spec's "preserve unknown keys when
round-tripping" asks for and what a parse-and-print would lose. Driven on a
block carrying a comment and a `hivemind_source_id`:
`meta-set status=stable lifecycle=live` changed two lines and moved nothing
else.

**The suggested `type` comes from the NEIGHBOURS, never a fixed list.** OKF says
`type` is "not centrally registered" and every corpus invents its own, so the
only honest source is what the documents beside this one already say; the
folder's name, de-pluralised, is the fallback (`decisions/` → `decision`). When
neither answers, nothing is suggested — a blank the human fills beats a
plausible guess, which is SCHEMA.md's own rule about `generated.by` and the
reason `description` is left EMPTY rather than invented.

**`generated.by` is recorded honestly:** `human` when the human clicked,
whatever the agent passed to `--by` otherwise, `unknown` when nobody said.

## E36 · One diff, computed in the daemon, rendered by the surface

**Built:** 2026-09-12 — the comparison slice, chosen over the chat slice
deliberately. Chat needs objects to carry; a comparison and (next) a comment are
those objects. The versions model already existed and a human had no way to READ
a version before making it active, which is a hole in what shipped rather than a
new feature, and it widens the moment chat makes versions easy to make.

**`@codemirror/merge` was measured, not dismissed.** Its dependencies are
`@codemirror/language`, `state`, `view` and `@lezer/highlight` — every one
already in the surface — so ward 1b has nothing to say about it and the bundle
argument that killed `lang-markdown` in E20 does not apply. It is still not
used, for a different reason: it would give the SURFACE its own diff while the
`diff` CLI verb used ours, and a hunk the human accepted would be a hunk a
different engine found. Two engines over one document is the lockstep-mirror
drift this house has already paid for once. The daemon computes; the surface
renders what it computed; "Take" sends hunk IDS back, never text.

**The left side is always the ACTIVE version, and that is a rule.** E2 says the
active version is the only one the human writes, so making it the left side of
every comparison means a merge has exactly one legal destination. Comparing two
versions neither of which is active would be readable and un-mergeable — a view
with a dead verb — so the shape does not offer it: activate the one you mean to
change first.

**A merge is written through `edit`**, the same path a keystroke takes, so it
obeys every rule a keystroke obeys: it lands on the active version and never the
original (E7), and check-before-write preserves an outside write as a new
version first (E2). Verified live: taking one hunk left the original saying
`status: draft` while the buffer said `stable`.

**Hunk ids are valid only against the text the diff saw.** The daemon re-diffs
on every merge and REFUSES an id it cannot find, naming the range it does have,
rather than applying a number to a document that moved underneath it. Driven:
after taking hunk 2, asking for hunk 2 again exits 6 with "run diff again".

**Line diff, then word refinement inside PAIRED lines only.** A hunk replacing
three lines with three is paired line by line; a 1-for-many hunk gets no spans
rather than an arbitrary pairing, because a word diff against the wrong line is
worse than none. A moved paragraph reads as a delete and an add — the honest
answer for a line diff, not a wrong clever one.

**The engine says when it gives up.** Past 3000 edits Myers stops and the whole
difference becomes ONE hunk with `coarse: true`, and the view prints a banner —
a human told "1 change" would read that as a small edit.

**Scrolling is synced by CONSTRUCTION, not by listeners.** The two halves are
cells of one grid inside one scroller, so they cannot drift. This does NOT fix
the raw/rendered split next door: those are two renderings with different line
counts and two independent scrollers, and syncing them is approximate work of
its own. Still on the list.

**A diff needed a second hue and the palette had none** — `rubric` and `danger`
are both reds, so additions and deletions looked the same. Measured in the
browser, not predicted. `--color-added` / `--color-removed` join the spell's
semantic tokens; they mean added and removed, and nothing else may borrow them
to mean good and bad.

## E37 · The human makes a version, and chooses which one they are in

**Built:** 2026-09-12, immediately after E36 and because of it. Compare gave a
human a reason to want versions, and then offered them no way to make one:
`version.new` had been on the agent's command union since E1 and never on the
surface's, so versions were an agent-only concept with a human-facing reader
bolted on. Cole found it by asking "how do I create a new version of a file?" —
which is the shape of gap a build finds and a plan does not.

**Read against Operator's `VersionDropdown.vue` first, at Cole's suggestion.**
Taken: the active version pinned to the top with a check, the AUTHOR shown per
row (its Sparkles/User pair — worth more here, where the other author is the
agent), and the LABEL as the identity with `vN` only as the fallback when nobody
named it. Not taken: `maxVersionsPerDocument` with its "approaching limit"
warnings and forced deletion, which solve a database quota; ours are files in a
session folder.

**Where we diverge, and why.** Operator spends two toolbar buttons (History,
Save-version) plus a "Manage versions…" item. Our document toolbar already
carries Revert, Save and four mode buttons. The list hangs off the STATUS
STRIP's version segment instead — the strip already answers "where am I", so the
versions belong behind the thing that names the current one, and no new toolbar
control is added at all.

**And the thing Operator's menu cannot do: COMPARE.** Switching to look is its
only offer. A row here offers both, and comparing deliberately does NOT activate
— reading a version before deciding is the whole point, and a menu that switched
you to whatever you wanted to look at would make that impossible. (The Compare
button lives inside the row, so it must stop the click reaching the row; that
also stops the menu closing, which is why the menu is controlled.)

**A new version is a SNAPSHOT, not a branch.** You keep editing the version you
were on and the copy waits in the list — Operator's model ("preserve the current
document state so you can refer back to it later"), and the one that matches
when a human reaches for this: before doing something risky, wanting to carry on
where they are. Switching to the copy is one click away, so the other reading is
not lost. _The dialog's prose described a branch while the code made a snapshot;
driving it in the browser is what showed the mismatch, and the words moved
rather than the behaviour._

**An empty name is allowed**, where Operator requires one. `v3` is a fine name
for a snapshot taken in a hurry, and a forced field collects "asdf". The hint
asks for INTENT rather than chronology — "before the agent's pass" — because the
number is already known and the only thing a human can add is why.

**`StatusSegment` grew a `node`**, rendered instead of the value. `value` stays
required as the segment's plain-text truth, so a node is a richer rendering of
the same fact and never a different one.

## E38 · The version control moves to the header, beside the title

**Ruled by Cole, 2026-09-12, within an hour of E37 shipping.** The menu was
built onto the STATUS STRIP's version segment, and his read of it is the
correction:

> "In the footer, one, it's the only button. So everything else is read only and
> then that one, you know, version property has a value, but it's really hard to
> read as a button. Like it's just not something I look towards."

**A lone control in a read-only row does not read as a control.** The strip is
status — words, characters, saved/unsaved — and putting the single interactive
thing among them made it invisible as an affordance, whatever its hover state
did. E37 chose that spot to avoid adding a seventh control to the header; the
cost it did not price was that the header is where a human LOOKS for an action,
and a button's neighbours are part of whether it reads as one.

**And which version you are in is not a status property.** Cole: _"the first
thing I tend to look at is the title… I think it's good to have that version
number really obvious rather than scanning towards the bottom of the app."_
Version is part of the identity of what is open, so it sits with the name —
`v2 · the agent's tighter prose │ note.md` — rather than among the measurements
below.

**So the trigger became a button in fact and not only in role:** a border, the
header's control height, and a chevron. The label gives way before the number
when the pane narrows, because the number is the identity and the name is the
useful half.

**Then the button shed its label, in the same conversation.** Carrying
`v2 · the agent's tighter prose` beside `note.md` put two titles side by side,
and Cole read the failure mode before it bit: _"if you get a longer one… they
can almost start to run together or just be a lot of text."_ The header button
is now the NUMBER alone — the identity, nothing else — and the name lives in the
menu it opens.

**And the name came back to the strip, read-only, which is where it belongs.**
Cole: _"it might make sense to then show that version information in the status
bar at the bottom as read-only… so that you're still able to glance at that
information but it's not taking up as much space in that top bar."_ So the two
places divide honestly: the header is where you go to CHANGE the version, the
strip is where you glance to see WHICH —
`Version: v2 · the agent's tighter prose` — and nothing competes with it down
there.

The strip's copy is truncated in JS rather than by CSS: the strip is one nowrap
row, so a long name left to itself would push the word counts off the end
instead of clipping itself.

`StatusSegment.node` — added in E37 so one segment could be a control — is gone
again. A field with no consumer is a surface waiting to be misused.

## E39 · The active version is highlighted, not dimmed

**Ruled by Cole, 2026-09-12.** The active row in the version menu was rendered
`disabled`, and shadcn draws a disabled item at 50% opacity. The semantics were
right and the signal was backwards:

> "It's kind of indicating that it's not selectable, which makes sense, but it's
> also meant to indicate that it's the active version… I feel like that's more
> of something you want to highlight than mute."

**Two facts share one row and they pull opposite ways.** "You cannot click this"
and "this is the one you are in" are both true of the active version, and a
component library only offers the first. Dimming answers the question nobody
asked — the row's unavailability is uninteresting; WHICH row it is, is the thing
the menu exists to say.

**So `disabled` is kept for what it does and overridden for what it says:**
`pointer-events-none` stays, `opacity-50` is replaced with a rubric tint and a
faint ring, and the check icon takes the accent. The row is now the most visible
thing in the list rather than the least.

**Dividers between rows** in the same pass — each row carries two lines (name,
then author and date), and without a rule between them the pairs ran together
into a wall.

_General shape worth remembering: when a library's state name matches your
meaning but its styling contradicts it, split them — take the behaviour, refuse
the appearance. Reaching instead for a different state (not-disabled plus a
no-op handler) would have bought the same look and lost the keyboard and screen
reader semantics._

## E40 · Selection gets its own colour, and it is not the brand's

**Ruled by Cole, 2026-09-12.** The selected row in the context sidebar — and the
active row in E39's version menu — were tinted with `--color-rubric`:

> "Because it's sort of red… it sort of reads as more warning than selection.
> What we're trying to just say is like a neutral highlight."

**First question asked and answered: WHERE does it come from.** Not the kit.
`rubric` is scriptorium's own token and appears nowhere in `src/kit` — the kit's
L0 layer is deliberately `bg`/`surface`/`ink`/`edge` with no accent at all, and
L1 shadcn aliases are banned there by house rule. So there was nothing upstream
to fix and the change is local. Worth recording because the opposite answer
would have made this a repo-wide job.

**The real collision is inside the palette:** `--color-rubric` is `#a8432a` and
`--color-danger` is `#b33a2e`. Selection was drawn a few degrees of hue from the
colour that means danger, so of course it read as caution. (E36 hit the same
wall from the other side and had to invent `added`/`removed` because every
existing token was warm.)

**`rubric` was doing five jobs** — brand accent, primary button fill, caret and
link colour, drop target, and selection. The last is the one that does not
belong: a brand colour asserts identity, and selection needs to assert nothing
at all. Not red (caution), not green (success).

**`--color-selected` is iron-gall ink** — the blue-black a scribe actually wrote
in. Conventional for selection, sits against parchment instead of fighting it,
and means only "this one". `#8098c0` dark, `#3f5f8f` light.

**HOVER deliberately stays warm-neutral** (`surface-raised`), so hover and
selected never collide: one is warm, one is cool, and no row can be mistaken for
the other.

**Drop targets KEEP `rubric`, and that is a distinction not an oversight.** A
drop target is a transient call for attention during a drag — "this is where it
lands, act now" — which is what an accent is for. Selection is a persistent
statement of fact. Different jobs, so different colours, and during a drag the
two are now legible at once instead of being the same wash.

## E41 · A version can be deleted, and its number never comes back

**Asked by Cole, 2026-09-12:** _"I think we need the ability to delete a
version… not sure if that is a completely missing verb or just a UI gap."_

**Completely missing.** No session method, no wire message, no CLI verb —
neither party could remove a version. E37 gave the human a way to MAKE them and
nothing to clean up with.

**The active version cannot be deleted, and refusing beats choosing.** Picking a
replacement would silently move where the human's edits and Save are pointed,
which is the one thing E2 and E7 exist to keep explicit. Because exactly one
version is always active, this also means the LAST version can never be deleted
— a document always has something to edit, and that falls out rather than being
a second rule.

**`from` on the survivors is left alone.** "Made from v2" stays true after v2 is
gone; deleting a version is not rewriting the history of the ones that remain.

**⛔ VERSION NUMBERS ARE NOW MONOTONIC, and this is the real cost of the
feature.** Numbering was `max(existing) + 1`, which is correct only while
nothing can be deleted: the moment it can, removing the highest hands its number
to the next one, and a `v3` named in a chat message, a log line or an agent's
notes points at a different document. So the number comes from a persisted
counter that only ever climbs.

**And the first implementation of that was wrong, in a way the unit test could
not see.** The counter is derived lazily from the versions PRESENT, so a
document that had never allocated one — a manifest written before E41, restored
— would derive the same number again after its highest version was deleted. The
test passed because it allocated first and so never had a cold counter; the
BROWSER found it, on a session that predated the feature. `deleteVersion` now
materialises the counter before it removes anything, and the regression cell
constructs a pre-E41 manifest on purpose (verified red without the fix).

_Worth keeping: a test built from the same mental model as the code inherits its
blind spot. This one only failed against state the code's author had not
imagined — an old session — which is what driving the real thing supplies and a
fresh fixture does not._

**The UI asks before deleting**, through the kit's `ConfirmDialog` (E27),
because this removes a FILE: the original on disk and the active version both
survive, but whatever was written only in that version does not. The trash
action is offered only on non-active rows — the same rule the daemon enforces,
so the surface never shows an action the wire would refuse.

**The compare view falls back to the original** when the side it was showing is
deleted or becomes active. The side can vanish under it; the original always
exists.

## E42 · Two intentions, two menu items, and the app says where you are

**Reported by Cole, 2026-09-12**, from using it: he made a version, carried on
typing, and was editing the OLD one. _"It's easy to miss the step of create a
new version and then now make that the active version."_

**E37 chose snapshot semantics from Operator, and the evidence it was
under-decided was in this spell's own dialog copy** — one hint offering both
_"before the agent's pass"_ and _"shorter draft"_. Those are two mental models
in one sentence:

- **Snapshot** — the new version is the archive; you keep working where you are;
  the name describes what the copy PRESERVES.
- **Branch** — the new version is where you are going; the old one becomes the
  archive; the name describes what you are about to DO there.

**Both make the same file.** A byte-identical copy of what is in front of you,
either way. Nothing is ever lost in one and kept in the other. The whole
difference is which copy you keep typing into — and therefore which side your
label ends up describing.

**Branch is the right DEFAULT for this spell, because versions here are working
files an agent edits with its own tools** — you make one to do something in it.
Operator's snapshot default is right for Operator, whose Save Version is a
backup button.

**But snapshot is kept as a second item rather than dropped, because branching
labels a bookmark BACKWARDS.** If you meant "mark this and keep typing", branch
leaves the frozen marker unnamed and hangs your label on the copy you are still
editing. And that is not repairable: version labels are write-once — there is no
rename-version verb — so a name attached to the wrong side stays wrong. Hence:
_New version from vN and edit it…_ and _Snapshot vN, keep editing it…_, each
with its own wording, and the dialog says which version you will be in.

**The agent's `version.new` still never activates.** Its versions arrive
unbidden; moving the human mid-thought would be the same failure in the other
direction. That asymmetry is E24, not an inconsistency.

**And the app now says where you are.** The conversation line gained a second
sentence — _"You are now editing v5."_ / _"You are still editing v2."_ — and a
TOAST fires whenever the active version changes, from any cause. It watches the
FACT rather than the action, which is why it also catches the agent activating a
version while the human is reading — the case that most needs saying, and the
one an action-fires-its-own-toast design would miss.

**⛔ THE TOAST IS HAND-WRITTEN, AND THAT IS A DEPENDENCY RULING.** shadcn's
`toast` recipe is generated against `@base-ui/react` ^1.8; this repo pins ^1.6
at the ROOT for every spell, and the CLI silently wrote ^1.8 into scriptorium's
own manifest while nothing installed it. Under 1.6 the recipe's manager accepted
`add()` with no error and its viewport stayed empty — a mismatch with no
diagnostic. Bumping base-ui would touch the shadcn components of FIVE spells for
one toast, and a visual regression in the other four is precisely what this
repo's tests do not catch. So the pin stays and the toast is ~50 lines in the
spell. If a second spell wants one, that file is the thing to lift into `kit/ui`
beside `ConfirmDialog`.

_A bar would have been wrong here: the conflict bar persists because it is a
state awaiting a decision. "You're now editing v5" is "that happened, carry on",
which is what a toast is for._

## E43 · "The saved file", not "the original"

**Reported by Cole, 2026-09-12:** _"What does the original actually mean in this
context? Is it the active document? Is it always the initial version… I'm
finding that language maybe a little ambiguous."_

**It is the .md file in the human's folder**, re-read from disk on every
comparison — so it also shows a change made outside scriptorium entirely. It is
NOT v1, and not the active version. Three things that can all differ: v1 is a
COPY taken at open and drifts the moment anyone edits it; the file of record
changes only when Save writes it or something outside does; the active version
is where keystrokes land.

**The word was doing locational work while sounding temporal.** "Original" reads
as "the first one", which is precisely what v1 is — the thing it is not. In the
CODE `original` is right and stays: it names the file of record on a record that
also holds versions. In PROSE it misleads.

**"The saved file" names it by the act that writes it**, which separates it from
a version without asking anyone to think about where files live. It also turns
out to be what the app already said elsewhere — Revert has always reported
"Reverted v2 of note to the saved file" — so this removes a second vocabulary
rather than inventing one.

The CLI now accepts `saved` alongside `original` and `file`; the older tokens
keep working because earlier sessions, notes and agent transcripts use them.

_Small, but the shape recurs: a name that is exactly right inside the code can
be exactly wrong in the sentence a human reads, and the two do not have to
match._

### E43 revised, within the hour — the file is NAMED, not described

"The saved file" survived about an hour. Cole came back with the case it fails:
Save. _"I'm not saving version 2 to version 2 — I'm saving the changes in
version 2 to the source file."_ As a DESTINATION the phrase is circular ("save
to the saved file"), and "source file" would be a third noun for one thing.

**So there is no noun.** The file is called by its name — `note.md` — in the
compare picker, the Save tooltip, the merge announcements and the CLI's
refusals. Cole: _"that's probably closer to the right answer versus trying to
come up with a word that encapsulates like it's this file at this location."_
Long names truncate in the MIDDLE: the extension says what kind of thing it is,
and a long name's tail is often what distinguishes it. The full name is the
`title`.

**The Save BUTTON keeps its label — deferred, not decided against.** The tooltip
names the destination (`Save v5 to note.md — the file in your folder`) and the
header shows the filename two inches away, so "Save" alone is not lying. Cole:
_"If anything I'd probably change it to 'Save to Name-of-file' so it's really
obvious, but let's defer."_ The cost to weigh when it returns is a label whose
WIDTH changes with the document, in a header already holding six controls.

**Underneath all of it was a question about PLACE, not language:** _"where are
these other files on disk?"_ Versions are real, permanent files at
`$SCRIPTORIUM_HOME/sessions/<id>/docs/<slug>/vN.md` — deliberately nowhere near
the human's project folder, which is why a version never litters a repo and why
the agent can edit one with ordinary file tools. E44 makes that answerable in
one click.

_A question of the form "which word means X?" is sometimes evidence that no word
does, and the thing should be pointed at instead._

## E44 · Reveal on every version row — and `disabled` gives way to `aria-current`

**Asked by Cole, 2026-09-12**, as the practical answer to E43's real question:
_"where are these other files on disk?"_ No wording fixes a spatial question;
opening the folder does.

**A new message rather than a wider one.** `reveal` takes a PATH and refuses any
path the session does not already show, so pointing it at a version file would
have meant widening it to accept the session folder — and then the surface could
ask to reveal anything. `reveal.version` names the doc and the number; the
daemon resolves the file itself. The spawn is one shared helper, still an argv
and never a shell string.

**Offered on EVERY row, the active one included** — the version being edited is
the one people ask about most.

**⛔ AND THAT IS WHAT BROKE E39's `disabled`.** The active row was rendered
`disabled` to say "you cannot switch to where you are", with the dimming
overridden so it read as highlighted. Putting a control INSIDE that row exposed
the rest of the bargain: a disabled menu item makes its children inert too, so
Reveal was dead on exactly the row it mattered most on. Caught by driving it —
Playwright refused the click with "element is not enabled".

**`aria-current="true"` replaces it, and is the better answer anyway.** The row
means _you are here_, which is a state; `disabled` means _this act is
unavailable_, which is a prohibition. Selecting the row you are already in is
now simply nothing, and E39's tint and ring survive untouched — the highlight no
longer depends on fighting a disabled style.

_The general shape, twice in one day: E39 took a library's state name because it
matched the meaning and overrode the styling. That works until something needs
the behaviour the state also implies. A state that must be visually contradicted
is a hint it was the wrong state._

## E45 · Notes that survive an edit, or say they did not

**Built 2026-09-12**, chosen over chat for the reason E36 gave: chat needs
objects to carry, and a note is one. Cole ruled the anchoring in advance — _"I
don't have a strong lean… I'd probably just go with your lean, we test it out
and see if it works and adjust as needed"_ — and the storage: the manifest.

**Quoted-text anchoring, and the alternative is why.** An offset goes stale on
the next keystroke: fix a typo three lines up and every note below points at the
wrong words. Pinning a note to the VERSION it was made on would be exact forever
and useless, because the stated use is making notes WHILE reading and editing.
So a note remembers the TEXT it was made on plus a little of what surrounded it,
and is re-found on every snapshot.

**Four outcomes, each named**, so the surface can show a confident note
differently from a guessed one: `context` (quote WITH its surroundings, once —
this is what tells two identical sentences apart), `unique` (the quote alone,
once), `nearest` (the quote repeats and its context is gone; the closest
occurrence wins, and is labelled a guess), and **`orphaned`** — the quote is
gone, and the note is shown detached rather than pinned somewhere plausible.

**⛔ THE ORPHAN IS THE POINT, NOT THE EDGE CASE.** A note silently re-anchored
onto unrelated words is the failure this whole design exists to avoid;
visible-and-wrong beats invisible-and-wrong. It is also the reason the notes
LIST exists beside the highlights: an orphan has no line to sit next to, so a
margin-only design would make it vanish — the one outcome that must not happen.
_(Demonstrated by accident: a test method replaced the buffer instead of
inserting into it, the note went "text gone" with its quote struck through, and
Revert brought both back.)_

**The human notes a SELECTION; the agent notes a QUOTE.** The agent has no
offsets, and asking it to count characters would be asking it to be wrong. A
quote the active version does not contain is REFUSED rather than stored as an
instant orphan — that would read as "the text changed" when the truth is "you
quoted something else". Both paths store the same shape.

**Two things in one pane.** Notes share the right pane with the conversation
behind a tab rather than taking a fourth resizable pane, which would leave every
pane too narrow to read. Both answer "what is being said about this document",
so when chat lands it joins as the same kind of tab instead of needing somewhere
new to live.

**The composer shows the quote BEFORE the note is written** — writing a note
without seeing which passage it is about is how you get a note on the wrong
sentence.

Driven end to end: a note followed a 68-character shift at full confidence,
orphaned when its line was deleted, came back when the text did, and clicking it
in the list selects its passage in the editor.

## E46 · A note can be rewritten, and made without leaving the text

**Two gaps Cole found by using E45.**

**1. A note could not be edited.** Now `note.edit` on both unions and
`note-edit` on the CLI, with a pencil on each row in the panel.

**⛔ EDITING CHANGES WHAT A NOTE SAYS, NEVER WHAT IT IS ABOUT.** The quote and
its context are untouched: a note you rewrote is still about the passage you
made it on. Re-quoting on edit would silently move the note to wherever the
caret happened to be — which is the same class of failure as a re-anchor onto
unrelated words, arriving by a different door. `editedAt` is recorded and shown,
because a note that changed after someone read it should say so.

**2. Making a note meant leaving the text.** Cole: _"this is a little quicker,
because the user does not need to switch to notes in the panel to add a note,
only to read or edit a note."_ That is the right split — making a note happens
mid-read, dozens of times; reading them back happens once — so the FAST path
went to where the eyes already are and the panel kept the slow one.

Right-click over a selection opens a small menu at the click, and "Add note"
swaps it for a composer in the same place. **Only over a SELECTION:** with
nothing selected there is nothing to note, so the browser's own menu (spelling,
copy, look up) is left alone rather than replaced with something useless.

**⛔ THE PASSAGE IS PAINTED, NOT SELECTED, WHILE THE COMPOSER IS OPEN.** The
browser's selection dims or vanishes the moment focus moves to a textarea, and
the one thing that must stay visible is WHICH passage is being written about. A
decoration makes it independent of focus — and it is deliberately rubric where a
real note is attention-amber, so a passage being noted never reads as a note
already made. The dismissal listens on `mousedown` rather than `click`, because
the editor would otherwise move the caret first and drop the selection.

**The menu is two steps rather than one on purpose:** it is where the other acts
on a passage will go — ask the agent about this, copy the quote — so it does not
collapse into the composer just because there is one item today.

## E47 · The document points at a note, as well as the other way round

**Asked by Cole, 2026-09-12.** E45 gave the panel a way to point INTO the text
(click a note, its passage is selected). This is the return trip: right-click a
passage that is already noted and the menu offers the note itself; choosing it
opens the Notes panel and borders that note.

**The right-click menu now opens over a SELECTION or over a NOTE** — with
neither there is still nothing of ours to offer, so the browser's own menu is
left alone. The two cases compose: a selection that overlaps a note shows both
the note and "Add note".

**Existing notes are listed FIRST, and labelled with what they SAY.** Right-
clicking a passage that is already noted is far more often "what did I say about
this?" than "let me say something else", so the reading act leads; and a menu
entry reading _"Still true — merge writes the version…"_ answers the question
without the panel being opened at all.

**A border, not a scroll-and-select.** The pointed-at note gets the `selected`
token's border and tint (E40's colour, doing exactly the job it was introduced
for) and is scrolled into view. Nothing about the note changes — pointing at
something must not edit it.

**Two cases that would otherwise point at nothing:**

- **The panel may be showing the CONVERSATION.** Choosing a note switches the
  pane; a border nobody can see is not an answer.
- **The note may be RESOLVED while resolved notes are hidden.** A focused note
  is shown regardless of that filter, or the menu would scroll to an empty list
  and read as broken.

**Fixed the same day:** clicking a note's quote in the panel showed its passage
but did not move the border, so the panel pointed at one note while the editor
showed another. **Whatever was last asked for is the one marked** — there is
only ever one focused note, whichever door it was reached through.

**And the menu grew a delete** (Cole). Immediate, like the panel's — one delete
that confirms while its twin does not is worse than either rule applied
consistently, and the note's own words are in the row being clicked, which is
the check that matters. Unlike the panel's, it is ALWAYS VISIBLE rather than
revealed on hover: a panel row is a thing being READ and its actions stay out of
the way until wanted; a menu is a list of ACTS, and an act hidden until hover is
one most people never find. _(Built hover-gated first, and the screenshot showed
an empty-looking menu — which was the argument.)_

## E48 · The human can finally speak — and the selection goes with them

**Built 2026-09-12, last of the big slices, in the order Cole set:** _"chat can
be like the last thing… if we can create a really good standard editing
experience for a human user, that will naturally lead into adding the chat."_ It
did: the agent already had versions, diffs, merges, frontmatter, links,
structure and notes as verbs, so chat arrived at a surface where there is
something to point AT.

**Almost none of this was new wire.** `select` and `say` have been on
`ClientMsg` since E1, `say` has always carried `withSelection`, the agent's
`tail` has always delivered the selection and the active path, and the
integration cells have covered it since the foundation. For eight slices
**nothing in the surface ever sent one.** The slice is a composer and the effect
that tells the daemon what is selected.

**⛔ THE DAEMON HOLDS THE SELECTION, NOT THE MESSAGE.** `say` attaches whatever
the DAEMON last heard, so the surface must report a selection as it changes —
and only when the RANGE changes, because a caret drifting through a document is
not news.

**What is sent is a POINTER, not a copy:** doc, version, line range, the
original's path, and the active version's path. The agent reads the file rather
than trusting a quotation that was true a moment ago. The quoted text travels
too, but as what the HUMAN SAW, not as the source of truth.

**Lines, not offsets.** A line range is what a human and an agent can both talk
about; a character offset is neither's language. (Notes keep offsets, because
they are painted rather than discussed.)

**The chip is shown BEFORE sending, and can be dropped** — dropping is
per-message, because carrying the passage is the common case and remembering a
refusal would silently stop doing the useful thing.

**And the log shows what was sent.** A message that carried a passage displays
it, quoted, with its source — otherwise the human reads "can you answer this
one?" a week later with no idea what "this" was, while the agent had it all
along.

Driven end to end against a real `tail`: selection → message → the agent's tail
carrying doc, version, lines, quote and both paths → `say` back → both turns in
the conversation.

## E49 · A link target with a space in it is percent-encoded, and we never decoded it

**Found in USE, 2026-09-13** — the first real task driven through the chat
slice. Cole asked for links between his Hollowbrook world-bible documents; a
subagent added ten, every one resolving on disk; and the map drew **six dangling
edges and no inbound links at all** into three of the five documents.

**The documents were right. The resolver was wrong.** A markdown link to a file
whose name has a space carries it percent-encoded — `Maren's%20Bakery.md` — and
`splitTarget` handed that on literally, so the lookup never matched the real
file. `Maren.md` resolved (no space in the name) and everything else silently
did not.

**This would have hit every Operator folder Cole has**, because his filenames
are prose — _Maren's Bakery.md_, _Hollowbrook — Overview.md_, _Visual Style.md_.
It never appeared in the corpus E33 was built against (`agent-cli-conformance`),
whose filenames are all kebab-case, and no fixture had a space in it either.

**⛔ THE DECODE MUST NOT THROW.** `decodeURIComponent` rejects a lone `%`, and
`100% done.md` is an ordinary filename. An undecodable target is returned
unchanged — worst case it fails to resolve, which is the behaviour before
decoding existed, rather than taking the whole graph down.

**Pinned with cells** covering the space, the em dash, a query after the
encoding, an anchor after it, and the undecodable case. `dangling` on Cole's set
went 6 → 0; `Visual Style.md` went from `in:0 out:0` to `in:2`.

_The finding is the method, not the bug: two corpora had been driven through
this code and neither had a space in a filename. The class of input that breaks
you is the one your fixtures share an assumption about — and the way to meet it
is to run the real thing, for a real reason, on somebody's actual documents._

## E50 · The work queue — a message that can be marked done

**Designed by Cole, 2026-09-13**, from using the chat slice: _"I could see part
of the workflow is you maintain your role as basically just being there to
listen to me… but when there's task work, just sub-task that to an agent."_ Then
the shape: _"they could be both — a message that can be marked done seems really
useful, but that could also feed into things like a toast… a list of tasks in
the queue that have not been marked done, and maybe some sort of spinner… all of
those affordances could be built around something really simple for an agent to
update."_

**⛔ THE PRIMITIVE IS TINY AND EVERYTHING IS BUILT ON IT.** A task is a chat
message with a `doneAt` or without one. The count, the tab spinner, the
outstanding list, the completion toast — none of them ask the agent for anything
beyond `task` and `task-done`. An agent that manages only those two verbs drives
all of it correctly, which is the property Cole was after and the reason not to
model a richer lifecycle.

**Announced and recorded in one act.** `startTask` posts the chat message AND
creates the task, linked by `messageId`: the conversation reads as a narrative,
the queue reads as state, over one fact rather than two.

**`status` is the optional richness** for long multi-step work — "reading the
three entries" — and Cole flagged it as maybe-not-MVP. It cost one field and one
verb, and the alternative was a schema change later.

**Finishing is IDEMPOTENT.** A task finished twice — an agent retrying, a human
clicking as the agent reports — is not an error, and refusing would make the
surface handle a race it did not cause.

**The human can always close a task.** An agent that dies mid-task would
otherwise leave the queue spinning forever, and a queue you cannot clear stops
being information.

**Two verbs beyond the brief, both because the queue is a RECORD:**
`task-remove` forgets one started by mistake — marking it done would put
something that never happened into the account — and `tasks-clear` (Cole, the
same day) forgets every FINISHED task while leaving outstanding work alone.

**The toast watches the QUEUE, not the act** — the same shape as E42's. The
human marks almost none of these done; an agent does, in another process, while
they are reading something else. A toast wired to a button would announce only
the ones they did themselves, which is exactly backwards.

_Process note, recorded because it was my error: this was tested in Cole's LIVE
session, which left three invented tasks in his real queue. `task-remove` exists
partly because I needed it to clean up after myself — a good verb found for a
bad reason. The scratch session was right there._

## E51 — a selection in the rendered view means what it means in the raw one

Cole, reading: _"if possible one thing that would be nice is when in markdown
render mode I can still select text and use that as context in a message, and
also still annotate text if possible."_

**The obstacle is that the two views do not share a coordinate system.** A
selection in the raw view is CodeMirror's, in SOURCE offsets, and everything
downstream is built on that — the chat's line numbers, a note's anchor. A
selection in the rendered view is a run of rendered text: `**Maren's Bakery**`
reaches the human as `Maren's Bakery`.

**Searching the source for what was selected was rejected, on evidence.** It
holds for plain prose and fails on exactly the documents this spell is for —
Hollowbrook's relationship rows are bold-inside-a-link on every line, so the
selected string does not occur in the source at all. There is a cell that
asserts that absence, so the reason survives the reasoning.

**micromark's own token stream would have been ideal and is not reachable:** its
`exports` map exposes `.` and `./stream` only, so the offsets its tokenizer
carries cannot be had from outside. Measured, not assumed.

**So the projection is built by `mdast-util-from-markdown`** — two new
dependencies, which Cole accepted on the argument that they wrap THE SAME
micromark the renderer uses, so the projection cannot disagree with what is on
screen about what is text and what is markup. The alternative was a hand-rolled
inline stripper with no dependency, refused as a second partial markdown reader
with nothing holding it level with the first — the lockstep-mirror drift
`diff.ts` names in its own header.

**It lives in the SURFACE, and the wire did not change at all.** The daemon has
no use for it: the agent's `note --quote` resolves against the source and always
did. `dist/server.js` and `dist/cli.js` are byte-identical across this slice,
which is the check that the claim is true. Putting it beside the renderer also
means the right-click menu resolves a passage in the frame the human clicked,
rather than after a round trip.

**Alignment is a PROGRESSIVE SEARCH, not an assumed concatenation.** micromark
writes a newline between block tags, so the DOM offers a `"\n"` text node where
the projection wrote `"\n\n"`; treating the container's text as the projection
puts every offset after the first block off by one and drifting. Matching each
run forwards from a cursor cannot drift, and a run that will not place gets
`null` rather than a guess.

**⛔ A RIGHT-CLICK DESTROYS THE THING IT IS ASKING ABOUT.** Found in the
browser: select a passage, right-click it, and the menu opens with nothing to
act on, because pressing a button collapses the DOM selection. The raw view
never had this problem — CodeMirror's selection is a MODEL, which a click cannot
touch. So the rendered view remembers the last range it resolved and trusts it
only when the pointer is inside it; a right-click elsewhere must not silently
offer a note on the previous passage. This is the whole reason "select, then
right-click" works here.

**And the passage stays visibly marked while the composer is open**, painted in
the rubric as the editor's `cm-note-pending` is — because the click that opened
the composer took the selection with it, and Cole asked for the text to stay
selected (E46). Without a mark of our own the human writes a note about text
that no longer looks chosen.

**Highlights are PAINTED, not wrapped** — the CSS Custom Highlight API, so
nothing is inserted into the rendered HTML. Wrapping a note's passage in a
`<mark>` would mean this component editing the renderer's output, and that
output is the spell's one HTML sink. Where the API is absent the notes simply
are not highlighted and everything else still works.

**A selection crossing markup carries the markup between its endpoints.** From
the rendered view, `Maren's Bakery … an extension` arrives as
`Maren's Bakery**](Maren's%20Bakery.md) (Locations) — her place, and an extension`.
The ENDPOINTS are exact; the span between them is the source that is really
there. The agent gets something it can locate in the file, and the chip shows
markup — flagged to Cole rather than decided quietly, since the alternative
(sending the rendered text) would hand the agent a string the file does not
contain.

### E51 addendum — the pane was destroying its own selection

Cole, from the app: a selection ran from the START of the content to the cursor;
it flickered while dragging; it died on release unless it ended at a paragraph
boundary. **One cause for all three**, and not in the projection:
`dangerouslySetInnerHTML={{ __html: html }}` allocates a new OBJECT per render,
and React 19 compares the prop object rather than the `__html` string — so every
commit re-ran `setInnerHTML` and replaced the whole subtree, identical markup or
not. Reporting a selection re-renders, the re-render rebuilt every text node,
and the browser re-anchored the homeless selection to its container's start.

**Latent long before this slice, and harmless until the pane held DOM state
worth keeping.** Adding selection is what promoted it to a bug.

**Three theories were wrong before the measurement** — focus theft by the chat
composer, the Custom Highlight API, stale `Range` objects. What settled it was a
MutationObserver (10 childList records for one drag, each replacing all ten
children) and a patched `innerHTML` setter that named React's own `commitUpdate`
as the writer. The lesson is the cheap one: instrument the DOM before theorising
about React.

_And a harness lesson worth keeping: my synthetic drags were unreliable in a way
that looked like app bugs. Some coordinate pairs never began a selection at all
with no JS involved, and a press inside an existing selection makes Chrome start
a drag-and-drop instead. I briefly believed cross-paragraph selection was broken
on that evidence; it was not. The trustworthy instrument turned out to be a
programmatic selection plus a forced re-render — which is also the crisp
regression check, since before the fix one render destroyed it and after it
three do not._

**`sinks.test.ts` went blind and said so.** It scanned only the inline
`{{ __html: x }}` shape, so hoisting the prop left it matching nothing — caught
by its own zero-guard. It now scans both shapes, enumerates every `__html`
writer in the surface separately, strips comments first (it had counted a
`__html: html` inside a comment in the ward itself), and declares `htmlProp` so
that reverting to the inline literal turns it red.

## E53 — the human is waiting, and the agent gets told once

Cole, through the app: _"after I send a message there is like a thinking sort of
animation until you reply, just provides a little reassurance that something is
happening"_ — stolen from mind-mapper and glamour, as he asked.

**Derived, never declared. His ruling, and the reasoning is the good part:**
_"we're not adding more tasks for the agent to have to explicitly do."_ An agent
that must remember to announce "thinking" will forget exactly when it matters —
it is busy, which is the situation being signalled. So the state is read off the
conversation: a human message with no agent message after it is a human waiting.

**mind-mapper's rule taken whole: the reply IS the completion signal.** No
`done` to emit, so no `done` to get out of sync. It also fell out that
`startTask` posts as the AGENT (E50), so the happy path Cole described — "I'll
get that started", then a task, then a subagent — clears this by construction,
with no acknowledgement of its own. Verified live: starting a task cleared the
wait.

**⚠ A SYSTEM LINE IS NOT A REPLY.** `announce()` narrates agent acts ("Agent
noted … on maren"), which is evidence of life but not a check-in with the person
waiting. Counting it would silence the signal in precisely the case this exists
for — an agent busy doing things that has not said a word. There is a cell.

**Stalled does not pulse.** 30 s (Cole's number) flips the badge to "took this
in, then went quiet — may be stuck", static and in the attention colour. An
animation is a claim that work is happening; running it over a wedged agent is
false liveness, which is the one thing this must not do. mind-mapper separates
them for the same reason.

**The clock runs from the FIRST unanswered message, not the latest.** Someone
who sends three messages while waiting has been waiting since the first —
resetting on every follow-up would mean the more anxious they get, the shorter
we claim their wait has been.

**⛔ ONE NUDGE PER MESSAGE, which is the whole anti-nag rule.** Cole: _"we don't
want to have a situation where an agent keeps getting pinged about something and
it's like, no, I'm actually working."_ At 30 s the daemon emits one
`{type:"waiting"}` on the AGENT'S TAIL — never in the chat, because the human
already sees the badge and telling them what they are looking at is noise. It
carries the pending message's TEXT (an agent returning needs to know what is
owed, not merely that something is) and names the two ways out. A message id
enters `nudged` when reported or when snoozed, and never leaves.

**`working` is the snooze, and carries nothing else.** An agent with something
to tell the human has `say` (a reply, which clears the wait) and `task-status`
(progress on declared work). A third channel for "here is what I am doing" would
be a third place to look, and two of them would go stale. A `note` field was
built and then removed for that reason.

**A snooze expiring changes what the HUMAN sees, not what the agent receives.**
The badge returns to stalled, because they are owed the truth eventually; the
agent is not pinged again, because it already answered the alarm. Measured end
to end: pulse → stalled at 31 s → one nudge → snoozed back to a pulse → stalled
again on expiry → still exactly one nudge.

**Where it is computed:** the daemon, in `PublicState.waiting`, on a 1 s tick
that broadcasts only when the badge CHANGES. The daemon needs the value anyway
to decide when to nudge, and two implementations of "is anyone waiting" would
eventually disagree about whether to draw a pulse and whether to send a ping.
`Waiting` itself lives in `protocol.ts` because it rides in state and that file
is import-free on purpose.

### Deployment note, not yet actionable

Cole's framing of the division of labour, to go into the spell's SKILL.md **when
there is one** (scriptorium is still declared WIP in the roster ward): the main
agent should work as an **orchestrator** — attentive to the human, creating
tasks, delegating the actual work to subagents — rather than doing the work
itself. His reason: _"you're essentially overloading an agent with multiple
responsibilities, both doing the work, attending to the user, maintaining
awareness of what's going on in the interface."_ E53's nudge is explicitly the
**error case** for when that discipline slips, not a substitute for it.

### E53 addendum — what the nudge actually measures

It fired for real on Cole's own session within minutes of landing, reporting a
26,857-second wait. Nothing had been forgotten: he was asking through the app
and being answered in the terminal, so the app was watching one side of a
conversation happening somewhere else.

**So the honest description of the signal is "unanswered IN THIS CHANNEL", not
"the agent forgot".** Those coincide in an ordinary session and came apart here
because this period of work is mixed — Cole switching between "change this
document" and "change the spell" — which is a property of building the thing
while using it, not a state worth engineering around. Ruled: leave it. Cole:
_"if both of us forget and we're chatting in a terminal or there's some mix, at
some point you'll get a reminder from the app and you can respond… it just shows
that it's working even if it's not actually needed."_

Two things it did prove, which the scratch sessions could not:

- **The restore nudge earns its keep.** A fresh agent joining a restored session
  had no idea three questions were owed; the tail told it. That behaviour was
  argued for on paper (in-memory, not persisted, so a restored wait re-reports)
  and this is the first time it mattered.
- **The clock-from-the-first-unanswered-message rule was right.** It named the
  ORIGINAL question rather than the most recent, which is the one that had been
  waiting longest — exactly what the rule exists for.

## E54–E56 — the four queued gaps, and one I had misdescribed

Cole: _"tackle those in the order you see fit."_

### E54 · a dangling-link report you can act on

**`graph` already had the facts and still did not answer the question.** Cole
asked whether an agent can check dangling links; the honest answer was "yes, by
fetching a set's whole map and filtering several hundred edges", which is a
different thing. The new `dangling` verb says only what is broken.

**What the map was throwing away is the part that matters.** An edge's `to` is
the RESOLVED target, so a report built from it says `deep.md` when the document
says `./missing/deep.md?rel=x` — a string that is not in the file. `LinkRef` and
`Edge` now carry `raw` (as written) and `line`, because the point of a report is
repair.

**⛔ BODY LINES ARE NOT FILE LINES.** Links are extracted from the body, so
every number was short by the frontmatter — a report saying "line 9" pointing
into the frontmatter of a document whose link is on line 15. Caught by reading
the first real report rather than by thinking about it; fixed with
`bodyLineOffset`, which has its own cells because the arithmetic is the whole
value.

**⚠ A fenced block shifts nothing**, and there is a cell for it: `withoutFences`
BLANKS fenced lines rather than removing them, so the line count survives. That
was luck, not design, and the cell makes it a property.

**Not an error.** A dangling link is a fact about a set (OKF §11), so the verb
reports and exits zero. A world bible pointing at things not written yet is
normal.

### E55 · a tail that says when it has lost the daemon

Cole's timeout question exposed it: a graceful close emits `closed` and ends the
tail, but a **crash, a `kill -9` or a sleeping laptop emits nothing** — the
client retries in silence and the absence of events is not an event. A watcher
waiting for the human's next message would wait forever and never learn it had
stopped listening.

**One line per EPISODE, not per attempt.** The reconnect loop runs with backoff
forever; a hook that spoke each time would emit a line every few seconds for as
long as the daemon stayed down, which is how a watcher gets muted and then
nobody hears the next real thing. **A keepalive clears the flag** — there is no
`onConnect` hook and this is the honest substitute, since the daemon only sends
comments down a live stream.

Measured: `kill -9` produced exactly one `tail.disconnected`
(`cause: "stream-error"`), still one after 40 s down, then one
`tail.reconnected` when the daemon came back.

### E56 · a dead session says how to come back

`"no running scriptorium session"` reads like the work is gone. It never is: the
manifest and every version file are on disk, so an exited daemon costs the URL
and nothing else. The hint now names **the command with the id already in it**,
and lists the restorable sessions as `choices`.

**`--timeout 0` already worked** — the flag forwards and `timeoutMs <= 0` means
never. So the gap was discoverability, not capability: the `open` verb now says
so, and the `ready` event carries `idle_timeout_s` so a standing session can be
confirmed from outside rather than discovered by losing one.

### The one I had misdescribed

I told Cole "compare against the file on disk" was missing. **It was not:**
`DiffSide` includes `"original"`, which reads the file of record, and it is the
default side. What was missing was any ROUTE to it from the warning about it —
so the conflict banner now offers **See the difference** first, before the two
buttons that each discard something. The banner also stopped claiming "while you
have unsaved edits" unconditionally: Cole's case was a reopened session where
the file had moved on and the active version had no edits at all, and asserting
edits someone has not made is how a warning loses its credibility.

### A mirror that was not guarded, and then was

`GraphPayload` hand-duplicates `links.ts`'s `Edge` and `GraphNode` because
`protocol.ts` is import-free on purpose. Adding `raw`/`line` to the computing
side alone drifted them, and the **type-check ward caught it** — which is the
ward working, but the duplication had no guard of its own. It has one now, and
the first version of that guard was WRONG in an instructive way: two-way
assignability is blind to an OPTIONAL field added to one side, measured by
planting exactly E54's drift and watching zero errors. The guard compares KEY
SETS (plus assignability, for a field whose type drifts while its name stays),
and was verified red against the planted drift and clean without it.

_Process note: while testing E55 I picked a daemon to kill with `head -1` over a
grep that matched every spell's server, and killed a process that was not mine —
most likely one of the mind-mapper daemons. Cole's scriptorium session and my
own scratch daemon were both still alive afterwards, so the victim was something
else of his. The fix is method, not care: resolve the daemon by the SESSION's
own port and confirm the process is the one you mean before signalling it, which
is what the re-run did._

## E57 — a note consumes the selection

Cole, from the app, having found it by using it: select a passage, right-click,
add a note — and the selection is still attached to the composer, so the next
message silently carries the same text. His words for the fix, and the reasoning
is the whole ruling: _"if you add a note, we should automatically treat that as
if you basically deselected the text because the note is the actual action
you're taking. You don't want to then also start typing in chat and realize
you're also sending basically the same context that you've already captured as
part of the note."_

**The passage was SPENT.** Attaching a selection to the composer is an offer —
"talk about this" — and making a note is one of the things you can do with it
instead. The bug was treating the attachment as ambient when it is really a
pending act that another act had already answered.

**Cleared in the surface, not the daemon**, and that direction matters: the chip
reads App's local `selection`, so clearing it there is what the human sees, and
the existing effect reports the change onward so the daemon's copy — the one
`say` attaches — agrees. Clearing daemon-side would have left the chip lying.

Verified as the exact scenario he described: chip shows
`prose.md · v1 · line 6 starter`, note added, chip gone, daemon
`selection: null`, and "I've made some notes, take a look at them." arrives
carrying nothing.

## E58 — search inside the document

Cole asked whether it existed. **It did not:** `@codemirror/search` was not
installed and nothing wired it, so ⌘F did nothing.

**⛔ AND THE BROWSER'S FIND IS NOT A SUBSTITUTE.** CodeMirror 6 renders only the
viewport, so `⌘F` at the browser level silently misses every line scrolled out
of view — which is worse than having no search, because it answers confidently
and wrongly. That is the reason this is a dependency rather than a shrug.

**Not gated on `editable`, because finding is reading.** The panel is
`top: true` so it does not sit over the status strip.

**The panel is STYLED, not accepted as shipped.** `@codemirror/search` inherits
the browser's default form controls, which in a themed surface reads as a piece
of another application bolted above the document. The rules use the spell's own
tokens so both themes follow — the same reason `.md-prose` is written by hand.

### Open for Cole's ruling: does search-navigation attach?

Stepping through matches sets the editor's selection, so it reports as one: the
daemon holds `text: "bridge"` after two presses of Enter, and the next message
would carry it. **Measured, not theorised.** This is E57's principle pointing
two ways at once — search is sometimes navigation ("just show me the line") and
sometimes exactly how you find the passage you want to talk about. The
suppression is a two-line change if wanted
(`update.transactions.some((t) => t.isUserEvent("select.search"))`), so the
decision is worth more than the code. Not decided unilaterally.

## E59 — search across the context

Cole: a search bar in the header, centered; type and get a list of files where
there's a match, click one and it opens. He raised **Fuse** as a library he has
used and asked for an idiomatic answer.

**⛔ TWO MATCHERS, BECAUSE THERE ARE TWO QUESTIONS.** Fuzzy on NAMES is for
jumping ("mabak" → Maren's Bakery); exact on CONTENT is for finding ("where did
I say 'asking-nicely'"). Note apps split these and it is not an accident. Fuzzy
full-text would be the worst of both: `bridge` would surface documents that
merely contain similar-looking letters, and "this phrase is on line 29" would
stop being trustworthy — which is the only thing a content search is for. Shown
as two groups, so the answer never pretends to be one ranking.

**Hand-rolled scorer, no dependency** (Cole's call, offered against Fuse): there
is no second engine this has to agree with, so fuzzy ranking is a self-contained
taste judgment with no drift risk. **Its cells assert ORDERINGS, never numbers**
— "contiguous beats scattered", "a word start beats mid-word", "shorter wins a
tie" — so the weights stay retunable without rewriting the suite, which is the
only way a scorer like this stays changeable.

**⛔ THE SWAP SEAM IS CORPUS-SHAPED, AND THAT IS THE DESIGN.** Cole asked for
the hand-rolled code to be easy to replace with Fuse. The obvious seam — a
per-item `score(name, query)` hook — looks smaller and would have FOUGHT the
library it exists to admit: Fuse indexes a list and searches it, it does not
score one string at a time. `NameSearch(candidates, query, limit) → ranked` fits
both, so a move to Fuse is one adapter and one default changed, with nothing in
the module, the session, the wire or the surface moving. There is a cell that
proves it with a stand-in matcher.

### Why the agent gets a verb at all — Cole's question, answered

He asked whether an agent needs this or can just grep. **It can grep files; it
cannot grep what the human is looking at.** A document open in the session is
shown as its ACTIVE VERSION, which lives under the session home and not at the
original path — so grep over the workspace finds the SAVED file and silently
misses the text being read. Demonstrated rather than argued: a phrase written
only into `v2` was invisible to `grep -rn` over the folder and found by `search`
at `maren.md v2` line 18.

So: **one cross-document verb, and no in-document verb.** For a single document
an agent can read it or grep it, and a verb there would be the layer that adds
nothing — which is the judgment he asked me to make.

**The surface drops stale answers.** Replies are asynchronous and the human
keeps typing, so the report carries its `query` and anything not matching the
box is discarded: results for a question already moved past are worse than an
empty pane.

**And the jump waits for the document.** A result is clicked while another
document is open, so revealing immediately would scroll the WRONG document to an
offset that means nothing in it. The request is keyed on a sequence and on the
open document actually being the one asked for.

Driven in a browser, in both themes: ⌘K focuses, "zephyr-clause" finds the
active-version-only line, clicking it opens `maren.md` and selects the phrase,
and "mar" shows both groups at once.

## E60 — the context has its own undo

Cole: _"undo redo in terms of the context sidebar — moving things around,
adding… those left and right arrows at the top of the context header… as you're
moving things around, those buttons light up… letting the user know that there's
an undo for this sidebar that isn't the same as undo redo when you're in the
editor."_

**⛔ PLACEMENT IS THE EXPLANATION.** ⌘Z inside the text belongs to CodeMirror
and always will; these arrows step through acts on the SHAPE of the context.
Putting them in the context header is the only honest way to say which undo is
which, and the keyboard follows the same rule — ⌘Z is the context's only while
focus is INSIDE that pane, scoped by letting the event bubble to the panel
rather than by a window listener that would have to guess what the human meant.

**⛔ UNDOING A CREATION DELETES, BEHIND A CONFIRMATION — and this reversed my
own design.** I first built a hard block (undo never deletes) and Cole pushed
back: blocking does not refuse one step, **it strands everything behind it**.
Create a folder, do two moves, undo the moves, and you meet a wall you can never
pass, at which point the history has stopped being a history. He was right, and
the second argument is what settled it: the thing undo would remove is one the
session made moments ago, usually empty — categorically different from deleting
work — and the app already had the pattern in the version-delete dialog.

**⛔ WITH ONE LIMIT NO DIALOG CAN AUTHORISE: a non-empty folder is refused.**
Undo runs backwards, so it empties a folder before it reaches that folder's
creation; if contents remain, something put them there the history does not know
about, and removing a directory TREE is a different act. Driven: a stray file
written into a created folder produced _"undodocs/keep is not empty (1 item) —
move what is inside it out first"_, the folder and the file survived, and **the
act stayed on the undo stack** — nothing happened, so nothing was forgotten.
`rmdirSync` rather than a recursive remove, so ENOTEMPTY is a second net under
the explicit check.

**⛔ A CONFIRMED DELETE HAS NO REDO, and says so by planning `null`.** Once a
created file is gone its contents are gone; a redo that "re-creates" it would
hand back an empty file wearing the same name, which is the kind of lie an undo
stack must not tell. Verified: after confirming, both arrows are grey.

**⛔ THE KEYBOARD IS NOT OFFERED THE DELETION.** There is no dialog in a
keystroke, and a reflex that removes a file is the one thing this must not grow
into. Measured: ⌘Z at a deleting step does nothing and opens no dialog, so the
arrow that can ask is the only way through.

**⚠ THE INVERSE IS BUILT WHEN THE ACT HAPPENS**, from what was true then — not
reconstructed later. A `move` records where the thing came from because only the
mover knows; a `hide` records the entry's WHOLE hidden list, because reading it
afterwards returns the list including what was just hidden, which restores
nothing. A no-op (unhiding an entry with nothing hidden) is not recorded at all:
an arrow that steps over acts which changed nothing lies about how far back it
can go.

**⚠ IN MEMORY, NOT IN THE MANIFEST.** An inverse describes the world as it is
now, and a session restored tomorrow may meet files somebody has since moved by
hand. Grey arrows after a restore are honest about what can still be put back.

Driven end to end: a rename recorded and undone on DISK (the file came back as
`a.md`), redo offered with an accurate label, a created folder deleted through
the dialog, the non-empty refusal, and ⌘Z inside the pane stepping the context's
history while refusing the deleting step.

### E60 addendum — the delete forgot to forget

Cole, within a minute of E60 landing: _"if I delete a file via undo and then
confirming, it's not being removed from the sidebar… then I created another
document also untitled and I think there might have been even a weird naming
issue."_

**Both halves were one bug, one level apart.** `removeCreated` called `rescan`
on every context entry — and **`rescan` returns early for any entry whose
membership is not `mirrored`**. A single document is a `listed` entry, so
nothing pruned it: the file left the disk and the node stayed in the sidebar.
One level down, the `DocRecord` outlived the file too, so its SLUG stayed taken
and the next `Untitled.md` became `untitled-2` while the file on disk was plain
`Untitled.md` — which is the "weird naming issue" he half-noticed.

**Evidence from his own session, not inference:**
`c-aeb0b9 listed → …/Spellbook/Untitled.md` and
`untitled-2 → …/Spellbook/Untitled.md`, both pointing at a path that no longer
existed.

Fixed with `forgetPath`, which prunes by hand what `rescan` will not look at,
drops an entry the pruning empties, and forgets records for a path that is gone.
**Two cells verified RED against the old code and green with the fix** — one for
the sidebar, one for the freed slug.

**⛔ AND DELIBERATELY NOT SELF-HEALED ON RESTORE.** The tempting generalisation
— prune anything missing when a session loads — would conflate two different
situations. A file that vanished BETWEEN sessions is already handled as a
finding ("X is gone from disk since this session was last open. Save would
recreate it"), and forgetting its record would throw away versions the human can
still save back. Residue from a deletion WE performed is a different thing, and
only that is forgotten, at the moment it happens.

**⚠ The version files under the session home are left where they are.** The
record is gone so nothing reads them, and removing them would be a second
deletion the human was never asked about — the dialog promised the created file,
not the session's own copies.

## E61 — `forget`, the answer the warning never had

Cole, after the E60 residue: _"should we have an explicit way to do that? Is
this a one-off because we had a bug, or is there actually a reason an agent
might need to do this?"_

**It was both, and the second half is the interesting one.** The stale record in
his session came from the E60 bug, which is fixed. But the same state arrives
from an ordinary act with no bug anywhere near it: **delete a document in
Finder, or `git checkout` it away, or rename it outside the app.** The record
survives, and restore says — correctly — _"gone from disk since this session was
last open. Save would recreate it."_ That notice is RIGHT: the session is still
holding the content and offering it back.

**What was missing was any way to answer it.** When the human's reply is "no, I
meant to delete that", there was no verb: the warning repeated on every restore
forever and the only escape was recreating the session. **A warning with no
corresponding act** is the shape this spell keeps trying not to have — the same
defect as the conflict banner with no route to the comparison (E54) and the
removal notice that claimed a file was still on disk.

So: **`forget <doc>`**, and deliberately narrow.

**⛔ REFUSED WHILE THE FILE EXISTS, and the refusal names the right verb.**
Forgetting a live document's record would discard its version history while the
document sits there on disk. Taking something out of the sidebar is `hide`; this
is only for a record whose subject is gone.

**⚠ It says what it is letting go** — "1 version in this session is no longer
reachable" — because the versions are content the session was holding and the
human should know the number before it stops being reachable.

**⚠ The version files are LEFT where they are**, as with undo's delete: nothing
reads them once the record is gone, and removing them would be a second deletion
nobody asked for.

**And the cleanup went through the verb rather than by hand.** Cole had already
approved removing his stale record; doing it by editing `manifest.json` would
have left the gap unfixed and the precedent bad. The first use of `forget` was
the case that motivated it — his session went from 37+1 records to 37, with no
paths pointing at missing files.

**No human-side affordance yet, and that is honest rather than lazy:** a
forgotten document is by definition not in the sidebar, so there is nowhere
natural to put a button. The conversation is the primary capability here (the
house's conversation-primary rule), and asking is the path until a
documents-this-session-knows-about view exists to hang it from.

## E62 — `doctor`, and a ghost that had nothing to do with the bug

Cole: _"is there any sort of app startup check that would inform an agent, hey,
there's some documents that maybe need to be forgotten… kind of like a doctor
command, but it would also just run at startup."_

**A startup check already existed, and asking about it found a real defect.**
Restore compares every document's file of record and announces what it finds —
that is the "gone from disk / changed on disk" line. But it covers document
RECORDS only, speaks in prose an agent must parse, and fires ONCE, so an agent
that joins later never sees it.

**⚠ WHAT IT NEVER COVERED, MEASURED:** a single document added to the context
and then deleted in Finder survives a restart as a GHOST in the sidebar.
Mirrored folders self-heal because restore rescans them; **`rescan` returns
early for a `listed` entry**, so a single-document entry is never rescanned at
all. Same root cause as E60's sidebar bug, a different way in — and this one is
reachable today with no bug involved, just Finder. Driven before writing a line
of E62.

**⛔ REPORTS, NEVER REPAIRS** (Cole: _"report, name the verb, let you decide"_).
Silently pruning a ghost would throw away the fact that the human asked for that
file to be in their context — and if it returns from a `git checkout` they would
have to notice its absence and add it again. Forgetting a record would discard
versions the session is still holding for them.

**⛔ EVERY FINDING CARRIES ITS VERB, with the argument already in it.** A report
that says "3 problems" and leaves you to work out what to type is the shape this
spell keeps failing at and fixing: the conflict banner with no route to the
comparison (E54), the "gone from disk" notice with no way to answer it (E61).
**A finding without a fix is half a finding.**

**Three checks, all evidenced rather than imagined** — a record whose original
is gone (→ `forget`), a context entry pointing at nothing (→ `hide`), links a
set cannot answer (→ `dangling`). Nothing is checked because it sounded
plausible.

**⚠ A record and an entry for the same missing path are TWO findings**, with two
verbs: merging them would leave whichever one the human did not do.

**⛔ ONE LINE AT STARTUP, AND SILENCE WHEN CLEAN.** A check that announces
itself when everything is fine is a line people learn to skip, and then it is
not a check. The summary counts by kind and points at the verb; the whole report
also goes on the agent's tail, so an agent arriving later neither has to ask nor
has to parse the sentence.

_Small thing caught in its own cells: appending "s" produced "ghost in the
contexts" and "1 link that answer nothing". Both forms are written out now — the
kind of small wrongness that makes a tool read as careless._

Driven against a session carrying all three at once, and the startup line
reported them in one sentence.

## E63 — Keeping your place: the top-visible line, and one primitive for both halves

**Ruled:** Cole, 2026-09-22, on the backlog item his real editing produced
(switching raw ↔ rendered returned to the top; split's panes scrolled apart).

**⛔ THE ANCHOR IS THE TOP-VISIBLE LINE, NOT THE SELECTION.** Whatever sits at
the top of the pane you leave sits at the top of the pane you arrive in. **Not
taken:** "the selection when there is one, the scroll offset otherwise", which
the backlog item itself proposed. Cole chose the single rule for the same reason
he chose one meaning for the chip's X the day before — one rule is less to
juggle for the human _and_ the agent than two that disagree at the edges.

**⛔ COMPARE IS OUT OF SCOPE**, decided rather than forgotten.
`@codemirror/merge` does its own scrolling, and only raw, rendered and split
take part.

**⚠ CLOSE, NOT PIXEL-PERFECT** (Cole). Rendered height and source height have no
common measure — a fenced block is twenty source lines and one box. So "close"
is defined rather than hoped for: the rendered pane is described by ANCHORS (the
source line each rendered block begins on, and where it sits in the scroller)
and anything between two anchors is interpolated. The error is bounded by the
BLOCK, which is the unit a human looks for when they switch views. **Measured on
`grimoire/house-style.md` (668 lines): when a block begins at the top edge, the
other pane's top line is that block's line EXACTLY (25 of the 27 `h2`–`h4`
headings the probe queried); of 42 arbitrary positions, 37 were measurable — one
bottom clamp, four where the oracle could not locate the text — and all 37 are
within three source lines.** Those figures are kept because a later change that
degrades the sync is caught by re-running that sweep and comparing; they carry
their population for the same reason.

**⛔ AND THAT IS THE TEST FOR WRITING A NUMBER DOWN AT ALL (Cole, 2026-09-22):
what is it for, who is it for, and what will they do with it?** A number that
has to stay true, or that a later reader will compare against to see whether
something degraded, earns its place — and then it owes its method, its
population and its limit, because without those there is nothing to compare
against. A number that merely records what was true on the day — how many cells
a branch added, how many anchors there were before and after a fix — is nobody's
to act on and is a hostage to the next person who measures it. **Not taken:**
reconciling every figure on the branch for accuracy's sake, which was the
instruction until this rule replaced it; accuracy is the second question, and
asking it first keeps figures alive that should have been cut. _Ruled while
correcting a denominator that did not match itself — the third numeric claim on
this branch to be corrected by someone else's instrument._ At the very bottom
the follower is already at maximum scroll and cannot put the leader's line at
the top at all — the residue is the distance from the last anchor to the last
line, a structural floor of scrolling, named here rather than papered over.

**⚠ A first pass claimed "within one source line"**, on a 24-position sweep
whose probe flattered it, and it did not reproduce for the verifier. Recorded
because the lesson is the general one: a number in the tree is a claim, and a
claim nobody else can reproduce is a defect in its own right. Measurements here
now carry their method and their limit.

**One primitive, two callers** (`surface/state/place.ts`). The source line is
the only coordinate both views can name: the raw half gets it exactly from
CodeMirror, the rendered half derives it through E51's projection, and a mode
switch and a split are then the same mechanism rather than two that drift. **Not
taken:** a scroll-fraction, which is wrong the moment the two documents have
different heights, and a second mapping beside E51's.

**⛔ THE FEEDBACK GUARD LIVES IN THE STORE, NOT IN THE PANES.** A pane that must
remember to suppress its own scroll handler while being driven is a pane that
will forget, and the failure — each pane re-triggering the other down the
document — is the classic one. A pane can only take part through `join`, and
`join` is what arms the guard.

**⛔ AND THE GUARD IS AN EVENT, NOT A DURATION — ruled after it was built the
other way.** The first version suppressed a pane's reports for 150 ms after
driving it. A window is a GUESS about which scroll a report came from, and an
independent verifier convicted both halves of the guess: a real scroll that
landed inside the window was thrown away with nothing to catch it up (**fifty
lines apart, and still fifty lines apart four seconds later**), and during a
fast wheel two windows overlapped so that one expired under the other and left
the follower **twelve lines behind, frozen there** until the next tick nudged
it. **Not taken:** widening or narrowing the window, which only moves which
scrolls are lost; and a tolerance on the line numbers, which would have made the
bottom clamp indistinguishable from a real move.

What replaced it works on events rather than clocks. A programmatic scroll
produces exactly ONE scroll event, so the arm is one-shot: the first report
after a drive IS that drive. A scroll event is dispatched in the rendering
update's scroll steps, which run BEFORE that frame's animation-frame callbacks —
so a one-frame disarm can clear an arm that will never be consumed (a drive that
moved nothing sends no event) without ever racing the event itself. And a human
scroll COALESCED into the same event as ours is told apart by WHERE THE PANE IS
against where the drive left it.

**⚠ IT IS NOT AIRTIGHT, AND THIS ENTRY SAID IT WAS.** The comparison can only
speak once `left` has been recorded, which is a frame after the drive. Two
windows are therefore uncovered: a report that arrives BEFORE `afterFrame` has
nothing to compare against, and a human scroll landing BETWEEN the drive and
`afterFrame` is folded into `left` itself and reads as the drive. Both swallow a
real scroll and leave the panes disagreeing until the next tick, which corrects
it completely. **Cole ruled it filed rather than fixed** — reaching either needs
a synthetic injection, and real alternating wheel input could not provoke worse
than three lines. Pinned by two cells in `place.test.ts` (`PINNED 1/2`,
`PINNED 2/2`) that assert TODAY'S behaviour so a later change cannot move it
silently, and filed as
[the coalesced-scroll item](../../backlog/2026-09-22-scriptorium-a-coalesced-scroll-is-lost-in-one-ordering.md).

_The word "airtight" stood here for exactly one round of review. It was written
in the same breath as this branch's own lesson — that an unreproducible claim in
the tree is a defect — and it is the third claim on this branch to be corrected
by someone else's instrument rather than by its author's._

_Measured, and the reason the ordering is written down rather than assumed:
CodeMirror's `scrollIntoView` is applied a frame late — immediately after the
dispatch `scrollTop` is unchanged; by the next frame it has landed._

**The invariant the cells now hold is the one the verifier named: when
everything settles, the two panes agree.** Asserting that the follower's report
is dropped was not enough — it asserted the mechanism and not the consequence,
and the defect lived in the gap between them.

## E64 — The side columns get out of the way

**Ruled:** Cole, 2026-09-22, on the backlog item his real use produced (more
room, above all in split and compare). Either column — the context on the left,
the conversation on the right — collapses on its own or with the other, and the
view mode does not change.

**⛔ TALKING TO THE AGENT NEVER NEEDS THE COLUMN (Cole).** While the
conversation column is collapsed, a floating composer is docked at the foot of
the document pane, and the selection chip rides on it exactly as it does in the
column. Conversation-primary: collapsing the chat must not remove the human's
way to talk to the agent.

**⛔ ONE COMPOSER'S WORTH OF STATE (Cole, applying the one-state rule from this
cycle's first branch —
[the memory](../../memories/2026-09-22-scriptorium-selection-and-the-chip.md)).**
The draft moved OUT of `ChatComposer` and into `App`, and the composer is drawn
in exactly one place at a time — the column while it is open, the float while it
is shut. A draft living inside the component would be lost on every move (the
move is a remount), and drawing it in both places would make two drafts that can
disagree. The chip has been the held selection's, not the component's, since
that branch, so it follows for free. **Not taken:** keeping the column's
composer mounted and hidden while the float shows a second one; that is the
two-copies defect by construction. _A side effect worth knowing: switching the
right pane to Notes or Tasks and back no longer loses a half-written message
either._

**⛔ COLLAPSED IS A WIDTH, NOT A FLAG.** `react-resizable-panels` already has
collapsible panels, and a collapsed panel is a panel at its collapsed size (0).
The layout that records that is the one `useDefaultLayout` already persists in
the home's prefs beside every other pane size, so the collapsed state persists
with no new mechanism, and "is the chat collapsed?" is read off the layout
(`state/columns.ts`, `collapsedSides`). Clicking the button, dragging the column
shut and restoring a saved layout all land on the same fact. **Not taken:** a
`panes:collapsed` pref beside the layout — a second record of what the layout
already says, which would disagree the first time someone dragged a column shut.

**⚠ WHAT THE LAYOUT CANNOT HOLD is the width a column reopens to.** The library
keeps that in memory only, so after a reload `expand()` reopened a column at its
minimum. That is a different fact — "how wide I like it", not "is it open" — so
it gets its own small pref, `panes:open`, and reopening uses `resize` to that
width (default 22% / 28%) instead of the library's `expand()`.

**⚠ AND TWO WAYS THAT FIRST VERSION WENT WRONG, found by the no-stake
verifier.** (1) The separator's Enter still ran the library's `expand()`, so
after a reload it reopened a column at its 12% minimum, and that minimum was
then SAVED as the reopen width, so the buttons reopened there from then on.
Enter on either handle now goes through the same collapse and reopen as the
buttons, taken in the capture phase before the library's listener sees it. A
width at a column's minimum is also never remembered, and a stored one decodes
to nothing, so a pref the bug already wrote heals itself. The price is that a
column deliberately dragged to exactly its minimum does not reopen there. (2) A
width remembered while the other column was collapsed could be too wide once
that column came back. Reopening at it squeezed the document to its minimum and
then pushed the OTHER column shut. The reopen width is now capped so the
document keeps its 25%, and never goes below the column's own minimum
(`reopenSize`).

**⛔ ONLY THE HUMAN'S RESIZE IS REMEMBERED (reviewer of record).** A reopen is
an imperative resize, and when the library squeezes a capped reopen, the width
it lands on is the library's compromise. Remembering it overwrote the width the
human had actually chosen. `rememberOpen` now takes the library's
`isUserInteraction` (true for a drag or a key on a handle; false for a reopen, a
collapse and the initial mount) and remembers only when it is true.

**The affordance (ours; Cole had not ruled).** A collapse button at the end of
each column's own heading, and a reopen button at the matching END of the
document's heading — where the column went, which is where the eye looks for it.
The resize handle stays at the window edge, so a column can also be dragged shut
or dragged back out. Enter on a focused handle collapses and reopens the column
beside it: the left handle acts on the context, the right on the conversation.
The library bound the right handle's Enter to the document, which does not
collapse, so it used to do nothing. **Controls that take themselves away hand
focus on**: collapsing moves focus to the reopen button, and reopening moves it
back to the collapse button, instead of dropping it to `<body>`. "Open the
conversation" on the float, and pointing at a note, reopen through the same
hand-off; a reopen or collapse that turns out to be a no-op leaves nothing
pending, so a stale hand-off cannot take focus later. **Not taken:** a keyboard
shortcut. The obvious ones collide (⌘[ / ⌘] are browser back and forward, ⌘B is
bold to anyone who has used an editor), and a shortcut is the least discoverable
of the options; it can come when real use asks for it.

**⛔ THESE CONTROLS STAY REACHABLE AT EVERY WIDTH THE LAYOUT ALLOWS
(verifier).** The conversation's tabs need about 275 px, and at its 15% minimum
the column is 192 px even in a 1280 px window, so a collapse button placed after
the tabs was pushed out of sight. Each column's collapse button is now pinned,
and the title and tabs around it shrink, wrap or clip instead. The document's
heading wraps to a second row instead of clipping, because the pane can be as
narrow as 25% of the window. Checked with `elementFromPoint` on every column,
reader and view-mode control at 1280, 900 and 600 px, with each column in turn
at its minimum and the document at its minimum. **Not taken:** an overflow menu,
which makes a control reachable only by first finding the menu.

**⚠ THE FLOAT IS IN THE FLOW, NOT OVER THE TEXT.** It reserves its own height at
the foot of the pane, so it never covers the last lines of the document and the
scrollers — which E63's keeping-your-place measures — need no padding to make
room for it. It carries one line of the conversation: the latest message, with
its waiting badge while the agent is on it, and "Open the conversation". _Our
ruling:_ without it, a message sent from the float got its answer somewhere the
human could not see.

**Split becomes available when collapsing gives it room.** The document pane
already measured its own width against split's floor (720 px, now `SPLIT_MIN_PX`
in `state/columns.ts`), so collapsing a column makes split available with no
further wiring, and reopening one falls back to rendered exactly as a narrow
drag always did. The disabled split button now says "collapse the side columns
to make room" when collapsing both WOULD make room (`splitRoom` computes the
width with both shut, so the words say both), and only then — a refusal that
names the act that answers it. The estimate is rounded to the pixel: the browser
lays out in 1/64 px units, and an unrounded one read a hair under 720 in a
window where collapsing gave exactly 720 (verifier). It is rounded to the
NEAREST pixel, not up: 719.3 is not 720. Compare gets the width and nothing
else, as ruled.

**⛔ READER MODE IS A PRESET, AND IT IS DERIVED (Cole: build only if cheap — it
was).** Reader mode is rendered + both columns collapsed + quieter chrome, so
`isReader` is true exactly when the view is rendered and both columns are shut,
however that came about. One toggle (the glasses, in the document's heading)
enters it — rendered, collapse whatever is open — and leaves it by reopening
both columns; the view stays rendered. There is no reader flag to fall out of
step with the columns it describes, and it is not a fifth entry in `VIEW_MODES`.
"Quieter" means the document's heading and status strip fade back until the
pointer or the keyboard focus reaches them. **Not taken:** hiding them — that
would take Save, the version and "Unsaved" out of reach. **Not taken:**
remembering the view you entered from and restoring it on leave, which would be
the second piece of state the preset exists to avoid.

**⛔ WHAT ASKS FOR ATTENTION STAYS LOUD (Cole, 2026-09-22, in two steps).**
First, after the verifier raised it: while the document has unsaved edits, Save
and the "Unsaved" marker stay at full strength in reader mode. Then,
generalised: **anything asking for attention stays at full strength, and only
idle chrome fades.** That is unsaved edits and warnings. The save-state marker
stays loud when it says "Unsaved" and when it says "Changed on disk". Save stays
loud while there is something to save; with nothing unsaved it is disabled and
fades with the rest. The changed-on-disk banner, which carries the acts that
answer it, was never faded. A quiet reading view must not make an unsaved edit
or a changed file easy to miss (`readerStaysLoud`). Because opacity multiplies
down the tree, the fade moved from the two bars onto their parts. A faded bar
cannot hold one of its children at full strength.

**⚠ A HOLE IN E63 THAT COLLAPSING EXPOSED, CLOSED.** The rendered pane caches
its block anchors and clears them from a `ResizeObserver`. A collapse widens the
pane in ONE layout, the browser's scroll anchoring moves `scrollTop` to keep the
same text at the top, and that scroll event is dispatched before the observer's
callback — so it was reported through anchors measured at the OLD width. Driven
on `grimoire/house-style.md`, 1280 × 800, with a saved split falling back to
rendered: a heading at the top of the pane was reported as a line in the section
before it, and the split that the widening then mounted opened there. A drag
reaches the same widths in small steps, and did not show it. The anchors now
record the width they were measured at, and a different width re-measures them —
exact evidence the table is stale, with no timing in it (`anchorCache` in
`state/place.ts`, whose cell asks it at a new width with no clear). Re-driven
after the fix, the same collapse landed both halves of the split on the heading
at each of four headings tried. ⚠ The cell holds the rule, not the wiring: that
`MarkdownView` reads its anchors through the cache is evidenced only by that
browser run. To reproduce: split saved but falling back to rendered, a heading
scrolled to the top, then collapse the context column so split mounts.

**Keeping your place across a collapse, as observed** (same document and
viewport): the rendered pane keeps its top block through a collapse and a
reopen, because the browser's scroll anchoring holds it; the raw pane moved by
one source line on collapse and returned exactly on reopen. E63's deferred item
— a resize does not re-place a pane — is unchanged and still Cole's to rule on
after use.

## E65 — A note shows that it is with the agent

**Ruled:** Cole, 2026-09-22, on the backlog item his real use produced. Agents
act on nearly every `note.added`, although the skill said "a note is not a
request", and he thinks acting is the right instinct. So the behaviour stays,
and what changes is everything around it. Between adding a note and the agent's
answer, the surface used to show nothing. Messages had E53's signal and notes
had none.

**⛔ DERIVED, LIKE E53, AND NO NEW AGENT DUTY (Cole).** A note the human wrote
shows a pulse ("with the agent…") until the agent answers it in a way the daemon
can see. After E53's 30 s with no answer it turns into a static "no word from
the agent — may be stuck" in the attention colour. It does not pulse, because an
animation over a wedged agent would be false liveness. Nothing asks the agent to
announce anything. The derivation is `notesWaiting` in `backend/waiting.ts`,
beside `waitingOn`, and the two share one `badgeFor`, so a note and a message
that have waited equally long cannot read differently. It rides in
`PublicState.notesWaiting` and is computed where `waiting` is (in the daemon, on
E53's 1 s tick, broadcast only on change). `working`'s snooze covers notes too.

**⛔ WHAT ANSWERS A NOTE (ours, after Cole's steer that resolving is the
close).** Every part is a fact the daemon already holds:

- **Resolved.** Resolving is the act that closes a note, whoever does it (Cole),
  so a resolved note is owed nothing. It is the note's own stored `resolved`, so
  there is no second record of it.
- **An agent message after it** (strictly after: one in the same millisecond
  cannot have read it). That is what the human is waiting for, and it is the
  same reason one reply answers E53's run of messages. So **two notes and then
  one reply clears both**, and a note added after that reply stays owed. The
  claim is "the agent has said something since", never "the agent dealt with
  this". The pending mark goes away and the note stays **open**. "Dealt with" is
  `resolved`.
- **The agent rewriting that note** (`note-edit`), an act on this note that the
  human sees on this note. It needed one new stored field, `editedBy`. A
  **human** rewrite makes the note owed again, timed from the rewrite, so a
  human's `note.edited` now carries the same fields as `note.added`. An edit
  made before `editedBy` existed is not evidence either way, so the note counts
  from when it was made.
- **⚠ A system line is still not a reply.** The agent resolving note A is
  narrated as a system line. It closes A and says nothing about B.

**Not taken:**

- **Only `resolved` counts.** This was Cole's suggested shape, weighed as he
  asked. An agent visibly working on a note, which has replied or started a
  task, would flip it to "may be stuck" at 30 s whenever it forgot to resolve,
  and E53's whole premise is that it forgets. That is a false alarm that teaches
  the human to ignore the mark.
- **A drawn "acknowledged" state between pending and resolved.** The daemon
  cannot tell that a reply was about this note, so a mark saying "the agent has
  this one" would claim more than it knows. Once answered, the note looks as it
  always did. Resolved is the existing dimmed, hidden-by-default state.
- **A ✓ once answered.** It would be a third look, with a lifetime of its own
  (when does it go?), and it would claim "handled" where the rule knows only
  "spoken since".
- **An agent version, an agent note nearby, or an edit to the lines.** The agent
  never writes the active version (E2), so its edits land in a version the note
  is not anchored in. "Near" is a guess, and a new version is announced as a
  system line.

- **A human reopening a note re-arms it, timed from the reopen** (verifier). It
  was first left out ("reopening stores no time"), and that left two cases
  disagreeing. A note resolved before any reply and then reopened came back owed
  but timed from its creation, so it could reappear already "may be stuck". An
  answered note, reopened, was not owed at all. Now there is one rule: making,
  rewriting and reopening are all the human putting the note in front of the
  agent, and the latest of them starts the clock. The agent reopening or
  rewriting a note is an act on it, and answers it. This needed two more stored
  fields, `reopenedAt` and `reopenedBy`. A human's `note.reopened` carries the
  same fields as `note.added`.

**⛔ "MAY BE STUCK" HAS AN ACT: "Ask the agent" (ours).** On the stuck note in
the notes panel, and on the floating composer's line. It sends one ordinary
message in the human's conversation, _About my note on “‹passage›” in ‹file›:
“‹excerpt›”_, and brings the conversation forward so they see it go. Being a
message, it gets everything a message gets: E53's badge on it, and E53's one
nudge if the agent stays quiet. The agent's reply to it answers the note as
well. The other way out is the existing ✓: resolving it yourself. **Not taken:**
a daemon nudge per stalled note on the agent's tail. The `note.added` that
delivered it already carried it, and routing the human's "are you there?"
through the conversation keeps one nudging mechanism, not two. Also not taken: a
"dismiss" flag. That would be a second record of what `resolved` already says.

**⛔ AND ONCE ASKED, THE NOTE WAITS ON THAT MESSAGE (verifier D1).** The first
version left the note reading "may be stuck" with the button still offered, so a
second click sent the same message again. The message now carries the note's
reference (`note: {doc, id}`, stored on the message). While a human message
about the note, sent after its latest human write, is unanswered, the note's
entry carries `askedIn` and reads "asked in the conversation…". Its badge **is**
E53's badge for the conversation, not a second clock that could disagree with
it. The button is not offered while the note is asked. The daemon drops a second
ask about a note that is already asked, which is the same derived fact, so a
double-click sends one message (driven: one `message` on the tail). There is no
"asked" flag; it is read off the conversation.

**⛔ THE ASK NAMES THE NOTE, NOT JUST ITS WORDS (verifier D4).** On the tail the
message carries `note` (the id), `doc`, and a `hint` naming
`note-resolve <id> --doc <slug>`, so the agent can act on it and resolve it
without matching prose. The message's text quotes only a short excerpt of the
note (120 characters). A long note pasted whole would bury the conversation, and
the reference is what the agent uses.

**`note.added` carries the note when it is short, and names the close (Cole).**
It carries the passage (`quote`), the `body` and the `lines` it covers (1-based,
in the active version; a range that ends on a newline ends on that line). Its
`hint` names `note-resolve <id> --doc <slug>`. **The cap is 1000 characters of
quote plus body** (`NOTE_TEXT_MAX`). Notes are made mid-read, on a phrase or a
sentence, and those should reach the agent whole so it can act without a round
trip. A note over a whole section is where the round trip pays, because `notes`
also says whether the passage still stands and where it is now. The agent
reading its tail is the one who acts on this number. **⛔ Whole or not at all,
never truncated.** A clipped quote reads as the whole passage. Over the cap, the
event keeps `lines` and its `hint` says to read the note with `notes --doc`. The
cap counts **characters (code points)**, not UTF-16 units, so an emoji counts as
one (verifier D6). **A note whose passage is gone** from the active version has
no `lines`. The event then says `passage: "gone"`, and its hint says so and
points at `notes`, where the long-note path already sent the agent (verifier
D5). Before this, a rewrite of such a note said "act on it" with nothing to
find.

**Where the signal shows: one derived list, drawn in four places, over ONE
scope: the session.** The rule it meets (verifier D3): if something is owed
anywhere in the session, the human can see it without collapsing a column. The
first version disagreed with itself. The tab and panel read the open document
while the composer read the session, so a stuck note on another document showed
only once the column was shut. Now:

- **The Notes tab** has one dot for every owed note in the session, stuck if any
  is. The count stays the open document's, like the list.
- **The notes panel** lists the open document's notes with their badges and act,
  and above them one line per other document with owed notes ("2 notes owed an
  answer on harbour.md", stuck if any is). Clicking the line opens that
  document.
- **The floating composer**, while the column is collapsed, shows the oldest
  note the human can still act on (not yet asked about), naming its document
  when it is not the open one. It has that note's own badge and act, and "+N
  more" is kept **outside** the truncated text so it never clips (verifier D2).
- **The note menu** on a passage has a dot beside each owed note. **Not taken:**
  marking the passage in the running text. Notes are already painted in the
  attention colour, so a "stuck" tint would not be told apart, and a badge in
  the text would move the words.

**Reload and restart.** What is stored is `editedBy`, `reopenedAt`/`reopenedBy`
and the ask's `note` reference; `notesWaiting` is not stored, and the state is
re-derived from the persisted notes and conversation, so it survives both.
Driven in the browser: a note pulsed, then cleared on a CLI `say`. A second note
went to "may be stuck" at 30 s. After a page reload it was still stuck, on the
tab and on the floating composer. After `close` and `open --restore` it was
still stuck. "Ask the agent" sent the message, and the tail carried it. Then
`note-resolve` from the CLI cleared the note, and the message kept its own E53
pulse until a `say`. The one thing that does not survive a restart is
`working`'s snooze, which is in memory, as in E53.

Re-driven after the verifier's fixes, with two documents: two notes stalled on
harbour.md while maren.md was open with the column open. The tab dot and the
panel's "2 notes owed an answer on harbour.md" showed them. With the column
collapsed, the composer line read "Your note on harbour.md … +1 more", and the
count was not clipped (checked with `elementFromPoint`). A double-click on "Ask
the agent" sent one message carrying `note`, `doc` and the hint. The asked note
then read "asked in the conversation…" with no button, and it still did after a
reload. A rewrite of a note whose passage had been deleted emitted
`passage: "gone"`.

### Known limits, left to real use (Cole)

Cole ruled these trade-offs are to be learned in use, not theorised. They are
left as built, and stated plainly here so real use knows what to watch for.

1. **Any agent reply clears pending on every earlier note, across documents.**
   The verifier's repro: an unrelated question and answer in the chat silenced a
   note nobody had touched, and one `say` cleared every stuck note across two
   documents. The notes stay open (unresolved), but the "may be stuck" signal is
   gone.
2. **An agent that works on the noted passage without speaking still reads as
   "may be stuck".** The agent writes a new version (E2 forbids the active one),
   changes the passage the note is about, and says nothing. At 30 s the note
   shows "may be stuck" although work visibly happened. Only a reply, a resolve
   or a rewrite of the note answers it.
3. **`working`'s snooze covers notes added after it.** A note made during a
   snooze pulses until the snooze ends instead of stalling at 30 s, as a message
   sent during a snooze does in E53.

Also as documented above: a note edited before `editedBy` existed counts from
when it was made.

## E66 — A selection belongs to the text it was made in

**Ruled:** the orchestrator of the `2026-09-scriptorium-real-use` cycle,
2026-09-22, reading Cole's standing "keep the UX model simple" and his chip
ruling ("if you clear the context from the chat, that … should be treated as
clearing the selection"). The defect was edge 0 of
[the selection-edges backlog item](../../backlog/2026-09-22-scriptorium-selection-edges-the-review-found.md).
Select in `alpha.md`, click `beta.md`, and the chip read `beta.md · v1 · line 5`
over alpha's words. The daemon held the same thing, so a `say` would have sent
alpha's text attributed to beta's path and line.

**⛔ THE RULE: when the document text on screen changes, the held selection is
cleared, in the surface and in the daemon.** "The text on screen" is the open
document at its active version, so another document **or another version**
counts. It is the same clear as the chip's X: the selection goes, and so does
its paint. It is dropped, never re-labelled, and going back does not revive it.

**Why it happened.** The surface held the selection as offsets and lines with no
document of its own. The effect that tells the daemon stamped it with whatever
document was open when it ran. A switch re-ran that effect, and the old passage
went out under the new name. The rendered pane could not catch it either: the
press was in the context list, so the emptied browser selection was not the
pane's to clear.

**Built:**

- `selectionOnScreen` (`backend/selection.ts`) is the one rule, shared by both
  halves: a selection is kept only while its `doc` and `version` are the ones on
  screen.
- **Surface.** `HeldSelection` carries the `doc` and `version` it was made in,
  stamped by App on each report. A new `shown` event goes through
  `applySelectionEvent`, so a switch reaches the paint the way the X does. App
  also derives `shown` for the one render between the switch and the clear. That
  render is the one that used to send the stale selection, so the chip, the
  Notes panel and the daemon read `shown`, not `selection`.
- **Daemon.** Every read of the held selection (`/state`, the snapshot, `say`)
  goes through the rule, and a `select` naming text that is not on screen is
  refused. The open document moves from many places: the surface's `open` and
  `open.doc`, a followed link, the agent's `activate`, a document removed, an
  undo. Checking at each of them is a check some later path would forget, so the
  check is on the read.

**Checked with real mouse input**, the chip and `/state` agreeing after each:
the context-list click (the repro), a search result in another document, the
Notes panel's "note owed an answer on X" line, a followed link, the agent's
`activate`, the human's version menu, the history arrow undoing a removal of the
open document, a reload, and raw mode. **A rename is not a switch.** The
document record and its text are the same, and the chip and the daemon's path
follow the new name together.

**Not taken:**

- **Re-key the selection to the new document.** That is the defect.
- **Keep it for a deliberate "select in A, ask about it from B".** No such flow
  was found, and the chip already names the document, so a human reading B while
  asking about A would see one name and mean the other. If real use produces
  this flow, the answer is a chip that visibly says "from alpha.md", not a
  selection that silently outlives its text.
- **Keep it across a version switch, since the text is often identical.** The
  offsets belong to one version's text, and a branch made to rewrite a passage
  is exactly the case where they stop matching. One rule is simpler to hold than
  "same document unless the text moved".
