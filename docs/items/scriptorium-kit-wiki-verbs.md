---
type: item
title: Scriptorium's wiki verbs on the kit daemon
description:
  Bring meta, meta-init, meta-set, find, info, forget, move plan, trust tiers
  and the remove verbs to the flagged Scriptorium through the kit's verb and
  appState slots.
status: stable
lifecycle: ready
id: 01a1478f-353c-7581-9e00-69376c30d10d
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
cycle: 2026-10-wiki-layer
parent: feature/workspace-kit
---

# Scriptorium's wiki verbs on the kit daemon

The flagged Scriptorium lacks the shipped app's wiki verbs (the SKILL delta in
[scriptorium-on-kit-daemon](./scriptorium-on-kit-daemon.md)). Most need no new
kit slot: they go in through the kit's `verbs`, the CLI's `commands`, and
`appState`
([write-up, 3a](../items/workspace-stack-port-shape/write-up.md#3a-the-wiki-layer-against-the-four-extension-points)).

**Move plan:** Cole ruled on 2026-10-16 that the move plan is a daemon command
in this cycle. The confirm dialog that shows it comes in cycle 3, with the
panes.

## Definition of done

- [ ] On the flagged path, `meta`, `meta-init`, `meta-set`, `find`, `info` and
      `forget` behave as the shipped verbs do, with tests ported from the
      shipped suite.
- [ ] `docMeta`, the trust tier and `stale` reach the agent through `appState`.
- [ ] A move plan is a daemon command: what would move, and which links would
      change. It writes nothing.
- [ ] `note-remove`, `task-remove` and `tasks-clear` are either built or mapped
      to the kit's verbs, and the SKILL delta says which.
- [ ] acc is conformant on both paths, the census is re-run for the flagged CLI,
      and the default path is unchanged.
