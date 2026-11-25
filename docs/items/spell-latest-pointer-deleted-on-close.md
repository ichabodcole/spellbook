---
type: item
title:
  magpie and glamour delete their latest pointer when the newest session closes
description:
  magpie's and glamour's daemons delete their latest discovery pointer at exit
  when it names them, as bounty's did, so with two sessions running, unpinned
  verbs lose the one still running.
status: draft
lifecycle: triage
id: 01a2110c-7014-7207-8c22-7462e077f9de
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-24 }
from: items/bounty-latest-pointer-and-list-title/sessions/2026-11-24-latest-goes-to-a-running-board.md
---

# magpie and glamour delete their latest pointer when the newest session closes

Found by the implementer of
[bounty-latest-pointer-and-list-title](./bounty-latest-pointer-and-list-title/item.md),
not checked further. `src/magpie/backend/server.ts` (around line 910) and
`src/glamour/backend/server.ts` (around line 612) delete their `latest`
discovery pointer at exit when it names the closing daemon, as bounty's did. If
either spell can run two sessions at once, closing the newest leaves unpinned
verbs with no session though one is still running. bounty's fix
(`src/bounty/backend/discovery.ts`) hands the pointer to the newest daemon still
answering.

## Definition of done

- [ ] For each of magpie and glamour: whether two sessions can run at once is
      established; if they can, closing the newest points `latest` at the newest
      still running (or removes it when none is), tested; if they can't, the
      item says so and the spell is left alone.
