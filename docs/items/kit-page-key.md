---
type: item
title: Only the page can act as the human
description:
  The page's socket and the human's routes require a key the page fetches, so a
  plain local call such as an agent's curl cannot act as the human.
status: stable
lifecycle: backlog
id: 01a1eb00-558a-7708-a1eb-96e1bcb40c04
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
blocked_by: [01a20f86-95ae-7357-8026-a46b53bb5192]
priority: high
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Only the page can act as the human

From the Story Studio port scan (2026-11-17). A kit daemon trusts a request as
the human's when its Origin header passes (`src/kit/wire/origin.ts`). A plain
local call, such as an agent's `curl` with no Origin header, passes that check,
so it can act as the human: activate a version, save, delete. That breaks the
house rule that the human's act is the human's.

Story Studio closed it in `1d7b4d29`: the page fetches a per-daemon key, and the
page's socket and the human's `/fs` routes require it
(`packages/kit/src/workspace/daemon/http.ts`, `context/daemonClient.ts`).

It touches `server.ts` and the daemon client throughout, so it waits on the
split's [D9](kit-split-d9.md), which creates `daemon/http.ts`.

## Definition of done

- [ ] The page's socket and every human-only route refuse a request without the
      daemon's key, with a test that a bare `curl` is refused.
- [ ] The page gets the key without the human doing anything, and the agent's
      verbs work as before.
- [ ] Every kit spell's daemon does this, not only Scriptorium's.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
