/**
 * What a move WOULD do, before it does it (kit-move-plan): the thing that
 * would move, where it would land, and the links the move would break, each
 * with the rewrite `move --update-links` would offer. Nothing is written.
 *
 * The links are found as the move finds them (`pinLinks`, then `planRelink`
 * in `session.ts`), against a world in which the move has already happened:
 * `movedWorld` maps every path of that world back to where it is on disk now,
 * so a link is resolved after the move without anything having moved. A path
 * under the old place is gone in that world; a path under the new place is
 * the file that is now under the old one.
 *
 * Pure: no disk, no session. `session.ts` holds the read side.
 */

import { sep } from "node:path";
import type { DocLinkFixes, WikiBreak } from "./protocol";

/** One move's pairs, `[from, to]`: the item, and an image's description beside it. */
export type MovedPairs = readonly (readonly [string, string])[];

/** The world after a move, as two maps over absolute paths. */
export type MovedWorld = {
  /** Where `p` (a path on disk now) is after the move. */
  forward(p: string): string;
  /** Where the file at `p` (a path after the move) is on disk now; null when `p` is under a place the move empties. */
  back(p: string): string | null;
};

const under = (p: string, root: string): boolean => p === root || p.startsWith(root + sep);

export function movedWorld(pairs: MovedPairs): MovedWorld {
  return {
    forward: (p) => {
      for (const [a, b] of pairs) if (under(p, a)) return b + p.slice(a.length);
      return p;
    },
    back: (p) => {
      for (const [a, b] of pairs) if (under(p, b)) return a + p.slice(b.length);
      for (const [a] of pairs) if (under(p, a)) return null;
      return p;
    },
  };
}

/**
 * The plan: what moves, and what it breaks. Read before a move is confirmed
 * (Scriptorium's confirm dialog, cycle 3); a confirmed move is then admitted,
 * because the plan refuses exactly what the move refuses.
 */
export type MovePlan = {
  /** The item, as the context names it. */
  from: string;
  /** Where it would be. */
  to: string;
  /** The folder it would move into. */
  into: string;
  /** Its own name. */
  name: string;
  /** A folder on disk (a set's folder, a group or a bundle). */
  folder: boolean;
  /** The documents the context shows that would move with it (1 for a document). */
  docs: number;
  /** An image's description that would move with it: where it would be. */
  sidecar?: string;
  /**
   * The path links the move would break, by the document they are in (`path`
   * after the move, `was` now), each with the target `--update-links` would
   * write. A link that would still land is not listed.
   */
  links: DocLinkFixes[];
  /** The wiki links the move would break: they name a page, and are never rewritten. */
  wiki: WikiBreak[];
  /**
   * A bundle's references (a board's cards) that land on the moved thing or
   * are written inside it: counted, not judged. Whether each still lands is
   * read after the move (`move --update-links`, or the link check).
   */
  references: number;
  /** How many links in all land on the moved thing or are written inside it. */
  checked: number;
};
