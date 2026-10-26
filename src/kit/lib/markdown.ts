/**
 * The markdown renderer for anything the surface shows as rendered text: a chat
 * message, a document's rendered view. micromark, CommonMark plus GFM.
 *
 * WHY THERE IS NO SANITISER HERE, AND WHY THAT IS NOT AN OVERSIGHT.
 * micromark encodes raw HTML in the source unless `allowDangerousHtml` is set,
 * which it is not and must never be: every tag in the output was MINTED BY THE
 * RENDERER, so a document containing `<script>` or an `onerror` attribute comes
 * out as text. That is why this does not carry a `marked` and DOMPurify pair:
 * `marked` emits raw HTML for raw HTML, so that renderer needs the sanitiser as a
 * real security boundary. The difference between the two is which one can emit a
 * tag it did not write.
 *
 * LINK TARGETS: micromark ALREADY REFUSES A DANGEROUS SCHEME, and this was
 * MEASURED rather than assumed: `[a](javascript:alert(1))` compiles to
 * `<a href="">a</a>`, as do `data:` and `vbscript:`, because micromark's HTML
 * compiler runs every href through an allowlist of protocols. `safeHref` below
 * is therefore a SECOND layer, not the only one: it holds the same line if the
 * renderer is ever swapped, reconfigured, or upgraded into a different default.
 *
 * IMAGES: NO `<img>` LEAVES THIS RENDERER. micromark writes one for every
 * `![alt](src)`, and a browser would fetch its `src` the moment it is parsed: a
 * remote one tells a server the document was read, and a relative one asks the
 * page's own origin for a path that is not a file there. So each becomes an
 * empty `<span class="md-embed">` carrying the target and the alt text as
 * attributes (`embedSpans`), and nothing is fetched. The rendered view resolves
 * each against the daemon and draws the image through the guarded file route;
 * anywhere else (the chat) it stays a quiet placeholder. A remote image and an
 * SVG are refused here, before anything could ask for them.
 *
 * Pure, and tested as such: no DOM, no React, so the rules the pane renders by
 * are unit cells rather than a thing to eyeball.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { isSvgName } from "./docFormat.ts";
import { linkScheme, splitTarget } from "./linkTarget.ts";
import { maskCode } from "./markdownCode.ts";

/** Schemes a rendered link may carry. Everything else becomes an inert anchor. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;
/** Anything that starts like a scheme: what micromark's own filter refuses. */
const SCHEME_LIKE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Is this link target safe to keep? Relative targets are (they name a file
 * beside the document); an absolute one must be http, https or mailto.
 * Whitespace and control characters are stripped first, because
 * `java\tscript:` and `java&#10;script:` are the classic ways past a prefix
 * test — the browser ignores them when it resolves the URL, so this must too.
 *
 * What is a scheme is `linkScheme`'s rule, the one the link check uses: a colon
 * before a bare document name (`Chapter2:intro.md`) is a file name, while
 * `javascript:` and `data:` are always schemes, whatever follows them.
 */
export function safeHref(raw: string): string | null {
  const bare = raw
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a browser ignores these when it resolves a URL, so `java\tscript:` must be read the same way here.
    .replace(/[\u0000-\u0020]/g, "");
  if (linkScheme(bare) === undefined) return raw; // relative: a file beside this one
  return SAFE_SCHEME.test(bare) ? raw : null;
}

