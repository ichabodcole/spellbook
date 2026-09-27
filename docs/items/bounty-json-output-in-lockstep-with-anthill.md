---
type: item
title: Switch bounty's list and sessions to JSON in lockstep with anthill
description:
  bounty's list and sessions stay prose because anthill's team-convene.ts
  regex-parses bounty sessions; switch both together so acc B5 is checked and
  the anthill#43 guard keeps working.
status: draft
lifecycle: triage # triage | backlog | ready | active | review | done | dropped
id: 01a0e0b7-1845-7476-8f6a-5c54862aea60
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
from: 01a0e03d-f826-7663-8e5f-e343cc87d3c6
---

# Switch bounty's list and sessions to JSON in lockstep with anthill

From [the bounty acc item](acc-conformance-bounty.md) and decision log #20 in
[the acc feature](../features/spell-cli-acc-conformance/decision-log.md).

`bounty list` and `bounty sessions` print prose, so bounty cannot declare
`defaultOutput: json` and acc's B5 stays `unverified`. They stayed prose because
anthill's `team-convene.ts` (`parseBountySessions`) regex-parses
`bounty sessions` for its anthill#43 snapshot guard, and skips lines it cannot
parse: switching bounty alone would disable that guard with no error.

## Definition of done

- [ ] anthill reads bounty's JSON (`bounty sessions`), shipped first or
      together.
- [ ] `list` and `sessions` print JSON by default, with `--human` for today's
      prose (imago's pattern); `acc.config.json` declares
      `"defaultOutput": "json"` and B5 reads checked.
- [ ] The golden snapshot's diff is exactly the output change, named in the
      commit.
