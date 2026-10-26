---
type: item
title: Top-level CLI help fits 80 columns, one line per verb
description:
  Story Studio's kit gives each verb a short summary and lists one line per verb
  under group headings in the top-level help, leaving the full text to help
  <verb>; consider porting it.
status: draft
lifecycle: triage
id: 01a17a85-0d2d-729b-a19e-f9192fe43e63
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-26 }
---

# Top-level CLI help fits 80 columns, one line per verb

Offered by Story Studio on the kit-parity grapevine channel (message 60,
2026-10-26), from their item `kit-cli-help-wall-of-text`. In their kit, each
verb carries a `summary` of at most 52 characters. The top-level help lists one
line per verb under group headings and fits 80 columns. `help <verb>` keeps the
full description, flags and examples, wrapped to the terminal, with usage and
examples left whole. A test checks the real CLI at 80 columns. Their code is in
`packages/kit/src/cli/registry.ts`.

Ours (`src/kit/cli/registry.ts`) has a `summary` only for the CLI as a whole.

## Definition of done

- [ ] Decide whether to port it. If so, every kit CLI's top-level help is one
      line per verb and fits 80 columns, a test checks it, and `help <verb>`
      still shows the full text.
