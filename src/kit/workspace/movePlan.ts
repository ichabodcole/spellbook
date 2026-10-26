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
import { type BundleType, bundleTypeOf } from "../lib/bundles";
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
 * (an app's confirm dialog); a confirmed move is then admitted, because the
 * plan refuses exactly what the move refuses.
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
   * The app's edges (its link slot's `edges`, such as frontmatter references)
   * the move would break: reported, never rewritten. Empty for an app with no
   * edges.
   */
  edges: EdgeBreak[];
  /**
   * A bundle's references (a board's cards) that land on the moved thing or
   * are written inside it: counted, not judged. Whether each still lands is
   * read after the move (`move --update-links`, or the link check).
   */
  references: number;
  /** How many links and app edges in all land on the moved thing or are written inside it. */
  checked: number;
};

/**
 * An app edge a move breaks: it landed on the moved thing (or is written
 * inside it), and after the move it lands nowhere, or elsewhere. `source` is
 * the document it is in, after the move; `key` says where in it, as the app
 * named it (a frontmatter key, `related[0]`).
 */
export type EdgeBreak = {
  kind: string;
  source: string;
  key?: string;
  line?: number;
  /** The target as written. */
  raw: string;
};

/**
 * The order a set's scan lists two documents in, by their paths from the
 * entry's root (`tree.ts`): depth-first, a folder's subfolders before its
 * files, each by name; a bundle is listed among the files, its main file
 * first and then its contents, folders first. What puts the documents of the
 * world after a move in the order the session will have them, which is the
 * order an app's resolver meets them in.
 */
export function treeOrder(a: string, b: string): number {
  const x = a.split(sep);
  const y = b.split(sep);
  let bundle: BundleType | null = null;
  let bundleAt = -1;
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const xs = x[i] as string;
    const ys = y[i] as string;
    const xLeaf = i === x.length - 1;
    const yLeaf = i === y.length - 1;
    if (xs === ys && !xLeaf && !yLeaf) {
      if (!bundle) {
        const t = bundleTypeOf(xs);
        if (t) {
          bundle = t;
          bundleAt = i;
        }
      }
      continue;
    }
    if (bundle && i === bundleAt + 1) {
      const xMain = xLeaf && xs === bundle.main;
      const yMain = yLeaf && ys === bundle.main;
      if (xMain !== yMain) return xMain ? -1 : 1;
    }
    // A folder is a group, unless it is a bundle met in a set: one item, among the files.
    const xGroup = !xLeaf && (bundle !== null || bundleTypeOf(xs) === null);
    const yGroup = !yLeaf && (bundle !== null || bundleTypeOf(ys) === null);
    if (xGroup !== yGroup) return xGroup ? -1 : 1;
    if (xs !== ys) return xs.localeCompare(ys);
  }
  return x.length - y.length;
}
