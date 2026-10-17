---
type: item
title: A kit whole-manifest migrate hook, and Scriptorium's session converter
description:
  Add a hook that rewrites a whole manifest before restore, and Scriptorium's
  converter for shipped sessions, dry-run against copies of real sessions.
status: stable
lifecycle: ready
id: 01a1478f-34ad-7712-b515-b36144069584
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
cycle: 2026-10-wiki-layer
parent: feature/workspace-kit
---

# A kit whole-manifest migrate hook, and Scriptorium's session converter

At the cutover, the kit must open the sessions the shipped Scriptorium wrote.
The kit's app-slot migrate only rewrites the app's own slot, and the core
manifest differs
([write-up, 3h](../items/workspace-stack-port-shape/write-up.md#3h-sessions-under-scriptorium-and-the-migration)):

- times in milliseconds, not ISO;
- chat `who`, not `from`, with no `type` or `about`;
- tasks with `text`, `who` and other statuses;
- versions with `author` and `from`;
- notes with `who`;
- `context[].hidden`, which moves to the app slot.

The write-up prefers a hook that runs before restore, so each session migrates
lazily and the version files never move. Story Studio has no migration of its
own, so the hook is offered back but not needed there.

## Definition of done

- [ ] The kit's app declaration can supply a whole-manifest migrate, run before
      the format check. A manifest it can't convert is refused with the reason
      and left unwritten.
- [ ] Scriptorium supplies a converter for every manifest shape the shipped app
      has written, with a test per shape.
- [ ] The old default workspace becomes an ordinary added folder, as
      [scriptorium-no-default-workspace](./scriptorium-no-default-workspace.md)
      requires.
- [ ] A dry run against copies of Cole's real sessions, made under a scratch
      home, converts every one, and each restores on the flagged daemon. Any
      that can't convert are listed with the reason. The real `~/.scriptorium`
      is only read.
- [ ] The converter stays off the default path until the cutover.
