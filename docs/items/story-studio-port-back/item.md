---
type: item
title: What to take back from Story Studio
description:
  Scan of Story Studio's kit, Atlas and practices for what Spellbook's kit and
  Scriptorium should port back, with a steal/skip call on each.
status: stable
lifecycle: done
id: 01a131ec-fb0f-71a4-b587-d155e3d4f56d
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-12 }
tags: [scriptorium, kit, story-studio]
---

# What to take back from Story Studio

Story Studio (`~/Projects/dreamwood/story-studio`) forked Spellbook's kit and
Scriptorium on 2026-09-30 and has moved well past them: its kit now holds
Scriptorium's daemon and panes made generic (`workspace`, `shell`, `context`,
`chat`, `document`), Atlas has added features and fixes, and the repo has grown
testing and process practices of its own. Cole wants what is generic brought
back to Spellbook's kit and Scriptorium. Issues #122–#143 are already filed
port-backs and are out of this item.

The decision it feeds: which candidates become items (and in which cycles),
which are skipped, and whether Scriptorium cherry-picks pieces or re-bases on a
generic workspace kit.

## Definition of done

- [x] The write-up lists every candidate the scan found, each with evidence in
      Story Studio (path or commit) and Spellbook's current state.
- [x] Cole has made a call on each: take, take later, or skip.
- [x] Each taken candidate is filed as an item (or a GitHub issue, if it is one
      of Story Studio's own), and the E67 overlap has a ruling. _The candidates
      taken with B are carried by
      [Workspace Kit](../../features/workspace-kit/feature.md); the practices
      are their own items; E67 is superseded by E71._
