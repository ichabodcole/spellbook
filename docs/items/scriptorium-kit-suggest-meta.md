---
type: item
title: A document with no frontmatter is offered a block to add
description:
  "Bring E35 to the kit path: a verb returns a suggested frontmatter block and
  the pane offers it into the buffer, as the shipped meta.suggest does."
status: stable
lifecycle: active
id: 01a14dc5-70c3-7762-8b0a-db667fbc47c8
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [scriptorium, kit, frontmatter]
parent: feature/workspace-kit
cycle: 2026-10-document-pane
---

# A document with no frontmatter is offered a block to add

E35: when a document has no frontmatter, the shipped header offers "Add a
block", which puts a suggested block into the editor for the human to keep or
change. The shipped daemon answers `meta.suggest` for it.

On the kit path, `suggestMeta` exists (`backend/kit/wiki.ts`), but it only feeds
`meta-init`, which writes the file. No verb returns a block for the editor, and
the kit's document header has no such offer.

This item brings it across: an app verb that returns the suggested block, and an
offer in the pane, through `frontmatterChips` or a small header slot, that puts
it into the editor unsaved.

## Definition of done

- [x] With `SCRIPTORIUM_KIT=1`, a document with no frontmatter offers "Add a
      block". Taking it puts the suggested block into the editor, unsaved, and
      the file is untouched until Save.
- [x] The suggested block matches what the shipped app suggests for the same
      document.
- [ ] Any kit change is a generic slot, offered back on kit-parity. (The slot is
      generic, with port-back notes below; the kit-parity offer is the lead's.)

## Done and verified

Commits on `impl/scriptorium-kit-suggest-meta`, from `cycle/document-pane`
(`231abf60`); nothing is ported from Story Studio, so there is no Story Studio
sha:

- `f745ba10`: `scriptorium.meta.suggest`, an app verb on the flagged backend
  (`backend/kit/wiki.ts`). It returns the shipped `suggestMeta`'s block for a
  document, `by: human` when the surface asks, and writes nothing.
  `suggestMeta.test.ts` holds it against the shipped `Session.suggestMeta` on
  one world: neighbour majority, a tie, folder fallback, a quoted title, no H1,
  no `by`, and the 409 for a block, readable or not. `wiki.integration.test.ts`
  asks it over a real daemon and checks that no file changes.
- `d370e18f`: the kit's `textOffer` slot on `DocumentPane`, with its tests.
- `1fd1a45a`: the frame fills the slot (`surface/kit/suggestMeta.ts`, a
  three-line `Frame.tsx` edit), with a frame test against a real flagged daemon.
- `08a16ece`: the dist rebuild. Only the kit page and `server.js` changed.

After the verifier ("Ready, with fixes"), three more commits:

- `e51a0f08`: the offer follows the daemon's shared answer.
  - Before this, a stale second tab still offered, and taking it there wiped the
    first tab's later typing (the verifier's `twotab2` repro). That tab had
    decided "no block" from its own copy of the text, and a tab never hears
    another tab's edits.
  - The shipped header reads `doc.meta` from the shared snapshot. The kit path
    now has the same thing: `appState.noFrontmatter`, the open documents whose
    active version has no block.
    - It applies the shipped `splitFrontmatter` to the whole version file.
    - It is cached by path, mtime and size.
    - An edit's broadcast refreshes it, within about 250 ms.
  - The tab's own text is still asked, so the offer goes at once in the tab that
    took it. The pane's re-ask guard stays as a second line of defence.
  - Tested with two real clients and frames on one flagged daemon, and on the
    list directly.
  - The repro, rerun in a real browser against the fix, ended with tab two's
    offer gone, "MORE FROM TAB ONE" kept, and the file untouched until Save.
- `08976a51`: four tests for rules the verifier's mutations survived: no offer
  while the app's view shows; nothing written once another version is active;
  the take is sent at once (flushed); and a rendered-view take is undone by one
  undo in raw. The `textOffer` doc comment no longer names an app.
- `80c9f27c`: the dist rebuild.

Deliberate choices:

- **Surface-only, no CLI command.** The agent's half of E35 is `meta-init`,
  which writes the file. The shipped CLI has no suggest verb either, so the acc
  surface is unchanged. A test pins that `meta-suggest` is not a command.
- **The offer rule is the shipped header's.** The frame decides whether there is
  a block with the shipped reader's `splitFrontmatter`, over the active
  version's text, as the shipped `doc.meta === null` does. So an unreadable
  block gets no offer, and the header shows it as written. The kit's own reader
  is stricter (it needs a key line), so the frame does not use it.
- **A refusal is announced.** The shipped click ignores a refusal silently (for
  example, a buffer with no block whose file on disk has one). The kit pane
  announces it with the daemon's words instead.

Real browser (Playwright, 127.0.0.1 only), on a scratch HOME, SCRIPTORIUM_HOME
and TMPDIR, with `open` stubbed and `SCRIPTORIUM_KIT=1`:

- `bare.md` showed "This document has no frontmatter. Add a block".
- Taking the offer put `type: memo` (from a neighbour), `title: The bare one`
  and `generated: { by: human, … }` at the top of the editor. The pane said
  Unsaved, the offer went away, and the file on disk was byte-identical.
- Save wrote the block to the file.
- `has.md` showed no offer.
- `bad.md` (an unclosed flow sequence) showed no offer, and its rendered header
  was the "could not be read, so it is shown as written" one.

The gate passes on `08a16ece` with this doc on top: `bun run gate`, run unpiped
with a scratch HOME, SCRIPTORIUM_HOME and TMPDIR, exited 0 (6547 pass, 0 fail).
The shipped Scriptorium is unchanged. Its `--help`, `--version`, and a scripted
`open --no-open`, `state`, `meta` and `close` on a scratch home give the same
output against the cycle tip's dist as against this branch's. The only
difference is the random session epoch.

## Port-back notes

- `DocumentPane` gains `textOffer?: (doc, text) => TextOffer | null` in
  `DocumentPaneSlots`, and exports the `TextOffer` type (`id`, `message`,
  `label`, `take`).
  - The pane shows the offer as a line under the header, with `data-slot`
    `text-offer` and `data-offer` set to the id.
  - Taking it awaits `take()`. It then asks `textOffer` again with the text as
    it is then, and writes only if the same offer still stands.
  - It inserts at offset 0: through the editor's `replaceRange` when the raw
    editor is mounted (one undo step), otherwise through `writeText` with the
    change kept in `replay` for the editor's undo, as `chooseRendered` does.
    Then it calls `flushText`.
  - `null` writes nothing. A throw is announced as "Not done: <label>" with its
    message.
  - The slot is not asked for JSON, nor while the app's view is active.
  - Optional; absent, the pane is unchanged.
- Seen while testing, not changed and not fully diagnosed: an edit sent in the
  first moments after an open was kept by the daemon. The client's own copy,
  though, went back to the older text. The likely cause is the open's `read`
  reply arriving after the edit. The kit test waits for the open to settle
  before taking the offer.
