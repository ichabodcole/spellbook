---
type: item
title: Mark required flags in the kit CLI registry
description:
  The registry cannot mark a flag required, so help and the acc declaration show
  required flags (astrolabe add --path, magpie element-add --bbox) as optional.
status: draft
lifecycle: triage # triage | backlog | ready | active | review | done | dropped
id: 01a0e0b7-568d-762a-a272-c2359c28d804
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
---

# Mark required flags in the kit CLI registry

`src/kit/cli/registry.ts` models a flag's type, `multiple`, `short` and
`default`, but not `required`. So a flag a verb cannot run without renders as
optional (`[--path ..]`) in help and in the acc declaration: astrolabe's
`add --path` and magpie's `element-add --bbox` today, with the rule held only in
a `check` hook or a describe line. acc's declaration format may not express
required flags either (filed upstream, feedback item 14).

## Definition of done

- [ ] A row can declare a flag required; the registry refuses a missing one with
      a usage error naming it, and help renders it without brackets.
- [ ] The acc declaration carries it, if the format allows; otherwise the gap is
      recorded against the upstream feedback.
- [ ] astrolabe `add --path` and magpie `element-add --bbox` use it, with their
      golden diffs named in the commit.
