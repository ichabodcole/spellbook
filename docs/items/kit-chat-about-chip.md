---
type: item
title:
  The chat chip stores and labels an app's about parts; entryIds gets a gesture
  or goes
description:
  A message chip keeps and names the about parts an app adds (Scriptorium's
  version and selection), and the agent-only entryIds field either gets a
  surface gesture that sends it or is removed from the wire.
status: stable
lifecycle: triage
id: 01a14bca-16a0-772c-a8d2-b31df9ffef83
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, chat]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# The chat chip stores and labels an app's about parts; entryIds gets a gesture or goes

Two leftovers from the port-shape plan's row 3. Neither is built in Story Studio
(their `kit-about-bundle` is backlog).

- **An app's own `about` parts.** A message's `about` can carry parts an app
  adds, such as Scriptorium's version or selected passage. The chip shows only
  the kit's parts and drops the rest when it shows the message again. The chip
  should store the app's parts with the message and label them in the app's own
  words.
- **`entryIds`.** The agent's `say` keeps `entryIds` (`kit-port-via-refs`), and
  the message view shows "N context items". No surface gesture sends it, so it's
  only half a feature. Either a gesture sends it, such as asking about several
  selected entries, or it's removed from the wire.

## Definition of done

- [ ] A message keeps an app's `about` parts through storage and restore, and
      the chip labels them in the app's words. A test uses a fixture app's part.
- [ ] `entryIds` is either sent by a named gesture on the surface, or removed
      from the wire, the CLI and the SKILL. The decision and its reason are
      recorded here.
- [ ] The flagged Scriptorium's version and selection show on its chips.
