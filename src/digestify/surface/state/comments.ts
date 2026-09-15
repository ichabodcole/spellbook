import type { Comment, WireComment } from "./types";

/** The chip shows the first 60 characters of the anchor; the editor's label
 *  shows the first 80. The FULL anchor is what is stored and submitted — only
 *  the display is truncated (template.html 1274–1277, 1309–1312). */
export const CHIP_ANCHOR_CHARS = 60;
export const EDITOR_ANCHOR_CHARS = 80;

export function truncate(text: string, max: number): string {
  return text.slice(0, max) + (text.length > max ? "…" : "");
}

/** Ids are client-only, minted in order from a counter that starts at 0 and is
 *  never reset — a restored session continues the sequence from its own count. */
export const commentId = (seq: number): string => `c${seq}`;

/** What crosses the wire and what is persisted: no id, ever. */
export const stripIds = (comments: readonly Comment[]): WireComment[] =>
  comments.map(({ anchor, text }) => ({ anchor, text }));

export function updateCommentText(
  comments: readonly Comment[],
  id: string,
  text: string,
): Comment[] {
  return comments.map((c) => (c.id === id ? { ...c, text } : c));
}

export function removeComment(comments: readonly Comment[], id: string): Comment[] {
  return comments.filter((c) => c.id !== id);
}

/** The blocks a comment can anchor to, and the fallback. Used both by the live
 *  selection path (`closest`) and by the restore path (a `querySelectorAll`
 *  scan for the first block whose text contains the anchor). */
export const BLOCK_SELECTOR = "p,li,blockquote,pre,h1,h2,h3,h4,h5,h6";

/** The needle a restored chip is re-anchored by: the anchor's first 60
 *  characters (template.html 1208). Deliberately the same width as the chip's
 *  display truncation — a coincidence in the old page, preserved here. */
export const anchorNeedle = (anchor: string): string => anchor.slice(0, CHIP_ANCHOR_CHARS);
