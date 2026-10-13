---
type: item
title: Where our messaging and context direction meets Story Studio's kit
description:
  "For each idea in Spellbook's earlier context, chat and message-log thinking:
  is it superseded by what Story Studio built, an evolution to carry on top of
  the ported kit, or a direction still open?"
status: draft
lifecycle: triage
id: 01a13662-6a31-7495-b914-eafa00335352
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, chat, context, story-studio]
parent: feature/workspace-kit
from: feature/workspace-kit
---

# Where our messaging and context direction meets Story Studio's kit

[Workspace Kit](../features/workspace-kit/feature.md) ports Story Studio's chat
and context modules as they are. Spellbook was already heading somewhere
similar, and some of that thinking may go further than what Story Studio built.
Cole (2026-10-13): Story Studio's improvements are real, but they don't
necessarily supersede our direction for messaging and context. Before the
workspace stack's chat and context modules are ported, map where the two meet.

**Spellbook's prior thinking to weigh:**

- [Context and Chat Kit](../features/context-and-chat-kit/feature.md): the ref
  contract (pinned/live, range union, role, resolution that refuses with
  candidates), drop intake, and the gated headless context list.
- [Shared context and chat components](./shared-context-and-chat-components/write-up.md):
  the census, ref chips in messages, telling gestures apart from typed messages,
  the UI not knowing the backend (disk, db, inline), the two channels _selected_
  and _active_, adapter capabilities.
- [The communication log as a primitive](./message-log-primitive/write-up.md):
  mind-mapper's `messageChannel.ts`, with channels, gesture provenance, `ground`
  and facets; the naming questions (`who`/`role`, `kind`).
- [Context as a first-class primitive](./context-primitive/write-up.md): a
  cross-project standard for context documents (`rel`, OKF, where the standard
  lives, the agent's cheap map).
- House canon: the message-surface paradigm, ambient vs intent, one state with
  one meaning, conversation as the primary capability.

**Story Studio's side** (`~/Projects/dreamwood/story-studio/packages/kit/src`,
read only):

- message `about` and `HeldSelection` (`workspace/protocol.ts`,
  `context/selection.ts`);
- `Message {from, type, about}`, the quiet tail's `TailRule`;
- the context model (`context/model.ts`, coupled to the workspace protocol);
- document profiles, typed relations, links to headings, bundles.

Already settled: the chat's refs port as they are, and the broader ref contract
comes later (Cole, 2026-10-13).

The decision this feeds: what the workspace stack's chat and context modules
carry beyond the port, and in what order; which of the four earlier documents
close, continue, or fold into Workspace Kit.

## Definition of done

- [ ] A write-up that sorts each prior idea as superseded (Story Studio's
      version is as good or better), an evolution (carry it on top of the ported
      module, with where it attaches), or an open direction (outside Workspace
      Kit), each with evidence from both codebases
- [ ] A recommendation for each of the four earlier documents (close, continue,
      or fold in), with Cole's ruling
- [ ] The evolutions are added to Workspace Kit's chat and context work, before
      that cycle starts

## Related Documents

- [Workspace Kit](../features/workspace-kit/feature.md)
