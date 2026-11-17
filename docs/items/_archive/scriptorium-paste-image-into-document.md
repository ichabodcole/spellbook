---
type: item
title: "Scriptorium: paste or drop an image into a document"
description:
  "GitHub #140: a pasted or dropped image is saved to images/ beside the
  document, with an embed at the caret; the kit shipped this in 6.0.0,
  unconfirmed in Scriptorium."
status: draft
lifecycle: dropped
id: 01a1eabe-f173-7384-94a3-382f9d3de8eb
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, images, editor]
parent: feature/workspace-kit-follow-ups
source: "#140"
---

# Scriptorium: paste or drop an image into a document

Filed as GitHub #140, from Story Studio's `ichabodcole/story-studio@12b6a51`. It
depends on embeds rendering
([scriptorium-image-embeds](scriptorium-image-embeds.md), #139).

The request:

- Paste or drop an image into the raw editor. It is written to `images/` beside
  the document, and `![name](images/….png)` goes in at the caret or the drop
  point as one undoable edit.
- A paste is named by date (`pasted-2026-10-05-153210.png`); a drop keeps its
  name. Names are made unique and shortened. The extension comes from the bytes.
- A copy from a spreadsheet whose HTML has words of its own pastes as text.
- `POST /fs/image?doc=` writes only that folder, capped as it streams. SVG is
  refused; HEIC is converted to JPEG where the OS can.
- The rendered view and non-markdown documents refuse with a hint.
- Link-check counts unused images. One `image.pasted` fact per burst.

On develop the kit has `src/kit/document/imagePaste.ts` (`clipboardImages`,
`pastedImageName`) and the `/fs/image` route, with
`DocumentPane.imagePaste.test.tsx` and `images.guards.test.ts`, shipped in
6.0.0. Not checked in Scriptorium yet. This is not
[kit-chat-image-drop](../kit-chat-image-drop.md), which attaches an image to a
chat message.

**Dropped on filing (2026-11-17):** a check found GitHub #140 already
implemented in spellbook 6.0.0, so the issue was closed with the evidence and
there is nothing to do here.

## Definition of done

- [ ] In Scriptorium, in a real browser: a pasted screenshot and a dropped file
      land in `images/` with an embed, and the rendered view refuses with a
      hint.
- [ ] Anything missing is ported or filed.
- [ ] #140 answered and closed once released.
