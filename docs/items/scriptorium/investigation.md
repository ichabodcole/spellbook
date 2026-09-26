---
type: artifact
title: "Scriptorium — investigation: editor, undo, save, diff, watching"
description:
  Investigation findings on editor engine, undo, save, diff, and file watching
  for Scriptorium implementation
status: stable
generated: { by: unknown, at: 2026-09-11 }
---

# Scriptorium — investigation: editor, undo, save, diff, watching

## Findings

### 1 · Editor engine — CodeMirror 6, which Operator already uses

Operator's desktop editor is **CodeMirror 6** for raw markdown
(`apps/desktop/src/renderer/src/components/CodeMirrorEditor.vue`), plus a
Milkdown/ProseMirror WYSIWYG pane kept in two-way sync, in
`edit | split | preview` modes. Obsidian is also built on CM6.

⚠ **Operator's two-way raw↔WYSIWYG sync is its most expensive bug surface**
(`docs/memories/2026-04-26-split-view-reactivity-loop-v2.md`): typing in the raw
pane inserted `<br>`, jumped the cursor and dropped characters; the fix that
held was only syncing preview→raw while the preview pane had DOM focus.

**Recommendation:** CM6 for the editable raw markdown, and a **separate,
read-only rendered view** (remark/micromark → HTML) — no two-way WYSIWYG. Live
preview (Obsidian-style decorations) is a later stretch. Wrap CM6 in React by
hand (own the `EditorView` in an effect) rather than `@uiw/react-codemirror`,
because dispatching annotated external transactions is core to this spell, not
an edge case.

### 2 · Undo/redo — the editor's own history, one state per file

Operator uses CM6's built-in `history()`, and keeps **one `EditorState` per
document** in a map, swapping with `view.setState()` — so each file keeps its
own undo history across switching
(`docs/memories/2026-04-25-desktop-undo-history-cm-native.md`).

⚠ **Its remote updates replace the whole document** with `addToHistory: false`,
which throws away the cursor and makes earlier undo steps meaningless.
**Recommendation:** apply an outside change as **minimal `changes`** (CodeMirror
remaps the selection through them) annotated `Transaction.remote` and
`isolateHistory`, so the human's undo never crosses the boundary. **Version
undo** (E6) is separate: making a version active is an action on the version
list, undone by making the previous one active again.

### 3 · Saving — explicit (E7), with a working copy the agent reads (E8, proposed)

Operator autosaves every 300 ms because its store is a database and every write
is a version. **For files on disk the house rule is explicit save** (E7, Cole) —
VS Code's default is the same. Consequence (E8): the agent must see unsaved
edits, so the human's current version is mirrored, debounced, to a **working
copy** in the spell's session folder, which is also crash insurance.

**Outside change to the original file:** Obsidian silently auto-merges when a
note changed externally within ~2 s of unsaved edits, and a long-open request on
its own forum asks for a toggle to turn that off. **Recommendation:** VS Code's
asymmetry — buffer clean → reload quietly (minimal changes, §2); buffer dirty →
ask, through the diff view rather than a dialog.

### 4 · Versions, diff and merge — `@codemirror/merge`, verified

Operator has versions (`document_versions`: `content`, `label`, `versionNumber`,
`createdBy: 'user' | 'ai:*'`) but **no diff view and no merge UI**, and its
agent edits overwrite the active version rather than arriving as a proposal —
the opposite of E2.

`@codemirror/merge` **6.12.2** (installed and read in a scratch probe):
`MergeView` renders two editors side by side with
`revertControls: "a-to-b" | "b-to-a"` — **per-chunk buttons that copy a change
from one side to the other**, which is granular merge in split-screen — plus
`highlightChanges` and `collapseUnchanged`; `unifiedMergeView` adds
`acceptChunk` / `rejectChunk`. The diff is character/line based, not
markdown-aware: rewriting `**bold**` as `__bold__` shows as a change.

**Recommendation:** `MergeView` for the two-version display, with
`revertControls` for granular merge; accept-whole is "make this version active".

### 5 · File watching under Bun — `@parcel/watcher` on the directory, verified

Editors save by writing a temp file and renaming it over the original, which a
per-file watch misses (the watched inode is gone). Bun's `fs.watch` has had
macOS bugs in exactly this area (fixed in 1.3.14 for `--hot`). **Driven in a
scratch probe:** `@parcel/watcher` loads under Bun and, watching the directory,
reported an in-place write as `update:doc.md` and an atomic save as
`delete:.doc.md.tmp`, `create:doc.md`. **Recommendation:** watch the directory,
debounce briefly, compare a content hash, and ignore events whose hash matches
our own last write.

### 6 · Things worth copying from Operator

- **`edit_document`'s contract** (`apps/api/src/features/mcp/tools.ts`): atomic
  find-and-replace that must match exactly once and returns the nearest match
  when nothing matches. In this spell the agent edits version files with its own
  file tools, which already behave this way — but any spell-side edit verb
  should copy it.
- **The link parser** (`packages/shared/src/links/parser.ts`): walks the remark
  syntax tree, so links in code are ignored; returns spans and `rel[]` — the
  shape relational links (Storyline's `relates to` / `supersedes`) would need.
  Operator writes links as `[Label](op:doc/<id>?rel=…)`, not `[[wiki]]`; this
  spell will want `[[wiki]]`.
- **Crepe's hard-coded pixel sizes** — a styling trap only if WYSIWYG returns.

### 7 · New ground — nothing to reuse

**Operator has no selection-to-agent mechanism and no chat UI.** Its
`context-selection` work was an unrelated operation-frontmatter feature, and its
investigation lists "selection-based context" as an unbuilt gap. Digestify's
highlight/comment code is the nearer kin for selections and annotations.

## Recommendation, in one paragraph

CodeMirror 6 for raw markdown with a separate read-only rendered view; CM6's own
history, one `EditorState` per file, outside changes applied as minimal changes
outside the human's undo; explicit save to the original with a debounced working
copy the agent reads; `MergeView` with per-chunk controls for the two-version
diff and granular merge; `@parcel/watcher` on directories with hash-based
self-write suppression. The prototype should drive the one untested seam: an
agent writing a version file while the human types in the working copy.
