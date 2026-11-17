---
type: item
title: "Scriptorium: image embeds through a guarded file route"
description:
  "GitHub #139: render image embeds through a guarded /fs/file route with
  nothing fetched early, refuse remote and SVG images, and count embeds as
  links; the kit shipped this in 6.0.0, unconfirmed in Scriptorium."
status: draft
lifecycle: dropped
id: 01a1eabe-f0ec-769d-a59c-a107bc79c959
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, images, security]
parent: feature/workspace-kit-follow-ups
source: "#139"
---

# Scriptorium: image embeds through a guarded file route

Filed as GitHub #139, from Story Studio's `b5aee1b` (embeds) and `820bec7` (file
route, Host check). Before the kit, Scriptorium wrote `<img src="x.png">`, which
404ed. A remote image was fetched on render, so it could act as a tracking
pixel. A missing image was never reported.

Story Studio's shape:

- An embed renders as a placeholder span, and becomes an image only after the
  daemon says what its target is (`link.embeds`). Lazy, sized from the image
  header, never enlarged.
- Remote images and SVG are refused.
- `GET /fs/file` serves only an image node inside its entry's root realpath,
  opened with `O_NOFOLLOW`, its type sniffed from the bytes.
- Embeds count as links in backlinks and link-check.

On develop the kit has `embedSpans` (`src/kit/document/embeds.tsx`),
`openNoFollow` (`src/kit/workspace/images.ts`), `sniffImage` and the `/fs/file`
route, shipped in 6.0.0. Not checked against the issue point by point yet. The
Host check is its own item,
[kit-origin-guard-dns-rebinding](kit-origin-guard-dns-rebinding.md) (#143).

**Dropped on filing (2026-11-17):** a check found GitHub #139 already
implemented in spellbook 6.0.0, so the issue was closed with the evidence and
there is nothing to do here.

## Definition of done

- [ ] Each point in #139 is confirmed on develop with its test, or ported.
- [ ] In Scriptorium, in a real browser: a local embed shows, a remote one and
      an SVG are refused, and link-check reports a missing one.
- [ ] #139 answered and closed once released.
