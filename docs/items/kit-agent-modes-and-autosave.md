---
type: item
title: Ask and Auto modes, consent and autosave for the kit
description:
  How Story Studio's working modes, progressive consent and autosave would work
  in Spellbook's kit, with global settings and short-lived sessions.
status: stable
lifecycle: backlog
id: 01a1eb00-5501-74c8-b80c-d7280c6f7fba
kind: research
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, research]
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Ask and Auto modes, consent and autosave for the kit

From the Story Studio port scan (2026-11-17). Story Studio has three linked
things Scriptorium lacks:

- **Working modes, Ask and Auto** (`5d3a0ec9`, `lib/agentMode.ts`,
  `document/AgentModeSwitch.tsx`). In Ask the agent proposes versions and the
  human takes them, which is how Scriptorium works today. In Auto the agent's
  change becomes the active version, saved as one undo step, unless the human is
  typing.
- **Progressive consent** (`dd1ee44e`, `fa73cbda`, `bee30a6b`). An `ask` verb
  blocks on a dialog (once, always or no); deleting and spending are off until
  the human allows them; a refusal exits 8 with `confirmation_required`.
- **Autosave** (`188b5d41`, `d23ba145`), with Save and Revert shown only for
  what autosave won't write, Save As, and a setting.

**Cole (2026-11-17):** do all three, not necessarily now. Ask and Auto and the
progressive consent are useful. For Scriptorium the settings are **global**, not
per folder: a session is short, not a project you live in, so Story Studio's
nearest-folder settings don't apply. Whether choices survive across sessions is
open; his guess is yes, or you would re-decide every session, but the
implementation settles it. Keep Story Studio's UX where it makes sense for
Scriptorium.

The question is how. Story Studio stores the mode per project in its project
home and runs an always-running service; Spellbook has neither.

## Definition of done

- [ ] A write-up reads Story Studio's implementation (the commits above) and
      says what each part depends on.
- [ ] It says where Spellbook's global settings would live, whether choices
      persist across sessions, and how each part maps onto a Scriptorium session
      and the kit's other spells.
- [ ] Cole has made the call, and the build items are filed.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
