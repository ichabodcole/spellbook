---
type: item
title: Line counters outside the note path miss lone-CR breaks
description:
  Several counters split on \n only, so a file with old-Mac \r endings misreads
  frontmatter, headings, line numbers, code masking, diffs and link context;
  Story Studio moved them onto shared lineBreaks helpers.
status: draft
lifecycle: ready
id: 01a1eabe-f634-704d-8baa-9fd7d70abc22
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, editor]
parent: feature/workspace-kit-follow-ups
priority: medium
---

# Line counters outside the note path miss lone-CR breaks

Reported by Story Studio on `kit-parity` (message 62, point 2).
[kit-lone-cr-line-endings](_archive/kit-lone-cr-line-endings.md) fixed the note
path. Other counters still split on `\n` only, so a lone-`\r` file reads as
fewer, longer lines:

- frontmatter is not recognised;
- only line 1 can be a heading;
- line numbers in search hits and in link-check are wrong;
- so are code masking, diffs and a link insert's line context.

Not reproduced here yet.

We already have `src/kit/lib/lineBreaks.ts`, which counts breaks as CodeMirror
does, used by `anchors.ts`, `projection.ts` and `text.ts`. **Story Studio's
fix** (in `c27f80f0`) moves every counter above onto their
`packages/kit/src/lib/lineBreaks.ts`, with a lone-CR test each, and reads a lone
`\r` in YAML frontmatter as `\n`.

## Definition of done

- [ ] Each counter listed uses the shared helpers, with a lone-CR test.
- [ ] Frontmatter with lone-`\r` breaks is recognised.
- [ ] Posted on `kit-parity`, or Story Studio's change is ported.
