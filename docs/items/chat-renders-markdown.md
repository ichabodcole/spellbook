---
type: item
title: Chat messages render as markdown
description:
  Agents answer in markdown but Scriptorium's chat log prints it raw; render it,
  rendered-only by Cole's default, and carry it into the shared kit chat
  component.
status: draft
lifecycle: done
id: 01a0e970-39ea-716f-88fb-e918d5088288
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-28 }
cycle: 2026-09-scriptorium-from-real-use-2
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

## Done (2026-09-28)

- Agent and human messages render as markdown through `state/markdown.ts`, in a
  new presentational `components/ChatMessageView.tsx`. System lines (the
  daemon's own words about an act) stay plain text. Human messages render too:
  micromark leaves ordinary prose alone, so `snake_case`, `2 * 3 * 4` and a lone
  `*` read as typed (a cell holds this).
- `sinks.test.ts` now declares a second sink, the chat body, and holds that it
  is fed by `renderMarkdown(text)` and nothing else. It is a second sink, not a
  second path: one renderer, same refusals. It was not folded into
  `MarkdownView`, because that sink carries E51's selection and E63's scroll
  machinery.
- Link behaviour (E33) moved out of `MarkdownView` into
  `components/renderedLink.ts` (a pure `linkAct` with cells, plus the click
  handler), and both views use it. A relative link in chat is resolved against
  the open document.
- `.md-prose.md-chat` is the compact variant: it inherits the bubble's size and
  colour, keeps headings close to body size and block spacing tight, lets code
  blocks and tables scroll inside themselves, and wraps long URLs. Code and
  header cells use the page colour, because the agent's bubble already uses
  `surface-raised`. It was checked in a real browser in both themes.
- The passage a message carried (E48) still shows, and a cell holds it.
- **Kept in Scriptorium, not the kit.** The kit has no renderer, and moving
  `markdown.ts` there would move the sink rule with it. `ChatMessageView` takes
  a message and a callback and has no daemon, so it can move when the kit chat
  component is built.
- Left open: GFM footnotes mint fixed ids (`footnote-label`), which would repeat
  across messages. Not fixed until a real reply uses one.

**The collapsed chat's one-line preview reads as plain text** (found by the
no-stake verifier). With the conversation collapsed, the line above the floating
composer printed the latest message raw, `##` and `**` included. It now shows
`oneLine(text)` (`surface/state/projection.ts`, with cells): the same parser's
text the rendered view is built from, with every block boundary and line break a
single space, and no frontmatter split, since a chat message is not a document.
It is a plain string, so no new HTML sink; the hover title shows the same text,
and truncation is unchanged. Checked in a real browser in both themes.
