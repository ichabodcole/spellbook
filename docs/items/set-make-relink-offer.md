---
type: item
title: Turning a document into a set reports broken links but offers no fix
description:
  make-set lists the links its move breaks but, unlike move, offers no relink; a
  warning needs an action.
status: draft
lifecycle: triage
id: 01a1486e-3bb8-74b7-b965-0ad8d262f898
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
---

# Turning a document into a set reports broken links but offers no fix

Found by the set-promotion verifier (2026-10-17). `make-set` moves a document
into a new folder and reports the links that broke as `broken`, but offers no
`relink`, unlike `move`. A warning needs an action.

## Definition of done

- [ ] After `make-set` breaks links, the agent and the surface get the same fix
      offer a move gives, and taking it repairs the links, with a test.
