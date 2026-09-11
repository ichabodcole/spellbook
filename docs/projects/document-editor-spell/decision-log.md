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

## E8 · A working copy the agent can read — proposed, awaiting Cole

**Proposed:** lead, 2026-09-11, as E7's consequence. If unsaved edits lived only
in the editor buffer, the agent — which reads files — would not see them, and a
selection could quote text that is in no file it can open. So: the human's
current version is mirrored to a **working copy** in the spell's session folder
(debounced as they type), which is what the agent reads; the agent's versions
sit beside it (E2); **Save** copies the active version over the original;
**Revert** copies the original back over the working copy. Unsaved edits also
survive a crash. **External change to the original:** clean buffer → silent
reload; dirty buffer → ask, through the diff view (VS Code's model — Obsidian's
silent auto-merge is a standing complaint among its own users). **Not taken:**
the agent only ever sees saved text (a selection could name text the agent
cannot read).

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
