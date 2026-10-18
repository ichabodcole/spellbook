// What a click on a rendered link does, shared by every place a surface shows
// `renderMarkdown` output: a rendered document and the chat log. One rule, so the
// two cannot drift.
//
// This page is not a browser: following a link in place would replace the
// surface with a web page and take the human's session with it. So an external
// link opens in a new tab; an INTERNAL one goes to the daemon, which knows what
// the bundle is and is the only side allowed to open a file; and a link the
// renderer refused (`data-blocked-link`) does nothing at all.
//
// A link that is ONLY a fragment (`#…`) is none of those: it names a place on
// this page — a GFM footnote's `[^1]` and its ↩ back-ref are the ones the
// renderer mints. It jumps in place, inside the container that was clicked, and
// in a document, looks for a heading of that name when nothing carries that
// id (kit-heading-links-build); the chat has no headings to look in, so there
// it does nothing. It never reaches the daemon,
// which used to answer one with "That link points at #user-content-fnref-1,
// which is not in this set".
import type { MouseEvent } from "react";

/** http(s) and mailto open outward; everything else is a document reference. */
const OPENS_OUTWARD = /^(https?:|mailto:)/i;

export type LinkAct =
  | { kind: "none" }
  | { kind: "outward"; href: string }
  | { kind: "follow"; href: string }
  | { kind: "jump"; id: string };

/** A fragment's id as the browser reads it — decoded, and never a throw. */
function fragmentId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // a lone `%` is an ordinary character in an id
  }
}

/** The decision, pure: what an anchor with this href and refusal mark does. */
export function linkAct(anchor: { href: string | null; blocked: boolean }): LinkAct {
  const { href, blocked } = anchor;
  if (blocked || !href) return { kind: "none" };
  if (href.startsWith("#")) {
    const id = fragmentId(href.slice(1));
    return id ? { kind: "jump", id } : { kind: "none" };
  }
  return OPENS_OUTWARD.test(href) ? { kind: "outward", href } : { kind: "follow", href };
}

/** What the jump needs of the container the handler is attached to. */
type Container = {
  querySelectorAll(selector: string): Iterable<{ id: string; scrollIntoView(o?: object): void }>;
};

/**
 * The click handler for a container of rendered markdown. Clicks on anything
 * but an anchor pass through untouched; a click on an anchor never navigates
 * the page, and does what `linkAct` says instead.
 */
export function onRenderedLinkClick(
  e: MouseEvent,
  onFollowLink?: (target: string) => void,
  onFollowHeading?: (anchor: string) => void,
): void {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  e.preventDefault();
  const act = linkAct({
    href: anchor.getAttribute("href"),
    blocked: anchor.hasAttribute("data-blocked-link"),
  });
  if (act.kind === "outward") window.open(act.href, "_blank", "noopener,noreferrer");
  else if (act.kind === "follow") onFollowLink?.(act.href);
  else if (act.kind === "jump") {
    // Looked up in THIS container, not the whole page: a chat message's jump
    // lands in that message even if another held the same id. Matched on `.id`
    // rather than a `#id` selector, so no id needs CSS escaping.
    for (const el of (e.currentTarget as unknown as Container).querySelectorAll("[id]"))
      if (el.id === act.id) {
        el.scrollIntoView({ block: "nearest" });
        return;
      }
    // No element has that id: in a document, it may name a heading
    // (kit-heading-links-build), handed over as written.
    onFollowHeading?.((anchor.getAttribute("href") ?? "").slice(1));
  }
}
