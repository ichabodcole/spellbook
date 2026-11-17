---
type: item
title: A daemon says when it is running old code
description:
  After an upgrade, a daemon still running the old build says so on its page and
  in tail, with the act that restarts it.
status: draft
lifecycle: backlog
id: 01a1eb00-5614-77d5-a591-2ce127ec3cea
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
blocked_by: [01a17a8e-259e-77a4-b704-af6c786e9732]
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# A daemon says when it is running old code

From the Story Studio port scan (2026-11-17). After a plugin upgrade, a running
kit daemon keeps serving the old build, and nothing says so. Grapevine's "roll
the daemon after the upgrade" is the same pain, by hand.

Story Studio's service records its build stamp; the page says "updated, restart
to use it", and `start` restarts an out-of-date service by itself (`3a945b58`).
Spellbook has no single service, so this is per daemon: compare the build stamp
the daemon started with against the one on disk, and say so on the page and in
`tail`, with the act that restarts it.

Blocked by [kit-split-oversized-modules](kit-split-oversized-modules.md).

## Definition of done

- [ ] A daemon whose build on disk has changed says so on its page, with a
      restart act, and once in `tail`.
- [ ] Restarting keeps the session, as a restore does today.
- [ ] A test changes the stamp under a running daemon and sees the notice.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
