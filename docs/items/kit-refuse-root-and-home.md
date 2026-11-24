---
type: item
title: Refuse the disk root and HOME as a set
description:
  Opening the disk root or the home folder as a set is refused, as Story Studio
  refuses them as a project.
status: stable
lifecycle: backlog
id: 01a1eb00-57ba-711b-8823-5c3e4ae68558
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Refuse the disk root and HOME as a set

From the Story Studio port scan (2026-11-17). A kit session can open any folder
as a set, including `/` or the home folder. The daemon then scans and watches
everything below it.

Story Studio refuses the disk root, `$HOME` and its own studio home as a project
(`28376008`). Spellbook already has the `O_NOFOLLOW` and realpath guards
(`src/kit/workspace/disk.ts`); these two refusals are what's missing.

## Definition of done

- [ ] Adding `/` or the home folder as a set is refused, with a message that
      says why and suggests a narrower folder.
- [ ] A test covers both, including through a symlink to either.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
