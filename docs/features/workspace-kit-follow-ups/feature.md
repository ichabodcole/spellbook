---
type: feature
title: Workspace Kit follow-ups
description:
  "The work the workspace stack surfaced once Scriptorium ran on the kit: fixes,
  gaps and trial findings in the kit and Scriptorium, collected after the
  Workspace Kit feature closed at the cutover."
tags: [kit, scriptorium]
status: draft
lifecycle: active
generated: { by: claude-opus-5-5, at: 2026-10-22 }
---

# Workspace Kit follow-ups

## Overview

[Workspace Kit](../workspace-kit/feature.md) closed on 2026-10-22, when the
cutover deleted the shipped Scriptorium and left the kit Scriptorium as the only
one. Its goal was met. But the six cycles that got there, and Cole's trial of
the flipped build, surfaced work the stack itself didn't need. That work is
fixes, gaps and ideas in the kit and in Scriptorium. This feature is its home,
so the finished feature can stay a closed record.

## Problem Statement

The open items fall into four kinds:

- **Things Cole felt in his trial:**
  - session identity: which project is this session for?
  - the native folder picker;
  - the off-theme violet;
  - the right-click menu with no selection.
- **Kit gaps the verifiers found:**
  - relink missing proposed versions;
  - a corrupt layout pref blanking the page;
  - CRLF note offsets;
  - waiting marks after End session;
  - the rendered view's render cost;
  - and more.
- **Ward and harness blind spots:**
  - the deletion's ward gaps;
  - the DOM harness;
  - the disk-write and prose wards.
- **Inherited issues the shipped app shared:**
  - concurrent restore;
  - symlinked sets;
  - write races;
  - session cleanup.

## Proposed Solution

None as a whole. Each item stands on its own, through triage and the cycles.
Group them into cycles by what Cole feels first. Session identity and session
cleanup share one metadata layer, so they should be designed together.

## Scope

**In scope:** the items whose `parent` is this feature.

**Out of scope:** new apps on the kit (mind-mapper on the Atlas pattern is its
own research item), and Story Studio's diverging project and file-tree paradigm,
which is watched, not ported.

---

**Related Documents:**

- [Workspace Kit](../workspace-kit/feature.md)
- [The cutover cycle](../../cycles/2026-10-cutover.md)
