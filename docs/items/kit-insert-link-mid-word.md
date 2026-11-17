---
type: item
title: Insert a link at a point lands mid-word and unspaced
description:
  "GitHub #147: a link inserted at a point goes exactly there, so in the
  rendered view it can split a word, and after a word it gets no space."
status: draft
lifecycle: ready
id: 01a1eabe-f525-7750-8c5a-624d7549f123
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, links, editor]
parent: feature/workspace-kit-follow-ups
source: "#147"
priority: medium
---

# Insert a link at a point lands mid-word and unspaced

Filed as GitHub #147. "Insert a link" with no selection writes the link at the
exact point. In the rendered view that is the character under the pixel, so a
link can split a word (`sta[ZZ](…)ge`). In either view, a link right after a
word gets no space (`on.[text](…)`). Not reproduced here yet.

Story Studio's change (branch `feat/editor-polish`, no commit named yet):

- `snapToWordEdge(text, at)` in `linkInsert.ts` snaps a no-selection point from
  the menu to the nearer word edge, start on a tie. Word characters are
  `\p{L}\p{N}_`, with an apostrophe only between letters.
- `paddedLink(link, text, at)` adds a space before after non-whitespace, unless
  after an opener (`(`, `[`, curly quotes, or a straight quote after
  whitespace), and a space after when a word follows.
- ⌘⇧K at a caret places the link as the caret says, padded except between two
  word characters.

Neither helper is on develop. The callers it names, `askLinkAt`, `chooseLink`
and `chooseRendered`, are in `src/kit/document/DocumentPane.tsx`. Touches the
same menu as
[kit-right-click-away-from-selection](kit-right-click-away-from-selection/item.md).

## Definition of done

- [ ] A link inserted at a point never splits a word, and is spaced from the
      words beside it, in raw and rendered.
- [ ] Tests for the snap and the padding rules, and existing tests updated.
- [ ] #147 answered and closed once released.