/** A markdown link's destination, `](target` or `](<target`, with indices. */
const DESTINATION = /\]\(\s*<?([^\s()<>]+)/dg;

/**
 * `text` with the colon of each link to a file named with one
 * (`[x](Chapter2:intro.md)`) written `%3A`, outside code. micromark's own
 * protocol filter reads `Chapter2:` as a scheme and empties the href, which
 * would strike through a link that resolves; encoded, it reads as the path it
 * is, and following it decodes it back. Only the href changes: link text and
 * code are left as written, so the rendered text still lines up with the source.
 */
function encodeColonPaths(text: string): string {
  if (!text.includes(":")) return text;
  // ⚠ ONLY PARSE WHEN THERE IS SOMETHING TO ENCODE. Masking code is a whole
  // micromark parse, a second one on every render; almost no document has a
  // link to a file named with a colon, so the raw text is asked first. A
  // destination found in code here is only a reason to look closer.
  const candidate = (target: string) =>
    SCHEME_LIKE.test(target) && linkScheme(target) === undefined;
  if (![...text.matchAll(DESTINATION)].some((m) => candidate(m[1] ?? ""))) return text;
  const masked = maskCode(text);
  let out = text;
  for (const m of [...masked.matchAll(DESTINATION)].reverse()) {
    const [from, to] = m.indices?.[1] ?? [0, 0];
    const target = text.slice(from, to);
    if (!candidate(target)) continue;
    const colon = from + target.indexOf(":");
    out = `${out.slice(0, colon)}%3A${out.slice(colon + 1)}`;
  }
  return out;
}

/** Why a remote image is a placeholder: said where it would have been. */
export const EMBED_REMOTE = "Remote image, not loaded: only images in this session are shown.";
/** Why an SVG embed is a placeholder. */
export const EMBED_SVG = "SVG image, not shown: an SVG can carry script.";
/** What an embed of a path says in the chat, where no image is drawn. */
export const EMBED_IN_CHAT = "Images show in the document view.";
/** Why an embed the renderer refused (`javascript:`, `data:`) is a placeholder. */
export const EMBED_BLOCKED = "Not shown: this is not a path to an image file.";

/**
 * micromark's own `<img>`: `src`, `alt`, and a title when one is written. Every
 * `"` in its output is one it wrote (raw HTML in the source is encoded), so the
 * values are read and moved as they are, still encoded.
 */
const IMG = /<img src="([^"]*)" alt="([^"]*)"(?: title="([^"]*)")? \/>/g;

/**
 * Every `<img>` the renderer wrote, as an embed's placeholder span: nothing in
 * it is fetched. `data-embed` is the target exactly as micromark normalised it
 * (what a followed link's `href` carries too), `data-alt` the alt text, and
 * `data-embed-state` says what is known before the daemon is asked:
 *
 * - `pending`: a path, for the rendered view to resolve;
 * - `remote`: an `http(s):` image, never loaded (`EMBED_REMOTE`);
 * - `svg`: an SVG, refused as the tree refuses one (`EMBED_SVG`);
 * - `blocked`: a target micromark emptied (`javascript:`, `data:`).
 *
 * The reason is an attribute the stylesheet draws, never text, so the rendered
 * view's selection still lines up with the source (an image contributes no
 * text there either; see `projection.ts`).
 */
export function embedSpans(html: string, pendingReason?: string): string {
  return html.replace(IMG, (_whole, src: string, alt: string, title?: string) => {
    const target = src.replace(/&amp;/g, "&");
    const scheme = src === "" ? "blocked" : linkScheme(target);
    const state =
      scheme === "blocked"
        ? "blocked"
        : scheme === "http" || scheme === "https"
          ? "remote"
          : scheme !== undefined
            ? "blocked"
            : isSvgName(splitTarget(target).path)
              ? "svg"
              : "pending";
    const reason =
      state === "remote"
        ? EMBED_REMOTE
        : state === "svg"
          ? EMBED_SVG
          : state === "blocked"
            ? EMBED_BLOCKED
            : (pendingReason?.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`) ?? "");
    const label = alt || title || "image";
    return (
      `<span class="md-embed" role="img" aria-label="${label}" data-embed="${src}" data-alt="${alt}"` +
      `${title ? ` title="${title}"` : ""} data-embed-state="${state}"` +
      `${reason ? ` data-embed-reason="${reason}"` : ""}></span>`
    );
  });
}

/** `href="…"` in micromark's own output — it is the only thing that writes one. */
const HREF = /<a href="([^"]*)"/g;

/** GFM's footnote heading id, which micromark writes bare whatever the prefix. */
const FOOTNOTE_LABEL = /(id|aria-describedby)="footnote-label"/g;

export type RenderOptions = {
  /**
   * Scopes the ids the renderer mints — GFM footnotes are the only thing that
   * mints any — to one caller's key. The chat log passes each message's id:
   * every message renders into the same page, so two replies with a `[^1]`
   * each would otherwise put two elements under one id. Reduced to
   * `[A-Za-z0-9_-]` before use, because it is written into attributes.
   */
  idPrefix?: string;
  /**
   * What an embed of a path says where nothing will resolve it (the chat): the
   * placeholder's reason. Absent, it says nothing until the rendered view has
   * asked the daemon.
   */
  embedReason?: string;
};

/**
 * Markdown → HTML, with every link target checked. A refused target keeps its
 * text and loses its link, rather than vanishing: a reader must still see what
 * the document said.
 */
export function renderMarkdown(text: string, options: RenderOptions = {}): string {
  const scope = options.idPrefix?.replace(/[^\w-]/g, "") ?? "";
  let html = micromark(encodeColonPaths(text), {
    extensions: [gfm()],
    // `clobberPrefix` is micromark's own knob for the footnote ids and the
    // fragment links to them; the default is `user-content-`.
    htmlExtensions: [gfmHtml(scope ? { clobberPrefix: `user-content-${scope}-` } : {})],
  });
  // The one id `clobberPrefix` does not reach. Every `"` in the output was
  // written by micromark (raw HTML in the source is encoded), so this matches
  // the renderer's attribute and never a document's text.
  if (scope) html = html.replace(FOOTNOTE_LABEL, `$1="user-content-${scope}-footnote-label"`);
  // An EMPTY target counts as refused, and that is not a detail: micromark
  // empties the href of a scheme it will not allow, so without this the reader
  // sees an ordinary-looking link that silently does nothing. Struck through
  // and dimmed (by the surface stylesheet's rule for a blocked link), the words stay
  // and the refusal shows.
  return embedSpans(
    html.replace(HREF, (whole, href: string) =>
      href === "" || safeHref(href) === null ? "<a data-blocked-link" : whole,
    ),
    options.embedReason,
  );
}
