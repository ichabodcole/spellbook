# Document editor spell — decision log

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
