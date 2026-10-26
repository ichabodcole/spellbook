---
type: item
title: Split the kit's oversized modules, starting with session.ts
description:
  src/kit/workspace/session.ts is 9,040 lines and server.ts 5,357; find the
  seams, propose a split that keeps port-back with Story Studio workable, and
  list the other files worth splitting.
status: draft
lifecycle: backlog
id: 01a17a8e-259e-77a4-b704-af6c786e9732
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-26 }
parent: feature/workspace-kit-follow-ups
---

# Split the kit's oversized modules, starting with session.ts

Asked for by Cole on 2026-10-26, after triage found three bug clusters all
editing `src/kit/workspace/session.ts`. Lines, measured that day:

| file                                | lines |
| ----------------------------------- | ----- |
| `src/kit/workspace/session.ts`      | 9,040 |
| `src/kit/workspace/server.ts`       | 5,357 |
| `src/bounty/backend/server.ts`      | 2,791 |
| `src/grapevine/backend/cli.ts`      | 2,562 |
| `src/bounty/backend/cli.ts`         | 2,552 |
| `src/kit/document/DocumentPane.tsx` | 2,405 |
| `src/kit/shell/WorkspaceShell.tsx`  | 2,341 |
| `src/kit/workspace/protocol.ts`     | 2,222 |
| `src/kit/workspace/verbs.ts`        | 2,040 |

The size costs us in two ways. Parallel branches collide in one file, so work
that is otherwise independent has to be done in sequence. And an agent can't
hold the module in view: it reads 9,000 lines in slices, and misses what's
outside the slice it read.

Two constraints:

- **Port-back.** Story Studio's kit (`packages/kit/src/workspace/session.ts`)
  has the same shape, and both teams cite each other's line numbers on
  kit-parity. If our split differs from theirs, porting gets harder in both
  directions. Agree the split with them before building it.
- **Lazy loading.** The daemon and every CLI spawn load the session. Some
  modules are kept out of that path on purpose (for example `notPlaced.ts`, and
  `loadNoteGuard`'s lazy import of the markdown parser), so a split mustn't pull
  heavy imports back into the start-up path.

## Definition of done

- [ ] A write-up maps `session.ts` and `server.ts` into proposed modules, each
      with what it owns, with the import graph and start-up path checked for
      every module.
- [ ] Each other file in the table is either recommended for a split, with
      proposed seams, or marked to leave alone, with the reason.
- [ ] The split has been offered to Story Studio on kit-parity, and their answer
      is recorded.
- [ ] Cole has decided whether to build it and when, and the build items are
      filed.
