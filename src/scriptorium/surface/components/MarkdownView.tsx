// The rendered half of the document pane (E29). The markdown is turned into
// HTML by `state/markdown.ts` — the ONLY thing in this surface allowed to feed
// an HTML sink, which `src/scriptorium/sinks.test.ts` holds — and styled by the
// `.md-prose` rules in styles.css, which are written in the spell's own tokens
// so both themes follow.
//
// Clicks are the one piece of behaviour here. A rendered document is full of
// links, and this page is not a browser: following one in place would replace
// the surface with a web page and take the human's session with it. An external
// link opens in a new tab; anything else does nothing yet (a relative link
// names a file beside the document — opening THAT document is the editing
// slice's, once a rel can be resolved to a context doc).
import { useMemo } from "react";
import { renderMarkdown } from "../state/markdown";

/** http(s) and mailto open outward; everything else is inert for now. */
const OPENS_OUTWARD = /^(https?:|mailto:)/i;

export function MarkdownView({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-slot="markdown-view">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the handler exists to intercept clicks on ANCHORS inside rendered markdown, and an anchor already fires click on Enter — a keyboard handler here would double-handle it. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same reason — the interactive elements are the anchors the renderer minted inside this container, each already focusable. */}
      <div
        className="md-prose mx-auto max-w-[76ch] px-8 pt-7 pb-16"
        onClick={(e) => {
          const anchor = (e.target as HTMLElement).closest("a");
          if (!anchor) return;
          e.preventDefault();
          const href = anchor.getAttribute("href");
          if (href && OPENS_OUTWARD.test(href)) window.open(href, "_blank", "noopener,noreferrer");
        }}
        // THE ONE HTML SINK IN THIS SURFACE, and what makes it safe is upstream:
        // micromark output only, so raw HTML in the document is encoded and
        // every link target has been checked (state/markdown.ts, with cells).
        // `src/scriptorium/sinks.test.ts` fails if a second sink appears, or if
        // this one is ever fed by anything but `renderMarkdown`.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
