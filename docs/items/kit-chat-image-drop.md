---
type: item
title: An image can be dropped into the chat for the agent
description:
  Dropping an image on the chat composer does nothing; let the human attach an
  image to a message for the agent, kept in the session (not added to the
  context list), so a one-off screenshot reaches the agent without becoming a
  document.
status: draft
lifecycle: triage
id: 01a16627-6435-72c8-b7d6-9cc5c05034b9
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
---

# An image can be dropped into the chat for the agent

Cole, 2026-10-22. He wanted to send a screenshot to the agent through
Scriptorium's chat, a one-off reference, and couldn't: the composer takes no
drop. Adding it to the context list works, but it makes a one-off image a
document of the session, and the drop dialog then asks where it should go
([kit-drop-keep-where-it-is](kit-drop-keep-where-it-is.md)).

**What it needs:** dropping or pasting an image on the composer attaches it to
the message, shown as a chip the human can remove before sending. The daemon
keeps the image in the session's own store (as imports are kept), not in the
context list. The agent's `message` event carries the image's path (and
`about`-style metadata), so it can read the file. The SKILL says so.

## Definition of done

- [ ] Dropping or pasting an image on the composer attaches it as a removable
      chip, and sending carries it with the message.
- [ ] The image is kept in the session, not added to the context list.
- [ ] The agent's tail event names the image's path, and the SKILL tells the
      agent how to read it.
- [ ] Non-image drops on the composer get a clear refusal, or the same treatment
      if agreed.
- [ ] Tested, checked in a real browser; offered on kit-parity.
