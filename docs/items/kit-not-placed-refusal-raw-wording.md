---
type: item
title: A note refused in the raw view tells the human to use the raw view
description:
  NOT_PLACED is the only refusal wording, so a note refused from the raw view
  says to select it in the raw view; the refusal should say which view it came
  from.
status: stable
lifecycle: ready
id: 01a17a85-0ca7-745c-a568-292168ccbcf7
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-26 }
parent: feature/workspace-kit-follow-ups
---

# A note refused in the raw view tells the human to use the raw view

Reported by Story Studio on the kit-parity grapevine channel (message 60,
2026-10-26). `NOT_PLACED` (`src/kit/document/notPlaced.ts`) is the only wording
a refused note has: "Select it in the raw view and add the note there." A note
refused from the raw view, where the text changed after the selection, gets the
same advice, which points at the view the human is already in.

Story Studio added `seenIn: "raw" | "rendered"` to `note.add`. A raw refusal
says: "The text changed after you selected it. Select the passage again and add
the note."

## Definition of done

- [ ] A note refused from the raw view says the text changed and to select the
      passage again; one refused from the rendered view keeps its current
      advice. A test covers each.
