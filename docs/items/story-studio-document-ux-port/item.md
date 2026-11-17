---
type: item
title: Which of Story Studio's new document UX should Scriptorium take?
description:
  Since the 2026-10-12 port-back scan, Story Studio has shipped about 37 cycles;
  this finds the document-UX features among them, such as the inbox and the icon
  tabs in the right column, that Scriptorium should port.
status: stable
lifecycle: ready
id: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
kind: research
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [scriptorium, kit, story-studio, ux]
parent: feature/workspace-kit-follow-ups
from: 01a131ec-fb0f-71a4-b587-d155e3d4f56d
cycle: 2026-11-research-and-safety
---

# Which of Story Studio's new document UX should Scriptorium take?

Story Studio forked Spellbook's kit and Scriptorium on 2026-09-30. The last
port-back scan,
[What to take back from Story Studio](../_archive/story-studio-port-back/item.md),
was on 2026-10-12. Since then Story Studio has closed about 37 cycles and made
over 900 commits. Most of that work is Story Studio's own: projects, boards,
stages, audio and packaging. Some of it is document UX that Scriptorium shares,
and Cole has found it useful in his real use. Two examples:

- **The inbox.** It tells the human what is still waiting on them: agent
  versions not yet taken or passed over, notes owed a reply, and agent actions
  in the background. It came from the inbox-and-copies cycle (2026-11-13), in
  commits `3539a3e1`, `523e4834` and `365f91ea`.
- **Icon tabs in the right column** (`416160b2`, from the links-and-colors cycle
  of 2026-11-16).

The question is which of Story Studio's document-UX changes since 2026-10-12
Scriptorium should take, which can wait, and which don't fit it. The answer
decides which items to file for the next feature cycle. It covers UI only: the
kit's bug fixes already come back over `kit-parity`.

## Definition of done

- [ ] The write-up lists every document-UX candidate from Story Studio since
      2026-10-12. Each one has evidence on Story Studio's side (a cycle, commit
      or path) and says what Scriptorium has today.
- [ ] Each candidate has a call: take, take later, or skip. Each call says why,
      including where Story Studio's project and file-tree model doesn't fit
      Scriptorium's.
- [ ] Cole has reviewed the calls. Each one he takes is filed as an item with
      `--from item/story-studio-document-ux-port`.

## Related Documents

- [What to take back from Story Studio](../_archive/story-studio-port-back/item.md)
