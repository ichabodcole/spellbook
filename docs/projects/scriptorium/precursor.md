# Scriptorium — precursor

**Created:** 2026-09-11 · **Status:** named (E12) — building the foundation
slice (E11). The spell was the "document editor" until it was named. **Source:**
Cole's brain dump, Operator doc `document-editor-spell-idea.md` (`28a57a1e`,
Spellbook workspace `fragments/`). **Decisions:**
[`decision-log.md`](./decision-log.md)

## Concept

A co-present document editor: bring documents in, edit them, and have an agent
present in the same surface to help — with the agent seeing what the human is
looking at and has selected. "A lightweight Obsidian, with an agent in it."

## The conversation

Three panes. **Left — context:** drag in single documents (markdown, plain text)
or whole folders; a folder opens as a file tree the human can drill into and
back out of. **Centre — the document:** raw markdown editing, with a rendered
view to come. **Right — agent chat plus event messages.** A message the human
sends carries the current **selection** as context; **shortcuts** (e.g. a
right-click "check spelling") are pre-canned messages carrying the same context
— visually distinct, collapsible, but ordinary chat messages (the house
message-surface paradigm).

## The problem

Cole edits a lot of documents, often ones an agent wrote. Today that means
bouncing between an editor and a chat, re-pasting context, and eyeballing what
the agent changed. He wants to point at text granularly, ask for changes, see
exactly what changed against the original, and take all or part of it.

## Surface-fit

Strong. Selection, side-by-side diff and granular merge are spatial acts chat
cannot carry; the conversation still stays primary — every surface affordance is
a channel into the chat (conversation-primary surfaces).

## What the human gets

- A context list of documents and folder trees; click to open.
- Direct markdown editing, with **undo/redo**, autosaved to the real file.
- Select text → talk about it; shortcuts for common asks.
- **Annotations:** mark several passages, each with a note, and send them to the
  agent together (or not).
- **Saved prompts:** reusable instructions (e.g. "format this transcript my
  way") saved once, available in every session; picking one fills the composer
  with the selection as context (E9).
- **Versions:** the agent's edits arrive as a new version; any number of
  versions are kept, **two shown at once**, side by side with a visual diff.
- **Merge:** accept a whole version as the active one, or pull in individual
  changes.

## What the agent does underneath

One agent (decided). It reads the documents and the human's selections and
annotations, and **writes edits as new version files** rather than touching the
version the human is editing — so the two never collide on one file (decision
E2). It can help with a merge when asked.

## First slice

Open a file or folder → edit markdown directly (undo/redo, autosave to disk) →
select text and ask the agent → the agent writes version 2 → split-screen diff
of v1 vs v2 → accept the whole version. **Next:** granular merge, annotations
batch, rendered view, OKF + wiki links, relational links, export-all, session
save.

## Open threads

- **Editor engine and the buffer↔disk sync model** — researched in
  [`investigation.md`](./investigation.md): CodeMirror 6, explicit save; the
  daemon owns the session and every version is a file the agent edits (E7/E8),
  `@codemirror/merge`, `@parcel/watcher`.
- **Session save** — probably "reopen the same folder + a small manifest", since
  files are the store; to confirm in the prototype.
- **Where versions live** — beside the file, or in a spell-owned session folder.
- **OKF standard** and **relational links** (Storyline's `relates to` /
  `supersedes` / `child of`) — later slices; wiki links are the must-have.
- **More than two versions on screen** — prototype with two.

## Kin

- **Operator** — Cole's database-backed markdown editor: rendering, styling,
  undo/redo reference (`~/Projects/Barkdown-editor/operator-mono`).
- **digestify** — read / highlight / comment; the annotation shape.
- **mind-mapper** — how OKF-style links and a graph can surface in a spell.
- **Obsidian** — the files-on-disk model and editor behaviour to emulate.
