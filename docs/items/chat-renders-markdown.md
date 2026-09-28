---
type: item
title: Chat messages render as markdown
description:
  Agents answer in markdown but Scriptorium's chat log prints it raw; render it,
  rendered-only by Cole's default, and carry it into the shared kit chat
  component.
status: draft
lifecycle: backlog
id: 01a0e970-39ea-716f-88fb-e918d5088288
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-28 }
---

# Chat messages render as markdown

**From Cole's real use of Scriptorium, 2026-09-28.** Agents write their replies
in markdown, but the chat log prints `m.text` as plain text
(`src/scriptorium/surface/App.tsx` ~1158), so the human sees raw `**`, `-` and
backticks rather than what the agent meant.

**Ruling (Cole):** messages are **rendered only**. They are read, never edited,
and the agent chose markdown to be read rendered. A raw/rendered toggle is
deferred until real use shows a need for it; don't build it speculatively.

## Definition of done

- [ ] Agent and human messages in Scriptorium's chat log render as markdown,
      styled in the spell's own tokens in both themes.
- [ ] The HTML comes from the existing renderer, `state/markdown.ts`.
      `src/scriptorium/sinks.test.ts` holds that renderer as the only thing
      allowed to feed an HTML sink, so chat must go through it and must not add
      a second path. Chat text is agent-written, so the renderer's link and HTML
      refusals apply unchanged.
- [ ] Links behave as they do in `MarkdownView`: an external link opens in a new
      tab, an internal one goes to the daemon, and a refused one does nothing.
      Reuse that behaviour rather than copy it.
- [ ] The chat's layout survives what markdown brings: headings, code blocks,
      long lines, tables. Size them for a narrow side panel (smaller headings,
      horizontal scroll for code).
- [ ] The passage a message carried (E48) still shows beside the rendered text.

## Beyond Scriptorium

Other spells have chat bars too. The
[shared context and chat components research](shared-context-and-chat-components/item.md)
is weighing one kit chat component, with per-backend adapters. Markdown
rendering belongs in that component's contract, so whichever lands first should
build it where the other can take it over. If the kit chat component is built
before this item, do it there and adopt it in Scriptorium.
