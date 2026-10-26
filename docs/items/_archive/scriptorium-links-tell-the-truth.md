---
type: item
title: Scriptorium's links tell the truth
description:
  "Seven port-backs from Story Studio: links resolve against their own document,
  folders and non-web schemes are reported correctly, extraction ignores code,
  one opened folder is the workspace, no unverified badge from a missing field."
status: stable
lifecycle: done
id: 01a1082f-9c18-72db-ae92-4a38f7c639c5
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-04 }
tags: [scriptorium, links]
cycle: 2026-10-links-tell-the-truth
---

# Scriptorium's links tell the truth

Seven of the thirteen Scriptorium issues Cole filed on 2026-10-03 and
2026-10-04. Each is a port-back: Story Studio's kit
(`~/Projects/dreamwood/story-studio`, `packages/kit/`) already fixed it, and the
issue names the commit. Port the fix to Scriptorium's own code; do not design
afresh. Where Scriptorium's code has moved apart from the kit's, keep the
behaviour and say where it differs.

## Definition of done

- [x] [#126](https://github.com/ichabodcole/spellbook/issues/126)
      (story-studio@a57d65a) — `extractLinks` skips inline and indented code,
      escaped brackets and HTML comments, finds the link shapes the issue lists,
      and counts lines in linear time. Graph, backlinks and dangling agree with
      it.
- [x] [#122](https://github.com/ichabodcole/spellbook/issues/122)
      (story-studio@3034d9c) — a link clicked in chat resolves against its own
      origin (`link.open` with `from: "chat"`), with or without a document open.
- [x] [#123](https://github.com/ichabodcole/spellbook/issues/123)
      (story-studio@3034d9c) — a link to a folder resolves as a folder, not a
      missing `.md`.
- [x] [#124](https://github.com/ichabodcole/spellbook/issues/124)
      (story-studio@3034d9c) — following a link into a collapsed folder reveals
      the document in the tree.
- [x] [#128](https://github.com/ichabodcole/spellbook/issues/128)
      (story-studio@9b4ece7) — `dangling` and the doctor report links with a
      non-web scheme (`op:doc/…`) instead of dropping them.
- [x] [#130](https://github.com/ichabodcole/spellbook/issues/130)
      (story-studio@cb47a04) — E67: `open` given exactly one folder makes it the
      workspace; several entries or a file keep the working directory; a
      restored session keeps its own; the handshake names the workspace.
- [x] [#131](https://github.com/ichabodcole/spellbook/issues/131)
      (story-studio@a06a47f) — E69: the trust badge shows only on a document
      with a `verified` field.
- [x] SKILL.md says what changed for an agent; tests cover each; gate green; a
      no-stake verifier has driven the CLI changes on the shipped launcher and
      the surface changes in a real browser.

## Rulings

E67 and E69 in [the Scriptorium decision log](scriptorium/decision-log.md).
