---
type: item
title: The daemon's records leave chat for an Activity tab
description:
  "File made, moved, renamed, version activated: the daemon's records go to
  their own Activity list in the right column, so chat holds only the human and
  the agent."
status: draft
lifecycle: backlog
id: 01a1eb00-52d2-74d4-9a58-7f22f32d65cf
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
blocked_by: [01a17a8e-259e-77a4-b704-af6c786e9732]
parent: feature/workspace-kit-follow-ups
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# The daemon's records leave chat for an Activity tab

From the Story Studio port scan (2026-11-17). Scriptorium's chat carries the
daemon's records: "You created…", "moved…", "renamed…", a version made active, a
save (`src/kit/workspace/server.ts` writes them as chat lines). **Cole
(2026-11-17):** they are noise. Most are his own acts, which he already knows
about, and they bury the messages between him and the agent. Anything he needs
to know will be in the inbox
([What still needs me](../features/scriptorium-inbox/feature.md)).

Story Studio moved them out in `a5174d51`. One kit rule,
`packages/kit/src/lib/messageSide.ts`, decides each line's side: a message from
the human or the agent goes to chat; a system line marked `notice` goes to both;
every other system line goes to activity. `chat/ActivityPanel.tsx` (89 lines)
lists them newest first, up to 200, with who and when. What the agent receives
(its tail and the `chat` verb) is unchanged. Our `Message` has no `notice` or
`by` field yet, so the daemon half marks each line where it is said.

This and [kit-icon-tabs](kit-icon-tabs.md) are meant to land on one branch: the
Activity tab is the fourth tab that makes icons pay off. Blocked by
[kit-split-oversized-modules](kit-split-oversized-modules.md).

## Definition of done

- [ ] Chat shows only the human's and the agent's messages, plus notices.
- [ ] An Activity tab in the right column lists the daemon's records, newest
      first, each with who did it and when.
- [ ] The agent's tail and `chat` verb return the same as before, with a test.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
