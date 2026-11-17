---
type: item
title: task-done doesn't take --stdin or --body-file
description:
  "GitHub #145: task-done takes its outcome only as positionals, so a multi-line
  result with backticks can't go through a file, as the SKILL asks of prose."
status: stable
lifecycle: active
id: 01a1eabe-f419-7485-9225-8ff80903f526
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, cli]
parent: feature/workspace-kit-follow-ups
source: "#145"
priority: medium
cycle: 2026-11-research-and-safety
---

# task-done doesn't take --stdin or --body-file

Filed as GitHub #145, seen in 5.1.0. `task-done <id> --stdin` is refused with a
usage error: `--stdin` is a known flag, just not this verb's. `task` and `say`
take `--stdin` and `--body-file`, and the SKILL's rule 4 says prose goes through
a file. A `task-done` outcome is often the real result of the task: several
lines of markdown with backticks. The only form left is a quoted positional,
which rule 4 warns against. The reporter split one event into a one-line
`task-done` and a `say --stdin`.

On develop the verb is in `src/kit/workspace/verbs.ts`, with flags
`[...SESSION, "failed"]` and the outcome as variadic positionals. It still takes
no body flag.

**Suggested fix:** accept `--stdin` and `--body-file` on `task-done`, as `task`
and `say` do. The issue's alternative is a SKILL note that `task-done` takes a
short line and the result follows in a `say`.

## Definition of done

- [ ] `task-done <id> --stdin` and `--body-file <path>` set the outcome, with
      `--failed` too. A positional outcome with either is refused.
- [ ] Tested, with the declaration re-recorded, and the SKILL updated.
- [ ] #145 answered and closed once released.
