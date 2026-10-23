---
type: item
title: A move's relink misses versions the agent proposed
description:
  relink and link-check read only a document's active version, so a version the
  agent proposed before a move keeps the old link and nothing reports it when
  the human later activates it.
status: stable
lifecycle: ready
id: 01a15bca-2b17-722c-ace0-957826510f24
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
cycle: 2026-10-polish
---

# A move's relink misses versions the agent proposed

Found by the cold read of the cutover's SKILL rewrite (2026-10-20). After `move`
or `rename`, `relink` rewrites links in each document's active version, and
`link-check` checks only active versions. A version the agent proposed before
the move, and the human has not yet taken, keeps the old path. When the human
activates it, the link is broken and nothing said so. The SKILL now warns the
agent about it.

## Definition of done

- [ ] A move's relink also reaches proposed versions, or `link-check` reports a
      broken link in a proposed version and names it, with the act that fixes
      it.
- [ ] Tested, and offered on kit-parity.
