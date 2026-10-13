---
type: item
title: Per-verb CLI help, with an acc re-run
description:
  Port the kit's per-verb help into src/kit/cli and re-run acc for every spell
  whose schema it changes.
status: stable
lifecycle: ready
id: 01a13706-98cd-77ec-8780-7af9e1e51778
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, cli, acc]
cycle: 2026-10-kit-foundation
parent: feature/workspace-kit
---

# Per-verb CLI help, with an acc re-run

Step 6 of [Workspace Kit](../features/workspace-kit/feature.md)'s first cycle.
Port Story Studio's per-verb help into `src/kit/cli`. It changes each adopting
CLI's schema, so acc is re-run for every spell whose schema changes. The
reply-shape leftovers (`outcome-nouns-left-to-migrate`,
`spell-refusal-envelope-nits`) touch the same CLIs and can join here if they are
still open (Cole, 2026-10-13).

## Definition of done

- [ ] `src/kit/cli` gives per-verb help, and the spells on it use it
- [ ] acc passes for every spell whose schema changed, with any new known
      failure recorded as debt
