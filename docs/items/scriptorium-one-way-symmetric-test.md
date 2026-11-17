---
type: item
title: Scriptorium tests the one-way symmetric link hint end to end
description:
  The one-way symmetric hint (#142) is tested only in the kit; nothing drives it
  from Scriptorium or in a browser.
status: draft
lifecycle: ready
id: 01a1eac9-922a-75e5-a979-4a2142ecda61
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [scriptorium, links, tests]
parent: feature/workspace-kit-follow-ups
priority: low
---

# Scriptorium tests the one-way symmetric link hint end to end

Found while checking GitHub #142 (closed 2026-11-17). The hint for one-way
symmetric links is in the kit: `oneWaySymmetric` in
`src/kit/workspace/relations.ts`, called from the link check, with its own
section and status-bar mark in `LinkCheck.tsx`. The kit's tests cover it.
Nothing tests it from Scriptorium, which depends on the shared shell and the
relations file being wired the way the kit's tests assume. It hasn't been driven
in a browser either.

## Definition of done

- [ ] A Scriptorium integration test opens a set with a symmetric relation in
      its vocabulary and a link written one way. `link-check` reports it under
      `symmetry`, and not in the broken-link count.
- [ ] The status-bar mark and the link check's section are driven once in a real
      browser on Scriptorium.
