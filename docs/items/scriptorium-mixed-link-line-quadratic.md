---
type: item
title:
  Scriptorium's link extractor is quadratic on lines mixing wiki and markdown
  links
description:
  Scriptorium's wiki-inside-markdown scan makes a 200k-character line mixing
  markdown and wiki links take 1.2-1.8 s; the kit's extractor is linear, so this
  goes away when Scriptorium moves onto it.
status: stable
lifecycle: triage
id: 01a139ee-790f-73bf-b84a-69ed0055a6b2
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [scriptorium, links, performance]
parent: feature/workspace-kit
---

# Scriptorium's link extractor is quadratic on lines mixing wiki and markdown links

Scriptorium's `src/scriptorium/backend/links.ts` drops a wiki link that sits
inside a markdown link by scanning every markdown span for every wiki link. On a
single long line that mixes the two, that's quadratic. The links differential's
verifier (2026-10-14) measured these times:

| Line            | 50k chars | 200k chars |
| --------------- | --------- | ---------- |
| `[a](b)[[c]]`   | 96 ms     | 1,662 ms   |
| `[[a]] [b](c) ` | —         | 1,765 ms   |

The kit's extractor, after its own fix in the workspace-daemon cycle, does the
same check with a sorted search and takes 43 ms at 200k.

It goes away when Scriptorium moves onto the kit's extractor (the wiki-layer
cycle). Fix it here only if that's far off.

## Definition of done

- [ ] Scriptorium's extractor is linear on mixed dense lines (under 2 s at
      200k), or Scriptorium is on the kit's extractor
