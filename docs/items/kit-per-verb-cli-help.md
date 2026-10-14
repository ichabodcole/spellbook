---
type: item
title: Per-verb CLI help, with an acc re-run
description:
  Port the kit's per-verb help into src/kit/cli and re-run acc for every spell
  whose schema it changes.
status: stable
lifecycle: active
id: 01a13706-98cd-77ec-8780-7af9e1e51778
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, cli, acc]
cycle: 2026-10-kit-foundation
parent: feature/workspace-kit
---

# Per-verb CLI help, with an acc re-run

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s first cycle.
Port Story Studio's per-verb help into `src/kit/cli`. It changes each adopting
CLI's schema, so acc is re-run for every spell whose schema changes. The
reply-shape leftovers (`outcome-nouns-left-to-migrate`,
`spell-refusal-envelope-nits`) touch the same CLIs and can join here if they are
still open (Cole, 2026-10-13).

It also replaces the hard-coded exit codes 124 and 130 that the `lib`/`wire`
port left in other spells with the kit's `EXIT_IDLE_TIMEOUT` and
`EXIT_CANCELLED`. They are in glamour, astrolabe, digestify, scriptorium and
imago (`backend/server.ts` or `review.ts`). Bounty's `onFatal("SIGINT", 130)`
stays a literal, because it is a signal exit.

## Definition of done

- [ ] `src/kit/cli` gives per-verb help, and the spells on it use it
- [ ] No spell hard-codes 124 or 130 where the kit's constant applies
- [ ] acc passes for every spell whose schema changed, with any new known
      failure recorded as debt
