/**
 * The rendered view's renderer (E29): micromark, CommonMark + GFM.
 *
 * ⛔ WHY THERE IS NO SANITISER HERE, AND WHY THAT IS NOT AN OVERSIGHT.
 * micromark encodes raw HTML in the source unless `allowDangerousHtml` is set,
 * which it is not and must never be: every tag in the output was MINTED BY THE
 * RENDERER, so a document containing `<script>` or an `onerror` attribute comes
 * out as text. That is mind-mapper's ruling (C2) and it is why this spell does
 * not carry digestify's `marked` + DOMPurify pair — `marked` emits raw HTML for
 * raw HTML, so THAT renderer needs the sanitiser as a real security boundary.
 * Two renderers in the roster, two correct answers; the difference is which one
 * can emit a tag it did not write.
 *
 * ⛔ LINK TARGETS: micromark ALREADY REFUSES A DANGEROUS SCHEME, and this was
 * MEASURED rather than assumed — `[a](javascript:alert(1))` compiles to
 * `<a href="">a</a>`, as do `data:` and `vbscript:`, because micromark's HTML
 * compiler runs every href through an allowlist of protocols. `safeHref` below
 * is therefore a SECOND layer, not the only one: it holds the same line if the
 * renderer is ever swapped, reconfigured, or upgraded into a different default.
 * (A backlog note claiming mind-mapper's renderer has this hole was filed and
 * WITHDRAWN on the measurement — it does not.)
 *
 * Pure, and tested as such: no DOM, no React, so the rules the pane renders by
 * are unit cells rather than a thing to eyeball.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/** Schemes a rendered link may carry. Everything else becomes an inert anchor. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;
/** A target with any scheme at all — `foo:bar`, and the encoded spellings of it. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Is this link target safe to keep? Relative targets are (they name a file
 * beside the document); an absolute one must be http, https or mailto.
 * Whitespace and control characters are stripped first, because
 * `java\tscript:` and `java&#10;script:` are the classic ways past a prefix
 * test — the browser ignores them when it resolves the URL, so this must too.
 */
export function safeHref(raw: string): string | null {
  const bare = raw
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a browser ignores these when it resolves a URL, so `java\tscript:` must be read the same way here.
    .replace(/[\u0000-\u0020]/g, "");
  if (!HAS_SCHEME.test(bare)) return raw; // relative: a file beside this one
  return SAFE_SCHEME.test(bare) ? raw : null;
}

/** `href="…"` in micromark's own output — it is the only thing that writes one. */
const HREF = /<a href="([^"]*)"/g;

/**
 * Markdown → HTML, with every link target checked. A refused target keeps its
 * text and loses its link, rather than vanishing: a reader must still see what
 * the document said.
 */
export function renderMarkdown(text: string): string {
  const html = micromark(text, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
  // An EMPTY target counts as refused, and that is not a detail: micromark
  // empties the href of a scheme it will not allow, so without this the reader
  // sees an ordinary-looking link that silently does nothing. Struck through
  // and dimmed (styles.css `.md-prose a[data-blocked-link]`), the words stay
  // and the refusal shows.
  return html.replace(HREF, (whole, href: string) =>
    href === "" || safeHref(href) === null ? "<a data-blocked-link" : whole,
  );
}
