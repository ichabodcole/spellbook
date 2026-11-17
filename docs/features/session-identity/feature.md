---
type: feature
title: Tell sessions apart at a glance
description:
  Scriptorium sessions carry a title, a description and a colour the agent
  picks, editable by the human and shown in the tab title, a favicon tinted with
  that colour and the page header, so several open sessions can be told apart at
  a glance.
tags: [scriptorium, sessions, ux]
status: draft
lifecycle: backlog
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Tell sessions apart at a glance

## Overview

Cole often has several Scriptorium sessions open at once, in separate tabs:

- one per project (Spellbook, Story Studio, others);
- often several within one project, such as a triage review beside a research
  write-up.

Nothing in a session says which project it belongs to or what it is for. To find
out, he reads document paths or opens items, which makes switching between tabs
slow. This feature gives each session an identity that the agent sets and the
human can recognise from the tab strip alone.

## Problem Statement

The shipped Scriptorium (before the kit cutover, 2026-10-22) showed a workspace
folder path. That was a weak cue, but it was one. The kit Scriptorium has no
home workspace, and its context list shows relative labels such as `docs/items`.
Every Scriptorium tab also looks the same: the favicon is an empty placeholder,
and the tab title is the app's name.

Scriptorium is the spell Cole runs most in parallel. The other spells are
usually one at a time, so the need is Scriptorium's first. The kit can offer it
to other spells later.

## Proposed Solution

A session carries:

- a **title** and a **description**;
- a **colour**.

The agent writes them at `open`, because it knows why it is opening the session.
The human can change them in the page. They show where Cole looks when
switching:

- **The tab title.**
- **The favicon, tinted with the session's colour.** Purple is one project,
  orange another. A row of tabs then tells sessions apart at a glance.
- **The page header.**
- **The session list** that
  [scriptorium-session-cleanup](../../items/scriptorium-session-cleanup.md)
  adds.

How these are laid out is a design question, settled with mockups first: the
first box of
[scriptorium-session-identity](../../items/scriptorium-session-identity.md).

## Scope

**In scope:**

- Session metadata (title, description, colour) for Scriptorium, set at `open`,
  changed by a verb or in the page, and kept across a restore.
- Showing it in the tab title, a session-tinted favicon and the header.
- Scriptorium's favicon itself ([spell-favicons](../../items/spell-favicons.md),
  Scriptorium first).
- The session list and cleanup, which share the same metadata.

**Out of scope:** per-session tints for the other spells. Each of them gets its
brand-coloured favicon from `spell-favicons`, and a per-session tint can follow
if parallel use appears there.

## Technical Approach

The metadata lives with the session, beside its restore state, and is part of
`state`, so the agent can read it. The favicon is already planned as an inline
`data:` SVG (Story Studio's `53eb176` pattern), so tinting it means building
that SVG with the session's colour in the page.

Two things to decide while designing:

- Whether the metadata belongs in the kit or in Scriptorium. The kit holds the
  session, so it is probably the kit, with Scriptorium the first app to show it.
- The palette: a handful of colours far enough apart to tell at tab size, in
  light and dark.

## Impact & Risks

**Benefits:** switching between sessions is faster. Fewer edits go to the wrong
session. The session list that cleanup needs gets readable rows.
[kit-unpinned-verbs-write-to-another-session](../../items/kit-unpinned-verbs-write-to-another-session/item.md)
(#137) refuses an ambiguous write by listing the live sessions, and a title in
that list helps the agent choose.

**Risks:** an agent that never sets the metadata, which the SKILL and a sensible
default (the opened folder's name) cover. Colours too close to tell apart, which
a small fixed palette avoids.

**Complexity:** Low to medium. The metadata is small; the design pass is most of
the work.

## Decided

Cole, 2026-11-17:

- **The agent picks the colour, per session.** It is not derived from a project.
  Sessions are short-lived and usually new, and tying a colour to a project
  would mean storing that link somewhere. A colour only has to tell apart the
  sessions open right now. The daemon can default to a palette colour that no
  other live session is using.
- **The icon never changes.** Scriptorium's favicon glyph stays the same in
  every session, so a tab is always recognisable as Scriptorium. Only its tint
  varies. There is no per-session icon.
- **No project field.** The title carries what the session is about, project
  included.

---

**Related Documents:**

- [A Scriptorium session shows what it's for](../../items/scriptorium-session-identity.md)
- [Scriptorium: see old sessions and delete the ones you're done with](../../items/scriptorium-session-cleanup.md)
- [Give every spell a recognisable favicon, Scriptorium first](../../items/spell-favicons.md)
