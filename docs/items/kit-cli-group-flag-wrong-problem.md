---
type: item
title: A flag before a group's sub-command is reported as the wrong problem
description:
  "`<cli> <group> --nope` is refused as 'expected a sub-command', never naming
  the flag; Image Farm's fix names it and hints to put the sub-command first."
status: draft
lifecycle: ready
id: 01a1eabe-f6bc-7056-9707-821f7cca248b
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, cli]
parent: feature/workspace-kit-follow-ups
priority: low
---

# A flag before a group's sub-command is reported as the wrong problem

Reported by Image Farm on `kit-parity` (message 63, point 1), their item
`registry-group-flag-rejection` (develop `30241167`).
`image-farm library --nope` falls into the group branch of `resolve` in the CLI
registry, which only knows "expected a sub-command". The flag is never named, so
an agent can't tell it misplaced it. Not reproduced here yet.

Our counterpart is `src/kit/cli/registry.ts`, where the group branch dies with
`${cand}: expected a sub-command` (around line 660).

**Image Farm's fix:** when a group has no sub-command and a flag-like token is
present, the usage error (still exit 2, `choices` unchanged) reads
`<group>: expected a sub-command before any flag, got --nope`, with the hint
`put the sub-command first: <cli> library <sub-command> --nope`. `=value` is
stripped from the named flag. The no-flag message is unchanged. Port-back files:
`src/cli/registry.ts` and `src/cli/registry.test.ts` (a new case, and the
"adjacent group does not look past a flag" case, which asserted the old text).

Related: [kit-cli-registry-followups](kit-cli-registry-followups.md).

## Definition of done

- [ ] A flag before a group's sub-command is named in the refusal, with the
      hint. The no-flag message is byte-identical.
- [ ] Tested in `registry.test.ts`.
- [ ] Posted on `kit-parity`, or Image Farm's change is ported.
