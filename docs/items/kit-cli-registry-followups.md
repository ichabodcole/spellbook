---
type: item
title: Per-verb help follow-ups in the kit's CLI registry
description:
  Group words have no help, two hand-written root helps do not mention help
  <verb>, required flags are not marked in schema, a required flag with a
  default can never be missing, and no spell supplies flagHelp or examples yet.
status: draft
lifecycle: triage
id: 01a138c6-afb2-7406-a222-5672da0779f7
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, cli]
parent: feature/workspace-kit
from: features/workspace-kit/sessions/2026-10-13-kit-foundation.md
---

# Per-verb help follow-ups in the kit's CLI registry

Per-verb help landed in the kit's CLI registry in the kit-foundation cycle.
Verification and the finalize review left these for later:

- Group words have no help. `mind-mapper node --help` and `help node` are
  refused.
- Grapevine's and mind-mapper's hand-written root help doesn't mention
  `help <verb>`.
- `schema` doesn't mark a required flag as required. A required flag with a
  `default` can never be missing, yet its usage line shows it as required.
- No spell supplies `flagHelp` or `examples`, so verb help lists flag names
  only.
- The differential test's help oracle re-implements the same rule as
  `asksForHelp`. It proves the wiring, not the rule. The base comparison is what
  checks the rule.

## Definition of done

- [ ] `<group> --help` and `help <group>` list the group's verbs
- [ ] `schema` marks required flags, and `defineCli` refuses a required flag
      that has a default
- [ ] The two hand-written root helps mention `help <verb>`

## Related Documents

- [Kit foundation — 2026-10-13](../features/workspace-kit/sessions/2026-10-13-kit-foundation.md)
