---
type: item
title: The kit CLI's add-folder makes a folder literally named ~
description:
  add-folder ~ (when the shell leaves ~ unexpanded, e.g. quoted) creates a
  folder named ~ in the caller's directory, while the surface's new folder at a
  path refuses the same input; expand a leading ~ the way the surface does, or
  refuse it.
status: stable
lifecycle: done
id: 01a14cb0-b4b0-7668-b41a-d2b31887f5ed
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-17 }
parent: feature/workspace-kit
from: features/workspace-kit/sessions/2026-10-17-panes.md
cycle: 2026-10-shell
---

# The kit CLI's add-folder makes a folder literally named ~

Found by the panes cycle's verifier of `scriptorium-kit-ask-location`
(2026-10-17). When `~` reaches the kit CLI unexpanded (quoted, or from a
script), `add-folder ~` creates a folder named `~` in the caller's directory.
The surface's "new folder at a path" refuses the same input (`~` already exists
as the home folder). The two should agree.

## Definition of done

- [x] `add-folder ~` and `add-folder ~/x` either expand a leading `~` as the
      surface does or are refused, and never create a folder named `~`.
- [x] A test covers both.

## Done and verified

`fix(kit): a literal ~ in a CLI path is refused, never made a folder` on
`impl/kit-cli-contract-v2` (2026-10-19).

**Refused, not expanded: deliberately stricter than the shipped CLI.** Driven
side by side on scratch homes: an unquoted `~/x` reaches either CLI already
expanded by the shell, as a full path, and works. A quoted `"~"` or `"~/x"`
arrives as it is. The shipped CLI never expands it: it resolves it against the
cwd, so its `new-folder`, `new-doc` and `add` fail when `<cwd>/~` is not in the
session or not on disk, and, when the cwd is inside a set, make a literal `~`
there (`new-folder "~"` makes `docs/~`; found by the verifier). Neither
expanding nor making `~` is kept: the kit refuses. The kit path had resolved the
same way, so `add-folder "~"`, whose parent (the cwd) exists, made a folder
named `~` there, and `add-folder "~/x"` made `x` inside it. The kit CLI now
refuses a token that is `~` or starts with `~/` (`pathArg`,
`src/kit/workspace/verbs.ts`) as `usage`, before any daemon call, with the
expanded path in the hint ("write the full path (…), or leave the ~ unquoted for
the shell to expand"), and, when a real `./~` exists in the cwd, "; for the
<cwd>/~ here, write ./~". A `~` later in a path, or a name such as `~notes`, is
a name. Expanding it, as the surface's typed paths do, was not taken: it would
make a quoted path mean something the shell did not, and a quoted `~` is usually
a quoting mistake worth saying.

It covers every kit verb that takes a path to make or add: `add` and `open`
(through `contextPaths`), `new-doc`, `new-folder`, and Scriptorium's
`add-folder` and `make-set` (`src/scriptorium/backend/kit/commands.ts`, through
the new `CliHelpers.pathArg`). `rename`, `move` and the other path verbs are
unchanged: a literal `~` there names nothing that exists, and the daemon refuses
it.

Tests: `src/kit/workspace/verbs.test.ts` (`pathArg` refuses `~`, `~/x`,
`~/a/b.md` with the expanded hint and passes `notes/~` and `~notes`; the fixture
CLI's `new-folder`, `new-doc`, `add` and `open` refuse a literal `~` with exit
2, stdout empty, and nothing made in the cwd), and
`src/scriptorium/backend/kit/nohome.integration.test.ts` (`add-folder "~"` and
`"~/x"` on a live kit session: usage, and no `~` folder made). Mutations: the
check off turns both kit tests red; `add-folder` back on a bare `resolve` turns
the Scriptorium test red.

**Fix round (verifier, 2026-10-19).** `make-set` back on a bare `resolve` left
every test green: the Scriptorium test now also runs `make-set "~"` and
`make-set "~/x.md"`, and that mutation turns it red. The hint names `./~` when
one exists (a new `verbs.test.ts` case, with `open "~"` and `open "~/x"` where
`./~/x` exists, and none where it does not; dropping the clause turns it red).
The write-up above was corrected: the kit is stricter than the shipped CLI, not
the same.

## Port-back notes

- `src/kit/workspace/verbs.ts`: new exported `pathArg(token, verb)`, and
  `CliHelpers.pathArg` so an app's verbs use it; `contextPaths(pos, verb)` takes
  the verb's name for the message and runs each path through `pathArg`;
  `new-doc` and `new-folder` use it in place of `resolve`. Story Studio's
  `contextPaths`, `new-doc` and `new-folder` at `develop` `5b3bd8d`
  (`packages/kit/src/workspace/verbs.ts`) resolve a literal `~` against the cwd
  the same way.
