---
type: item
title: One link holding many images is still quadratic
description:
  "A link whose label holds many images puts every link in one overlapping run,
  and each near() call copies and sorts the run: 1.6 s at 98k characters, in
  both kits. Story Studio filed it as kit-links-images-in-one-label; whoever
  fixes it first posts the commit."
status: stable
lifecycle: triage
id: 01a13bdd-bafc-7333-ae73-072ea44abbda
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, links]
parent: feature/workspace-kit-follow-ups
---

# One link holding many images is still quadratic

Part of [Workspace Kit](../features/workspace-kit/feature.md). Found by Story
Studio's review of the links speed fix (`15d6e2b6`, their `0772d65`), reported
on `kit-parity` (message 33).

`"[" + "![a](b)".repeat(k) + "](c)"`, one outer link holding many images, puts
every link in one overlapping run. Each `near()` call then copies and sorts the
whole run. This takes 1.6 s at 98k characters in both kits. Story Studio's
suggested fix: sort a run's members once, then binary-search the members that
strictly hold an edge. Story Studio filed it as `kit-links-images-in-one-label`;
whichever kit fixes it first posts the commit.

## Definition of done

- [ ] The shape runs in linear or near-linear time. A test holds it to a time
      budget at about 100k characters.
- [ ] Output is unchanged on the existing links tests and the differential.
- [ ] The commit is posted on `kit-parity`, or Story Studio's is ported.
