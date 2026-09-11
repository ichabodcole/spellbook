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
