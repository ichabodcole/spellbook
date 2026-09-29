// What a click on a rendered link does (E33) — shared by every place this
// surface shows `renderMarkdown` output: the rendered document (MarkdownView)
// and the chat log (ChatMessageView). One rule, so the two cannot drift.
//
// This page is not a browser: following a link in place would replace the
// surface with a web page and take the human's session with it. So an external
// link opens in a new tab; an INTERNAL one goes to the daemon, which knows what
// the bundle is and is the only side allowed to open a file; and a link the
// renderer refused (`data-blocked-link`) does nothing at all.
import type { MouseEvent } from "react";

/** http(s) and mailto open outward; everything else is a document reference. */
const OPENS_OUTWARD = /^(https?:|mailto:)/i;

export type LinkAct =
  | { kind: "none" }
  | { kind: "outward"; href: string }
  | { kind: "follow"; href: string };

/** The decision, pure: what an anchor with this href and refusal mark does. */
export function linkAct(anchor: { href: string | null; blocked: boolean }): LinkAct {
  const { href, blocked } = anchor;
  if (blocked || !href) return { kind: "none" };
  return OPENS_OUTWARD.test(href) ? { kind: "outward", href } : { kind: "follow", href };
}

/**
 * The click handler for a container of rendered markdown. Clicks on anything
 * but an anchor pass through untouched; a click on an anchor never navigates
 * the page, and does what `linkAct` says instead.
 */
export function onRenderedLinkClick(e: MouseEvent, onFollowLink?: (target: string) => void): void {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  e.preventDefault();
  const act = linkAct({
    href: anchor.getAttribute("href"),
    blocked: anchor.hasAttribute("data-blocked-link"),
  });
  if (act.kind === "outward") window.open(act.href, "_blank", "noopener,noreferrer");
  else if (act.kind === "follow") onFollowLink?.(act.href);
}
