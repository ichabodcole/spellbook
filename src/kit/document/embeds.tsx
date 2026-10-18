// Embeds in the rendered view (the kit-image-embeds item): `![alt](x.png)`
// drawn where it is written, through the daemon's guarded file route.
//
// The renderer never writes an `<img>` (`lib/markdown.ts`, `embedSpans`): each
// embed arrives as an empty `<span class="md-embed">` with its target and alt
// text as attributes, so nothing is fetched until the daemon has said what the
// target is. The pane asks (`link.embeds`) for every target the view found and
// hands the answers back; each span then gets either the image, in a button
// that opens the viewer, or a quiet placeholder that says why not. The
// placeholder's words are attributes the stylesheet draws (`.md-embed` in
// `theme/document.css`), never text, so the view's selection and notes still line
// up with the source, as they do around an image's alt text.

import { useLayoutEffect, useState } from "react";
import { onRenderedLinkClick } from "../chat/renderedLink.ts";
import type { EmbedView } from "../workspace/protocol";

/** An embed the daemon says is shown: what the file route serves. */
export type ShownEmbed = Extract<EmbedView, { state: "shown" }>;

/** What the rendered view needs to draw embeds; without it they stay placeholders. */
export type EmbedSource = {
  /** What each target shows, once the daemon has said; a target not in it is pending. */
  views: ReadonlyMap<string, EmbedView>;
  /** Where the image is drawn from: the 1024 px thumbnail, or the file itself. */
  src: (view: ShownEmbed) => string;
  /** Open the image in the viewer (Close brings the document back). */
  open: (path: string) => void;
};

/** Why a shown image did not draw: its bytes passed the guard, but the browser could not read them. */
export const EMBED_FAILED =
  "Could not be shown: this browser cannot read it, or the file is damaged.";

/** Every embed span in a rendered body that is waiting on the daemon, with its target. */
export function pendingEmbeds(root: ParentNode): { el: HTMLElement; target: string }[] {
  return [...root.querySelectorAll<HTMLElement>('.md-embed[data-embed-state="pending"]')].map(
    (el) => ({ el, target: el.getAttribute("data-embed") ?? "" }),
  );
}

/** Set an embed span's state, its spoken name and the reason the stylesheet draws. */
function mark(el: HTMLElement, state: string, alt: string, reason: string | null): void {
  el.setAttribute("data-embed-state", state);
  if (reason) {
    el.setAttribute("data-embed-reason", reason);
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", `${alt || "Image"}: ${reason}`);
  } else {
    el.removeAttribute("data-embed-reason");
    // Shown, the button inside carries the name; a role here would hide it.
    if (state === "shown") {
      el.removeAttribute("role");
      el.removeAttribute("aria-label");
    } else {
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", alt || "Image");
    }
  }
}

/**
 * One embed, mounted into its span: the image in a button that opens the
 * viewer, or nothing (the span's placeholder says why). Lazy, so a long
 * document's images below the fold are not fetched until they are near.
 */
export function Embed({
  el,
  view,
  source,
  onFollowLink,
}: {
  el: HTMLElement;
  view: EmbedView | undefined;
  source: EmbedSource;
  /** The view's link follower: a linked image (`[![alt](x.png)](doc.md)`) follows its link. */
  onFollowLink?: (target: string) => void;
}) {
  const alt = el.getAttribute("data-alt") ?? "";
  const [failed, setFailed] = useState<string | null>(null);
  const shown = view?.state === "shown" ? view : null;
  const src = shown ? source.src(shown) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new src is a new image.
  useLayoutEffect(() => setFailed(null), [src]);
  useLayoutEffect(() => {
    if (!view) mark(el, "pending", alt, null);
    else if (view.state === "not-shown") mark(el, "not-shown", alt, view.reason);
    else if (failed) mark(el, "failed", alt, failed);
    else mark(el, "shown", alt, null);
  }, [el, view, failed, alt]);
  if (!shown || !src || failed) return null;
  return (
    <button
      type="button"
      data-slot="embed-open"
      aria-label={`Open ${alt || shown.path.split("/").pop()} in the viewer`}
      title={alt || undefined}
      onClick={(e) => {
        // Mounted through a portal, this click never reaches the body's own
        // handler, so it is decided here: a linked image
        // (`[![alt](x.png)](doc.md)`) is the link's, and the page never
        // navigates either way.
        e.stopPropagation();
        if (el.closest("a")) {
          onRenderedLinkClick(e, onFollowLink);
          return;
        }
        e.preventDefault();
        source.open(shown.path);
      }}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        // The size the header gave, so the space is held before the bytes come:
        // lazy loading then fetches only what is near, and nothing shifts.
        {...(shown.width && shown.height ? { width: shown.width, height: shown.height } : {})}
        data-slot="embed-image"
        onError={() => setFailed(EMBED_FAILED)}
      />
    </button>
  );
}
