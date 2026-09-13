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
