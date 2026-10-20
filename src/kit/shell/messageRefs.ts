// What the next message is about and what it draws on, as the composer will
// send it: pure, so the rules are cells, not something to eyeball.
//
// ONE SUBJECT. A text selection, else the active document or image, or an app's
// own part (the daemon adds that). Documents a view points at (`pointedDocs`)
// give one subject: the open one among them, else the first; the rest are refs.
//
// REFS FROM TWO GESTURES. The file tree's selection, read here at send and not
// cleared by it (the tree's own, which the human clears there), and the
// references added by hand ("Add as reference"), which clear on send. Neither
// takes part in "one kind at a time": a change of subject keeps them. A ref
// naming the subject is dropped, and so is a second with the same path. The
// daemon applies the same dedup to what it is sent; this is what the chip shows.

import type { RowRef } from "../context/model.ts";
import type { MessageRef } from "../workspace/protocol";

/** A ref as the chip shows it, and where it came from: its X undoes that. */
export type HeldRef = {
  path: string;
  name: string;
  role?: string;
  /** `tree`: the file tree's selection (`row`); `added`: by hand; `pointed`: a view's other documents. */
  from: "tree" | "added" | "pointed";
  /** The tree row it stands for, when `from` is `tree`. */
  row?: string;
  /** The ref as sent. */
  ref: MessageRef;
};

/**
 * The most refs one message carries: the daemon's `MAX_REFS`, which the
 * surface may not import (a test holds the two equal). The chip shows no more
 * than go, and says how many more there are.
 */
export const REFS_SENT = 50;

export type MessageParts = {
  /** The whole document or image to name as the subject (`about.path`); null leaves it to the daemon. */
  subject: string | null;
  /** What goes with the message, at most `REFS_SENT`. */
  refs: HeldRef[];
  /** Held refs past the cap, which do not go. */
  unsent: number;
};

export function messageParts(input: {
  /** A text selection rides: it is the subject. */
  selection: boolean;
  /** Documents a view points at, in its order. */
  pointed: readonly { path: string; name: string }[];
  /** The open document: its original's path and its active version's. */
  openDoc: { original: string; path?: string } | null;
  /** The open image's path. */
  openImage: string | null;
  /** The tree's selected rows, as refs (`rowRefs`). */
  tree: readonly RowRef[];
  /** The references added by hand. */
  added: readonly MessageRef[];
  /** A path's name, for a ref added without a label. */
  nameOf: (path: string) => string;
}): MessageParts {
  const docPaths = input.openDoc ? [input.openDoc.original, input.openDoc.path ?? ""] : [];
  let subject: string | null = null;
  let own: readonly string[] = docPaths;
  const held: HeldRef[] = [];
  if (!input.selection && input.pointed.length > 0) {
    const open = input.pointed.find((p) => p.path === input.openImage || docPaths.includes(p.path));
    const first = open ?? input.pointed[0];
    subject = first?.path ?? null;
    own = subject ? [subject] : [];
    for (const p of input.pointed)
      if (p !== first)
        held.push({
          path: p.path,
          name: p.name,
          from: "pointed",
          ref: { path: p.path, label: p.name },
        });
  } else if (!input.selection && input.openImage) {
    subject = input.openImage;
    own = [input.openImage];
  }
  for (const r of input.tree)
    held.push({
      path: r.path,
      name: r.name,
      from: "tree",
      row: r.row,
      ref: { path: r.path, label: r.name },
    });
  for (const r of input.added)
    held.push({
      path: r.path,
      name: r.label ?? input.nameOf(r.path),
      ...(r.role ? { role: r.role } : {}),
      from: "added",
      ref: r,
    });
  const seen = new Set<string>(own.filter((p) => p !== ""));
  const refs: HeldRef[] = [];
  let unsent = 0;
  for (const h of held) {
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    if (refs.length === REFS_SENT) unsent++;
    else refs.push(h);
  }
  return { subject, refs, unsent };
}
